/**
 * A checkout Deployment, as two places might run it: its config and its database's Secret beside
 * it, for the tests of comparing them. Put in a cluster by a test, and undone by its reset.
 */
import type { MockCluster } from '../server.ts'
import type { KubeObject } from '../types.ts'

/** A checkout Deployment, its config and its database's Secret, in `namespace` of a cluster. */
export function checkout(
  cluster: MockCluster,
  namespace: string,
  {
    image,
    replicas,
    url,
    password,
  }: { image: string; replicas: number; url: string; password: string },
) {
  if (!cluster.object('Namespace', undefined, namespace)) {
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        uid: `ns-${namespace}`,
        creationTimestamp: '2026-10-01T00:00:00Z',
      },
    } as KubeObject)
  }
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'checkout-config',
      namespace,
      uid: `cm-${namespace}`,
      creationTimestamp: '2026-10-01T00:00:00Z',
    },
    data: { PAYMENTS_URL: url, LOG_LEVEL: 'info' },
  } as unknown as KubeObject)
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'checkout-db',
      namespace,
      uid: `s-${namespace}`,
      creationTimestamp: '2026-10-01T00:00:00Z',
    },
    type: 'Opaque',
    data: { host: btoa('db.internal'), password: btoa(password) },
  } as unknown as KubeObject)
  cluster.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'checkout',
      namespace,
      uid: `d-${namespace}-${image}`,
      generation: replicas * 7,
      resourceVersion: String(replicas * 1000),
      creationTimestamp: '2026-10-02T16:40:51Z',
      labels: { app: 'checkout' },
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: 'checkout' } },
      template: {
        metadata: { labels: { app: 'checkout' } },
        spec: {
          containers: [
            {
              name: 'api',
              image,
              envFrom: [{ configMapRef: { name: 'checkout-config' } }],
              env: [
                {
                  name: 'DB_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'checkout-db', key: 'password' } },
                },
              ],
            },
          ],
        },
      },
    },
    status: { replicas, availableReplicas: replicas, observedGeneration: replicas * 7 },
  } as unknown as KubeObject)
}
