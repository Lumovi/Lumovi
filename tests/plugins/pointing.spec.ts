/**
 * What points at an object (src/renderer/src/lib/pointing.ts): what may be pointed at, for an
 * object, and the lists read to find what does, by labels. Plain data and plain functions.
 */
import { expect, test } from '../temp-folders.ts'
import type { KubeObject } from '../../src/shared/api.ts'
import type { View, ViewLink } from '../../src/shared/plugins.ts'
import {
  pointingLists,
  pointsAtOne,
  targetsOf,
  worstFirst,
  type Listed,
} from '../../src/renderer/src/lib/pointing.ts'

const object = (
  kind: string,
  name: string,
  more: { uid?: string; owner?: [string, string, string, string]; replicas?: number } = {},
): KubeObject =>
  ({
    apiVersion: kind === 'Deployment' || kind === 'ReplicaSet' ? 'apps/v1' : 'v1',
    kind,
    metadata: {
      name,
      namespace: 'shop',
      uid: more.uid ?? `uid-${name}`,
      ...(more.owner
        ? {
            ownerReferences: [
              {
                apiVersion: more.owner[0],
                kind: more.owner[1],
                name: more.owner[2],
                uid: more.owner[3],
                controller: true,
              },
            ],
          }
        : {}),
    },
    ...(more.replicas !== undefined ? { spec: { replicas: more.replicas } } : {}),
  }) as unknown as KubeObject

const VIEW = { name: 'reports', plugin: 'trivy-operator', source: 'Lumovi', kinds: [] } as View
const listed = (kind: string, labels: Listed['labels']): Listed => ({
  kind,
  view: VIEW,
  link: { name: 'Of', kind: '', objectName: '', listedThere: true } as ViewLink,
  labels,
})
const BY_LABELS = listed('VulnerabilityReport.aquasecurity.github.io', {
  name: 'trivy-operator.resource.name',
  kind: { label: 'trivy-operator.resource.kind' },
})
const NAMESPACED = (kind: string) =>
  kind === 'ClusterRole' || kind === 'Node' || kind.startsWith('Cluster') ? false : true

test('what’s pointed at: the object, its controllers up the chain, and the ReplicaSets a Deployment runs', () => {
  const web = object('Deployment', 'web')
  const sets = [
    object('ReplicaSet', 'web-new', {
      owner: ['apps/v1', 'Deployment', 'web', 'uid-web'],
      replicas: 3,
    }),
    // Kept for its history, running nothing; and another Deployment's.
    object('ReplicaSet', 'web-old', {
      owner: ['apps/v1', 'Deployment', 'web', 'uid-web'],
      replicas: 0,
    }),
    object('ReplicaSet', 'api-new', {
      owner: ['apps/v1', 'Deployment', 'api', 'uid-api'],
      replicas: 2,
    }),
  ]
  expect(targetsOf(web, undefined, sets)).toEqual([
    { kind: 'Deployment', name: 'web' },
    { kind: 'ReplicaSet', name: 'web-new' },
  ])
  // A Pod: its ReplicaSet, and that one's Deployment once it's read.
  const set = sets[0]!
  const pod = object('Pod', 'web-new-x', {
    owner: ['apps/v1', 'ReplicaSet', 'web-new', 'uid-web-new'],
  })
  expect(targetsOf(pod, undefined, [])).toEqual([
    { kind: 'Pod', name: 'web-new-x' },
    { kind: 'ReplicaSet', name: 'web-new' },
  ])
  expect(targetsOf(pod, set, [])).toEqual([
    { kind: 'Pod', name: 'web-new-x' },
    { kind: 'ReplicaSet', name: 'web-new' },
    { kind: 'Deployment', name: 'web' },
  ])
  // A Job's Pod: the Job, and its CronJob (what Trivy reports on). An owner read that isn't the
  // controller (another of that name, since) says nothing.
  const job = object('Job', 'nightly-1', {
    owner: ['batch/v1', 'CronJob', 'nightly', 'uid-nightly'],
  })
  const jobPod = object('Pod', 'nightly-1-x', {
    owner: ['batch/v1', 'Job', 'nightly-1', 'uid-nightly-1'],
  })
  expect(targetsOf(jobPod, job, []).map(({ kind }) => kind)).toEqual(['Pod', 'Job', 'CronJob'])
  expect(targetsOf(jobPod, object('Job', 'nightly-1', { uid: 'other' }), [])).toHaveLength(2)
  // Nothing controls it: itself alone.
  expect(targetsOf(object('Pod', 'lonely'), undefined, [])).toEqual([
    { kind: 'Pod', name: 'lonely' },
  ])
})

