/** Kubeconfig generation and a one-call setup of every mock cluster the tests use. */
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { demoCluster, DEMO } from './fixtures/demo.ts'
import { largeCluster, LARGE } from './fixtures/large.ts'
import { sandboxCluster, SANDBOX } from './fixtures/sandbox.ts'
import { startMockCluster, type MockCluster } from './server.ts'

export interface KubeconfigSpec {
  currentContext?: string
  clusters: { name: string; server: string; caPem?: string; insecure?: boolean }[]
  users: {
    name: string
    token?: string
    exec?: {
      command: string
      args?: string[]
      apiVersion?: string
      env?: { name: string; value: string }[]
    }
  }[]
  contexts: { name: string; cluster: string; user: string; namespace?: string }[]
}

/**
 * Writes a kubeconfig to `dir/fileName` and returns its path. The file is
 * JSON, which is valid YAML and accepted by kubectl and client libraries.
 */
export function writeKubeconfig(dir: string, spec: KubeconfigSpec, fileName = 'config'): string {
  const config = {
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    ...(spec.currentContext ? { 'current-context': spec.currentContext } : {}),
    clusters: spec.clusters.map((c) => ({
      name: c.name,
      cluster: {
        server: c.server,
        ...(c.caPem
          ? { 'certificate-authority-data': Buffer.from(c.caPem).toString('base64') }
          : {}),
        ...(c.insecure ? { 'insecure-skip-tls-verify': true } : {}),
      },
    })),
    users: spec.users.map((u) => ({
      name: u.name,
      user: {
        ...(u.token ? { token: u.token } : {}),
        ...(u.exec
          ? {
              exec: {
                apiVersion: u.exec.apiVersion ?? 'client.authentication.k8s.io/v1',
                command: u.exec.command,
                args: u.exec.args ?? [],
                env: u.exec.env ?? null,
                interactiveMode: 'Never',
                provideClusterInfo: false,
              },
            }
          : {}),
      },
    })),
    contexts: spec.contexts.map((c) => ({
      name: c.name,
      context: {
        cluster: c.cluster,
        user: c.user,
        ...(c.namespace ? { namespace: c.namespace } : {}),
      },
    })),
  }
  const path = join(dir, fileName)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}

/** Context names in the kubeconfig written by `startTestClusters`, in file order. */
export const CONTEXTS = {
  /** Rich cluster over HTTPS with a CA and bearer token. The current context. */
  demo: 'demo',
  /** Nearly empty cluster over plain HTTP (opted in with insecure-skip-tls-verify), no metrics API. */
  sandbox: 'sandbox',
  /** Thousands of pods, HTTPS with insecure-skip-tls-verify. */
  large: 'large',
  /** Points at a closed port: connection refused. */
  offline: 'offline',
  /** Demo server with a wrong token: HTTP 401. */
  expired: 'expired',
  /** Demo server without its CA: TLS verification fails. */
  untrusted: 'untrusted',
  /** Credential plugin that is not installed. */
  execMissing: 'exec-missing',
  /** References a cluster entry that does not exist. */
  brokenRef: 'broken-ref',
  /** The sandbox over plain HTTP without opting in: refused before connecting. */
  plainHttp: 'plain-http',
} as const

export const DEMO_TOKEN = 'kubestacks-demo-token'
export const MISSING_PLUGIN = 'kubestacks-missing-credential-plugin'

export { DEMO, LARGE, SANDBOX }

export interface TestClusters {
  kubeconfigPath: string
  demo: MockCluster
  sandbox: MockCluster
  large: MockCluster
  /** URL of a port nothing listens on. */
  offlineUrl: string
  close(): Promise<void>
}

/** Finds a local port that is not listening (bind, read the port, close). */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 1
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Starts the demo, sandbox and large clusters and writes a kubeconfig for them into `dir`. */
export async function startTestClusters(
  dir: string,
  options: { jitter?: boolean } = {},
): Promise<TestClusters> {
  const [demo, sandbox, large, offlinePort] = await Promise.all([
    startMockCluster({
      fixture: () => demoCluster(),
      tls: true,
      token: DEMO_TOKEN,
      gitVersion: DEMO.gitVersion,
      jitter: options.jitter,
    }),
    // An older cluster: discovery one API group at a time, and no OpenAPI v3.
    startMockCluster({
      fixture: () => sandboxCluster(),
      gitVersion: SANDBOX.gitVersion,
      aggregatedDiscovery: false,
      openApi: false,
    }),
    startMockCluster({
      fixture: () => largeCluster(),
      tls: true,
      gitVersion: LARGE.gitVersion,
      jitter: options.jitter,
    }),
    closedPort(),
  ])
  const offlineUrl = `https://127.0.0.1:${offlinePort}`
  const kubeconfigPath = writeKubeconfig(dir, {
    currentContext: CONTEXTS.demo,
    clusters: [
      { name: 'demo-cluster', server: demo.url, caPem: demo.caPem },
      { name: 'sandbox-cluster', server: sandbox.url, insecure: true },
      { name: 'sandbox-cluster-strict', server: sandbox.url },
      { name: 'large-cluster', server: large.url, insecure: true },
      { name: 'offline-cluster', server: offlineUrl },
      { name: 'demo-cluster-untrusted', server: demo.url },
    ],
    users: [
      { name: 'demo-admin', token: DEMO_TOKEN },
      { name: 'sandbox-user' },
      { name: 'large-user' },
      { name: 'expired-user', token: 'expired-token' },
      {
        name: 'exec-user',
        exec: { command: MISSING_PLUGIN, args: ['get-token', '--cluster', 'demo'] },
      },
    ],
    contexts: [
      { name: CONTEXTS.demo, cluster: 'demo-cluster', user: 'demo-admin' },
      { name: CONTEXTS.sandbox, cluster: 'sandbox-cluster', user: 'sandbox-user' },
      {
        name: CONTEXTS.large,
        cluster: 'large-cluster',
        user: 'large-user',
        namespace: LARGE.namespace,
      },
      { name: CONTEXTS.offline, cluster: 'offline-cluster', user: 'demo-admin' },
      { name: CONTEXTS.expired, cluster: 'demo-cluster', user: 'expired-user' },
      { name: CONTEXTS.untrusted, cluster: 'demo-cluster-untrusted', user: 'demo-admin' },
      { name: CONTEXTS.execMissing, cluster: 'demo-cluster', user: 'exec-user' },
      { name: CONTEXTS.brokenRef, cluster: 'deleted-cluster', user: 'demo-admin' },
      { name: CONTEXTS.plainHttp, cluster: 'sandbox-cluster-strict', user: 'sandbox-user' },
    ],
  })
  return {
    kubeconfigPath,
    demo,
    sandbox,
    large,
    offlineUrl,
    async close() {
      await Promise.all([demo.close(), sandbox.close(), large.close()])
    },
  }
}
