/**
 * Helm releases for the demo cluster, stored the way Helm 3 and 4 store them:
 * a Secret per revision (type helm.sh/release.v1, labelled owner=helm) whose
 * `release` key holds the release as base64 of gzipped JSON — or, for the
 * configmap driver, a ConfigMap. Their manifests name objects in the demo.
 */
import { gzipSync } from 'node:zlib'
import { DAY, HOUR, MINUTE, type clusterBuilder } from '../builders.ts'
import type { Json } from '../types.ts'

type Builder = ReturnType<typeof clusterBuilder>

export const HELM = {
  storefront: 'storefront',
  redis: 'redis',
  metricsServer: 'metrics-server',
  grafana: 'grafana',
  podinfo: 'podinfo',
  reports: 'nightly-reports',
  dashboards: 'old-dashboards',
} as const

/** What Helm writes: base64 of the gzipped release JSON. */
export function encodeRelease(release: Json): string {
  return gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')
}

const b64 = (text: string) => Buffer.from(text).toString('base64')

interface Revision {
  revision: number
  status: string
  ago: number
  chartVersion: string
  appVersion?: string
  description: string
  values: Json | null
  manifest: string
  notes?: string
}

interface ReleaseSpec {
  name: string
  namespace: string
  driver?: 'secret' | 'configmap'
  chart: {
    name: string
    description?: string
    home?: string
    dependencies?: string[]
    values?: Json | null
    schema?: Json
    templates?: Record<string, string>
    files?: Record<string, string>
  }
  revisions: Revision[]
}

const at = (now: number, ago: number) => new Date(now - ago).toISOString()

/** A release record as Helm keeps it. */
export function releaseRecord(spec: ReleaseSpec, revision: Revision, now: number): Json {
  const first = spec.revisions[0]!
  return {
    name: spec.name,
    namespace: spec.namespace,
    version: revision.revision,
    info: {
      first_deployed: at(now, first.ago),
      last_deployed: at(now, revision.ago),
      deleted: '',
      description: revision.description,
      status: revision.status,
      ...(revision.notes ? { notes: revision.notes } : {}),
    },
    chart: {
      metadata: {
        apiVersion: 'v2',
        name: spec.chart.name,
        version: revision.chartVersion,
        ...(revision.appVersion ? { appVersion: revision.appVersion } : {}),
        ...(spec.chart.description ? { description: spec.chart.description } : {}),
        ...(spec.chart.home ? { home: spec.chart.home, sources: [spec.chart.home] } : {}),
        type: 'application',
        ...(spec.chart.dependencies
          ? {
              dependencies: spec.chart.dependencies.map((name) => ({
                name,
                version: '2.x.x',
                repository: 'oci://registry-1.docker.io/bitnamicharts',
              })),
            }
          : {}),
      },
      lock: null,
      // Helm writes null for a chart without templates or files.
      templates: spec.chart.templates
        ? Object.entries(spec.chart.templates).map(([name, data]) => ({ name, data: b64(data) }))
        : null,
      values: spec.chart.values === undefined ? {} : spec.chart.values,
      ...(spec.chart.schema ? { schema: b64(JSON.stringify(spec.chart.schema)) } : {}),
      files: spec.chart.files
        ? Object.entries(spec.chart.files).map(([name, data]) => ({ name, data: b64(data) }))
        : null,
    },
    config: revision.values,
    manifest: revision.manifest,
    hooks: [],
  }
}

function release(b: Builder, now: number, spec: ReleaseSpec): void {
  for (const revision of spec.revisions) {
    const labels = {
      name: spec.name,
      owner: 'helm',
      status: revision.status,
      version: String(revision.revision),
      modifiedAt: String(Math.floor((now - revision.ago) / 1000)),
    }
    const stored = encodeRelease(releaseRecord(spec, revision, now))
    const name = `sh.helm.release.v1.${spec.name}.v${revision.revision}`
    if (spec.driver === 'configmap') {
      b.simple(
        'v1',
        'ConfigMap',
        name,
        spec.namespace,
        revision.ago,
        { data: { release: stored } },
        { labels },
      )
    } else {
      b.simple(
        'v1',
        'Secret',
        name,
        spec.namespace,
        revision.ago,
        { type: 'helm.sh/release.v1', data: { release: b64(stored) } },
        { labels },
      )
    }
  }
}

const source = (template: string, body: string) => `---\n# Source: ${template}\n${body.trim()}\n`

