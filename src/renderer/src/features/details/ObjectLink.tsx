import { apiKindOf, isBuiltinKind, kindFor } from '@shared/resources'
import { cn } from '@renderer/lib/cn'
import { useOpenObject } from '@renderer/hooks/open-object'
import { resourceFor, useResources } from '@renderer/hooks/resources'

/**
 * Another object (an owner, an event's subject, a view's link), opened in the
 * detail panel. References name an apiVersion and kind, which identify any
 * kind; without an apiVersion, `kind` is how Lumovi names the kind
 * ("Secret", "ClusterIssuer.cert-manager.io"). Only kinds the cluster serves open.
 */
export function ObjectLink({
  apiVersion,
  kind,
  name,
  namespace,
  inText = false,
}: {
  apiVersion?: string
  kind: string
  name: string
  namespace?: string
  /** One of several in a sentence: under a finger its reach is its line, not a finger's height. */
  inText?: boolean
}) {
  const open = useOpenObject()
  // Re-renders once discovery says which kinds the cluster serves.
  useResources()
  const target = apiVersion ? kindFor(apiVersion, kind) : kind
  // Where it's too long for its place, it breaks after its kind first: the kind stays whole.
  const label = (
    <>
      {apiKindOf(target)}/<wbr />
      {name}
    </>
  )
  if (!isBuiltinKind(target) && !resourceFor(target)) {
    return <span className="font-mono text-xs wrap-anywhere text-ink-2">{label}</span>
  }
  return (
    <button
      type="button"
      onClick={() => open(target, name, namespace)}
      data-in-text={inText || undefined}
      className={cn(
        'text-left font-mono text-xs wrap-anywhere text-accent-strong hover:underline',
        inText
          ? 'touch:relative touch:before:absolute touch:before:inset-x-0 touch:before:-inset-y-1'
          : 'touch:finger',
      )}
    >
      {label}
    </button>
  )
}
