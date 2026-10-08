import { ShieldAlert } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { useReadOnly } from '@renderer/hooks/settings'
import { formatDateTime } from '@renderer/lib/format'
import { useCluster } from '@renderer/state/cluster'

/**
 * For those who may set it: this cluster's read-only was changed where the server keeps it,
 * outside Lumovi (by whoever can write there). It stays until one of them sets it again, either
 * way: then it's their choice, recorded as theirs.
 */
export function ReadOnlyOutsideBanner() {
  const { context } = useCluster()
  const readOnly = useReadOnly()
  const outside = readOnly.outside
  if (!outside || !readOnly.mayChange) return null
  return (
    <section
      aria-label="Changed outside Lumovi"
      className="flex shrink-0 animate-fade-in items-center gap-3 border-b border-critical/25 bg-critical/8 px-5 py-2 text-[13px]"
    >
      <ShieldAlert className="size-4 shrink-0 text-critical-text" />
      <span className="min-w-0 flex-1 text-ink-1">
        <span className="font-medium">
          {outside.readOnly
            ? `${context} was made read-only outside Lumovi.`
            : `${context} is no longer read-only: it was changed outside Lumovi.`}
        </span>{' '}
        <span className="text-ink-2">
          On {formatDateTime(outside.at)},{' '}
          {outside.how === 'deleted'
            ? 'its setting was deleted'
            : 'an older copy of its setting was put back'}{' '}
          where Lumovi keeps it, by whoever can write there. It’s in the audit log.
        </span>
      </span>
      <Button variant="secondary" onClick={() => void readOnly.set(outside.readOnly)}>
        {outside.readOnly ? 'Keep it read-only' : 'Keep it changeable'}
      </Button>
      <Button variant="primary" onClick={() => void readOnly.set(!outside.readOnly)}>
        {outside.readOnly ? 'Allow changes' : 'Make it read-only again'}
      </Button>
    </section>
  )
}
