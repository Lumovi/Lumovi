import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@renderer/components/Button'

/**
 * Where a manifest shown holds a Secret's values (a release's Manifest tab, its history, a
 * rollback's changes): that they're hidden, and Reveal values, as an object's YAML tab has it.
 */
export function SecretsHidden({
  revealed,
  onReveal,
}: {
  revealed: boolean
  onReveal: (revealed: boolean) => void
}) {
  return (
    <>
      {!revealed && <span className="text-xs text-ink-3">Secrets’ values hidden</span>}
      <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => onReveal(!revealed)}>
        {revealed ? <EyeOff /> : <Eye />}
        {revealed ? 'Hide values' : 'Reveal values'}
      </Button>
    </>
  )
}
