/**
 * `npm run dev:server`: builds Lumovi and serves it, as it runs in a
 * cluster, against the mock clusters the e2e tests use (their demo cluster),
 * so no real cluster is needed. LUMOVI_* variables set when running it
 * are passed on (LUMOVI_AUTH=proxy, say; see https://docs.lumovi.dev/server/configuration).
 */
import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN, PEOPLE, startTestClusters } from '../tests/mock-cluster/kubeconfig.ts'

execSync('npm run build', { stdio: 'inherit' })
const dir = mkdtempSync(join(tmpdir(), 'lumovi-dev-'))
const clusters = await startTestClusters(dir, { jitter: true })

console.log(`
Sign in with one of the demo cluster's tokens:
  ${DEMO_TOKEN}  (an administrator)
  ${PEOPLE.alice.token}  (${PEOPLE.alice.user.username})
Behind a proxy (LUMOVI_AUTH=proxy), a browser extension can send X-Forwarded-User.
`)
const server = spawn(process.execPath, ['out/server/index.js'], {
  stdio: 'inherit',
  env: {
    LUMOVI_ADDRESS: '127.0.0.1',
    LUMOVI_CLUSTER_NAME: 'demo',
    ...process.env,
    KUBECONFIG: clusters.kubeconfigPath,
    LUMOVI_CONTEXT: 'demo',
  },
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal))
}
server.on('exit', async (code) => {
  await clusters.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(code ?? 0)
})
