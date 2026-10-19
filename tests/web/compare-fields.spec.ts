/**
 * Two objects made ready to compare (src/shared/compare.ts): their fields in one order; what the
 * cluster sets and their status left out unless asked; and a workload's config paired by where
 * it's referenced. Plain functions: nothing is served.
 */
import { expect, test } from '../temp-folders.ts'
import type { KubeObject } from '../../src/shared/api.ts'
import { comparable, configPairs, configRefs, WITHHELD_MARK } from '../../src/shared/compare.ts'

const deployment = (namespace: string, extra: Record<string, unknown> = {}) =>
  ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'checkout',
      namespace,
      uid: `uid-${namespace}`,
      resourceVersion: '41',
      generation: 7,
      creationTimestamp: '2026-10-02T16:40:51Z',
      managedFields: [{ manager: 'kubectl' }],
      labels: { app: 'checkout' },
      annotations: {
        'deployment.kubernetes.io/revision': '9',
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
        team: 'payments',
      },
    },
    spec: {
      replicas: 2,
      template: {
        metadata: { labels: { app: 'checkout', 'pod-template-hash': '6d4f9b' } },
        spec: {
          containers: [
            {
              name: 'api',
              image: 'checkout:1.15.0',
              envFrom: [{ configMapRef: { name: `checkout-config-${namespace}` } }],
              env: [
                {
                  name: 'DB_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'checkout-db', key: 'password' } },
                },
                { name: 'MODE', value: 'fast' },
              ],
              volumeMounts: [{ name: 'flags', mountPath: '/flags' }],
            },
          ],
          volumes: [{ name: 'flags', configMap: { name: 'checkout-flags' } }],
          imagePullSecrets: [{ name: 'registry' }],
        },
      },
    },
    status: { availableReplicas: 2, observedGeneration: 7 },
    ...extra,
  }) as unknown as KubeObject

test('what the cluster set and how the object is are left out, unless asked; the rest kept, in one order', () => {
  const clean = comparable(deployment('shop'))
  expect(clean).toEqual({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { annotations: { team: 'payments' }, labels: { app: 'checkout' }, name: 'checkout' },
    spec: {
      replicas: 2,
      template: {
        metadata: { labels: { app: 'checkout' } },
        spec: (deployment('shop').spec as { template: { spec: unknown } }).template.spec,
      },
    },
  })
  // Keys in order, at every depth; a list keeps its own.
  expect(Object.keys(clean)).toEqual(['apiVersion', 'kind', 'metadata', 'spec'])
  const container = (
    clean.spec as { template: { spec: { containers: Record<string, unknown>[] } } }
  ).template.spec.containers[0]!
  expect(Object.keys(container)).toEqual(['env', 'envFrom', 'image', 'name', 'volumeMounts'])
  expect((container.env as { name: string }[]).map((e) => e.name)).toEqual(['DB_PASSWORD', 'MODE'])
  // Two namespaces' alike, but for their config's names: what's left differs there alone.
  const [a, b] = [comparable(deployment('shop')), comparable(deployment('staging'))]
  expect(JSON.stringify(a).replaceAll('-shop', '-staging')).toBe(JSON.stringify(b))
  // Asked for: everything, in the same order.
  const all = comparable(deployment('shop'), { noise: true })
  expect(all.status).toEqual({ availableReplicas: 2, observedGeneration: 7 })
  expect((all.metadata as Record<string, unknown>).uid).toBe('uid-shop')
  expect(Object.keys(all.metadata as object)).toEqual(
    [...Object.keys(all.metadata as object)].sort(),
  )
  // An object read is never changed.
  const read = deployment('shop')
  const before = JSON.stringify(read)
  comparable(read)
  comparable(read, { noise: true })
  expect(JSON.stringify(read)).toBe(before)
})

test('of some kinds, what the cluster gave them is left out too: an address, a volume, a node', () => {
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 's' },
    spec: {
      clusterIP: '10.0.0.7',
      clusterIPs: ['10.0.0.7'],
      ports: [{ port: 80 }],
      type: 'ClusterIP',
    },
  } as unknown as KubeObject
  expect(comparable(service).spec).toEqual({ ports: [{ port: 80 }], type: 'ClusterIP' })
  const claim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'c' },
    spec: { volumeName: 'pv-1', resources: { requests: { storage: '1Gi' } } },
  } as unknown as KubeObject
  expect(comparable(claim).spec).toEqual({ resources: { requests: { storage: '1Gi' } } })
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'p', labels: { 'pod-template-hash': 'x' } },
    spec: { nodeName: 'worker-1', containers: [] },
  } as unknown as KubeObject
  expect(comparable(pod)).toEqual({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'p' },
    spec: { containers: [] },
  })
  // (Kept as it is where it's asked for.)
  expect((comparable(service, { noise: true }).spec as { clusterIP: string }).clusterIP).toBe(
    '10.0.0.7',
  )
})

