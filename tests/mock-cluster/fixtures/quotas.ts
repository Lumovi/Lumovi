/**
 * Quotas in the shop, as a busy namespace has them: one nearly full, one full, one well within,
 * one not counted yet; a limit range for volume claims; and a rollout one of them stops. Put in a
 * cluster by a test, and undone by its reset.
 */
import type { MockCluster } from '../server.ts'
import type { KubeObject } from '../types.ts'

const CREATED = '2026-09-06T10:00:00Z'

const quota = (
  name: string,
  namespace: string,
  hard: Record<string, string>,
  used?: Record<string, string>,
) =>
  ({
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name, namespace, uid: `rq-${namespace}-${name}`, creationTimestamp: CREATED },
    spec: { hard },
    ...(used ? { status: { hard, used } } : {}),
  }) as unknown as KubeObject

/** The API's words for a pod the quota `compute` has no room for. */
export const REFUSED =
  'pods "checkout-7d9f6c5b8-x2kqp" is forbidden: exceeded quota: compute, requested: requests.memory=512Mi, used: requests.memory=3.75Gi, limited: requests.memory=4Gi'

/** The shop's quotas and its volume claims' limit range. */
export function quotas(cluster: MockCluster) {
  // 93% of its memory requests (3.75 Gi of 4 Gi: floored, never 94), 90% of its CPU requests.
  cluster.upsert(
    quota(
      'compute',
      'shop',
      {
        'requests.memory': '4Gi',
        'requests.cpu': '2',
        'limits.cpu': '4',
        'limits.memory': '8Gi',
        pods: '20',
        'services.loadbalancers': '0',
      },
      {
        'requests.memory': '3840Mi',
        'requests.cpu': '1800m',
        'limits.cpu': '3200m',
        'limits.memory': '6Gi',
        pods: '9',
        'services.loadbalancers': '0',
      },
    ),
  )
  cluster.upsert(
    quota('storage', 'shop', { persistentvolumeclaims: '10' }, { persistentvolumeclaims: '10' }),
  )
  cluster.upsert(
    quota('objects', 'shop', { 'count/configmaps': '25' }, { 'count/configmaps': '9' }),
  )
  // Only forbids: within quota, and never in Needs attention.
  cluster.upsert(
    quota(
      'no-balancers',
      'batch',
      { 'services.loadbalancers': '0' },
      { 'services.loadbalancers': '0' },
    ),
  )
  // Just made: the controller hasn't counted it.
  cluster.upsert(quota('fresh', 'data', { pods: '5' }))
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: {
      name: 'pvc-size',
      namespace: 'shop',
      uid: 'lr-shop-pvc',
      creationTimestamp: CREATED,
    },
    spec: {
      limits: [
        { type: 'PersistentVolumeClaim', min: { storage: '1Gi' }, max: { storage: '100Gi' } },
      ],
    },
  } as unknown as KubeObject)
}

/** Bounds without defaults, in the data namespace: a container's and a pod's. */
export function bounds(cluster: MockCluster) {
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: {
      name: 'bounds',
      namespace: 'data',
      uid: 'lr-data-bounds',
      creationTimestamp: CREATED,
    },
    spec: {
      limits: [
        {
          type: 'Container',
          min: { cpu: '50m', memory: '64Mi' },
          max: { cpu: '2', memory: '4Gi' },
        },
        { type: 'Pod', max: { cpu: '4', memory: '8Gi' } },
      ],
    },
  } as unknown as KubeObject)
}

/** A Deployment the quota `compute` stops: 2 of its 3 pods there, the third refused. */
export function stuckRollout(cluster: MockCluster) {
  cluster.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'checkout-quota',
      namespace: 'shop',
      uid: 'd-checkout-quota',
      generation: 2,
      creationTimestamp: CREATED,
      labels: { app: 'checkout-quota' },
    },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: 'checkout-quota' } },
      template: {
        metadata: { labels: { app: 'checkout-quota' } },
        spec: { containers: [{ name: 'api', image: 'ghcr.io/acme/checkout:1.14.0' }] },
      },
    },
    status: {
      replicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
      observedGeneration: 2,
      conditions: [
        { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
        { type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: REFUSED },
      ],
    },
  } as unknown as KubeObject)
}
