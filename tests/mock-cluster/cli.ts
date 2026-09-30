/**
 * Runs the mock clusters until interrupted:
 *
 *   npm run mock-cluster
 *
 * then point kubectl or the app at the printed kubeconfig.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXTS, DEMO_TOKEN, startTestClusters } from './kubeconfig.ts'

const dir = mkdtempSync(join(tmpdir(), 'kubestacks-mock-'))
const clusters = await startTestClusters(dir, { jitter: true })

console.log(`Mock clusters are running.

  KUBECONFIG=${clusters.kubeconfigPath}

  demo     ${clusters.demo.url}   (token: ${DEMO_TOKEN})
  sandbox  ${clusters.sandbox.url}
  large    ${clusters.large.url}

Contexts: ${Object.values(CONTEXTS).join(', ')}
Press Ctrl+C to stop.`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await clusters.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
