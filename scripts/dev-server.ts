/**
 * `npm run dev:server`: builds Lumovi and serves it, as it runs in a
 * cluster, against the mock clusters the e2e tests use (their demo cluster),
 * so no real cluster is needed. LUMOVI_* variables set when running it
 * are passed on (LUMOVI_AUTH=proxy, say; see https://docs.lumovi.dev/server/configuration).
 *
 * `npm run dev:server -- --fleet`: a fleet of them instead, signed in to with
 * a mock single sign-on as Alice, a developer.
 */
import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fleetKubeconfig } from '../tests/mock-cluster/fleet.ts'
import { DEMO_TOKEN, PEOPLE, startTestClusters } from '../tests/mock-cluster/kubeconfig.ts'
import { startMockOidc } from '../tests/mock-oidc/server.ts'

const fleet = process.argv.includes('--fleet')
execSync('npm run build', { stdio: 'inherit' })
const dir = mkdtempSync(join(tmpdir(), 'lumovi-dev-'))
const clusters = await startTestClusters(dir, { jitter: true })
const port = Number(process.env.LUMOVI_PORT || 8080)
const oidc = fleet ? await startMockOidc({ clientId: 'lumovi' }) : undefined

if (oidc) {
  oidc.person = { sub: 'alice', email: PEOPLE.alice.user.username, groups: ['developers'] }
  console.log(`
A fleet of the mock clusters, at http://127.0.0.1:${port}/: sign in, and you're Alice.
`)
} else {
  console.log(`
Sign in with one of the demo cluster's tokens:
  ${DEMO_TOKEN}  (an administrator)
  ${PEOPLE.alice.token}  (${PEOPLE.alice.user.username})
Behind a proxy (LUMOVI_AUTH=proxy), a browser extension can send X-Forwarded-User.
`)
}
const server = spawn(process.execPath, ['out/server/index.js'], {
  stdio: 'inherit',
  env: {
    LUMOVI_ADDRESS: '127.0.0.1',
    LUMOVI_CLUSTER_NAME: 'demo',
    ...process.env,
    ...(oidc
      ? {
          LUMOVI_FLEET_KUBECONFIG: fleetKubeconfig(clusters),
          LUMOVI_AUTH: 'oidc',
          LUMOVI_URL: `http://127.0.0.1:${port}`,
          LUMOVI_OIDC_ISSUER: oidc.issuer,
          LUMOVI_OIDC_CLIENT_ID: 'lumovi',
          LUMOVI_OIDC_PROVIDER_NAME: 'the mock provider',
        }
      : { KUBECONFIG: clusters.kubeconfigPath, LUMOVI_CONTEXT: 'demo' }),
  },
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal))
}
server.on('exit', async (code) => {
  await oidc?.close()
  await clusters.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(code ?? 0)
})
