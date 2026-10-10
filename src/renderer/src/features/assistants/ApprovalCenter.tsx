import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  RotateCw,
  Sparkles,
  Timer,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { KubeObject, LumoviApi } from '@shared/api'
import type {
  ChangeProposal,
  ProposalAction,
  ProposalDecision,
  ProposalOutcome,
} from '@shared/assistants'
import { apiKindOf } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { MOD_KEY } from '@renderer/components/Kbd'
import { sheetBody, sheetFrame, SheetGrabber, sheetHeader } from '@renderer/components/Sheet'
import { refreshAfterChange } from '@renderer/hooks/change'
import { useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { pluralize } from '@renderer/lib/format'
import { toYaml } from '@renderer/lib/yaml'
import { useActivity } from '@renderer/state/activity'
import { toast } from '@renderer/state/toasts'
import { TYPE_TO_DELETE } from '../actions/DeleteDialog'
import { useApprovals } from './approvals'

type ApprovalsApi = NonNullable<LumoviApi['approvals']>

const ICONS: Record<ProposalAction, LucideIcon> = {
  apply: FileCode2,
  scale: ArrowUpDown,
  restart: RotateCw,
  delete: Trash2,
}

/**
 * The changes AI assistants ask for, each shown with the diff it makes, for
 * the person to approve or reject (with a note the assistant is told). Put
 * aside, they wait in a pill at the bottom of the window.
 */
export function ApprovalCenter({ approvals }: { approvals: ApprovalsApi }) {
  const queryClient = useQueryClient()
  const { queue, shown, hidden, add, remove } = useApprovals()

  // What comes, and what's waiting already (the window was reloaded, say).
  useEffect(
    () =>
      approvals.onProposal((proposal) => {
        add(proposal)
        notify(proposal)
      }),
    [approvals, add],
  )
  useEffect(
    () =>
      approvals.onOutcome((outcome) => {
        remove(outcome.proposal.id)
        settle(outcome, queryClient)
      }),
    [approvals, remove, queryClient],
  )
  useEffect(
    () => void approvals.pending().then((waiting) => waiting.forEach(add)),
    [approvals, add],
  )

  const proposal = queue.find((p) => p.id === shown)
  if (!proposal) return null
  if (hidden) return <Waiting queue={queue} />
  const decide = (decision: ProposalDecision) => {
    remove(proposal.id)
    void approvals.decide(proposal.id, decision)
  }
  return <ApprovalDialog key={proposal.id} proposal={proposal} decide={decide} />
}

/**
 * A served page's notification of a change waiting, while it isn't in front
 * (where the browser lets it): the desktop app's main process sends its own.
 */
function notify({ client, context, title }: ChangeProposal) {
  if (
    api.host !== 'server' ||
    document.visibilityState === 'visible' ||
    !('Notification' in window) ||
    Notification.permission !== 'granted'
  ) {
    return
  }
  const notice = new Notification(`${client} asks to change ${context}`, {
    body: `${title}. Review it in Lumovi.`,
  })
  notice.onclick = () => window.focus()
}

/** What became of a change: in the activity log, and told when the person didn't decide it. */
function settle({ proposal, status, unasked, error }: ProposalOutcome, queryClient: QueryClient) {
  const { client, context, title, done, command, target } = proposal
  const entry = { context, command, target, via: client }
  const { record } = useActivity.getState()
  switch (status) {
    case 'applied':
      record({ ...entry, title: done, status: 'done' })
      refreshAfterChange(queryClient, context, target.kind)
      toast({
        tone: 'success',
        title: done,
        description: unasked
          ? `${client} changed ${context} without asking: assistants may, there.`
          : `As ${client} asked, in ${context}.`,
      })
      break
    case 'failed':
      record({ ...entry, title: done, status: 'failed', error })
      toast({ tone: 'error', title: `${title} failed`, description: error })
      break
    case 'rejected':
      record({ ...entry, title, status: 'rejected', ...(error ? { note: error } : {}) })
      break
    case 'expired':
      toast({
        tone: 'info',
        title: 'Not approved in time',
        description: `${client} asked to ${lowerFirst(title)}. Nothing was changed.`,
      })
      break
    case 'withdrawn':
      toast({
        tone: 'info',
        title: `${client} withdrew a change`,
        description: `${title}. Nothing was changed.`,
      })
  }
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** The object as the diff shows it: what's set, not what the server keeps (Lumovi hid Secrets' values). */
function forDiff(object: KubeObject | null): string {
  if (!object) return ''
  const { status: _status, ...rest } = object
  const {
    uid: _uid,
    creationTimestamp: _created,
    generation: _generation,
    resourceVersion: _version,
    managedFields: _managed,
    ...metadata
  } = rest.metadata
  return toYaml({ ...rest, metadata })
}

/** Seconds left until `at`, counting down. */
function useSecondsLeft(at: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.round((at - now) / 1_000))
}

