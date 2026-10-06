import { useQueries, useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Layers,
  PackageSearch,
  Search,
  ServerOff,
  Tag,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Dialog, DropdownMenu } from 'radix-ui'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { ClusterSummary, KubeContext, KubeError, Result } from '@shared/api'
import { REPO_URL } from '@shared/app'
import type { Status } from '@shared/health'
import { Button, IconButton } from '@renderer/components/Button'
import { GithubMark } from '@renderer/components/GithubMark'
import { Kbd } from '@renderer/components/Kbd'
import { LogoLockup } from '@renderer/components/LogoLockup'
import { Meter } from '@renderer/components/Meter'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorIcon, ErrorState, Loading } from '@renderer/components/States'
import { HEALTH_STYLE, StatusDot } from '@renderer/components/Status'
import { useUpdateParams } from '@renderer/hooks/update-params'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import {
  clusterStatus,
  fleetLabels,
  groupBy,
  hasLabels,
  labelText,
  shows,
  type FleetFilter,
} from '@renderer/lib/fleet'
import { percent, pluralize } from '@renderer/lib/format'
import { HEALTH_RANK, statusOf } from '@renderer/lib/health'
import { matchWords } from '@renderer/lib/match'
import { clusterPath, formatRef, workloadsPath } from '@renderer/lib/routes'
import { useSession } from '@renderer/state/session'
import { AccountMenu } from '../session/AccountMenu'
import { ServerBanner } from '../session/ServerBanner'
import { Commands } from '../shell/Commands'
import { menuContent, menuItem } from '../shell/menu-styles'
import { ShortcutsDialog } from '../shell/ShortcutsDialog'
import { ServerAssistantsButton } from '../assistants/ServerAssistantsDialog'
import { ThemeMenu } from '../shell/ThemeMenu'

/** How often each cluster is summed up again, while the page is open. */
const REFRESH_MS = 30_000
const COUNT = new Intl.NumberFormat()

const FILTERS: { id: FleetFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'unreachable', label: 'Unreachable' },
]

interface Item {
  context: KubeContext
  summary?: ClusterSummary
  status: Status
}

/**
 * A fleet's home: every cluster this person may see, summed up as their
 * overviews would, what needs attention first. Filters, labels and grouping
 * live in the URL, so Back and Forward restore them.
 */
