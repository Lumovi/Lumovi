import { isResourceKind } from '@shared/resources'
import { useOpenObject } from '@renderer/hooks/open-object'

/** A reference to another object; opens it in the detail panel when KubeStacks knows the kind. */
export function ObjectLink({
  kind,
  name,
  namespace,
}: {
  kind: string
  name: string
  namespace?: string
}) {
  const open = useOpenObject()
  const label = `${kind}/${name}`
  if (!isResourceKind(kind)) return <span className="font-mono text-xs text-ink-2">{label}</span>
  return (
    <button
      type="button"
      onClick={() => open(kind, name, namespace)}
      className="font-mono text-xs text-accent-strong hover:underline"
    >
      {label}
    </button>
  )
}
