/**
 * The audit log: what was done through Lumovi, by whom, from where, and
 * how it came out. Changes (the page's and AI assistants', with how they
 * were approved), shells, port-forwards, logs and Secrets read, sign-ins,
 * and what decides what may be done. Searched, filtered, followed live,
 * exported, and checked.
 */
import { ScrollText, SearchX, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { lostText, type AuditEvent, type AuditInfo, type AuditVerification } from '@shared/audit'
import { EmptyState, Loading } from '@renderer/components/States'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useSession } from '@renderer/state/session'
import { Commands } from '../shell/Commands'
import { PageHeader } from '../shell/PageHeader'
import { filtersOf, narrowing, paramsOf, queryOf, type AuditFilters } from './audit-model'
import { EventDetail } from './EventDetail'
import { EventList, type EventListHandle } from './EventList'
import { Toolbar } from './Toolbar'
import { ExportMenu, Verification, VerifyButton } from './Tools'
import { useAuditEvents, useAuditInfo } from './use-audit'

export function AuditPage() {
  useEffect(() => {
    document.title = 'Audit log — Lumovi'
  }, [])
  const session = useSession()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => filtersOf(params), [params])
  const key = paramsOf(filters).toString()
  const query = useMemo(() => queryOf(filters), [filters])
  const info = useAuditInfo().data
  const found = useAuditEvents(query, filters.range, key)
  const contexts = useContexts().data?.contexts
  const [selected, setSelected] = useState<AuditEvent>()
  const [verified, setVerified] = useState<AuditVerification>()
  const list = useRef<EventListHandle>(null)

  const setFilters = (next: AuditFilters) => setParams(paramsOf(next), { replace: true })
  const people = useMemo(
    // People: not Lumovi itself.
    () =>
      [
        ...new Set([
          ...filters.users,
          ...found.events.flatMap((e) => (e.actor.via === 'server' ? [] : [e.actor.user])),
        ]),
      ].sort(),
    [filters.users, found.events],
  )
  const clusters = useMemo(
    () =>
      [
        ...new Set([
          ...(contexts ?? []).map((c) => c.name),
          ...filters.clusters,
          ...found.events.flatMap((e) => (e.cluster ? [e.cluster] : [])),
        ]),
      ].sort(),
    [contexts, filters.clusters, found.events],
  )
  const filtered = narrowing(filters) > 0 || filters.text.trim() !== ''

  return (
    <div className="vt-page flex h-full flex-col overflow-hidden bg-app">
      <PageHeader
        scope={
          api.host === 'desktop' ? 'This computer' : session!.fleet ? 'Fleet' : session!.cluster!
        }
        end={session && <span className="truncate text-xs text-ink-2">{session.user.name}</span>}
      />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-line bg-app px-5 pt-6 pb-4">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-[1_1_420px]">
                <h1 className="text-[28px] leading-[1.15] headline text-ink-1">
                  <span className="block">Audit log</span>
                  <span className="block text-ink-3">What was done, by whom, and how it went.</span>
                </h1>
                {info && <Kept info={info} />}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {info?.everyone && <VerifyButton onResult={setVerified} />}
                {info && (
                  <ExportMenu query={query} range={filters.range} limit={info.exportLimit} />
                )}
              </div>
            </div>
            {info && <Problems info={info} />}
            {verified && (
              <div className="mt-4">
                <Verification result={verified} onClose={() => setVerified(undefined)} />
              </div>
            )}
            <div className="mt-5">
              <Toolbar
                filters={filters}
                onChange={setFilters}
                people={people}
                clusters={clusters}
                everyone={info?.everyone === true}
                onArrowDown={() => list.current?.focus()}
              />
            </div>
          </div>
          {found.loading ? (
            <Loading label="Finding events…" />
          ) : found.error ? (
            <EmptyState icon={TriangleAlert} title="The audit log couldn’t be searched">
              {found.error.message}
            </EmptyState>
          ) : found.events.length === 0 ? (
            <EmptyState
              icon={filtered ? SearchX : ScrollText}
              title={filtered ? 'No events match' : 'Nothing yet'}
            >
              {found.stopped ? `${lookedThrough(found.stopped)} ` : ''}
              {filtered
                ? 'Try fewer filters, other words, or further back.'
                : 'What’s done through Lumovi shows here as it happens: changes, shells, port-forwards, logs and Secrets read, sign-ins, and what AI assistants do.'}
              {found.stopped && (
                <button
                  type="button"
                  onClick={found.loadMore}
                  className="mt-3 block w-full text-[13px] font-medium text-accent-strong hover:underline"
                >
                  Look further back
                </button>
              )}
            </EmptyState>
          ) : (
            <EventList
              ref={list}
              events={found.events}
              fresh={found.fresh}
              selected={selected?.id}
              onSelect={setSelected}
              more={found.more && !found.stopped}
              loadingMore={found.loadingMore}
              loadMore={found.loadMore}
            />
          )}
          {found.stopped !== undefined && found.events.length > 0 && (
            <p className="shrink-0 border-t border-line bg-surface px-5 py-2 text-xs text-ink-3">
              {lookedThrough(found.stopped)}{' '}
              <button
                type="button"
                onClick={found.loadMore}
                className="font-medium text-accent-strong hover:underline"
              >
                Look further back
              </button>
            </p>
          )}
        </main>
        {selected && (
          <div
            className={cn(
              'w-[440px] shrink-0',
              // Narrow windows: over the list, not beside it.
              'max-[980px]:absolute max-[980px]:inset-y-0 max-[980px]:right-0 max-[980px]:z-20 max-[980px]:shadow-pop',
            )}
          >
            <EventDetail
              event={selected}
              onClose={() => {
                setSelected(undefined)
                list.current?.focus()
              }}
              onFilter={(by) =>
                setFilters(
                  by === 'user'
                    ? { ...filters, users: [selected.actor.user] }
                    : { ...filters, target: selected.target, range: 'all' },
                )
              }
            />
          </div>
        )}
      </div>
      <Commands />
    </div>
  )
}

