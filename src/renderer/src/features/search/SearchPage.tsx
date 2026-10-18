import {
  Bookmark,
  BookmarkCheck,
  Info,
  LoaderCircle,
  Search,
  SearchX,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject, SearchItem } from '@shared/api'
import { hasHealth, statusFor } from '@renderer/lib/health'
import { Button } from '@renderer/components/Button'
import { Kbd } from '@renderer/components/Kbd'
import { KindIcon } from '@renderer/components/KindIcon'
import { StatusPill } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useListResponses } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { useCluster } from '@renderer/state/cluster'
import { SAVED_SEARCH_LENGTH, SAVED_SEARCHES_AT_MOST } from '@shared/preferences'
import { savedKeyCaps, savedKeysHere, useSavedSearches } from './saved'
import { matchedLabels, searches, termsOf, type Terms } from './terms'
import { useClusterSearch, type KindSearch } from './use-search'

/** The address's parameters as they are now: the desktop keeps its place in the hash. */
const liveParams = () =>
  new URLSearchParams(
    api.host === 'desktop' ? (location.hash.split('?')[1] ?? '') : location.search,
  )

/** How long typing waits before it searches. */
const TYPING_MS = 300
/** How old what's read is before the foot line says so. */
const STALE_MS = 60_000
/** A group's rows shown before "Show all". */
const ROWS_SHOWN = 50

/** "1,234". */
const count = (n: number) => n.toLocaleString('en-US')
/** "Pods, Roles and RoleBindings". */
const and = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/**
 * Search (LMV-171): any object of a kind the person may list, by part of its name or by its
 * labels, in the namespaces picked, grouped by kind with its status. What's read is each kind's
 * metadata, once (use-search.ts); typing matches against it.
 */
export function SearchPage() {
  useEffect(() => {
    document.title = 'Search — Lumovi'
  }, [])
  const [params, setParams] = useSearchParams()
  const text = params.get('q') ?? ''
  const [typed, setTyped] = useState(text)
  const [seen, setSeen] = useState(text)
  // (A saved search run, or Back: what the address says is what's typed.)
  if (text !== seen) {
    setSeen(text)
    setTyped(text)
  }
  // Typing searches after a moment, ↵ at once: either way over what the address said when it
  // began, so a search run another way meanwhile (a saved search, the palette, Back) is never
  // written over by one still waiting.
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)
  const settle = () => {
    clearTimeout(pending.current)
    pending.current = undefined
  }
  const run = (next: string, over = text) => {
    settle()
    // (The address as it is now, not as this render saw it: a search run another way may have
    // gone there since, before the page drew it.)
    const live = liveParams()
    if ((live.get('q') ?? '') !== over) return
    if (next.trim()) live.set('q', next.trim())
    else live.delete('q')
    setParams(live, { replace: true })
  }
  useEffect(() => {
    if (typed.trim() === text) return
    const from = text
    pending.current = setTimeout(() => run(typed, from), TYPING_MS)
    return settle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed])
  // (Whatever changes the address lets go of a search still waiting.)
  useEffect(() => settle, [text])
  const terms = useMemo(() => termsOf(text), [text])
  const on = searches(terms)
  const search = useClusterSearch(terms, true)
  const field = useRef<HTMLInputElement>(null)
  // ⌘⇧F (or the palette) brings the field back, its text selected.
  useEffect(() => {
    const focus = () => {
      field.current?.focus()
      field.current?.select()
    }
    focus()
    window.addEventListener('lumovi:search', focus)
    return () => window.removeEventListener('lumovi:search', focus)
  }, [])
  const phone = useLayout() === 'phone'
  const saved = useSavedSearches()

  const waiting = search.kinds.filter((kind) => kind.state === 'waiting')
  const answered = search.kinds.length - waiting.length
  const groups = search.kinds.filter((kind) => kind.found.length > 0)
  const found = groups.reduce((sum, kind) => sum + kind.found.length, 0)

  return (
    // (No ligatures: != is two characters a person types, not ≠.)
    <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto [font-variant-ligatures:none] [overflow-anchor:auto]">
      <div className="px-6 pt-4 phone:px-4 phone:pt-3">
        <div className="flex items-center gap-2.5">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft phone:h-11">
            <Search className="size-4 shrink-0 text-ink-3" />
            <input
              ref={field}
              aria-label="Search the cluster"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') run(typed)
              }}
              placeholder="Part of a name, or labels: app=web"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
              {waiting.length > 0 || search.discovering ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  <span className="@max-[760px]:hidden">
                    Searching · {answered} of {search.kinds.length} kinds
                    {on ? ` · ${count(found)} so far` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={search.stop}
                    className="font-medium text-accent-strong hover:underline"
                  >
                    Stop
                  </button>
                </>
              ) : on ? (
                <>
                  <b className="font-medium text-ink-2">{count(found)}</b>
                  <span className="@max-[760px]:hidden">
                    {found === 1 ? 'object' : 'objects'} in {groups.length}{' '}
                    {groups.length === 1 ? 'kind' : 'kinds'}
                  </span>
                  <span className="@min-[761px]:hidden">found</span>
                </>
              ) : null}
            </span>
          </label>
          {on && (
            <SaveButton
              saved={saved.has(text)}
              why={
                saved.saved.length >= SAVED_SEARCHES_AT_MOST
                  ? `${SAVED_SEARCHES_AT_MOST} searches are saved, the most there can be. Remove one to save this.`
                  : text.length > SAVED_SEARCH_LENGTH
                    ? `A saved search is at most ${SAVED_SEARCH_LENGTH} characters.`
                    : undefined
              }
              onSave={() => saved.save(text)}
              onRemove={() => saved.remove(text)}
            />
          )}
        </div>
        {saved.saved.length > 0 && (on || phone) && (
          <SavedStrip running={text} onRun={run} phone={phone} />
        )}
        {on && (
          <p className="mt-1.5 text-right text-[11.5px] text-ink-3 phone:hidden">
            Labels: <code className="font-mono">app=web tier!=db team=* !canary</code>
          </p>
        )}
      </div>
      {!on ? (
        <BeforeTyping onRun={run} phone={phone} />
      ) : (
        <Results
          terms={terms}
          text={text}
          groups={groups}
          kinds={search.kinds}
          phone={phone}
          answered={waiting.length === 0 && !search.discovering}
          readAt={search.readAt}
          onRefresh={search.refresh}
        />
      )}
    </div>
  )
}

