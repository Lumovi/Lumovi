/**
 * `npm run dev:mock`: starts the mock clusters used by the e2e tests and runs
 * the app in dev mode against them, so no real cluster is needed.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestClusters } from '../tests/mock-cluster/kubeconfig.ts'

const dir = mkdtempSync(join(tmpdir(), 'kubestacks-dev-'))
const clusters = await startTestClusters(dir, { jitter: true })
console.log(`Mock clusters ready (KUBECONFIG=${clusters.kubeconfigPath})`)

const env = { ...process.env, KUBECONFIG: clusters.kubeconfigPath }
// Extra arguments are passed on, e.g. `npm run dev:mock -- --remoteDebuggingPort 9222`.
const args = ['electron-vite', 'dev', ...process.argv.slice(2)]
const child =
  process.platform === 'win32'
    ? spawn(`npx ${args.join(' ')}`, { stdio: 'inherit', env, shell: true })
    : spawn('npx', args, { stdio: 'inherit', env })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', async (code) => {
  await clusters.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(code ?? 0)
})