test('a workload’s config is each ConfigMap and Secret it references, where it does', () => {
  expect(configRefs(deployment('shop'))).toEqual([
    {
      kind: 'ConfigMap',
      name: 'checkout-flags',
      place: 'volume/flags',
      said: 'volume flags, container api',
    },
    {
      kind: 'Secret',
      name: 'checkout-db',
      place: 'env/api/DB_PASSWORD',
      said: 'env DB_PASSWORD, container api',
    },
    {
      kind: 'ConfigMap',
      name: 'checkout-config-shop',
      place: 'envFrom/api/ConfigMap/0',
      said: 'envFrom, container api',
    },
    { kind: 'Secret', name: 'registry', place: 'imagePullSecrets/0', said: 'image pull secret' },
  ])
  // A CronJob's, through its job's template; a Pod's, its own; anything else, none.
  const cron = {
    kind: 'CronJob',
    metadata: { name: 'c' },
    spec: {
      jobTemplate: {
        spec: {
          template: {
            spec: { containers: [{ name: 'run', envFrom: [{ secretRef: { name: 's' } }] }] },
          },
        },
      },
    },
  } as unknown as KubeObject
  expect(configRefs(cron).map((ref) => ref.name)).toEqual(['s'])
  const pod = {
    kind: 'Pod',
    metadata: { name: 'p' },
    spec: { volumes: [{ name: 'v', secret: { secretName: 'x' } }], containers: [] },
  } as unknown as KubeObject
  expect(configRefs(pod)).toEqual([
    { kind: 'Secret', name: 'x', place: 'volume/v', said: 'volume v' },
  ])
  expect(configRefs({ kind: 'ConfigMap', metadata: { name: 'm' } } as KubeObject)).toEqual([])
})

test('two workloads’ config is paired by where it’s referenced, not by its name; one on a side alone is said', () => {
  const production = deployment('shop')
  const staging = deployment('staging')
  // Staging mounts no flags, and has a Secret of its own besides.
  const spec = (staging.spec as { template: { spec: Record<string, unknown> } }).template.spec
  spec.volumes = [{ name: 'certs', secret: { secretName: 'checkout-certs' } }]
  expect(configPairs(production, staging)).toEqual([
    { kind: 'ConfigMap', left: 'checkout-flags', said: ['volume flags, container api'] },
    {
      kind: 'Secret',
      left: 'checkout-db',
      right: 'checkout-db',
      said: ['env DB_PASSWORD, container api'],
    },
    {
      kind: 'ConfigMap',
      left: 'checkout-config-shop',
      right: 'checkout-config-staging',
      said: ['envFrom, container api'],
    },
    { kind: 'Secret', left: 'registry', right: 'registry', said: ['image pull secret'] },
    { kind: 'Secret', right: 'checkout-certs', said: ['volume certs'] },
  ])
  // One object referenced at two places is one pair, saying both.
  const twice = deployment('shop')
  const container = (twice.spec as { template: { spec: { containers: { env: unknown[] }[] } } })
    .template.spec.containers[0]!
  container.env.push({
    name: 'DB_USER',
    valueFrom: { secretKeyRef: { name: 'checkout-db', key: 'user' } },
  })
  expect(configPairs(twice, twice).filter((pair) => pair.left === 'checkout-db')).toEqual([
    {
      kind: 'Secret',
      left: 'checkout-db',
      right: 'checkout-db',
      said: ['env DB_PASSWORD, container api', 'env DB_USER, container api'],
    },
  ])
})

test('what either side withholds is taken out of both, and marked where it would be: never a difference', () => {
  const report = (match: string, extra: Record<string, unknown> = {}) =>
    ({
      apiVersion: 'aquasecurity.github.io/v1alpha1',
      kind: 'ExposedSecretReport',
      metadata: { name: 'r' },
      report: { secrets: [{ ruleID: 'aws', match, ...extra }, { ruleID: 'gh' }] },
    }) as unknown as KubeObject
  const withheld = [{ keys: ['report', 'secrets', 'match'] }]
  // One side's cluster withholds it, the other's not: both the same, marked, its value gone.
  const [a, b] = [report('KEY=one'), report('KEY=two')].map((object) =>
    comparable(object, { withheld }),
  )
  expect(a).toEqual(b)
  expect(JSON.stringify(a)).not.toContain('KEY=')
  expect((a!.report as { secrets: Record<string, unknown>[] }).secrets).toEqual([
    { match: WITHHELD_MARK, ruleID: 'aws' },
    { match: WITHHELD_MARK, ruleID: 'gh' },
  ])
  // What else differs still does.
  expect(comparable(report('x', { target: '/a' }), { withheld })).not.toEqual(
    comparable(report('y', { target: '/b' }), { withheld }),
  )
  // And so with everything shown.
  expect(JSON.stringify(comparable(report('KEY=one'), { withheld, noise: true }))).not.toContain(
    'KEY=',
  )
})
