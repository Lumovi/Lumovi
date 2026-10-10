/**
 * `node out/server/index.js`: Lumovi as a server, showing the cluster it
 * runs in, or a fleet of clusters, to everyone who signs in (see
 * https://docs.lumovi.dev/server/overview).
 */
import { version } from '../../package.json'
import { setUpNetwork } from '@backend/network'
import { sized } from '@shared/files'
import { startServer } from './app'
import { HostedCluster, type Hosted } from './cluster'
import { readConfig, RENDERER_DIR } from './config'
import { HostedFleet } from './fleet/fleet'
import { log } from './log'

const SIGN_IN = { token: 'a token', oidc: 'single sign-on', proxy: 'the proxy in front of it' }

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
  const server = await startServer({ config, hosted, env: process.env, version })
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
