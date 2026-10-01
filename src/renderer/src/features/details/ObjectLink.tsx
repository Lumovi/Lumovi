import { apiKindOf, isBuiltinKind, kindFor } from '@shared/resources'
import { useOpenObject } from '@renderer/hooks/open-object'
import { resourceFor, useResources } from '@renderer/hooks/resources'

/**
 * Another object (an owner, an event's subject, a view's link), opened in the
 * detail panel. References name an apiVersion and kind, which identify any
 * kind; without an apiVersion, `kind` is how KubeStacks names the kind
 * ("Secret", "ClusterIssuer.cert-manager.io"). Only kinds the cluster serves open.
 */
export function ObjectLink({
  apiVersion,
  kind,
  name,
  namespace,
}: {
  apiVersion?: string
  kind: string
  name: string
  namespace?: string
}) {
  const open = useOpenObject()
  // Re-renders once discovery says which kinds the cluster serves.
  useResources()
  const target = apiVersion ? kindFor(apiVersion, kind) : kind
  const label = `${apiKindOf(target)}/${name}`
  if (!isBuiltinKind(target) && !resourceFor(target)) {
    return <span className="font-mono text-xs text-ink-2">{label}</span>
  }
  return (
    <button
      type="button"
      onClick={() => open(target, name, namespace)}
      className="font-mono text-xs text-accent-strong hover:underline"
    >
      {label}
    </button>
  )
}