export function FleetPage() {
  const session = useSession()!
  const [params] = useSearchParams()
  const update = useUpdateParams()
  const contexts = useQuery({
    queryKey: ['contexts'],
    queryFn: () => api.kube.contexts(),
    refetchInterval: REFRESH_MS,
  })
  const all = contexts.data?.contexts ?? []
  const summaries = useQueries({
    queries: all.map(({ name }) => ({
      queryKey: ['fleet-summary', name],
      queryFn: () => api.fleet!.summary(name),
      refetchInterval: REFRESH_MS,
    })),
  })

  useEffect(() => {
    document.title = 'Clusters — Lumovi'
  }, [])

  const q = params.get('q') ?? ''
  const show = (FILTERS.find((f) => f.id === params.get('show'))?.id ?? 'all') as FleetFilter
  const wanted = params.getAll('label')
  const group = params.get('group') ?? undefined
  const set = (key: string, value: string | undefined) =>
    update((p) => {
      if (value) p.set(key, value)
      else p.delete(key)
    })

  const items: Item[] = all
    .map((context, i) => {
      const summary = summaries[i]!.data
      return { context, summary, status: clusterStatus(summary) }
    })
    .sort(
      (a, b) =>
        HEALTH_RANK[a.status.health] - HEALTH_RANK[b.status.health] ||
        a.context.name.localeCompare(b.context.name),
    )
  const checking = items.filter((i) => !i.summary).length
  const attention = items.filter((i) => shows('attention', i.summary)).length
  const matching = items.filter(
    (i) =>
      hasLabels(i.context, wanted) &&
      matchWords(
        `${i.context.name} ${Object.entries(i.context.labels!)
          .map(([k, v]) => labelText(k, v))
          .join(' ')}`,
        q,
      ) > 0,
  )
  const visible = matching.filter((i) => shows(show, i.summary))
  const labels = fleetLabels(all)
  const keys = [...new Set(labels.map((l) => l.key))]

  return (
    <div className="vt-page flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-6">
        <Link to="/" aria-label="Lumovi: every cluster" className="mr-auto rounded-md">
          <LogoLockup className="h-6" />
        </Link>
        <ThemeMenu />
        {api.serverAssistants && <ServerAssistantsButton assistants={api.serverAssistants} />}
        <AccountMenu session={session} />
        <IconButton label="Lumovi on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
          <GithubMark />
        </IconButton>
      </header>
      <ServerBanner />
      <main id="content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-8 pb-12">
          {contexts.isPending ? (
            <Loading label="Reading this server’s clusters…" className="py-24" />
          ) : !contexts.data ? (
            // (Once it has them, it keeps showing them while it can't read them again.)
            <ErrorState
              error={contexts.error!}
              onRetry={() => void contexts.refetch()}
              className="py-24"
            />
          ) : all.length === 0 ? (
            <EmptyState icon={ServerOff} title="No clusters for you here" className="py-24">
              This Lumovi shows a fleet of clusters, but none of them is shared with you. Ask
              whoever runs it to add one, or to share one with your groups.
            </EmptyState>
          ) : (
            <>
              <h1 className="text-[30px] leading-[1.15] headline text-ink-1">
                {pluralize(all.length, 'cluster')}
                <span className="block text-ink-3">
                  {attention > 0
                    ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention`
                    : checking > 0
                      ? 'Checking each one…'
                      : 'All healthy'}
                </span>
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  value={q}
                  onChange={(value) => set('q', value)}
                  onArrowDown={() =>
                    document.querySelector<HTMLElement>('[data-cluster-card]')?.focus()
                  }
                  placeholder="Search clusters and labels…"
                  className="w-72"
                />
                <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1">
                  {FILTERS.map((filter) => {
                    const count = matching.filter((i) => shows(filter.id, i.summary)).length
                    if (count === 0 && filter.id !== show && filter.id !== 'all') return null
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        aria-pressed={show === filter.id}
                        onClick={() => set('show', filter.id === 'all' ? undefined : filter.id)}
                        className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-ink-2 transition-colors hover:text-ink-1 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong"
                      >
                        {filter.label}
                        <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="ml-auto flex items-center gap-1">
                  {keys.length > 0 && (
                    <GroupMenu keys={keys} group={group} onChange={(key) => set('group', key)} />
                  )}
                  <FindWorkload items={items} />
                </div>
              </div>
              {labels.length > 0 && (
                <div
                  role="group"
                  aria-label="Labels"
                  className="-mt-2 flex flex-wrap items-center gap-1.5"
                >
                  <Tag className="mr-0.5 size-3.5 text-ink-3" aria-hidden />
                  {labels.map(({ key, value, count }) => {
                    const text = labelText(key, value)
                    const on = wanted.includes(text)
                    return (
                      <button
                        key={text}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          update((p) => {
                            p.delete('label')
                            for (const label of on
                              ? wanted.filter((l) => l !== text)
                              : [...wanted, text]) {
                              p.append('label', label)
                            }
                          })
                        }
                        className="flex h-6 items-center gap-1 rounded-md border border-line px-2 font-mono text-2xs text-ink-2 transition-colors hover:text-ink-1 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong"
                      >
                        {text}
                        <span className="font-sans tabular-nums opacity-70">{count}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {visible.length === 0 ? (
                <EmptyState icon={Search} title="No clusters match">
                  <Button
                    className="mt-3"
                    onClick={() =>
                      update((p) => {
                        for (const key of ['q', 'show', 'label']) p.delete(key)
                      })
                    }
                  >
                    Show every cluster
                  </Button>
                </EmptyState>
              ) : group ? (
                groupBy(visible, group).map(({ value, items: grouped }) => (
                  <section key={value ?? ''} aria-label={value ?? `No ${group}`}>
                    <h2 className="mb-2.5 flex items-baseline gap-2 text-[13px] font-semibold text-ink-1">
                      {value === undefined ? (
                        <span className="text-ink-3">No {group}</span>
                      ) : (
                        <span className="font-mono">{labelText(group, value)}</span>
                      )}
                      <span className="text-xs font-normal text-ink-3 tabular-nums">
                        {grouped.length}
                      </span>
                    </h2>
                    <Cards items={grouped} />
                  </section>
                ))
              ) : (
                <Cards items={visible} />
              )}
            </>
          )}
        </div>
      </main>
      <Commands />
      <ShortcutsDialog />
    </div>
  )
}

function GroupMenu({
  keys,
  group,
  onChange,
}: {
  keys: string[]
  group: string | undefined
  onChange: (key: string | undefined) => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" className="h-8 text-xs">
          <Layers /> {group ? `Grouped by ${group}` : 'Group by'}
          <ChevronDown className="size-3.5 text-ink-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
          <DropdownMenu.RadioGroup
            value={group ?? ''}
            onValueChange={(value) => onChange(value || undefined)}
          >
            {['', ...keys].map((key) => (
              <DropdownMenu.RadioItem key={key} value={key} className={menuItem}>
                <span className={cn('flex-1', key && 'font-mono')}>{key || 'Nothing'}</span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 text-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Cards({ items }: { items: Item[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <ClusterCard key={item.context.name} {...item} />
      ))}
    </div>
  )
}

/** A cluster, summed up as its overview's tiles: it opens the cluster. */
function ClusterCard({ context, summary, status }: Item) {
  const version = summary?.version
  return (
    <Link
      data-cluster-card
      to={clusterPath(context.name)}
      aria-label={`${context.name}, ${status.label}`}
      className="@container flex min-w-0 animate-rise flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4 shadow-panel transition-colors hover:border-line-strong hover:bg-surface"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <StatusDot health={status.health} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink-1">{context.name}</p>
          <p className={cn('truncate text-xs', HEALTH_STYLE[status.health].text)}>{status.label}</p>
        </div>
        {version?.ok && (
          <span className="shrink-0 pt-0.5 text-right font-mono text-xs text-ink-3">
            {version.data.gitVersion}
            <span className="block">{version.data.latencyMs} ms</span>
          </span>
        )}
      </div>
      {Object.keys(context.labels!).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(context.labels!).map(([key, value]) => (
            <span
              key={key}
              className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
            >
              {labelText(key, value)}
            </span>
          ))}
        </div>
      )}
      {!summary ? (
        <div aria-hidden className="grid grid-cols-2 gap-3 @md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-11 animate-shimmer rounded-md bg-surface-3" />
          ))}
        </div>
      ) : !summary.version.ok ? (
        <Problem error={summary.version.error} />
      ) : (
        <Answered summary={summary as Required<ClusterSummary>} />
      )}
    </Link>
  )
}

/** Why a cluster can't be shown (its status above says what kind of problem it is). */
function Problem({ error }: { error: KubeError }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-surface-3 px-3 py-2.5">
      <ErrorIcon code={error.code} className="mt-0.5 size-4 shrink-0 text-critical-text" />
      <p className="min-w-0 text-[13px] leading-relaxed break-words text-ink-2 selectable">
        {error.message}
      </p>
    </div>
  )
}

function Answered({ summary }: { summary: Required<ClusterSummary> }) {
  const { nodes, pods, workloads, warnings, usage } = summary
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 @md:grid-cols-4">
        <Stat
          label="Nodes"
          part={nodes}
          value={(n) => `${COUNT.format(n.ready)}/${COUNT.format(n.total)}`}
        >
          {(n) =>
            n.ready < n.total ? (
              <Detail health="critical">{n.total - n.ready} not ready</Detail>
            ) : (
              <Detail health="healthy">All ready</Detail>
            )
          }
        </Stat>
        <Stat
          label="Pods running"
          part={pods}
          value={(p) => `${COUNT.format(p.running)}${p.truncated ? '+' : ''}`}
        >
          {(p) =>
            p.unhealthy > 0 ? (
              <Detail health="warning">{COUNT.format(p.unhealthy)} unhealthy</Detail>
            ) : p.total === 0 ? (
              <span className="text-ink-3">None yet</span>
            ) : (
              <Detail health="healthy">All fine</Detail>
            )
          }
        </Stat>
        <Stat
          label="Workloads"
          part={workloads}
          value={(w) =>
            w.total === 0 ? '0' : `${COUNT.format(w.healthy)}/${COUNT.format(w.total)}`
          }
        >
          {(w) =>
            w.healthy < w.total ? (
              <Detail health="warning">{COUNT.format(w.total - w.healthy)} degraded</Detail>
            ) : w.total === 0 ? (
              <span className="text-ink-3">None yet</span>
            ) : (
              <Detail health="healthy">Healthy</Detail>
            )
          }
        </Stat>
        <Stat label="Warnings" part={warnings} value={(w) => COUNT.format(w.lastHour)}>
          {() => <span className="text-ink-3">Last hour</span>}
        </Stat>
      </dl>
      <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
        {(['cpu', 'memory'] as const).map((resource) => {
          const label = resource === 'cpu' ? 'CPU' : 'Memory'
          const capacity = usage.ok && usage.data?.[resource]
          return (
            <div key={resource} className="min-w-0">
              <p className="mb-1.5 flex items-baseline justify-between text-xs">
                <span className="text-ink-3">{label}</span>
                <span className="text-ink-2 tabular-nums">
                  {capacity
                    ? percent(capacity.used / capacity.total)
                    : usage.ok
                      ? 'No metrics'
                      : 'No access'}
                </span>
              </p>
              {capacity ? (
                <Meter value={capacity.used / capacity.total} label={`${label} in use`} />
              ) : (
                <span className="block h-1.5 rounded-full bg-surface-3" />
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

/** One of a card's counts, or "No access" where the person may not list its kind. */
function Stat<T>({
  label,
  part,
  value,
  children,
}: {
  label: string
  part: Result<T>
  value: (data: T) => string
  children: (data: T) => ReactNode
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[17px] leading-6 font-semibold text-ink-1 tabular-nums">
        {part.ok ? value(part.data) : '—'}
      </dd>
      <dd className="truncate text-xs" title={part.ok ? undefined : part.error.message}>
        {part.ok ? children(part.data) : <span className="text-ink-3">No access</span>}
      </dd>
    </div>
  )
}

function Detail({ health, children }: { health: Status['health']; children: ReactNode }) {
  return (
    <span className={cn('flex items-center gap-1', HEALTH_STYLE[health].text)}>
      <StatusDot health={health} className="size-1.5" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** The kinds a workload search looks through. */
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'] as const
/** Results shown at most; the rest are counted. */
const MAX_RESULTS = 50

/** Workloads by name, in every cluster that answered: a dialog the toolbar opens. */
function FindWorkload({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" className="h-8 text-xs">
          <PackageSearch /> Find a workload
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[680px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Find a workload</Dialog.Title>
          <WorkloadSearch items={items} onOpen={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function WorkloadSearch({ items, onOpen }: { items: Item[]; onOpen: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])
  const reachable = items.filter((i) => i.summary?.version.ok).map((i) => i.context.name)
  const searching = debounced.length >= 2
  const lists = useQueries({
    queries: reachable.flatMap((context) =>
      WORKLOAD_KINDS.map((kind) => ({
        queryKey: ['fleet-workloads', context, kind],
        queryFn: () => api.kube.list({ context, kind }),
        enabled: searching,
        staleTime: REFRESH_MS,
      })),
    ),
  })
  const found = searching
    ? lists.flatMap((list, i) => {
        if (!list.data?.ok) return []
        const context = reachable[Math.floor(i / WORKLOAD_KINDS.length)]!
        const kind = WORKLOAD_KINDS[i % WORKLOAD_KINDS.length]!
        return list.data.data.items
          .filter((o) => matchWords(`${o.metadata.name} ${o.metadata.namespace}`, debounced) > 0)
          .map((object) => ({ context, kind, object }))
      })
    : []
  const pending = searching && lists.some((l) => l.isPending)
  const shown = found.slice(0, MAX_RESULTS)
  return (
    <Command shouldFilter={false} label="Workload name">
      <div className="flex h-12 items-center gap-3 border-b border-line px-4">
        <PackageSearch className="size-4 shrink-0 text-ink-3" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Find a workload by name or namespace…"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink-1 outline-none placeholder:text-ink-3"
        />
      </div>
      {shown.length > 0 ? (
        <Command.List label="Workloads found" className="max-h-[420px] overflow-y-auto p-2">
          {shown.map(({ context, kind, object }) => {
            const status = statusOf(kind, object)
            const { name, namespace } = object.metadata
            const key = `${context}/${kind}/${namespace}/${name}`
            return (
              <Command.Item
                key={key}
                value={key}
                onSelect={() => {
                  onOpen()
                  void navigate(
                    `${workloadsPath(context)}?open=${encodeURIComponent(formatRef({ kind, name, namespace }))}`,
                  )
                }}
                className="flex h-11 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13.5px] select-none data-[selected=true]:bg-surface-3"
              >
                <StatusDot health={status.health} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink-1">{name}</span>
                  <span className="text-ink-3">
                    {' '}
                    · {kind} in {namespace}
                  </span>
                </span>
                <span className={cn('shrink-0 text-xs', HEALTH_STYLE[status.health].text)}>
                  {status.label}
                </span>
                <span className="w-28 shrink-0 truncate text-right font-mono text-xs text-ink-2">
                  {context}
                </span>
              </Command.Item>
            )
          })}
        </Command.List>
      ) : (
        <div className="px-6 py-10 text-center text-[13px] text-ink-3">
          {!searching ? (
            <>
              In {pluralize(reachable.length, 'cluster')}: their Deployments, StatefulSets,
              DaemonSets and CronJobs.
            </>
          ) : pending ? (
            <Loading
              label={`Looking in ${pluralize(reachable.length, 'cluster')}…`}
              className="py-0"
            />
          ) : (
            <>No workload here is called “{debounced}”.</>
          )}
        </div>
      )}
      <footer className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
        {found.length > MAX_RESULTS ? (
          <span>
            And {found.length - MAX_RESULTS} more: type more of a name to narrow them down.
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>{' '}
              to open
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Kbd>esc</Kbd> to close
        </span>
      </footer>
    </Command>
  )
}
