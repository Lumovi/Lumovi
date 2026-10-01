import type { KubeObject } from '@shared/api'
import { kindOf } from '@shared/resources'
import type { ClusterChange } from '@renderer/hooks/change'

export { kindOf }

/** What every action dialog is given. */
export interface ActionProps {
  object: KubeObject
  onClose: () => void
}

/** "Deployment · shop", or just the kind for cluster-wide objects. */
export function subjectOf(object: KubeObject): string {
  const { namespace } = object.metadata
  return namespace ? `${object.kind} · ${namespace}` : object.kind!
}

/** The part of a change request that names `object` (cluster-wide objects have no namespace). */
export function target(object: KubeObject): Pick<ClusterChange, 'kind' | 'name' | 'namespace'> {
  return {
    kind: kindOf(object),
    name: object.metadata.name,
    namespace: object.metadata.namespace,
  }
}

/** "1 replica", "3 replicas". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** An RFC 3339 timestamp at second precision, the way kubectl writes restartedAt. */
export function nowTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
