/**
 * "large": one namespace with thousands of pods, for exercising list
 * virtualization and big payloads.
 */
import { clusterBuilder, DAY, Mi, SECOND } from '../builders.ts'
import type { ClusterFixture, KubeObject } from '../types.ts'

export const LARGE = {
  gitVersion: 'v1.32.9',
  node: 'large-node',
  namespace: 'load',
  podCount: 2500,
  podName: (i: number) => `load-${String(i).padStart(5, '0')}`,
} as const

export function largeCluster(now = Date.now()): ClusterFixture {
  const b = clusterBuilder(now)
  b.node({
    name: LARGE.node,
    age: 30 * DAY,
    ip: '10.20.0.10',
    zone: 'eu-central-1a',
    instanceType: 'c7i.48xlarge',
    cpu: 192,
    memoryGi: 384,
    usage: { cpu: 0.57, memory: 0.44 },
  })
  b.namespace('default', 30 * DAY)
  b.namespace(LARGE.namespace, 30 * DAY)
  // VictoriaMetrics: a single-node server that answers PromQL, and a cluster's query
  // frontend that isn't running.
  b.namespace('monitoring', 30 * DAY)
  b.service({
    namespace: 'monitoring',
    name: 'vmsingle-vm',
    age: 30 * DAY,
    clusterIP: '10.96.8.29',
    labels: { 'app.kubernetes.io/name': 'vmsingle' },
    ports: [{ name: 'http', port: 8429 }],
  })
  b.service({
    namespace: 'monitoring',
    name: 'vmselect-vm',
    age: 30 * DAY,
    clusterIP: '10.96.8.81',
    labels: { 'app.kubernetes.io/name': 'vmselect' },
    // A port by an unusual name and number: the first one is used.
    ports: [{ name: 'query', port: 8080 }],
  })
  const fixture = {
    ...b.build(),
    prometheus: [
      { namespace: 'monitoring', service: 'vmsingle-vm', flavor: 'victoriametrics' as const },
    ],
  }
  const created = b.time(3 * DAY)
  const started = b.time(3 * DAY - 20 * SECOND)
  // Pods are built directly (not through the builder) to keep 2500 of them cheap.
  for (let i = 0; i < LARGE.podCount; i++) {
    const name = LARGE.podName(i)
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: LARGE.namespace,
        uid: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
        resourceVersion: String(90000 + i),
        creationTimestamp: created,
        labels: { 'app.kubernetes.io/name': 'load', shard: String(i % 10) },
      },
      spec: {
        nodeName: LARGE.node,
        containers: [
          {
            name: 'worker',
            image: 'ghcr.io/acme/load-worker:v1.0.0',
            resources: { requests: { cpu: '20m', memory: '32Mi' } },
          },
        ],
        restartPolicy: 'Always',
      },
      status: {
        phase: 'Running',
        conditions: [
          { type: 'Ready', status: 'True', lastTransitionTime: started },
          { type: 'PodScheduled', status: 'True', lastTransitionTime: created },
        ],
        hostIP: '10.20.0.10',
        podIP: `10.244.${Math.floor(i / 250)}.${i % 250}`,
        startTime: started,
        containerStatuses: [
          {
            name: 'worker',
            image: 'ghcr.io/acme/load-worker:v1.0.0',
            imageID: 'ghcr.io/acme/load-worker@sha256:1f0e4c',
            ready: true,
            started: true,
            restartCount: i % 97 === 0 ? 1 : 0,
            state: { running: { startedAt: started } },
          },
        ],
        qosClass: 'Burstable',
      },
    }
    fixture.objects.push(pod)
    fixture.metrics!.pods.push({
      namespace: LARGE.namespace,
      name,
      containers: [{ name: 'worker', cpu: 0.005 + (i % 17) * 0.001, memory: (18 + (i % 23)) * Mi }],
    })
  }
  return fixture
}