function SaveButton({
  saved,
  why,
  onSave,
  onRemove,
}: {
  saved: boolean
  /** Why it can't be saved, where it can't. */
  why?: string
  onSave: () => void
  onRemove: () => void
}) {
  return (
    <Button
      onClick={saved ? onRemove : onSave}
      aria-pressed={saved}
      disabled={!saved && why !== undefined}
      title={saved ? 'Saved: press to remove it' : (why ?? 'Save this search')}
      className="h-9 shrink-0 @max-[760px]:w-9 @max-[760px]:px-0 phone:h-11"
    >
      {saved ? <BookmarkCheck className="text-accent-strong" /> : <Bookmark />}
      <span className="@max-[760px]:hidden">{saved ? 'Saved' : 'Save this search'}</span>
    </Button>
  )
}

/** The saved searches, each a chip: its key (the first nine) and ×; the one running, lit. */
function SavedStrip({
  running,
  onRun,
  phone,
}: {
  running: string
  onRun: (text: string) => void
  phone: boolean
}) {
  const { saved, remove } = useSavedSearches()
  const keys = savedKeysHere(phone)
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5"
      aria-label="Saved searches"
      role="list"
    >
      <span className="mr-1 text-xs text-ink-3 phone:hidden">Saved</span>
      {saved.map((search, i) => (
        <span
          key={search}
          role="listitem"
          className={cn(
            'flex h-[26px] items-center gap-1 rounded-md border pr-1 pl-2 text-xs phone:h-8',
            search === running
              ? 'border-accent bg-accent-soft text-ink-1'
              : 'border-line-strong bg-surface-2 text-ink-2',
          )}
        >
          <button type="button" onClick={() => onRun(search)} className="flex items-center gap-1.5">
            <code className="font-mono text-[11.5px]">{search}</code>
            {keys && i < 9 && (
              <span className="flex gap-0.5">
                {savedKeyCaps(i + 1).map((cap) => (
                  <Kbd key={cap}>{cap}</Kbd>
                ))}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={`Remove the saved search ${search}`}
            onClick={() => remove(search)}
            onKeyDown={(event) => event.key === 'Delete' && remove(search)}
            className="grid size-5 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink-1"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

/** Before typing: the saved searches, then what can be typed. */
function BeforeTyping({ onRun, phone }: { onRun: (text: string) => void; phone: boolean }) {
  const { saved, remove } = useSavedSearches()
  const keys = savedKeysHere(phone)
  const how: [string, string][] = [
    ['checkout', 'Any part of a name, in any case'],
    ['app=checkout', 'A label with this value'],
    ['tier!=db', 'Not this value, or no such label'],
    ['team=*', 'Has this label, any value'],
    ['!canary', 'Doesn’t have this label'],
    ['checkout app=web', 'Both: every term must match'],
  ]
  return (
    <div className="grid gap-8 px-6 py-6 @min-[900px]:grid-cols-2 phone:px-4">
      {saved.length > 0 && (
        <section aria-label="Saved searches">
          <h3 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Saved searches
          </h3>
          <div className="overflow-hidden rounded-[10px] border border-line">
            {saved.map((search, i) => (
              <div
                key={search}
                className="flex min-h-10 items-center gap-2.5 px-3 text-[13px] [&+&]:border-t [&+&]:border-line"
              >
                <Search className="size-3.5 text-ink-3" />
                <button
                  type="button"
                  onClick={() => onRun(search)}
                  className="min-w-0 flex-1 truncate text-left"
                >
                  <code className="font-mono text-[12.5px]">{search}</code>
                </button>
                {keys && i < 9 && (
                  <span className="flex gap-0.5">
                    {savedKeyCaps(i + 1).map((cap) => (
                      <Kbd key={cap}>{cap}</Kbd>
                    ))}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove the saved search ${search}`}
                  onClick={() => remove(search)}
                  className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-1"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section aria-label="What you can type">
        <h3 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          What you can type
        </h3>
        <dl className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          {how.map(([term, says]) => (
            <div key={term} className="contents">
              <dt>
                <code className="font-mono text-[12.5px] text-ink-1">{term}</code>
              </dt>
              <dd className="text-ink-2">{says}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

/** The cluster's objects that match, a group a kind; then what was searched, and what wasn't. */
function Results({
  terms,
  text,
  groups,
  kinds,
  phone,
  answered,
  readAt,
  onRefresh,
}: {
  terms: Terms
  text: string
  groups: KindSearch[]
  kinds: KindSearch[]
  phone: boolean
  answered: boolean
  readAt: number
  onRefresh: () => void
}) {
  const { namespaces } = useCluster()
  // (What's shown isn't watched: once it's over a minute old, the foot line says how old.)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const old = Number.isFinite(readAt) && now - readAt > STALE_MS
  // Statuses, of the kinds that have one, as their lists read them (only where something matched).
  const statused = groups.filter((group) => hasHealth(group.resource.kind))
  const lists = useListResponses(statused.map((group) => group.resource))
  const objects = useMemo(() => {
    const byUid = new Map<string, KubeObject>()
    for (const list of lists) {
      for (const object of list.data?.items ?? []) {
        byUid.set(object.metadata.uid!, object)
      }
    }
    return byUid
  }, [lists])
  const where = namespaces === null ? 'All namespaces' : and([...namespaces])
  const done = kinds.filter((kind) => kind.state === 'done').length
  const denied = kinds.filter((kind) => kind.state === 'denied')
  const late = kinds.filter((kind) => kind.state === 'late' || kind.state === 'failed')
  const stopped = kinds.filter((kind) => kind.state === 'stopped')
  const waiting = kinds.filter((kind) => kind.state === 'waiting')

  return (
    <div className="pb-6">
      {groups.length > 0 ? (
        <div role="table" aria-label="Found" className="mt-3">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1.4fr)_150px_170px_minmax(0,1fr)_64px] gap-x-4 border-b border-line px-6 pb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase @max-[760px]:grid-cols-[minmax(0,1fr)_150px] phone:hidden"
          >
            <span role="columnheader">Name</span>
            <span role="columnheader" className="@max-[760px]:hidden">
              Namespace
            </span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="@max-[760px]:hidden">
              {terms.labels.length > 0 ? 'Labels' : ''}
            </span>
            <span role="columnheader" className="text-right @max-[760px]:hidden">
              Age
            </span>
          </div>
          {groups.map((group) => (
            <Group
              key={group.resource.kind}
              group={group}
              terms={terms}
              objects={objects}
              phone={phone}
            />
          ))}
        </div>
      ) : (
        answered && <NothingFound terms={terms} text={text} />
      )}
      <div className="mx-6 mt-4 flex flex-col gap-1.5 text-xs leading-[18px] text-ink-3 phone:mx-4">
        {waiting.length > 0 && (
          <p className="flex items-center gap-1.5">
            <LoaderCircle className="size-3.5 animate-spin" />
            Still searching:{' '}
            {and(
              waiting.length > 3
                ? [
                    ...waiting.slice(0, 3).map((kind) => kind.resource.label),
                    `${waiting.length - 3} more`,
                  ]
                : waiting.map((kind) => kind.resource.label),
            )}
            .
          </p>
        )}
        {late.map((kind) => (
          <p key={kind.resource.kind} className="flex items-center gap-1.5">
            <TriangleAlert className="size-3.5 text-warn-text" />
            {kind.resource.label}{' '}
            {kind.state === 'late' ? 'didn’t answer in time' : 'couldn’t be read'} ·{' '}
            <button
              type="button"
              onClick={kind.retry}
              className="font-medium text-accent-strong hover:underline"
            >
              Retry
            </button>
          </p>
        ))}
        {stopped.length > 0 && (
          <p>
            Stopped before {and(stopped.map((kind) => kind.resource.label))}:{' '}
            <button
              type="button"
              onClick={() => stopped.forEach((kind) => kind.retry())}
              className="font-medium text-accent-strong hover:underline"
            >
              Search them
            </button>
          </p>
        )}
        {waiting.length === 0 && (
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Searched {done} {done === 1 ? 'kind' : 'kinds'} in{' '}
              <b className="font-medium text-ink-2">{where}</b>.
              {denied.length > 0 &&
                ` Not searched: ${and(denied.map((kind) => kind.resource.label))}, which your access doesn’t list.`}
              {namespaces !== null && ' Kinds outside namespaces are searched with All namespaces.'}{' '}
              Secrets and ConfigMaps are found by name and label, never by what they hold.
              {old && (
                <>
                  {' '}
                  Read {age(new Date(readAt).toISOString(), now)} ago ·{' '}
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="font-medium text-accent-strong hover:underline"
                  >
                    Refresh
                  </button>
                </>
              )}
            </span>
          </p>
        )}
      </div>
    </div>
  )
}

function NothingFound({ terms, text }: { terms: Terms; text: string }) {
  const labels = and(text.split(/\s+/).filter((term) => !terms.words.includes(term.toLowerCase())))
  const words = terms.words.join(' ')
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <SearchX className="size-6 text-ink-3" />
      <b className="text-[14px] font-medium text-ink-1">
        {terms.labels.length === 0
          ? `No object’s name has “${words}”.`
          : terms.words.length === 0
            ? `Nothing has the labels ${labels}.`
            : `No object’s name has “${words}” with the labels ${labels}.`}
      </b>
    </div>
  )
}

/** A kind's group: its rows, and where it was cut short, what that leaves out. */
function Group({
  group,
  terms,
  objects,
  phone,
}: {
  group: KindSearch
  terms: Terms
  objects: Map<string, KubeObject>
  phone: boolean
}) {
  const [all, setAll] = useState(false)
  const { resource, found, truncated, total, read, byLabel } = group
  // (Read by the labels typed, it's cut short only where the labels alone match more.)
  const cut = truncated
  const rows = all ? found : found.slice(0, ROWS_SHOWN)
  return (
    <div role="rowgroup" aria-label={resource.label}>
      <div
        role="row"
        className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-6 py-1.5 text-xs text-ink-2 phone:px-4"
      >
        <KindIcon kind={resource.kind} className="size-3.5 text-ink-3" />
        <span role="rowheader" className="font-medium">
          {resource.label}
        </span>
        <span className="text-ink-3">
          {count(found.length)}
          {resource.group && !resource.category ? ` · ${resource.group}` : ''}
        </span>
        {cut && (
          <span className="ml-auto text-warn-text">
            {total !== undefined
              ? `Searched the first ${count(read)} of ${count(total)}`
              : `Searched the first ${count(read)}: there are more`}
          </span>
        )}
      </div>
      {rows.map((item) => (
        <Row
          key={item.uid}
          item={item}
          group={group}
          terms={terms}
          object={objects.get(item.uid)}
          phone={phone}
        />
      ))}
      {found.length > rows.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-b border-line px-6 py-2 text-left text-xs font-medium text-accent-strong hover:underline"
        >
          Show all {count(found.length)}
        </button>
      )}
      {cut && (
        <p className="flex items-center gap-1.5 border-b border-line px-6 py-2 text-xs text-ink-2 phone:px-4">
          <TriangleAlert className="size-3.5 shrink-0 text-warn-text" />
          <span>
            {byLabel
              ? `${resource.label}: its labels match more than Lumovi reads at once, so some weren’t searched.`
              : total !== undefined
                ? `${resource.label}: ${count(total)} is more than Lumovi reads at once, so ${count(total - read)} weren’t searched by name.`
                : `${resource.label}: there are more than Lumovi reads at once, so some weren’t searched by name.`}{' '}
            <button
              type="button"
              onClick={() =>
                document
                  .querySelector<HTMLElement>('header button[aria-label="Namespace"]')
                  ?.click()
              }
              className="font-medium text-accent-strong hover:underline"
            >
              Choose namespaces
            </button>{' '}
            or add a label to search them all.
          </span>
        </p>
      )}
    </div>
  )
}

/** A name with the parts typed marked. */
function Marked({ name, words }: { name: string; words: string[] }) {
  const lower = name.toLowerCase()
  const marks: [number, number][] = []
  for (const word of words) {
    const at = lower.indexOf(word)
    if (at >= 0) marks.push([at, at + word.length])
  }
  marks.sort((a, b) => a[0] - b[0])
  const parts: ReactNode[] = []
  let from = 0
  for (const [start, end] of marks) {
    if (start < from) continue
    if (start > from) parts.push(name.slice(from, start))
    parts.push(
      <mark key={start} className="rounded-[3px] bg-accent-soft text-inherit">
        {name.slice(start, end)}
      </mark>,
    )
    from = end
  }
  parts.push(name.slice(from))
  return <>{parts}</>
}

/** What a kind's list says second of an object: how many are ready, restarts, an address. */
function factOf(kind: string, object: KubeObject | undefined): string {
  if (!object) return ''
  const status = (object as { status?: Record<string, unknown> }).status ?? {}
  const spec = (object as { spec?: Record<string, unknown> }).spec ?? {}
  switch (kind) {
    case 'Pod': {
      const restarts = ((status.containerStatuses as { restartCount?: number }[]) ?? []).reduce(
        (sum, container) => sum + (container.restartCount ?? 0),
        0,
      )
      return `${restarts} ${restarts === 1 ? 'restart' : 'restarts'}`
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
      return `${Number(status.readyReplicas ?? 0)}/${Number(spec.replicas ?? 0)} ready`
    case 'DaemonSet':
      return `${Number(status.numberReady ?? 0)}/${Number(status.desiredNumberScheduled ?? 0)} ready`
    default:
      return ''
  }
}

function Row({
  item,
  group,
  terms,
  object,
  phone,
}: {
  item: SearchItem
  group: KindSearch
  terms: Terms
  object: KubeObject | undefined
  phone: boolean
}) {
  const open = useOpenObject()
  const { kind } = group.resource
  const status = object ? statusFor(kind, object) : null
  const labels = terms.labels.length > 0 ? matchedLabels(item.labels, terms.labels) : []
  const fact = labels.length > 0 ? null : factOf(kind, object)
  const pill = status ? <StatusPill status={status} /> : <span className="text-ink-3">—</span>
  const name = (
    <span className="truncate font-medium text-ink-1">
      <Marked name={item.name} words={terms.words} />
    </span>
  )
  if (phone) {
    return (
      <button
        type="button"
        role="row"
        onClick={() => open(kind, item.name, item.namespace)}
        className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left text-[15px]"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          {name}
          <span className="text-[13px] text-ink-3">
            {[item.namespace, age(item.created)].filter(Boolean).join(' · ')}
          </span>
          {labels.length > 0 && (
            <code className="font-mono text-[12px] text-ink-2">{labels.join(' ')}</code>
          )}
        </span>
        {status && pill}
      </button>
    )
  }
  return (
    <button
      type="button"
      role="row"
      onClick={() => open(kind, item.name, item.namespace)}
      className="grid min-h-10 w-full grid-cols-[minmax(0,1.4fr)_150px_170px_minmax(0,1fr)_64px] items-center gap-x-4 border-b border-line px-6 text-left text-[13px] hover:bg-surface-3/50 focus-visible:bg-surface-3/50 focus-visible:outline-none @max-[760px]:grid-cols-[minmax(0,1fr)_150px]"
    >
      <span role="cell" className="flex min-w-0 flex-col">
        {name}
        {item.namespace && (
          <span className="text-xs text-ink-3 @min-[761px]:hidden">{item.namespace}</span>
        )}
      </span>
      <span role="cell" className="truncate text-ink-2 @max-[760px]:hidden">
        {item.namespace ?? ''}
      </span>
      <span role="cell">{pill}</span>
      <span role="cell" className="truncate text-ink-2 @max-[760px]:hidden">
        {labels.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <code
                key={label}
                className="rounded border border-line px-1.5 font-mono text-[11.5px]"
              >
                {label}
              </code>
            ))}
          </span>
        ) : (
          <span className="font-mono text-[12px]">{fact}</span>
        )}
      </span>
      <span role="cell" className="text-right text-ink-3 tabular-nums @max-[760px]:hidden">
        {age(item.created)}
      </span>
    </button>
  )
}