test('what points is read by labels, in the namespace of what it points at, for what its link can name', () => {
  const targets = [
    { kind: 'Deployment', name: 'web' },
    { kind: 'ReplicaSet', name: 'web-new' },
    // No label holds a name that long: it's never asked for.
    { kind: 'ReplicaSet', name: 'x'.repeat(64) },
  ]
  const [list] = pointingLists([BY_LABELS], targets, 'shop', NAMESPACED)
  expect(list).toMatchObject({
    namespace: 'shop',
    labelSelector:
      'trivy-operator.resource.name in (web,web-new),trivy-operator.resource.kind in (Deployment,ReplicaSet)',
    targets: targets.slice(0, 2),
  })
  // It's one of them only by its kind and its name together.
  const report = (kind: string, name: string) =>
    ({
      metadata: {
        name: 'r',
        labels: { 'trivy-operator.resource.kind': kind, 'trivy-operator.resource.name': name },
      },
    }) as unknown as KubeObject
  expect(pointsAtOne(report('ReplicaSet', 'web-new'), list!)).toBe(true)
  expect(pointsAtOne(report('ReplicaSet', 'web'), list!)).toBe(false)
  expect(pointsAtOne({ metadata: { name: 'r' } } as KubeObject, list!)).toBe(false)

  // A kind written out: only for that kind, by the name's label alone.
  const written = listed('Certificate.cert-manager.io', {
    name: 'cert-manager.io/certificate-name',
    kind: { written: 'ReplicaSet' },
  })
  const [byName] = pointingLists([written], targets, 'shop', NAMESPACED)
  expect(byName!.labelSelector).toBe('cert-manager.io/certificate-name in (web-new)')
  expect(
    pointsAtOne(
      {
        metadata: { name: 'c', labels: { 'cert-manager.io/certificate-name': 'web-new' } },
      } as unknown as KubeObject,
      byName!,
    ),
  ).toBe(true)
  expect(pointingLists([written], [{ kind: 'Pod', name: 'p' }], 'shop', NAMESPACED)).toEqual([])

  // What isn't served isn't read; nor a kind without namespaces, for what's in one.
  expect(pointingLists([BY_LABELS], targets, 'shop', () => undefined)).toEqual([])
  const clusterWide = listed('ClusterRbacAssessmentReport.aquasecurity.github.io', BY_LABELS.labels)
  expect(pointingLists([clusterWide], targets, 'shop', NAMESPACED)).toEqual([])
  // What's pointed at without a namespace: what points there is read anywhere.
  const [role] = pointingLists(
    [clusterWide],
    [{ kind: 'ClusterRole', name: 'admin' }],
    undefined,
    NAMESPACED,
  )
  expect(role).toMatchObject({ namespace: null })
})

test('worst first, the same whatever order they came in: health, the larger number, then the name', () => {
  const row = (name: string, health?: 'critical' | 'warning' | 'healthy', label = '') => ({
    name,
    status: health ? { health, label } : null,
  })
  const rows = [
    row('d', 'healthy', 'No critical or high'),
    row('c', 'critical', '2 critical'),
    row('none'),
    row('b', 'warning', '1 high'),
    row('a', 'critical', '9 critical'),
    row('z', 'critical', 'Critical findings'),
    row('y', 'critical', 'Critical findings'),
    row('e', 'critical', '10 critical'),
  ]
  const order = (each: typeof rows) => [...each].sort(worstFirst).map(({ name }) => name)
  expect(order(rows)).toEqual(['e', 'a', 'c', 'y', 'z', 'b', 'd', 'none'])
  expect(order([...rows].reverse())).toEqual(order(rows))
})
