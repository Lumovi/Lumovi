import type { UseQueryResult } from '@tanstack/react-query'
import { Info, Lock, LoaderCircle, RotateCw } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { isBuiltinKind, type ResourceKind } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { MiddleTruncate, widthIn } from '@renderer/components/MiddleTruncate'
import { EmptyState } from '@renderer/components/States'
import { SelectionBar } from '@renderer/features/actions/BulkActions'
import {
  columnsFor,
  sortedBy,
  sortRows,
  type CellContext,
  type Column,
} from '@renderer/features/resources/columns'
import { countBy, HealthChips, ListBar } from '@renderer/features/resources/ListToolbar'
import { ResourceTable } from '@renderer/features/resources/ResourceTable'
import { useListState } from '@renderer/features/resources/list-state'
import { workloadColumns } from '@renderer/features/workloads/columns'
import { useListsAcross } from '@renderer/hooks/queries'
import { resourceFor } from '@renderer/hooks/resources'
import { useClusterName, useProduction } from '@renderer/hooks/settings'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { hasHealth, healthName, statusOf, type Health } from '@renderer/lib/health'
import { formatRef } from '@renderer/lib/routes'
import { listedWorkloads } from '@renderer/lib/workloads'
import type { PickedList } from '@renderer/lib/namespaces'
import { kindOf } from '../actions/common'
import { toast } from '@renderer/state/toasts'
import { isEditable } from '../actions/ActionSurfaces'
import { namesRow } from '@renderer/features/resources/column-choices'
import { ClusterDot } from './ClusterDot'
import { OnCluster, useSeveral } from './SeveralLayout'
import {
  clusterOf,
  fromCluster,
  ONLY_PARAM,
  OPEN_CLUSTER_PARAM,
  SEVERAL_PAGES,
  severalKey,
} from './set'

/** How long a cluster has to answer before it's given up on for this read. */
export const ANSWER_MS = 10_000

const number = new Intl.NumberFormat()

/** What one cluster's read came to, for its chip. */
type Read =
  | { state: 'unopened' }
  | { state: 'reading' }
  | { state: 'late' }
  | { state: 'refused' }
  | { state: 'failed'; error: KubeApiError }
  | {
      state: 'answered'
      count: number
      total?: number
      truncated: boolean
      /** Its last refresh failed: these are the rows it last answered with. */
      stale?: boolean
    }

/** Whether a read failed for the person's access, which asking again doesn't change. */
const refused = (error: unknown) =>
  (error as KubeApiError | null)?.code === 'forbidden' ||
  (error as KubeApiError | null)?.code === 'not-allowed'

/** The kinds a page merges, each read in every cluster of the set. */
function kindsOf(page: keyof typeof SEVERAL_PAGES): ResourceKind[] {
  if (page === 'workloads') {
    return ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'Pod']
  }
  return [SEVERAL_PAGES[page].kind]
}

