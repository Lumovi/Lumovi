/**
 * What's done with the audit log as a whole: exporting what the filters
 * find (CSV for spreadsheets, JSON Lines for log tools, in the order it
 * happened), and checking that its chain holds.
 */
import { Download, LoaderCircle, ShieldCheck, ShieldX, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import {
  AUDIT_CSV_COLUMNS,
  auditCsvRow,
  type AuditEvent,
  type AuditQuery,
  type AuditVerification,
} from '@shared/audit'
import { Button } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { menuContent, menuItem } from '../shell/menu-styles'
import { fromOf, type Range } from './audit-model'

type Format = 'csv' | 'jsonl'

/** Every event the search finds (as many as an export holds), oldest first. */
async function everything(
  query: AuditQuery,
  limit: number,
): Promise<{ events: AuditEvent[]; cut: boolean }> {
  const events: AuditEvent[] = []
  let after: string | undefined
  do {
    const page = await api.audit.query({ ...query, limit: 1000, ...(after ? { after } : {}) })
    events.push(...page.events)
    after = page.next
  } while (after && events.length < limit)
  return { events: events.slice(0, limit).reverse(), cut: events.length > limit || Boolean(after) }
}

export function ExportMenu({
  query,
  range,
  limit,
}: {
  query: AuditQuery
  range: Range
  /** How many an export holds, at most. */
  limit: number
}) {
  const [busy, setBusy] = useState(false)
  const save = async (format: Format) => {
    setBusy(true)
    try {
      const from = fromOf(range, Date.now())
      const { events, cut } = await everything({ ...query, ...(from ? { from } : {}) }, limit)
      const text =
        format === 'csv'
          ? `${[AUDIT_CSV_COLUMNS.join(','), ...events.map(auditCsvRow)].join('\r\n')}\r\n`
          : events.map((event) => `${JSON.stringify(event)}\n`).join('')
      const day = new Date().toISOString().slice(0, 10)
      const saved = await api.app.saveFile(`lumovi-audit-${day}.${format}`, text)
      if (!saved.ok) throw new Error(saved.error.message)
      if (saved.data) {
        toast({
          tone: 'success',
          title: `Exported ${events.length.toLocaleString('en')} ${events.length === 1 ? 'event' : 'events'}`,
          description: cut
            ? `The ${limit.toLocaleString('en')} most recent the filters find: narrow them (by time, say) for the rest.`
            : undefined,
        })
      }
    } catch (error) {
      toast({ tone: 'error', title: 'Couldn’t export', description: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
          <DropdownMenu.Label className="px-2 py-1.5 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            What the filters find
          </DropdownMenu.Label>
          <DropdownMenu.Item className={menuItem} onSelect={() => void save('csv')}>
            <span className="flex-1">CSV</span>
            <span className="text-xs text-ink-3">for spreadsheets</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => void save('jsonl')}>
            <span className="flex-1">JSON Lines</span>
            <span className="text-xs text-ink-3">for log tools</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function VerifyButton({ onResult }: { onResult: (result: AuditVerification) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void api.audit
          .verify()
          .then(onResult)
          .catch((error: Error) =>
            toast({ tone: 'error', title: 'Couldn’t check it', description: error.message }),
          )
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
      {busy ? 'Checking…' : 'Check integrity'}
    </Button>
  )
}

const day = (time: string) =>
  new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** What checking found: that every event follows from the one before it, or where one doesn't. */
export function Verification({
  result,
  onClose,
}: {
  result: AuditVerification
  onClose: () => void
}) {
  const { broken } = result
  const Icon = broken ? ShieldX : ShieldCheck
  return (
    <div
      role={broken ? 'alert' : 'status'}
      aria-label="Integrity"
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3',
        broken ? 'border-critical/30 bg-critical/8' : 'border-good/30 bg-good/10',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', broken ? 'text-critical-text' : 'text-good-text')}
      />
      <div className="min-w-0 flex-1 text-[13px]">
        {broken ? (
          <>
            <p className="font-semibold text-critical-text">
              The log was changed: event #{broken.seq.toLocaleString('en')}
              {broken.time && ` (after ${day(broken.time)})`} doesn’t follow.
            </p>
            <p className="mt-0.5 text-ink-2">
              {broken.reason} The {result.checked.toLocaleString('en')} before it hold.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-good-text">
              {result.checked === 0
                ? 'Nothing to check yet.'
                : `All ${result.checked.toLocaleString('en')} events hold.`}
            </p>
            {result.from && (
              <p className="mt-0.5 text-ink-2">
                Each, from the first ({day(result.from)}) to the last, follows from the one before
                it: none was changed, removed, or added since it was recorded.
              </p>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
