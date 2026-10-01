/**
 * "sandbox": a fresh, nearly empty cluster without metrics-server, served
 * over plain HTTP like `kubectl proxy`.
 */
import { clusterBuilder, DAY, HOUR } from '../builders.ts'
import type { ClusterFixture } from '../types.ts'
import { widgets } from './custom.ts'

export const SANDBOX = {
  gitVersion: 'v1.33.4',
  node: 'sandbox-node',
  namespaces: ['default', 'kube-system'],
} as const

export function sandboxCluster(now = Date.now()): ClusterFixture {
  const b = clusterBuilder(now)
  b.node({
    name: SANDBOX.node,
    age: 2 * DAY,
    ip: '172.18.0.2',
    zone: 'local',
    instanceType: 'kind',
    role: 'control-plane',
    cpu: 2,
    memoryGi: 4,
  })
  for (const name of SANDBOX.namespaces) b.namespace(name, 2 * DAY)
  b.service({
    namespace: 'default',
    name: 'kubernetes',
    age: 2 * DAY - HOUR,
    clusterIP: '10.96.0.1',
    labels: { component: 'apiserver', provider: 'kubernetes' },
    ports: [{ name: 'https', port: 443, targetPort: 6443 }],
  })
  // An alias for an outside host: a service without ports.
  b.simple('v1', 'Service', 'docs', 'default', DAY, {
    spec: { type: 'ExternalName', externalName: 'docs.example.com' },
  })
  widgets(b)
  const { metrics: _metrics, ...fixture } = b.build()
  return fixture
}
