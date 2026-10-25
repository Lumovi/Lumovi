/**
 * What plugins' objects say of each workload (src/renderer/src/lib/findings.ts): by the labels a
 * counting link reads, what's wrong only, worst first, and a Deployment's by the ReplicaSets it
 * runs. Plain data and plain functions.
 */
import { expect, test } from '../temp-folders.ts'
import type { KubeObject } from '../../src/shared/api.ts'
import type { View, ViewLink } from '../../src/shared/plugins.ts'
import { indexFindings } from '../../src/renderer/src/lib/findings.ts'
import type { Listed } from '../../src/renderer/src/lib/pointing.ts'

const KIND = 'trivy-operator.resource.kind'
const NAME = 'trivy-operator.resource.name'
const VIEW = {
  name: 'vulnerabilities',
  plugin: 'trivy-operator',
  source: 'Lumovi',
  kinds: ['VulnerabilityReport.aquasecurity.github.io'],
  status: [
    {
      when: { path: '.critical', notEquals: 0 },
      health: 'critical',
      label: '{{ .critical }} critical',
    },
    { when: { path: '.high', notEquals: 0 }, health: 'warning', label: '{{ .high }} high' },
    { health: 'healthy', label: 'No critical or high' },
  ],
} as unknown as View
const LISTED: Listed = {
  kind: 'VulnerabilityReport.aquasecurity.github.io',
  view: VIEW,
  link: {
    name: 'Workload',
    kind: '',
    objectName: '',
    listedThere: true,
    counts: true,
    about: "the {{ .metadata.labels['trivy-operator.container.name'] }} container",
  } as ViewLink,
  labels: { name: NAME, kind: { label: KIND } },
}

const report = (
  name: string,
  of: [string, string, string?],
  counts: { critical: number; high: number },
  namespace = 'shop',
) =>
  ({
    metadata: {
      name,
      namespace,
      uid: `uid-${name}`,
      labels: {
        [KIND]: of[0],
        [NAME]: of[1],
        ...(of[2] ? { 'trivy-operator.container.name': of[2] } : {}),
      },
    },
    ...counts,
  }) as unknown as KubeObject

const workload = (kind: string, name: string, uid = `uid-${name}`) =>
  ({ kind, metadata: { name, namespace: 'shop', uid } }) as unknown as KubeObject
const replicaSet = (name: string, deployment: string, replicas: number, namespace = 'shop') =>
  ({
    kind: 'ReplicaSet',
    metadata: {
      name,
      namespace,
      uid: `uid-${name}`,
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: deployment,
          uid: `uid-${deployment}`,
          controller: true,
        },
      ],
    },
    spec: { replicas },
  }) as unknown as KubeObject

test('a workload’s findings: what’s wrong, worst first, and a Deployment’s by the ReplicaSets it runs', () => {
  const findings = indexFindings(
    [
      {
        listed: LISTED,
        items: [
          report('rs-web-new-api', ['ReplicaSet', 'web-new', 'api'], { critical: 2, high: 0 }),
          report('rs-web-new-sidecar', ['ReplicaSet', 'web-new', 'sidecar'], {
            critical: 9,
            high: 1,
          }),
          report('rs-web-new-proxy', ['ReplicaSet', 'web-new'], { critical: 0, high: 3 }),
          // Fine: not said.
          report('rs-web-new-clean', ['ReplicaSet', 'web-new', 'clean'], { critical: 0, high: 0 }),
          // The ReplicaSet it ran before, running nothing; another namespace's of that name.
          report('rs-web-old-api', ['ReplicaSet', 'web-old', 'api'], { critical: 5, high: 0 }),
          report(
            'rs-web-new-elsewhere',
            ['ReplicaSet', 'web-new', 'api'],
            { critical: 7, high: 0 },
            'other',
          ),
          // Of the StatefulSet itself; one with no kind said.
          report('sts-db', ['StatefulSet', 'db', 'postgres'], { critical: 0, high: 2 }),
          // Of shop's ReplicaSet of that other set's name, which web doesn't run.
          report('rs-x-1', ['ReplicaSet', 'x-1', 'x'], { critical: 3, high: 0 }),
          {
            metadata: { name: 'nameless', namespace: 'shop', labels: { [NAME]: 'db' } },
            critical: 4,
          } as unknown as KubeObject,
        ],
      },
    ],
    [
      replicaSet('web-new', 'web', 3),
      replicaSet('web-old', 'web', 0),
      // Another namespace's, naming web's uid as its owner: no Deployment of shop's.
      replicaSet('x-1', 'web', 1, 'elsewhere'),
    ],
  )
  const said = (object: KubeObject) =>
    findings
      .of(object, object.kind!)
      .map((f) => `${f.status.label}${f.about ? `, ${f.about}` : ''}`)
  expect(said(workload('Deployment', 'web'))).toEqual([
    '9 critical, the sidecar container',
    '2 critical, the api container',
    '3 high',
  ])
  expect(said(workload('StatefulSet', 'db'))).toEqual(['2 high, the postgres container'])
  // Its ReplicaSet itself; nothing of a workload nothing counts against, or a Deployment of
  // another uid.
  expect(said(workload('ReplicaSet', 'web-new'))).toHaveLength(3)
  expect(said(workload('Deployment', 'cart'))).toEqual([])
  expect(said(workload('Deployment', 'web', 'another-uid'))).toEqual([])
})

test('a link that writes its kind out counts only against that kind, by its name’s label', () => {
  const findings = indexFindings(
    [
      {
        listed: { ...LISTED, labels: { name: NAME, kind: { written: 'Deployment' } } },
        items: [report('policy', ['ignored', 'web'], { critical: 1, high: 0 })],
      },
    ],
    [],
  )
  expect(findings.of(workload('Deployment', 'web'), 'Deployment')).toHaveLength(1)
  expect(findings.of(workload('StatefulSet', 'web'), 'StatefulSet')).toHaveLength(0)
})
