/**
 * Helm releases, read where Helm 3 keeps them: one Secret per revision
 * (or ConfigMap, with HELM_DRIVER=configmap) labelled owner=helm, holding the
 * release as gzipped JSON. Reading them needs no helm binary.
 */
import { gunzipSync } from 'node:zlib'
import type { HelmRelease, HelmReleaseDetail, HelmRevision, KubeObject } from '@shared/api'
import { KubeRequestError } from '../kube/errors'

/** What KubeStacks reads of Helm's release record. */
export interface StoredRelease {
  name: string
  namespace: string
  version: number
  info: {
    first_deployed?: string
    last_deployed?: string
    description?: string
    status: string
    notes?: string
  }
  chart: {
    metadata: {
      name: string
      version: string
      appVersion?: string
      description?: string
      home?: string
      sources?: string[]
      dependencies?: { name: string }[]
    }
    values?: Record<string, unknown> | null
    /** values.schema.json, base64-encoded. */
    schema?: string
    templates?: { name: string; data: string }[] | null
    files?: { name: string; data: string }[] | null
  }
  config?: Record<string, unknown> | null
  manifest: string
}

type ListRaw = (path: string, labelSelector: string) => Promise<KubeObject[]>

const RELEASE_SECRET = 'helm.sh/release.v1'
/** Resources Flux's helm-controller manages carry these labels. */
const FLUX_NAME = /^\s*helm\.toolkit\.fluxcd\.io\/name: ['"]?([^'"\s]+)/m
const FLUX_NAMESPACE = /^\s*helm\.toolkit\.fluxcd\.io\/namespace: ['"]?([^'"\s]+)/m

/** A release record: base64 of gzipped JSON (in a Secret, base64-encoded once more). */
export function decodeRelease(object: KubeObject): StoredRelease {
  const stored = (object.data as { release: string }).release
  const helmEncoded = object.kind === 'Secret' ? Buffer.from(stored, 'base64').toString() : stored
  return JSON.parse(gunzipSync(Buffer.from(helmEncoded, 'base64')).toString()) as StoredRelease
}

/** Release records in a namespace (or everywhere), in both of Helm's storage drivers. */
async function records(
  list: ListRaw,
  namespace: string | undefined,
  selector: string,
): Promise<StoredRelease[]> {
  const scope = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}` : '/api/v1'
  const [secrets, configMaps] = await Promise.all([
    list(`${scope}/secrets`, selector).catch((error: unknown) => {
      if (error instanceof KubeRequestError && error.code === 'forbidden') {
        throw new KubeRequestError(
          'forbidden',
          `Helm keeps releases in Secrets, which your account can’t list${namespace ? ` in ${namespace}` : ''}. ${error.message}`,
        )
      }
      throw error
    }),
    list(`${scope}/configmaps`, selector),
  ])
  return [
    ...secrets
      .filter((s) => s.type === RELEASE_SECRET)
      .map((s) => decodeRelease({ ...s, kind: 'Secret' })),
    ...configMaps.map((c) => decodeRelease({ ...c, kind: 'ConfigMap' })),
  ]
}

function summary(release: StoredRelease): HelmRelease {
  const { metadata } = release.chart
  const fluxName = FLUX_NAME.exec(release.manifest)?.[1]
  return {
    name: release.name,
    namespace: release.namespace,
    revision: release.version,
    status: release.info.status,
    chart: metadata.name,
    chartVersion: metadata.version,
    appVersion: metadata.appVersion,
    updated: release.info.last_deployed,
    description: release.info.description,
    ...(fluxName
      ? {
          managedBy: {
            name: fluxName,
            namespace: FLUX_NAMESPACE.exec(release.manifest)?.[1] ?? release.namespace,
          },
        }
      : {}),
  }
}

/** Each release once, at its latest revision, sorted by namespace and name. */
export async function listReleases(
  list: ListRaw,
  namespace: string | undefined,
): Promise<HelmRelease[]> {
  // Superseded revisions are history: leaving them out keeps this to about one per release.
  const latest = new Map<string, StoredRelease>()
  for (const release of await records(list, namespace, 'owner=helm,status!=superseded')) {
    const key = `${release.namespace}/${release.name}`
    if ((latest.get(key)?.version ?? 0) < release.version) latest.set(key, release)
  }
  return [...latest.values()]
    .map(summary)
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

/** Every revision of a release, newest first, without the chart's templates. */
export async function releaseHistory(
  list: ListRaw,
  namespace: string,
  name: string,
): Promise<{ detail: HelmReleaseDetail; latest: StoredRelease }> {
  const revisions = (await records(list, namespace, `owner=helm,name=${name}`)).sort(
    (a, b) => b.version - a.version,
  )
  const latest = revisions[0]
  if (!latest) {
    throw new KubeRequestError('not-found', `${namespace} has no Helm release named ${name}.`)
  }
  const { metadata, values, schema } = latest.chart
  const detail: HelmReleaseDetail = {
    ...summary(latest),
    firstDeployed: latest.info.first_deployed,
    chartInfo: {
      description: metadata.description,
      home: metadata.home,
      sources: metadata.sources,
      dependencies: (metadata.dependencies ?? []).map((d) => d.name),
    },
    defaults: values ?? {},
    ...(schema ? { schema: JSON.parse(Buffer.from(schema, 'base64').toString()) } : {}),
    revisions: revisions.map((r): HelmRevision => ({
      revision: r.version,
      status: r.info.status,
      updated: r.info.last_deployed,
      chartVersion: r.chart.metadata.version,
      appVersion: r.chart.metadata.appVersion,
      description: r.info.description,
      values: r.config ?? {},
      manifest: r.manifest,
      notes: r.info.notes,
    })),
  }
  return { detail, latest }
}
