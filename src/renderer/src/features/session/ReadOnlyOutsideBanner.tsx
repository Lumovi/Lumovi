import { ShieldAlert } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { useReadOnly } from '@renderer/hooks/settings'
import { formatDateTime } from '@renderer/lib/format'
import { useCluster } from '@renderer/state/cluster'

const NAMED = { metricsSource: 'metrics source', nodeShell: 'node shells' } as const

/**
 * For those who may set it: this cluster's settings were changed where the server keeps them,
 * outside Lumovi (by whoever can write there), and Lumovi kept the stricter. Shown on every
 * replica until one of them sets read-only again, either way: then it's their choice, recorded
 * as theirs. The buttons say what it is now.
 */
export function ReadOnlyOutsideBanner() {
  const { context } = useCluster()
  const readOnly = useReadOnly()
  const outside = readOnly.outside
  if (!outside || !readOnly.mayChange) return null
  const others = outside.restored.map((key) => NAMED[key]).join(' and ')
  return (
    <section
      aria-label="Changed outside Lumovi"
      className="flex shrink-0 animate-fade-in items-center gap-3 border-b border-critical/25 bg-critical/8 px-5 py-2 text-[13px]"
    >
      <ShieldAlert className="size-4 shrink-0 text-critical-text" />
      <span className="min-w-0 flex-1 text-ink-1">
        <span className="font-medium">
          {outside.readOnly === 'restored'
            ? `${context}’s read-only was turned off outside Lumovi, and Lumovi made it read-only again.`
            : outside.readOnly === 'made'
              ? `${context} was made read-only outside Lumovi.`
              : `What’s set for ${context} was changed outside Lumovi, and Lumovi put it back.`}
        </span>{' '}
        <span className="text-ink-2">
          On {formatDateTime(outside.at)},{' '}
          {outside.how === 'deleted'
            ? 'its setting was deleted'
            : 'an older copy of its setting was put back'}{' '}
          where Lumovi keeps it, by whoever can write there.
          {others &&
            ` Lumovi put back its ${others} as it last set ${outside.restored.join() === 'metricsSource' ? 'it' : 'them'}.`}{' '}
          It’s in the audit log.
        </span>
      </span>
      {readOnly.readOnly ? (
        <>
          <Button variant="secondary" onClick={() => void readOnly.set(false)}>
            Allow changes
          </Button>
          <Button variant="primary" onClick={() => void readOnly.set(true)}>
            Keep it read-only
          </Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={() => void readOnly.set(true)}>
            Make it read-only
          </Button>
          <Button variant="primary" onClick={() => void readOnly.set(false)}>
            Keep it changeable
          </Button>
        </>
      )}
    </section>
  )
}