/** One cluster's chip: its colour, its name and its count, or how its read went. */
function ClusterChip({
  context,
  read,
  only,
  noun,
  onOnly,
  onRetry,
  onOpen,
}: {
  context: string
  read: Read
  only: boolean
  noun: string
  onOnly: () => void
  onRetry: () => void
  onOpen: () => void
}) {
  const name = useClusterName()(context)
  const label = (() => {
    switch (read.state) {
      case 'unopened':
        return 'Signs in when opened'
      case 'reading':
        return 'Reading…'
      case 'late':
      case 'failed':
        return 'didn’t answer in time'
      case 'refused':
        return `your access doesn’t list ${noun}`
      case 'answered':
        return read.truncated && read.total !== undefined
          ? `${number.format(read.count)} of ${number.format(read.total)}`
          : number.format(read.count)
    }
  })()
  const bad = read.state === 'late' || read.state === 'failed'
  const stale = read.state === 'answered' && read.stale === true
  return (
    <span
      data-cluster={context}
      className={cn(
        // (One line, whatever its room: where even one chip is wider than the strip, its state's
        // words are cut, never its name or its button.)
        'flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] whitespace-nowrap',
        only ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
      )}
    >
      <button
        type="button"
        aria-pressed={only}
        disabled={read.state !== 'answered'}
        onClick={onOnly}
        className="flex min-w-0 items-center gap-1.5 disabled:cursor-default"
      >
        <ClusterDot context={context} />
        {/* (Its state's words give way first; then its name, cut in its middle; its button never.) */}
        <MiddleTruncate text={name} className="min-w-0 shrink font-medium text-ink-1" />
        {read.state === 'reading' && (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ink-3" />
        )}
        <span
          title={stale ? `${label} · couldn’t refresh · showing the last data` : label}
          className="flex min-w-0 shrink-[1000] gap-1.5"
        >
          <span className={cn('truncate text-ink-3', bad && 'text-critical-text')}>{label}</span>
          {stale && (
            <span className="truncate text-warn-text">
              couldn’t refresh · showing the last data
            </span>
          )}
        </span>
      </button>
      {(bad || stale) && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-accent-strong hover:underline"
        >
          Retry
        </button>
      )}
      {read.state === 'unopened' && (
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 text-accent-strong hover:underline"
        >
          Open
        </button>
      )}
    </span>
  )
}

/** The Cluster column's least: room for a name of about 16 characters and its Production mark. */
const CLUSTER_WIDTH = 250

/**
 * The Cluster column: the cluster's colour, its name and its Production mark. The name has its
 * room first: where it and the mark don't fit, the mark shortens to its first letter, and then
 * the name is cut in its middle, keeping its end (prod-eu and prod-us stay apart).
 */