/** Where the history is kept, for how long, and whose it is. */
function Kept({ info }: { info: AuditInfo }) {
  const oldest =
    info.oldest && new Date(info.oldest).toLocaleDateString(undefined, { dateStyle: 'medium' })
  return (
    <p className="mt-3 max-w-[640px] text-[13px] text-ink-2">
      {info.kept === 'files'
        ? `Kept on ${api.host === 'desktop' ? 'this computer' : 'the server'} for ${info.retentionDays} days.`
        : api.host === 'desktop'
          ? `Kept in memory until Lumovi quits: ${info.unkept}`
          : 'Kept in the server’s memory, since it started: set LUMOVI_AUDIT_DIR (the Helm chart’s audit.persistence) to keep it.'}
      {oldest && ` The oldest is from ${oldest}.`}{' '}
      {api.host === 'server' &&
        (info.everyone
          ? 'You see everyone’s: you’re one of its auditors.'
          : 'You see your own: its auditors see everyone’s.')}
      {info.level === 'changes' &&
        ' It records changes, sign-ins and settings: not what’s opened or read (shells, logs, Secrets).'}
    </p>
  )
}

/** Where events couldn't be kept or sent, and why: said until the server restarts. */
function Problems({ info }: { info: AuditInfo }) {
  const failing = info.sinks.filter((sink) => sink.dropped > 0 || sink.problem)
  if (!info.everyone || failing.length === 0) return null
  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-[13px]"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-text" />
      <ul className="min-w-0 space-y-1">
        {failing.map((sink) => (
          <li key={sink.name} className="text-ink-1">
            <span className="font-semibold">
              {sink.dropped > 0
                ? `${lostText(sink.dropped, sink.name)} since Lumovi started.`
                : `Events are waiting to be sent to ${sink.name}.`}
            </span>{' '}
            <span className="text-ink-2">{sink.problem}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** How far a search that stopped looked: as many as it says, to an auditor. */
const lookedThrough = ({ scanned }: { scanned?: number }) =>
  scanned === undefined
    ? 'Lumovi looked as far back as one search goes.'
    : `Lumovi looked through the ${scanned.toLocaleString('en')} most recent events.`
