/**
 * One audit event, all of it: who did it and from where, what and where,
 * how it was approved (an assistant's change), the command that does the
 * same, what else it says, and its place in the log's chain.
 */
import { ExternalLink, Filter, History, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { AuditDetail, AuditEvent } from '@shared/audit'
import { apiKindOf } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { useContexts } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { formatRef, helmPath, kindPath } from '@renderer/lib/routes'
import { ACTIONS, CATEGORY_LABELS, OUTCOME_STYLES, waited } from './audit-model'

const APPROVALS = {
  approved: 'Approved',
  unasked: 'Made without asking',
  rejected: 'Rejected',
  expired: 'Nobody answered',
  withdrawn: 'The assistant stopped waiting',
}

export function EventDetail({
  event,
  onClose,
  onFilter,
}: {
  event: AuditEvent
  onClose: () => void
  /** Narrows the list: to this person's events, or this object's. */
  onFilter: (by: 'user' | 'object') => void
}) {
  const action = ACTIONS[event.action]
  const outcome = OUTCOME_STYLES[event.outcome]
  const { actor, target, approval } = event
  const contexts = useContexts().data?.contexts
  const time = new Date(event.time)
  // Where it is now, in Lumovi: not what's gone (deleted, uninstalled).
  const open =
    target?.name &&
    event.cluster &&
    contexts?.some((c) => c.name === event.cluster) &&
    !['resource.delete', 'helm.uninstall'].includes(event.action)
      ? target.kind === 'HelmRelease'
        ? helmPath(event.cluster)
        : `${kindPath(event.cluster, target.kind)}?open=${encodeURIComponent(formatRef({ kind: target.kind, name: target.name, namespace: target.namespace }))}`
      : undefined
  return (
    <aside
      aria-label="Event"
      className="flex h-full w-full flex-col overflow-hidden border-l border-line bg-surface"
    >
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span
          className={cn(
            'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2',
            outcome.className,
          )}
        >
          <action.icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] leading-snug font-semibold break-words text-ink-1 selectable">
            {event.summary}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className={cn('rounded-md px-1.5 py-px font-semibold', outcome.badge)}>
              {outcome.label}
            </span>
            <time dateTime={event.time} title={event.time}>
              {time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
            </time>
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {CATEGORY_LABELS[event.category]}: {action.label.toLowerCase()}
          </p>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {event.error && (
          <p
            role="note"
            className="mt-4 rounded-lg border border-critical/30 bg-critical/8 px-3 py-2 text-xs break-words text-critical-text selectable"
          >
            {event.error}
          </p>
        )}

        <Section title="Who">
          <Field label="Person">{actor.via === 'server' ? 'Lumovi itself' : actor.user}</Field>
          {actor.groups && (
            <Field label="Groups">
              <Chips values={actor.groups} />
            </Field>
          )}
          <Field label="Through">
            {actor.via === 'assistant'
              ? `${actor.assistant}, an AI assistant acting as them`
              : actor.via === 'ui'
                ? 'Lumovi’s page'
                : 'Lumovi itself'}
          </Field>
          {actor.kubeUser && <Field label="Kubeconfig user">{actor.kubeUser}</Field>}
          {actor.address && (
            <Field label="From">
              <span className="font-mono">{actor.address}</span>
              {actor.forwardedFor && (
                <span className="block text-ink-3">
                  forwarded for <span className="font-mono">{actor.forwardedFor}</span>
                </span>
              )}
            </Field>
          )}
          {actor.userAgent && (
            <Field label="Browser">
              <span className="font-mono text-2xs break-all">{actor.userAgent}</span>
            </Field>
          )}
          {actor.session && (
            <Field label="Session">
              <span className="font-mono">{actor.session}</span>
            </Field>
          )}
          {actor.via !== 'server' && (
            <FilterButton icon={Filter} onClick={() => onFilter('user')}>
              Everything {actor.user} did
            </FilterButton>
          )}
        </Section>

        {(event.cluster || target) && (
          <Section title="Where">
            {event.cluster && <Field label="Cluster">{event.cluster}</Field>}
            {target?.namespace && <Field label="Namespace">{target.namespace}</Field>}
            {target && (
              <Field label="Object">
                <span>{apiKindOf(target.kind)}</span>{' '}
                {target.name && <span className="font-mono">{target.name}</span>}
                {target.uid && (
                  <span className="block font-mono text-2xs text-ink-3">{target.uid}</span>
                )}
              </Field>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {open && (
                <Link
                  to={open}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-3"
                >
                  <ExternalLink className="size-3.5" /> Open in Lumovi
                </Link>
              )}
              {target?.name && (
                <FilterButton icon={History} onClick={() => onFilter('object')}>
                  Its history
                </FilterButton>
              )}
            </div>
          </Section>
        )}

        {approval && (
          <Section title="Approval">
            <Field label="Answer">{APPROVALS[approval.status]}</Field>
            {approval.by && <Field label="By">{approval.by}</Field>}
            {approval.waitedMs !== undefined && (
              <Field label="Waited">{waited(approval.waitedMs)}</Field>
            )}
            {approval.note && (
              <Field label="Their note">
                <span className="italic">“{approval.note}”</span>
              </Field>
            )}
          </Section>
        )}

        {event.command && (
          <Section title="Does the same">
            <div className="flex items-start gap-1 rounded-lg bg-surface-3/70 py-1 pr-1 pl-2.5">
              <code className="min-w-0 flex-1 py-0.5 font-mono text-2xs break-all text-ink-1 selectable">
                {event.command}
              </code>
              <CopyButton text={event.command} label="Copy command" />
            </div>
          </Section>
        )}

        {event.details && Object.keys(event.details).length > 0 && (
          <Section title="Details">
            {Object.entries(event.details).map(([key, value]) => (
              <Field key={key} label={key} mono>
                <DetailValue value={value} />
              </Field>
            ))}
          </Section>
        )}

        <Section title="In the log">
          <Field label="Place">
            <span className="font-mono">#{event.seq.toLocaleString('en')}</span>
          </Field>
          <Field label="Id">
            <span className="font-mono text-2xs break-all">{event.id}</span>
          </Field>
          <Field label="Hash">
            <span className="flex items-start gap-1">
              <span className="min-w-0 flex-1 font-mono text-2xs break-all">{event.hash}</span>
              <CopyButton text={event.hash} label="Copy hash" />
            </span>
          </Field>
          {event.prev && (
            <Field label="After">
              <span className="font-mono text-2xs break-all text-ink-3">{event.prev}</span>
            </Field>
          )}
          <div className="mt-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
              The event as recorded, as JSON
              <CopyButton text={() => JSON.stringify(event, null, 2)} label="Copy the event" />
            </span>
          </div>
        </Section>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-5">
      <h3 className="mb-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
      <dl className="space-y-1.5">{children}</dl>
    </section>
  )
}

function Field({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 text-xs">
      <dt className={cn('truncate text-ink-3', mono && 'font-mono text-2xs leading-5')}>{label}</dt>
      <dd className="min-w-0 break-words text-ink-1 selectable">{children}</dd>
    </div>
  )
}

function Chips({ values }: { values: string[] }) {
  return values.length === 0 ? (
    <span className="text-ink-3">none</span>
  ) : (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <span
          key={value}
          className="rounded-md bg-surface-3 px-1.5 py-px font-mono text-2xs text-ink-2"
        >
          {value}
        </span>
      ))}
    </span>
  )
}

function DetailValue({ value }: { value: AuditDetail }) {
  if (Array.isArray(value)) return <Chips values={value} />
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>
  return <span className="font-mono text-2xs">{String(value)}</span>
}

function FilterButton({
  icon: Icon,
  onClick,
  children,
}: {
  icon: LucideIcon
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-3"
    >
      <Icon className="size-3.5" />
      {children}
    </button>
  )
}