function ClusterCell({ context }: { context: string }) {
  const name = useClusterName()(context)
  const production = useProduction(context)
  const cell = useRef<HTMLSpanElement>(null)
  const mark = useRef<HTMLSpanElement>(null)
  const [short, setShort] = useState(false)
  useLayoutEffect(() => {
    if (!production) return
    const span = cell.current!
    const fit = () => {
      const markStyle = getComputedStyle(mark.current!)
      const markPadding =
        Number.parseFloat(markStyle.paddingLeft) + Number.parseFloat(markStyle.paddingRight)
      // The dot, the two gaps, the name and the whole mark, against the cell's room.
      const gap = Number.parseFloat(getComputedStyle(span).columnGap) || 0
      const dot = (span.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
      const needs =
        dot + 2 * gap + widthIn(span)(name) + widthIn(mark.current!)('PRODUCTION') + markPadding
      setShort(needs > span.clientWidth + 0.5)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(span)
    void document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [name, production])
  return (
    <span ref={cell} className="flex w-full min-w-0 items-center gap-1.5">
      <ClusterDot context={context} />
      <MiddleTruncate text={name} className="min-w-0 flex-1" />
      {production && (
        <span
          ref={mark}
          title={short ? 'Production' : undefined}
          className="shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase"
        >
          {short ? <ShortProduction /> : 'Production'}
        </span>
      )}
    </span>
  )
}

/** The Production mark at its least: its first letter, read and titled as the word. */
function ShortProduction() {
  return (
    <>
      <span aria-hidden>P</span>
      <span className="sr-only">Production</span>
    </>
  )
}

/**
 * Where the Cluster column has given way (a narrow list beside the panel): the row's names, the
 * cluster under them, after the namespace, with its short Production mark where it's one.
 */
function NamesWithCluster({ object, names }: { object: KubeObject; names?: ReactNode }) {
  const context = clusterOf(object)
  const name = useClusterName()(context)
  const production = useProduction(context)
  const { namespace } = object.metadata
  const cluster = (
    <span className="flex min-w-0 items-center gap-1 text-xs text-ink-3">
      {!names && namespace && (
        <>
          <span className="max-w-[50%] shrink-0 truncate">{namespace}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <ClusterDot context={context} className="size-2" />
      <MiddleTruncate text={name} className="min-w-0" />
      {production && (
        <span
          title="Production"
          className="shrink-0 rounded bg-critical/10 px-1 text-2xs font-semibold text-critical-text"
        >
          <ShortProduction />
        </span>
      )}
    </span>
  )
  return (
    <span className="flex min-w-0 flex-col">
      {names ?? <MiddleTruncate text={object.metadata.name} className="font-medium text-ink-1" />}
      {cluster}
    </span>
  )
}

/** The columns a page shows, with the Cluster column after the name (or first, where there's none). */
function withCluster(columns: Column[], nameOf: (context: string) => string): Column[] {
  const cluster: Column = {
    id: 'cluster',
    header: 'Cluster',
    width: `minmax(${CLUSTER_WIDTH}px, 1fr)`,
    priority: 1,
    cell: (o) => <ClusterCell context={clusterOf(o)} />,
    sort: (o) => nameOf(clusterOf(o)),
    text: (o) => nameOf(clusterOf(o)),
    csv: { value: (o) => nameOf(clusterOf(o)) },
  }
  const at = columns.findIndex((column) => column.id === 'name')
  const index = at === -1 ? 1 : at + 1
  return [...columns.slice(0, index), cluster, ...columns.slice(index)]
}

/** What usage columns read: nothing here (one cluster's measures are its own page's). */
const USAGE = new Set(['cpu', 'memory'])

/** The text the filter box matches against. */
function searchText(object: KubeObject, cluster: string): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const event =
    object.kind === 'Event'
      ? [object.reason, object.message, (object.involvedObject as { name?: string }).name]
      : []
  return [object.metadata.name, object.metadata.namespace, cluster, ...labels, ...event]
    .join(' ')
    .toLowerCase()
}

/**
 * A page of several clusters: their lists of a kind merged, with a Cluster column; each cluster
 * read on its own, its chip saying how that went, and one slow or unreachable never holding the
 * others. A row's actions and its panel are its own cluster's.
 */
export function SeveralList() {
  const { page, contexts, reads, open: openCluster, namespaces } = useSeveral()
  const nameOf = useClusterName()
  const kinds = kindsOf(page)
  const main = kinds.length === 1 ? kinds[0]! : undefined
  const namespaced = main ? (resourceFor(main)?.namespaced ?? true) : true
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const only = params.get(ONLY_PARAM)
  const noun = SEVERAL_PAGES[page].noun
  const builtin = main
    ? columnsFor(main, { showNamespace: true, hasHealth: hasHealth(main) })
    : undefined
  const [state, update] = useListState(builtin?.defaultSort ?? 'status')
  const options = {
    namespace: namespaced ? undefined : null,
    labelSelector: state.labels || undefined,
  }
  // (A hook a kind, the same each render: a page's kinds don't change.)
  const reads0 = useListsAcross(contexts, namespaces, kinds[0]!, options, reads, ANSWER_MS)
  const reads1 = useListsAcross(
    kinds[1] ? contexts : [],
    namespaces,
    kinds[1] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const reads2 = useListsAcross(
    kinds[2] ? contexts : [],
    namespaces,
    kinds[2] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const reads3 = useListsAcross(
    kinds[3] ? contexts : [],
    namespaces,
    kinds[3] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const reads4 = useListsAcross(
    kinds[4] ? contexts : [],
    namespaces,
    kinds[4] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const reads5 = useListsAcross(
    kinds[5] ? contexts : [],
    namespaces,
    kinds[5] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const reads6 = useListsAcross(
    kinds[6] ? contexts : [],
    namespaces,
    kinds[6] ?? 'Pod',
    options,
    reads,
    ANSWER_MS,
  )
  const all = [reads0, reads1, reads2, reads3, reads4, reads5, reads6].slice(0, kinds.length)
  /** A cluster's reads, a kind each. */
  const of = (i: number): UseQueryResult<PickedList>[] => all.map((each) => each[i]!)
  const readOf = (context: string, i: number): Read => {
    if (!reads(context)) return { state: 'unopened' }
    const each = of(i)
    // (Not answered yet: its first read failed. One whose refresh failed keeps its last rows, as
    // one cluster's list does: a cluster under strain is the one whose failing pods matter.)
    const failure = each.find((r) => r.isError && !r.data)
    if (failure) {
      return refused(failure.error)
        ? { state: 'refused' }
        : { state: 'failed', error: failure.error as KubeApiError }
    }
    if (each.some((r) => r.isPending)) return { state: 'reading' }
    const lists = each.map((r) => r.data!)
    return {
      state: 'answered',
      ...(each.some((r) => r.isError) ? { stale: true } : {}),
      count: rowsOf(context, lists).length,
      truncated: lists.some((list) => list.truncated),
      ...(lists.every((list) => list.total !== undefined)
        ? {
            total:
              rowsOf(context, lists).length +
              lists.reduce((sum, l) => sum + (l.total! - l.items.length), 0),
          }
        : {}),
    }
  }
  /** A cluster's rows, from its lists: a workload's page leaves out what's another's. */
  function rowsOf(context: string, lists: PickedList[]): KubeObject[] {
    if (page !== 'workloads') return fromCluster(context, lists[0]!.items)
    const [Deployment, StatefulSet, DaemonSet, CronJob, Job, ReplicaSet, Pod] = lists.map(
      (l) => l.items,
    )
    return fromCluster(
      context,
      listedWorkloads({
        Deployment: Deployment!,
        StatefulSet: StatefulSet!,
        DaemonSet: DaemonSet!,
        CronJob: CronJob!,
        Job: Job!,
        ReplicaSet: ReplicaSet!,
        Pod: Pod!,
      }),
    )
  }
  const states = contexts.map((context, i) => ({ context, read: readOf(context, i) }))
  const answered = states.filter(({ read }) => read.state === 'answered')
  const items = states.flatMap(({ context, read }, i) =>
    read.state === 'answered'
      ? rowsOf(
          context,
          of(i).map((r) => r.data!),
        )
      : [],
  )
  const retry = (i: number) => of(i).forEach((r) => void r.refetch())

  // The columns: the kind's (or a workload's), without what one cluster's measures say, with the
  // Cluster column after the name.
  const base =
    builtin?.columns ?? workloadColumns({ showNamespace: true, usage: false, scalers: new Map() })
  // Which columns the list's width doesn't hold: the Cluster column's name goes to the row's names.
  const [unfit, setUnfit] = useState<string[]>([])
  const clusterGone = unfit.includes('cluster')
  const columns = withCluster(
    base.filter((column) => !USAGE.has(column.id)),
    nameOf,
  ).map((column) => ({
    ...column,
    // Drawn on the row's own cluster; what it opens (an event's object) opens there too. Where
    // the Cluster column has given way, the row's names say it.
    cell: (o: KubeObject, ctx: CellContext) => {
      const drawn = column.cell(o, {
        ...ctx,
        open: (kind, name, namespace) => openOn(clusterOf(o), kind, name, namespace),
      })
      return (
        <OnCluster context={clusterOf(o)}>
          {clusterGone && namesRow(column, base) ? (
            <NamesWithCluster object={o} {...(column.id === 'name' ? {} : { names: drawn })} />
          ) : (
            drawn
          )}
        </OnCluster>
      )
    },
  }))
  const openOn = (context: string, kind: ResourceKind, name: string, namespace?: string) =>
    updateParams((next) => {
      next.set('open', formatRef({ kind, name, namespace }))
      next.set(OPEN_CLUSTER_PARAM, context)
    })
  const ctx: CellContext = { now: Math.max(0, ...all.flat().map((r) => r.dataUpdatedAt)) }
  const withHealth = main ? hasHealth(main) : true
  const levelOf = (object: KubeObject): Health | undefined =>
    withHealth ? statusOf(kindOf(object), object).health : undefined
  // The chips and the count: of the clusters that answered, narrowed to one where it's pressed.
  const shownItems = only ? items.filter((o) => clusterOf(o) === only) : items
  const counts = countBy(
    withHealth ? shownItems.filter((object) => levelOf(object)) : [],
    (object) => levelOf(object)!,
  )
  const needle = state.q.trim().toLowerCase()
  const { column, desc } = sortedBy(columns, state, builtin?.defaultSort ?? 'status', columns)
  const matching = shownItems
    .filter((o) => state.health.length === 0 || state.health.includes(levelOf(o)!))
    .filter((o) => !needle || searchText(o, nameOf(clusterOf(o)).toLowerCase()).includes(needle))
  const rows = sortRows(matching, column, desc, ctx)

  // Rows ticked, for this set and kind: across clusters only to copy them.
  const scopeKey = `${page}/${contexts.join(',')}/${only ?? ''}`
  const [picked, setPicked] = useState<{ scope: string; keys: ReadonlySet<string> }>({
    scope: scopeKey,
    keys: new Set(),
  })
  if (picked.scope !== scopeKey) setPicked({ scope: scopeKey, keys: new Set() })
  const pickedRows = rows.filter((o) => picked.keys.has(severalKey(o)))
  const pickedOn = [...new Set(pickedRows.map(clusterOf))]
  const gridRef = useRef<HTMLDivElement>(null)

  const openKey = (() => {
    const ref = params.get('open')
    const on = params.get(OPEN_CLUSTER_PARAM)
    if (!ref || !on) return undefined
    const [kind, ns = '', name] = ref.split('/')
    return `${on}\u0000${(kind && resourceFor(kind)?.apiKind) ?? kind}\u0000${ns}/${name}`
  })()
  const capped = states.filter(
    (each): each is { context: string; read: Extract<Read, { state: 'answered' }> } =>
      each.read.state === 'answered' && each.read.truncated && each.read.total !== undefined,
  )

  const strip = (
    <div
      role="group"
      aria-label="Clusters"
      className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-2.5"
    >
      <span className="text-[13px] text-ink-2">
        <span className="font-medium text-ink-1">{answered.length}</span> of {contexts.length}{' '}
        answered
      </span>
      {states.map(({ context, read }, i) => (
        <ClusterChip
          key={context}
          context={context}
          read={read}
          noun={main ? (resourceFor(main)?.label ?? noun) : 'workloads'}
          only={only === context}
          onOnly={() =>
            updateParams((next) =>
              only === context ? next.delete(ONLY_PARAM) : next.set(ONLY_PARAM, context),
            )
          }
          onRetry={() => retry(i)}
          onOpen={() => openCluster(context)}
        />
      ))}
    </div>
  )
  const cappedLines = capped.map(({ context, read }) => (
    <p key={context} className="flex items-center gap-2 px-6 pt-2 text-xs text-ink-3">
      <Info className="size-3.5" aria-hidden />
      {nameOf(context)} shows the first {number.format(read.count)} of {number.format(read.total!)}{' '}
      {noun}. Choose a namespace or use a label selector to see the rest.
    </p>
  ))

  let body: ReactNode
  const unopened = states.filter(({ read }) => read.state === 'unopened')
  const failed = states.filter(({ read }) => read.state === 'late' || read.state === 'failed')
  if (unopened.length === contexts.length) {
    body = (
      <EmptyState icon={Lock} title="">
        Open a cluster above to list its {main ? (resourceFor(main)?.label ?? noun) : 'workloads'}.
      </EmptyState>
    )
  } else if (
    answered.length === 0 &&
    failed.length > 0 &&
    failed.length + unopened.length === contexts.length
  ) {
    const names = failed.map(({ context }) => nameOf(context))
    body = (
      <EmptyState
        icon={RotateCw}
        title={`None of the ${contexts.length} clusters answered`}
        footer={
          <Button
            variant="primary"
            onClick={() => failed.forEach(({ context }) => retry(contexts.indexOf(context)))}
          >
            <RotateCw /> Retry all
          </Button>
        }
      >
        Lumovi couldn’t reach {listed(names)} in time. Retry, or open one of them alone from the
        sidebar.
      </EmptyState>
    )
  } else {
    body = (
      <ResourceTable
        ref={gridRef}
        label={SEVERAL_PAGES[page].title}
        columns={columns}
        rows={rows}
        ctx={ctx}
        selected={openKey}
        sort={{ id: column.id, desc }}
        onSort={(id) => update({ sort: id, desc: column.id === id ? !desc : false })}
        onOpen={(o) => openOn(clusterOf(o), kindOf(o), o.metadata.name, o.metadata.namespace)}
        followSelection={params.has('open')}
        {...(page === 'events'
          ? {}
          : {
              picked: picked.keys,
              onPick: (keys: Set<string>) => setPicked({ scope: scopeKey, keys }),
            })}
        rowKey={severalKey}
        onUnfit={setUnfit}
        menuFor={(o, menu) => (
          <OnCluster context={clusterOf(o)}>
            <ContextMenu.Label className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              Actions on <ClusterDot context={clusterOf(o)} />
              <span className="normal-case">{nameOf(clusterOf(o))}</span>
            </ContextMenu.Label>
            {menu}
          </OnCluster>
        )}
      />
    )
  }

  const total = items.length
  const count = only
    ? `${number.format(rows.length)} of ${number.format(total)} ${noun}`
    : `${number.format(rows.length)} ${noun}`
  return (
    <div className="flex h-full min-h-0 flex-col">
      {strip}
      {cappedLines}
      <ListBar
        count={count}
        chips={
          <HealthChips
            counts={counts}
            active={state.health}
            onToggle={(health) =>
              update({
                health: state.health.includes(health)
                  ? state.health.filter((h) => h !== health)
                  : [...state.health, health],
              })
            }
            name={(health) => healthName(main && isBuiltinKind(main) ? main : 'Pod', health)}
          />
        }
        labels={state.labels}
        onLabels={(labels) => update({ labels })}
        filter={state.q}
        noun={noun}
        onFilter={(q) => update({ q })}
        onArrowDown={() => gridRef.current?.focus()}
      />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {pickedRows.length > 0 && (
        // (On one cluster, its own actions there; on several, none of them, each shown off with
        // why. A bulk action never spans clusters.)
        <OnCluster context={pickedOn[0]!}>
          <SelectionBar
            objects={pickedRows}
            noun={noun}
            onClear={() => setPicked({ scope: scopeKey, keys: new Set() })}
            {...(pickedOn.length > 1 ? { refused: acrossWhy(pickedOn.length) } : {})}
          />
          {pickedOn.length > 1 && (
            <AcrossKeys clusters={pickedOn.length} panelOpen={params.has('open')} />
          )}
        </OnCluster>
      )}
    </div>
  )
}

/** Why rows ticked on several clusters aren't acted on together. */
const acrossWhy = (clusters: number) =>
  `They’re on ${clusters} clusters: pick rows on one to act on them together.`

/**
 * Rows ticked on several clusters: the keys that would act on them ("." and ⌘⌫, where no panel
 * has them) say why they don't.
 */
function AcrossKeys({ clusters, panelOpen }: { clusters: number; panelOpen: boolean }) {
  useEffect(() => {
    if (panelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target) || document.querySelector('[role="dialog"], [role="menu"]'))
        return
      const mod = event.metaKey || event.ctrlKey
      if ((event.key === '.' && !mod && !event.altKey) || (event.key === 'Backspace' && mod)) {
        event.preventDefault()
        toast({ tone: 'info', title: acrossWhy(clusters) })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen, clusters])
  return null
}

/** "A, B or C". */
function listed(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}