/** The storefront chart's templates, kept with each release: it has no subcharts. */
const STOREFRONT_TEMPLATES = {
  'templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`,
  'templates/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
`,
  'templates/NOTES.txt': `The storefront is at https://{{ .Values.host }}.
`,
}

function storefrontManifest(tag: string, replicas: number): string {
  return [
    source(
      'storefront/templates/configmap.yaml',
      `apiVersion: v1
kind: ConfigMap
metadata:
  name: storefront-config
data:
  LOG_LEVEL: info`,
    ),
    source(
      'storefront/templates/service.yaml',
      `apiVersion: v1
kind: Service
metadata:
  name: storefront
spec:
  ports:
    - port: 80
      targetPort: http`,
    ),
    source(
      'storefront/templates/deployment.yaml',
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
spec:
  replicas: ${replicas}
  template:
    spec:
      containers:
        - name: app
          image: ghcr.io/acme/storefront:${tag}`,
    ),
    source(
      'storefront/templates/hpa.yaml',
      `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: storefront`,
    ),
    source(
      'storefront/templates/serviceaccount.yaml',
      `apiVersion: v1
kind: ServiceAccount
metadata:
  name: storefront`,
    ),
    // Deleted by hand since: the release still lists it.
    source(
      'storefront/templates/flags.yaml',
      `apiVersion: v1
kind: ConfigMap
metadata:
  name: storefront-feature-flags`,
    ),
  ].join('')
}

