/**
 * `node out/server/index.js`: Lumovi as a server, showing the cluster it
 * runs in, or a fleet of clusters, to everyone who signs in (see
 * https://docs.lumovi.dev/server/overview).
 */
import { version } from '../../package.json'
import { setUpNetwork } from '@backend/network'
import { sized } from '@shared/files'
import { startServer, type RunningServer } from './app'
import { HostedCluster, type Hosted } from './cluster'
import { readConfig, RENDERER_DIR } from './config'
import { HostedFleet } from './fleet/fleet'
import { log } from './log'

const SIGN_IN = { token: 'a token', oidc: 'single sign-on', proxy: 'the proxy in front of it' }
/** The server's last line when it stops for having lost its audit history; why follows it. */
const STOPS_WITHOUT_ITS_HISTORY =
  'Lumovi stops: nothing done through it could be recorded in its audit history any more.'

try {
  const config = readConfig(process.env, RENDERER_DIR)
  // Before anything connects anywhere: the certificate authorities trusted, and the proxy.
  const network = setUpNetwork(process.env, {
    caFiles: config.caFiles,
    // In a cluster, its API server and its services are reached directly.
    direct: process.env.KUBERNETES_SERVICE_HOST
      ? [process.env.KUBERNETES_SERVICE_HOST, 'kubernetes.default.svc', '.svc', '.cluster.local']
      : [],
  })
  for (const said of network.said) log(said)
  const hosted: Hosted = config.fleet
    ? await HostedFleet.start(config.fleet, process.env, config)
    : HostedCluster.fromEnvironment(process.env, {
        name: config.clusterName,
        usernamePrefix: config.usernamePrefix,
        groupsPrefix: config.groupsPrefix,
        labels: config.clusterLabels,
      })
  // A server that lost its audit history to another Lumovi stops: it would go on doing what
  // people ask with nothing of it recorded where their auditors read, and say so only in its
  // own output. Stopped, whatever runs it shows it (a pod that isn't ready, restarting), and
  // started again it waits its turn for the history, or says who holds it.
  let running: RunningServer | undefined
  const stopped = (why: string) => {
    log(`${STOPS_WITHOUT_ITS_HISTORY} ${why}`)
    // As for SIGTERM (people's pages are told, what's kept is kept), then as a failure.
    void (running?.close() ?? Promise.resolve()).finally(() => process.exit(1))
  }
  const server = (running = await startServer({
    config,
    hosted,
    env: process.env,
    version,
    auditLost: stopped,
  }))
  log(
    config.fileCopyMaxBytes > 0
      ? `Files are copied to and from containers, ${sized(config.fileCopyMaxBytes)} a copy at most (LUMOVI_FILE_COPY_MAX_BYTES)`
      : 'Copying files to and from containers is turned off (LUMOVI_FILE_COPY_MAX_BYTES)',
  )
  log(
    `Lumovi ${version} shows ${hosted.describe()} at ${server.url}; people sign in with ${SIGN_IN[config.auth.mode]}`,
  )
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)))
  }
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
