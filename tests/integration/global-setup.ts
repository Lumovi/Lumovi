import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CONTEXT, KUBECONFIG } from './cluster.ts'

/** Fails early, and says how, when there's no cluster to test against. */
export default function globalSetup() {
  const ready =
    existsSync(KUBECONFIG) &&
    (() => {
      try {
        execFileSync('kubectl', [
          '--kubeconfig',
          KUBECONFIG,
          '--context',
          CONTEXT,
          'get',
          '--raw',
          '/readyz',
        ])
        return true
      } catch {
        return false
      }
    })()
  if (!ready) {
    throw new Error(`No ${CONTEXT} cluster to test against. Start it with: npm run kind:up`)
  }
}
