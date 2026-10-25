/**
 * Trivy's reports of exposed secrets, for the tests of what Lumovi withholds: its
 * ExposedSecretReport CRD and reports of it, whose `report.secrets[].match` is the line around a
 * secret it found. Put in a cluster by a test (`scanned`), and undone by its reset.
 */
import type { MockCluster } from '../server.ts'
import type { KubeObject } from '../types.ts'

/** What Trivy found: never anywhere Lumovi puts anything. */
export const SECRET = 'AKIAWITHHELD7EXAMPLE'
export const KIND = 'ExposedSecretReport.aquasecurity.github.io'
export const REPORT = 'replicaset-storefront-6d4f9b-storefront'
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/**
 * Trivy's ExposedSecretReport CRD (v0.34.0, its fields as Lumovi-plugins keeps them), with one
 * column more than Trivy's: one that shows the first match, as any CRD's column could.
 */
export const CRD = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: {
    name: 'exposedsecretreports.aquasecurity.github.io',
    uid: 'crd-exposedsecretreports',
    creationTimestamp: '2026-10-01T00:00:00Z',
  },
  spec: {
    group: 'aquasecurity.github.io',
    names: {
      kind: 'ExposedSecretReport',
      listKind: 'ExposedSecretReportList',
      plural: 'exposedsecretreports',
      singular: 'exposedsecretreport',
      shortNames: ['exposedsecret', 'exposedsecrets'],
    },
    scope: 'Namespaced',
    versions: [
      {
        name: 'v1alpha1',
        served: true,
        storage: true,
        additionalPrinterColumns: [
          { name: 'Repository', type: 'string', jsonPath: '.report.artifact.repository' },
          { name: 'Scanner', type: 'string', jsonPath: '.report.scanner.name' },
          { name: 'High', type: 'integer', jsonPath: '.report.summary.highCount' },
          { name: 'First match', type: 'string', jsonPath: '.report.secrets[0].match' },
        ],
        schema: {
          openAPIV3Schema: {
            type: 'object',
            properties: {
              report: {
                type: 'object',
                properties: {
                  artifact: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                  scanner: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                  summary: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                  secrets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: Object.fromEntries(
                        ['target', 'ruleID', 'title', 'category', 'severity', 'match'].map(
                          (field) => [field, { type: 'string' }],
                        ),
                      ),
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
  status: { acceptedNames: { kind: 'ExposedSecretReport', plural: 'exposedsecretreports' } },
} as unknown as KubeObject

/** One finding, as Trivy writes it: the match is the line, the secret starred out but for ours. */
export const finding = (i: number, secret = SECRET) => ({
  target: '/app/.env',
  ruleID: 'aws-access-key-id',
  title: 'AWS Access Key ID',
  category: 'AWS',
  severity: 'CRITICAL',
  match: `AWS_ACCESS_KEY_ID=${secret}-${i}`,
})

/** A report of `secrets` in shop, kept by kubectl's annotation too (which holds every field). */
export function report(name: string, secrets: unknown[]): KubeObject {
  const object = {
    apiVersion: 'aquasecurity.github.io/v1alpha1',
    kind: 'ExposedSecretReport',
    metadata: {
      name,
      namespace: 'shop',
      uid: `uid-${name}`,
      creationTimestamp: '2026-10-15T08:00:00Z',
      labels: { 'trivy-operator.resource.name': 'storefront' },
    },
    report: {
      artifact: { repository: 'shop/storefront', tag: '1.4.2' },
      scanner: { name: 'Trivy', vendor: 'Aqua Security', version: '0.56.0' },
      summary: { criticalCount: secrets.length, highCount: 0, mediumCount: 0, lowCount: 0 },
      secrets,
    },
  }
  return {
    ...object,
    metadata: {
      ...object.metadata,
      annotations: { [LAST_APPLIED]: JSON.stringify(object) },
    },
  } as unknown as KubeObject
}

/**
 * The CRD of another of Trivy's namespaced reports (`VulnerabilityReport`, say), its report
 * preserved as Trivy writes it.
 */
export function reportCrd(kind: string): KubeObject {
  const plural = `${kind.toLowerCase()}s`
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${plural}.aquasecurity.github.io`,
      uid: `crd-${plural}`,
      creationTimestamp: '2026-10-01T00:00:00Z',
    },
    spec: {
      group: 'aquasecurity.github.io',
      names: { kind, listKind: `${kind}List`, plural, singular: kind.toLowerCase() },
      scope: 'Namespaced',
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                report: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
              },
            },
          },
        },
      ],
    },
    status: { acceptedNames: { kind, plural } },
  } as unknown as KubeObject
}

/** Trivy's CRD and a report of two findings, in the demo cluster (undone after each test). */
export function scanned(cluster: MockCluster) {
  cluster.upsert(CRD)
  cluster.upsert(report(REPORT, [finding(1), finding(2)]))
}
