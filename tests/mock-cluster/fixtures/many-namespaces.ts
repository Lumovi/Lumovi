/**
 * "many namespaces": a big multi-tenant cluster, thousands of namespaces of a
 * Deployment of one to three pods each, with Prometheus. Not one of the test
 * clusters every worker starts: the tests that need it start it.
 */
import { clusterBuilder, DAY, Mi, withState, type PodTemplate } from '../builders.ts'
import type { ClusterFixture } from '../types.ts'

/** Its namespaces' names: team-0000, team-0001… */
export const tenant = (i: number) => `team-${String(i).padStart(4, '0')}`

export function manyNamespacesCluster(count: number, now = Date.now()): ClusterFixture {
  const b = clusterBuilder(now)
  for (let n = 0; n < 4; n++) {
    b.node({
      name: `node-${n}`,
      age: 60 * DAY,
      ip: `10.30.0.${10 + n}`,
      zone: 'eu-central-1a',
      instanceType: 'm7i.8xlarge',
      cpu: 32,
      memoryGi: 128,
      usage: { cpu: 0.4, memory: 0.5 },
    })
  }
  b.namespace('monitoring', 60 * DAY)
  b.service({
    namespace: 'monitoring',
    name: 'prometheus',
    age: 60 * DAY,
    clusterIP: '10.96.9.90',
    labels: { 'app.kubernetes.io/name': 'prometheus' },
    ports: [{ name: 'web', port: 9090 }],
  })
  const template: PodTemplate = {
    labels: { app: 'api' },
    containers: [
      { name: 'api', image: 'ghcr.io/acme/api:v2.1.0', cpu: ['200m'], memory: ['256Mi', '512Mi'] },
    ],
  }
  for (let i = 0; i < count; i++) {
    const namespace = tenant(i)
    b.namespace(namespace, 30 * DAY)
    // Some busy, most idle, as tenants are.
    const replicas = 1 + (i % 3)
    const api = b.deployment({
      namespace,
      name: 'api',
      age: 30 * DAY,
      replicas,
      ready: replicas,
      template,
    })
    for (let r = 0; r < replicas; r++) {
      b.pod({
        ...template,
        namespace,
        name: api.podName(r),
        generateName: api.generateName,
        age: 14 * DAY,
        node: `node-${(i + r) % 4}`,
        owner: api.replicaSet,
        labels: api.podLabels,
        containers: withState(template.containers, {
          api: { usage: [0.01 + (i % 7) * 0.02, (60 + (i % 5) * 40) * Mi] },
        }),
      })
    }
  }
  return {
    ...b.build(),
    prometheus: [{ namespace: 'monitoring', service: 'prometheus', flavor: 'prometheus' }],
  }
}
