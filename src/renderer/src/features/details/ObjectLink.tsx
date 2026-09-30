import { useSearchParams } from 'react-router'
import { isResourceKind } from '@shared/resources'
import { formatRef } from '@renderer/lib/routes'

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
  const [, setParams] = useSearchParams()
  const label = `${kind}/${name}`
  if (!isResourceKind(kind)) return <span className="font-mono text-xs text-ink-2">{label}</span>
  return (
    <button
      type="button"
      onClick={() => setParams({ open: formatRef({ kind, name, namespace }) })}
      className="font-mono text-xs text-accent-strong hover:underline"
    >
      {label}
    </button>
  )
}
