/**
 * `node out/server/index.js`: KubeStacks as a server, showing the cluster it
 * runs in to everyone who signs in (see https://docs.kubestacks.com/server/overview).
 */
import { version } from '../../package.json'
import { startServer } from './app'
import { HostedCluster } from './cluster'
import { readConfig, RENDERER_DIR } from './config'
import { log } from './log'

const SIGN_IN = { token: 'a token', oidc: 'single sign-on', proxy: 'the proxy in front of it' }

try {
  const config = readConfig(process.env, RENDERER_DIR)
  const cluster = HostedCluster.fromEnvironment(process.env, {
    name: config.clusterName,
    usernamePrefix: config.usernamePrefix,
    groupsPrefix: config.groupsPrefix,
  })
  const server = await startServer({ config, cluster, env: process.env, version })
  log(
    `KubeStacks ${version} shows ${cluster.name} (${cluster.server}) at ${server.url}; people sign in with ${SIGN_IN[config.auth.mode]}`,
  )
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)))
  }
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