function ApprovalDialog({
  proposal,
  decide,
}: {
  proposal: ChangeProposal
  decide: (decision: ProposalDecision) => void
}) {
  const { queue, show, hide } = useApprovals()
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [typed, setTyped] = useState('')
  const left = useSecondsLeft(proposal.expiresAt)
  const { client, context, target, action } = proposal
  const Icon = ICONS[action]
  const danger = action === 'delete'
  const production = useProduction(context)
  // Deletions Lumovi's own Delete asks to type the name for, so does this.
  const typeToConfirm =
    danger && (TYPE_TO_DELETE.includes(target.kind) || production) ? target.name : undefined
  const confirmed = typeToConfirm === undefined || typed === typeToConfirm
  const diff = unifiedDiff(forDiff(proposal.before), forDiff(proposal.after))
  const at = queue.indexOf(proposal)

  const approve = () => decide({ approved: true })
  const reject = () => decide({ approved: false, ...(note.trim() ? { note: note.trim() } : {}) })
  // ⌘↩ answers: approves (once the name's typed, where it must be), or rejects once a note's
  // being written.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (rejecting) reject()
      else if (confirmed) approve()
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && hide()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          // Nothing's focused at first, so a stray Enter answers nothing.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement).focus()
          }}
          // Escape leaves a note unwritten first, then puts the change aside.
          onEscapeKeyDown={(event) => {
            if (!rejecting) return
            event.preventDefault()
            setRejecting(false)
          }}
          className={cn(
            'fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[680px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none',
            // On a phone it's a sheet: dragged down, or its scrim tapped, the change is put
            // aside as Later does. It isn't rejected: it waits, and its pill stays.
            sheetFrame,
          )}
        >
          <SheetGrabber onClose={hide} className="hidden phone:block" />
          <header className={cn('flex items-start gap-3 px-5 pt-5 pb-1', sheetHeader)}>
            <div
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-xl',
                danger ? 'bg-critical/10 text-critical-text' : 'bg-accent-soft text-accent-strong',
              )}
            >
              <Icon className="size-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1 text-xs font-medium text-accent-strong">
                <Sparkles className="size-3" /> {client} asks
              </p>
              <Dialog.Title className="mt-0.5 truncate text-[15px] leading-snug font-semibold text-ink-1">
                {proposal.title}
              </Dialog.Title>
              {/* On a phone the cluster and its Production mark are never cut short: they wrap. */}
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3 phone:flex-wrap">
                <span className="truncate phone:whitespace-normal">
                  {apiKindOf(target.kind)}
                  {target.namespace && ` · ${target.namespace}`} ·{' '}
                  <span className="font-medium text-ink-2">{context}</span>
                </span>
                {production && (
                  <span className="shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
                    Production
                  </span>
                )}
              </p>
            </div>
            {queue.length > 1 && (
              <div className="flex shrink-0 items-center text-xs text-ink-3 tabular-nums">
                <NavButton
                  label="Previous change"
                  disabled={at === 0}
                  onClick={() => show(queue[at - 1]!.id)}
                >
                  <ChevronLeft />
                </NavButton>
                {at + 1} of {queue.length}
                <NavButton
                  label="Next change"
                  disabled={at === queue.length - 1}
                  onClick={() => show(queue[at + 1]!.id)}
                >
                  <ChevronRight />
                </NavButton>
              </div>
            )}
            {/* A plain button: a tooltip opening on focus would swallow the first Escape. */}
            <Dialog.Close
              aria-label="Later"
              title="Later: it waits at the bottom of the window"
              className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1 touch:m-0 touch:size-11 touch:[&_svg]:size-5"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>

          <div className={cn('min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-4 pb-5', sheetBody)}>
            <figure className="rounded-lg border-l-2 border-accent bg-accent-soft/40 py-2 pr-3 pl-3">
              <figcaption className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
                Why
              </figcaption>
              <blockquote className="mt-0.5 text-[13px] leading-relaxed text-ink-1 selectable">
                {proposal.reason}
              </blockquote>
            </figure>

            <section aria-label="Changes">
              <p className="mb-1.5 flex items-baseline justify-between text-xs text-ink-2">
                <span className="font-medium">
                  {action === 'delete'
                    ? 'Deletes it, and what it owns'
                    : proposal.before
                      ? 'The cluster accepts it'
                      : 'Creates it: the cluster accepts it'}
                </span>
                <span className="tabular-nums">
                  <span className="font-medium text-good-text">+{diff.added}</span>{' '}
                  <span className="font-medium text-critical-text">−{diff.removed}</span>{' '}
                  {diff.added + diff.removed === 1 ? 'line' : 'lines'}
                </span>
              </p>
              <div className="flex max-h-[38vh] min-h-0 flex-col overflow-hidden rounded-lg border border-line">
                <DiffView diff={diff} label="Changes" />
              </div>
            </section>

            {proposal.takesOver && (
              <div
                role="note"
                className="flex gap-2.5 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2.5 text-[13px] leading-relaxed text-ink-1"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-text" />
                <p className="min-w-0 break-words">
                  <span className="font-medium">It takes fields over from what manages them</span>{' '}
                  (Helm, Argo CD, an autoscaler…), which may change them back:{' '}
                  <span className="text-ink-2 selectable">{proposal.takesOver}</span>
                </p>
              </div>
            )}

            {proposal.manifest && (
              <details className="group rounded-lg border border-line">
                <summary className="cursor-default px-3 py-2 text-xs font-medium text-ink-2 select-none hover:text-ink-1">
                  The manifest {client} gave
                </summary>
                <pre className="max-h-60 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed text-ink-2 selectable">
                  {proposal.manifest.trim()}
                </pre>
              </details>
            )}

            <div className="group relative rounded-lg bg-surface-3/70 px-3 py-2.5 touch:pr-11">
              <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                Equivalent command
              </p>
              <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
                {proposal.command}
              </code>
              <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                <CopyButton text={proposal.command} label="Copy command" />
              </span>
            </div>

            {typeToConfirm !== undefined && !rejecting && (
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-2">
                  {production && <TriangleAlert className="size-3.5 text-critical-text" />}
                  Type{' '}
                  <span className="font-mono font-medium text-ink-1 select-all">
                    {typeToConfirm}
                  </span>{' '}
                  to approve
                </span>
                <input
                  aria-label={`Type ${typeToConfirm} to approve`}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[13px] text-ink-1 outline-none focus:border-critical focus:ring-3 focus:ring-critical/15 phone:h-11"
                />
              </label>
            )}

            {rejecting && (
              <label className="block animate-fade-in">
                <span className="mb-1.5 block text-xs text-ink-2">
                  Tell {client} why, or what to do instead (optional)
                </span>
                <textarea
                  aria-label="Note"
                  autoFocus
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2_000}
                  rows={3}
                  placeholder="Scale it to 4 instead: the nodes are nearly full."
                  className="block w-full resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft"
                />
              </label>
            )}
          </div>

          {/* On a phone the wait has a line of its own, and under it the quiet button is at the
              left edge and the one that acts at the right, a finger's height, apart. */}
          <footer className="flex items-center gap-2 border-t border-line bg-surface px-5 py-3 phone:flex-wrap phone:justify-between phone:px-4 phone:[&>button]:h-11 phone:[&>button]:px-4 phone:[&>button:first-of-type]:-ml-4 phone:[&>button:last-of-type]:min-w-[120px]">
            <span
              className={cn(
                'mr-auto flex items-center gap-1.5 text-xs tabular-nums phone:mb-3 phone:w-full',
                left <= 60 ? 'text-warn-text' : 'text-ink-3',
              )}
              title={`${client} gets “not approved” if nobody answers by then`}
            >
              <Timer className="size-3.5" />
              Waits {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more
            </span>
            {/* Keyed: the buttons are swapped, not restyled in place. */}
            {rejecting ? (
              <Fragment key="rejecting">
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Back
                </Button>
                <Button variant="danger" onClick={reject} className="min-w-20">
                  Reject <Keys />
                </Button>
              </Fragment>
            ) : (
              <Fragment key="answering">
                <Button variant="ghost" onClick={() => setRejecting(true)}>
                  Reject…
                </Button>
                <Button
                  variant={danger ? 'danger' : 'primary'}
                  onClick={approve}
                  disabled={!confirmed}
                  className="min-w-20"
                >
                  {danger ? 'Approve deletion' : 'Approve'} <Keys />
                </Button>
              </Fragment>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The shortcut that answers, on its button. */
function Keys() {
  return (
    // (Keys to press: of no use to a finger.)
    <span aria-hidden className="text-[11px] font-normal opacity-70 touch:hidden">
      {MOD_KEY === '⌘' ? '⌘↩' : 'Ctrl+↩'}
    </span>
  )
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink-1 disabled:opacity-40 touch:size-11 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

/** Changes put aside: they wait here until they're looked at, answered, or given up on. */
function Waiting({ queue }: { queue: ChangeProposal[] }) {
  const show = useApprovals((state) => state.show)
  const clients = [...new Set(queue.map((p) => p.client))]
  return (
    <button
      type="button"
      onClick={() => show()}
      // On a phone it's as wide as the screen lets it be, its words on more lines if they must.
      className="fixed bottom-12 left-1/2 z-50 flex -translate-x-1/2 animate-pop-in items-center gap-2 rounded-full border border-accent/30 bg-surface-2 py-1.5 pr-3 pl-2 text-[13px] text-ink-1 shadow-pop hover:border-accent/60 phone:w-max phone:max-w-[calc(100vw-32px)] phone:rounded-2xl phone:py-2.5 phone:text-left touch:min-h-11"
    >
      <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent-strong">
        <Sparkles className="size-3.5" />
      </span>
      <span>
        {pluralize(queue.length, 'change')} from {clients.join(' and ')}{' '}
        {queue.length === 1 ? 'waits' : 'wait'} for you
      </span>
      <span className="font-medium text-accent-strong">Review</span>
    </button>
  )
}