/** The demo cluster's Helm releases, in every state. */
export function demoHelmReleases(b: Builder, now: number): void {
  release(b, now, {
    name: HELM.storefront,
    namespace: 'shop',
    chart: {
      name: 'storefront',
      description: 'The Acme shop’s web frontend.',
      home: 'https://github.com/acme/storefront',
      values: {
        replicaCount: 2,
        image: { repository: 'ghcr.io/acme/storefront', tag: 'latest', pullPolicy: 'IfNotPresent' },
        host: 'shop.example.com',
        resources: { requests: { cpu: '100m', memory: '128Mi' } },
      },
      schema: {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { replicaCount: { type: 'integer', minimum: 1 } },
      },
      templates: STOREFRONT_TEMPLATES,
      files: { 'README.md': '# storefront\n' },
    },
    revisions: [
      {
        revision: 1,
        status: 'superseded',
        ago: 60 * DAY,
        chartVersion: '2.3.0',
        appVersion: '3.8.0',
        description: 'Install complete',
        values: { image: { tag: 'v3.8.0' } },
        manifest: storefrontManifest('v3.8.0', 2),
      },
      {
        revision: 2,
        status: 'superseded',
        ago: 20 * DAY,
        chartVersion: '2.4.0',
        appVersion: '3.9.0',
        description: 'Upgrade complete',
        values: { image: { tag: 'v3.9.0' }, replicaCount: 3 },
        manifest: storefrontManifest('v3.9.0', 3),
      },
      {
        revision: 3,
        status: 'deployed',
        ago: 2 * DAY,
        chartVersion: '2.4.1',
        appVersion: '3.9.1',
        description: 'Upgrade complete',
        values: { image: { tag: 'v3.9.1' }, replicaCount: 3, host: 'www.shop.example.com' },
        manifest: storefrontManifest('v3.9.1', 3),
        notes: 'The storefront is at https://www.shop.example.com.\n',
      },
    ],
  })

  // Its last upgrade failed; the revision before it still runs.
  const redis = (tag: string) =>
    [
      source(
        'redis/templates/master/application.yaml',
        `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  template:
    spec:
      containers:
        - name: redis
          image: docker.io/bitnami/redis:${tag}`,
      ),
      source(
        'redis/templates/master/service.yaml',
        `apiVersion: v1
kind: Service
metadata:
  name: redis`,
      ),
    ].join('')
  release(b, now, {
    name: HELM.redis,
    namespace: 'data',
    chart: {
      name: 'redis',
      description: 'Redis(R) is an open source, advanced key-value store.',
      home: 'https://bitnami.com',
      dependencies: ['common'],
      values: { architecture: 'replication', auth: { enabled: true } },
    },
    revisions: [
      ...(
        [
          ['superseded', 90 * DAY, '19.5.0'],
          ['superseded', 40 * DAY, '19.6.0'],
          ['deployed', 9 * DAY, '19.6.1'],
        ] as const
      ).map(([status, ago, chartVersion], i): Revision => ({
        revision: i + 1,
        status,
        ago,
        chartVersion,
        appVersion: '7.2.5',
        description: i === 0 ? 'Install complete' : 'Upgrade complete',
        values: { architecture: 'standalone' },
        manifest: redis('7.2.5'),
      })),
      {
        revision: 4,
        status: 'failed',
        ago: 3 * HOUR,
        chartVersion: '19.6.2',
        appVersion: '7.4.0',
        description:
          "Upgrade \"redis\" failed: cannot patch \"redis\" with kind StatefulSet: StatefulSet.apps \"redis\" is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden",
        values: { architecture: 'standalone', master: { persistence: { size: '20Gi' } } },
        manifest: redis('7.4.0'),
      },
    ],
  })

  // Installed without values of its own.
  release(b, now, {
    name: HELM.metricsServer,
    namespace: 'kube-system',
    chart: {
      name: 'metrics-server',
      description: 'Metrics Server is a scalable, efficient source of container resource metrics.',
      values: { args: [], replicas: 1 },
    },
    revisions: [
      {
        revision: 1,
        status: 'deployed',
        ago: 300 * DAY,
        chartVersion: '3.12.2',
        appVersion: '0.7.2',
        description: 'Install complete',
        values: null,
        manifest: [
          source(
            'metrics-server/templates/deployment.yaml',
            `apiVersion: apps/v1
kind: Deployment
metadata:
  name: metrics-server
  namespace: kube-system`,
          ),
          source(
            'metrics-server/templates/service.yaml',
            `apiVersion: v1
kind: Service
metadata:
  name: metrics-server
  namespace: kube-system`,
          ),
          source(
            'metrics-server/templates/clusterrole.yaml',
            `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: view`,
          ),
        ].join(''),
      },
    ],
  })

  // An upgrade that never finished, of a chart without default values.
  const grafana = (tag: string) =>
    source(
      'grafana/templates/deployment.yaml',
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
spec:
  template:
    spec:
      containers:
        - name: grafana
          image: grafana/grafana:${tag}`,
    )
  release(b, now, {
    name: HELM.grafana,
    namespace: 'monitoring',
    chart: { name: 'grafana', values: null },
    revisions: [
      {
        revision: 1,
        status: 'superseded',
        ago: 100 * DAY,
        chartVersion: '8.4.0',
        appVersion: '11.1.0',
        description: 'Install complete',
        values: { adminUser: 'admin' },
        manifest: grafana('11.1.0'),
      },
      {
        revision: 2,
        status: 'pending-upgrade',
        ago: 25 * MINUTE,
        chartVersion: '8.5.1',
        appVersion: '11.2.0',
        description: 'Preparing upgrade',
        // null takes a default away.
        values: { adminUser: 'admin', sidecar: null },
        manifest: grafana('11.2.0'),
      },
    ],
  })

  // Flux's helm-controller installed it, and labels what it made.
  release(b, now, {
    name: HELM.podinfo,
    namespace: 'flux-system',
    chart: { name: 'podinfo', values: { replicaCount: 1 } },
    revisions: [
      {
        revision: 1,
        status: 'deployed',
        ago: 30 * DAY,
        chartVersion: '6.7.1',
        appVersion: '6.7.1',
        description: 'Install complete',
        values: { replicaCount: 2 },
        manifest: source(
          'podinfo/templates/deployment.yaml',
          `apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  labels:
    helm.toolkit.fluxcd.io/name: podinfo
    helm.toolkit.fluxcd.io/namespace: flux-system`,
        ),
      },
    ],
  })

  // Stored with HELM_DRIVER=configmap.
  release(b, now, {
    name: HELM.reports,
    namespace: 'batch',
    driver: 'configmap',
    chart: { name: 'cronjobs', values: {} },
    revisions: [
      {
        revision: 1,
        status: 'deployed',
        ago: 50 * DAY,
        chartVersion: '0.3.0',
        description: 'Install complete',
        values: { schedule: '0 2 * * *' },
        manifest: source(
          'cronjobs/templates/cronjob.yaml',
          `apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report`,
        ),
      },
    ],
  })

  // Uninstalled with --keep-history: only its history is left.
  release(b, now, {
    name: HELM.dashboards,
    namespace: 'monitoring',
    chart: { name: 'dashboards', values: {} },
    revisions: [
      {
        revision: 1,
        status: 'uninstalled',
        ago: 10 * DAY,
        chartVersion: '1.0.0',
        description: 'Uninstallation complete',
        values: {},
        manifest: '',
      },
    ],
  })
}
