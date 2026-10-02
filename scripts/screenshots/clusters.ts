/**
 * The mock clusters the screenshots are taken of, in a process of their own
 * with the clock stopped (see still.ts), so the screenshot script's own
 * timers keep running. Prints the kubeconfig's path, then runs until its
 * input closes. Addresses are shown on screen, so they're fixed. The
 * kubeconfig is .kube/config in a folder of its own (the app is started
 * there, so the clusters page names it the same way every time).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEMO_TOKEN,
  LARGE,
  startTestClusters,
  writeKubeconfig,
} from '../../tests/mock-cluster/kubeconfig.ts'
import { EPOCH, stopClock } from './still.ts'

/** The ports they answer on, and one where nothing does. */
const PORTS = { demo: 46443, sandbox: 46444, large: 46445, offline: 46446 }

/** The names clusters go by in the screenshots. */
export const CLUSTERS = {
  /** The demo cluster: a small production one, with a few things wrong. */
  production: 'production',
  /** A nearly empty, older cluster. */
  staging: 'staging',
  /** Thousands of pods. */
  loadTest: 'load-test',
  /** Nothing answers. */
  edge: 'edge',
} as const

if (import.meta.main) {
  stopClock(EPOCH)
  const dir = mkdtempSync(join(tmpdir(), 'kubestacks-screenshots-'))
  const clusters = await startTestClusters(dir, { jitter: true, ports: PORTS }).catch(
    (error: Error) => {
      throw new Error(
        `The mock clusters need ports ${Object.values(PORTS).join(', ')} (${error.message})`,
      )
    },
  )
  mkdirSync(join(dir, '.kube'))
  const kubeconfig = writeKubeconfig(
    join(dir, '.kube'),
    {
      currentContext: CLUSTERS.production,
      clusters: [
        { name: 'production', server: clusters.demo.url, caPem: clusters.demo.caPem },
        { name: 'staging', server: clusters.sandbox.url, insecure: true },
        { name: 'load-test', server: clusters.large.url, insecure: true },
        { name: 'edge', server: clusters.offlineUrl },
      ],
      users: [{ name: 'admin', token: DEMO_TOKEN }, { name: 'developer' }],
      contexts: [
        { name: CLUSTERS.production, cluster: 'production', user: 'admin' },
        { name: CLUSTERS.staging, cluster: 'staging', user: 'developer' },
        {
          name: CLUSTERS.loadTest,
          cluster: 'load-test',
          user: 'developer',
          namespace: LARGE.namespace,
        },
        { name: CLUSTERS.edge, cluster: 'edge', user: 'admin' },
      ],
    },
    'config',
  )
  console.log(JSON.stringify({ kubeconfig }))
  process.stdin.resume()
  process.stdin.on('end', () => {
    void clusters.close().then(() => {
      rmSync(dir, { recursive: true, force: true })
      process.exit(0)
    })
  })
}
