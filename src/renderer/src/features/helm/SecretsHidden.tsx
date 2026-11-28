import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { Hidden } from '@renderer/lib/helm-diff'

/** What's hidden of a manifest, said: its Secrets' values, its documents hidden whole, or both. */
export function hiddenSaid({ values, documents }: Hidden): string {
  if (documents === 0) return 'Secrets’ values hidden'
  const whole = `${documents} ${documents === 1 ? 'document' : 'documents'}`
  return values ? `Secrets’ values and ${whole} hidden` : `${whole} hidden`
}

/**
 * Where a manifest shown holds a Secret's values, or a document hidden whole (a release's Manifest
 * tab, its history, a rollback's changes): what's hidden, and Reveal values, as an object's YAML
 * tab has it.
 */
export function SecretsHidden({
  revealed,
  onReveal,
  hidden,
}: {
  revealed: boolean
  onReveal: (revealed: boolean) => void
  hidden: Hidden
}) {
  return (
    <>
      {!revealed && <span className="text-xs text-ink-3">{hiddenSaid(hidden)}</span>}
      <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => onReveal(!revealed)}>
        {revealed ? <EyeOff /> : <Eye />}
        {revealed ? 'Hide values' : 'Reveal values'}
      </Button>
    </>
  )
}
