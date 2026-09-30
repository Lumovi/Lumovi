import type { NavTarget } from '@shared/navigation'
import type { ResourceKind } from '@shared/resources'
import { resourceByKind } from '@shared/resources'

export function clusterPath(context: string): string {
  return `/cluster/${encodeURIComponent(context)}`
}

export function kindPath(context: string, kind: ResourceKind): string {
  return `${clusterPath(context)}/${resourceByKind(kind).plural}`
}

/** The route for the overview or a resource list. */
export function targetPath(context: string, target: NavTarget): string {
  return target === 'overview' ? clusterPath(context) : kindPath(context, target)
}

export interface ObjectRef {
  kind: ResourceKind
  name: string
  namespace?: string
}

/** Serialises an object reference for the `?open=` search param: `Kind/namespace/name`. */
export function formatRef({ kind, name, namespace = '' }: ObjectRef): string {
  return `${kind}/${namespace}/${name}`
}

export function parseRef(value: string): ObjectRef {
  const [kind, namespace, name] = value.split('/') as [ResourceKind, string, string]
  return { kind, name, namespace: namespace || undefined }
}
