import { useLayout } from '@renderer/lib/layout'
import { Info, Pin, PinOff, SearchX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import {
  apiKindOf,
  isBuiltinKind,
  listNoun,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { kindIcon } from '@renderer/components/KindIcon'
import {
  EmptyState,
  ErrorState,
  Loading,
  StaleNotice,
  UnreadNotice,
} from '@renderer/components/States'
import { useGo } from '@renderer/hooks/go'
import { usePluginOf } from '@renderer/hooks/plugins'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useUpdateParams } from '@renderer/hooks/update-params'
import { objectKey, useListResponse, useListTotals, useMetrics } from '@renderer/hooks/queries'
import { useResource } from '@renderer/hooks/resources'
import { usePlugins } from '@renderer/hooks/plugins'
import type { KubeApiError } from '@renderer/lib/api'
import { namespacesParam, readOf, scopeOf } from '@renderer/lib/namespaces'
import { hasHealth, healthName, statusFor, statusOf, type Health } from '@renderer/lib/health'
import { fieldValue, listedPlugins, viewFor } from '@renderer/lib/plugins'
import { pinnable } from '@renderer/lib/marks'
import { isWorkloadType } from '@renderer/lib/workloads'
import { useManagers } from '@renderer/hooks/managers'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { countOf, SelectionBar } from '../actions/BulkActions'
import { usePageRoom } from '../details/SidePanel'
import { holdsTimeline, leastForTimeline, ShownAs, Timeline, useWidth } from '../events/Timeline'
import type { TimelineSelection } from '../events/timeline-rows'
import { PluginTabs } from '../plugins/PluginPage'
import { WorkloadTabs } from '../workloads/WorkloadTabs'
import {
  columnsFor,
  customColumnsFor,
  metricsKey,
  sortedBy,
  sortRows,
  withManagedBy,
  type CellContext,
} from './columns'
import { SearchInput } from '@renderer/components/SearchInput'
import { atOne, atOneEmpty, AtOneNote, clearAtOne, nameSelector } from './AtOne'
import { useListColumns } from './ColumnsMenu'
import { useListState } from './list-state'
import {
  countBy,
  HealthChips,
  LabelSelector,
  ListBar,
  SortButton,
  type LabelSelectorHandle,
} from './ListToolbar'
import { Pagination } from './Pagination'
import { ResourceTable } from './ResourceTable'
import { TableSkeleton } from './TableSkeleton'
import { openView, VIEW_PARAM, viewOfList } from './views'
import { useOpenView, ViewsMenu, viewWords } from './ViewsMenu'

const METRICS_TARGET: Partial<Record<ResourceKind, 'pods' | 'nodes'>> = {
  Pod: 'pods',
  Node: 'nodes',
}

const number = new Intl.NumberFormat()
/** The room each side of the list's toolbar, which a timeline of events keeps too. */
const INSET = 20
/** A page narrower than this (one beside an open panel) has List | Timeline as icons alone. */
const COMPACT_TOOLBAR = 900

/** The text the filter box matches against, with what the server's columns show. */
function searchText(object: KubeObject, cells: unknown[] = []): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const event =
    object.kind === 'Event'
      ? [object.reason, object.message, (object.involvedObject as { name: string }).name]
      : []
  return [object.metadata.name, object.metadata.namespace, ...labels, ...event, ...cells]
    .join(' ')
    .toLowerCase()
}

/** The list of a kind the cluster serves beyond the built-in ones (`r/:kind`). */
export function CustomResourcePage() {
  const kind = useParams().kind!
  const { context } = useCluster()
  const { resource, pending, error, retry } = useResource(kind)
  if (resource) return <ResourcePage key={kind} resource={resource} />
  if (pending) return <Loading label={`Loading ${apiKindOf(kind)}…`} />
  if (error) return <ErrorState error={error as KubeApiError} onRetry={retry} />
  return (
    <EmptyState icon={kindIcon(kind)} title={`${context} doesn’t serve ${kind}`}>
      Its CustomResourceDefinition may have been removed, or never installed in this cluster.
    </EmptyState>
  )
}

export function ResourcePage({ resource }: { resource: ResourceDefinition }) {
  const kind = resource.kind
  const builtin = isBuiltinKind(kind)
  const noun = listNoun(resource.label, builtin)
  const { context, namespace, namespaces } = useCluster()
  const touchKind = usePrefs((prefs) => prefs.touchKind)
  // Custom kinds opened lately stay at hand in the sidebar.
  useEffect(() => {
    if (!builtin) touchKind(context, kind)
  }, [builtin, context, kind, touchKind])
  const [params] = useSearchParams()
  // Views decide the columns, status and icon of the kinds they cover.
  usePlugins()
  const plugin = usePluginOf(builtin ? undefined : kind)
  const showNamespace = resource.namespaced && namespace === null
  // Built-in kinds know their columns; others learn them, and whether they have a status, from the list.
  const builtinColumns = builtin
    ? columnsFor(kind, { showNamespace, hasHealth: hasHealth(kind) })
    : undefined
  const [state, update] = useListState(builtinColumns?.defaultSort ?? 'status')
  // At one object, where a plugin's page opened it so: that one alone, read where it is.
  const at = atOne(params, kind, listedPlugins())
  const updateParams = useUpdateParams()
  const clearAt = () => updateParams(clearAtOne, { replace: true })
  const gridRef = useRef<HTMLDivElement>(null)
  const phone = useLayout() === 'phone'
  // Events can be drawn on a timeline (?as=timeline), where the page is wide enough for one: on
  // a phone, or narrower, the address opens the list.
  const [pageBox, pageWidth] = useWidth<HTMLDivElement>()
  const timelineOffered = kind === 'Event' && !phone && holdsTimeline(pageWidth, 'page', INSET)
  const asTimeline = timelineOffered && params.get('as') === 'timeline'
  const showAs = (as: 'list' | 'timeline') =>
    updateParams((next) => (as === 'timeline' ? next.set('as', as) : next.delete('as')), {
      replace: true,
    })
  const [timeline, setTimeline] = useState<TimelineSelection>({ range: 'all' })
  // A panel opened from the timeline opens over it, where beside it would leave too little for
  // one: what was clicked never turns into a list under the click.
  const keepRoom = usePageRoom((room) => room.keep)
  useEffect(() => {
    if (!asTimeline) return
    keepRoom(leastForTimeline(INSET))
    return () => keepRoom(undefined)
  }, [asTimeline, keepRoom])
  // Rows picked for bulk actions, for this list only.
  const scopeKey = `${kind}/${namespacesParam(namespaces) ?? null}/${at ? `${at.namespace ?? ''}/${at.name}` : ''}`
  const [picked, setPicked] = useState<{ scope: string; keys: ReadonlySet<string> }>({
    scope: scopeKey,
    keys: new Set(),
  })
  if (picked.scope !== scopeKey) setPicked({ scope: scopeKey, keys: new Set() })
  const labelsRef = useRef<LabelSelectorHandle>(null)

  const query = at
    ? {
        // (In its own namespace, whichever are picked: the page that opened it said where it is.
        // Named without one, by hand, it's looked for where the list looks.)
        namespace: resource.namespaced ? at.namespace : null,
        fieldSelector: nameSelector(at.name),
        labelSelector: state.labels || undefined,
      }
    : {
        namespace: resource.namespaced ? undefined : null,
        labelSelector: state.labels || undefined,
      }
  const response = useListResponse(kind, query)
  const list = { ...response, data: response.data?.items }
  const totals = useListTotals(kind, query)
  const table = response.data?.table
  const items = list.data ?? []
  const view = builtin ? undefined : viewFor(kind)
  const withHealth = builtin
    ? hasHealth(kind)
    : items.some((object) => statusFor(kind, object) !== null)
  const { columns: ownColumns, defaultSort } =
    builtinColumns ?? customColumnsFor({ kind, showNamespace, hasHealth: withHealth, view, table })
  // What manages each workload, where a plugin says what can and the cluster serves it.
  const managers = useManagers(isWorkloadType(kind))
  const columns = managers ? withManagedBy(ownColumns, () => kind) : ownColumns
  const cells = table
    ? new Map(items.map((item, i) => [item, table.cells[i]!] as const))
    : undefined
  // The filter also matches what the view's or the server's columns show.
  const shownValues = (object: KubeObject): unknown[] | undefined =>
    view?.columns
      ? view.columns.map((column) => fieldValue(column, object).text)
      : cells?.get(object)
  const metricsTarget = METRICS_TARGET[kind]
  const metrics = useMetrics(
    metricsTarget ?? 'pods',
    resource.namespaced ? namespaces : null,
    metricsTarget !== undefined,
  )

  const open = useOpenObject()
  const ctx: CellContext = {
    // Ages are relative to the last refresh, which keeps rendering pure.
    now: list.dataUpdatedAt,
    open,
    cells,
    managers,
    metrics: metrics.data?.available
      ? new Map(
          metrics.data.items.map((sample) => [metricsKey(sample.namespace, sample.name), sample]),
        )
      : undefined,
  }

  const counts = countBy(withHealth ? items : [], (object) => statusOf(kind, object).health)
  // The columns as the person chose them for this kind in this cluster.
  const chosen = useListColumns({
    list: kind,
    columns,
    listed: items,
    ctx,
    title: resource.label,
    count: (n) => countOf(kind, n),
    namespaced: resource.namespaced,
  })
  const shown = chosen.columns
  // The saved views: what the list shows now, and the one it was opened as (the address says).
  const go = useGo()
  const current = viewOfList({
    name: '',
    kind,
    state,
    namespaced: resource.namespaced,
    namespaces,
    columns: usePrefs((prefs) => prefs.columns[`${context}/${kind}`]),
  })
  const openName = params.get(VIEW_PARAM) ?? undefined
  const opened = useOpenView(current, openName)
  const views = (
    <ViewsMenu
      current={current}
      open={openName}
      kinds={noun}
      onOpen={(view) => openView(context, view, go)}
      onNamed={(name) => updateParams((next) => next.set(VIEW_PARAM, name), { replace: true })}
    />
  )

  const needle = state.q.trim().toLowerCase()
  const { column, desc } = sortedBy(shown, state, defaultSort, columns)
  const matching = items
    .filter((o) => state.health.length === 0 || state.health.includes(statusOf(kind, o).health))
    .filter((o) => !needle || searchText(o, shownValues(o)).includes(needle))
  const rows = sortRows(matching, column, desc, ctx)
  const pages = Math.max(1, Math.ceil(rows.length / state.size))
  const page = Math.min(state.page, pages)
  const pageRows = rows.slice((page - 1) * state.size, page * state.size)
  // Only what's on screen: rows hidden by a filter since stay out of it.
  const pickedRows = rows.filter((o) => picked.keys.has(objectKey(o)))

  const toggleHealth = (health: Health) =>
    update({
      health: state.health.includes(health)
        ? state.health.filter((h) => h !== health)
        : [...state.health, health],
    })
  const onSort = (id: string) => update({ sort: id, desc: column.id === id ? !desc : false })
  const goToPage = (next: number) => update({ page: Math.max(1, Math.min(pages, next)) })
  // (What couldn't be read is said above the list, and isn't counted where nothing was found.)
  const unread = response.data?.unread
  const scope = resource.namespaced ? scopeOf(readOf(namespaces, unread)) : 'in this cluster'
  const notice = <UnreadNotice unread={unread} noun={noun} />

  let body
  if (list.isPending) {
    body = <TableSkeleton columns={shown} label={`Loading ${noun}`} />
  } else if (!list.data) {
    body = <ErrorState error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
  } else if (items.length === 0 && at) {
    body = (
      <>
        {notice}
        <EmptyState
          icon={kindIcon(kind)}
          title={atOneEmpty(at, resource.apiKind, resource.namespaced, scope)}
        />
      </>
    )
  } else if (items.length === 0) {
    body = (
      <>
        {notice}
        <EmptyState icon={kindIcon(kind)} title={`No ${noun} ${scope}`}>
          {state.labels
            ? `Nothing matches the label selector “${state.labels}”.`
            : resource.namespaced && namespaces
              ? namespace
                ? 'Try another namespace, or all namespaces.'
                : 'Pick other namespaces, or all of them.'
              : 'Nothing to show yet.'}
        </EmptyState>
      </>
    )
  } else if (asTimeline) {
    body = (
      <>
        {list.isError && (
          <StaleNotice error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
        )}
        {notice}
        <Timeline
          events={matching}
          by="object"
          now={list.dataUpdatedAt}
          showNamespace={namespace === null}
          filtered={needle !== '' || state.health.length > 0}
          selection={timeline}
          onSelection={setTimeline}
          onOpenEvent={(event) => open('Event', event.metadata.name, event.metadata.namespace)}
          onOpenObject={(row) => row.kind && open(row.kind, row.name, row.namespace)}
          inset={INSET}
        />
      </>
    )
  } else if (rows.length === 0) {
    body = (
      <>
        {notice}
        <EmptyState icon={SearchX} title="Nothing matches">
          No {noun} match the current filters.
        </EmptyState>
      </>
    )
  } else {
    body = (
      <>
        {list.isError && (
          <StaleNotice error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
        )}
        {notice}
        <ResourceTable
          resetKey={`${page}/${state.size}`}
          ref={gridRef}
          label={resource.label}
          columns={shown}
          rows={pageRows}
          ctx={ctx}
          selected={params.get('open')?.replace(`${kind}/`, '')}
          sort={{ id: column.id, desc }}
          onSort={onSort}
          onOpen={(o) => open(kind, o.metadata.name, o.metadata.namespace)}
          onPage={(delta) => goToPage(page + delta)}
          followSelection={params.has('open')}
          picked={kind === 'Event' ? undefined : picked.keys}
          onPick={kind === 'Event' ? undefined : (keys) => setPicked({ scope: scopeKey, keys })}
          layout={chosen.layout}
          onCopy={() => chosen.copy(pickedRows)}
          pins={pinnable(kind)}
        />
        <SelectionBar
          noun={noun}
          objects={pickedRows}
          onClear={() => setPicked({ scope: scopeKey, keys: new Set() })}
          onCopy={() => chosen.copy(pickedRows)}
        />
        <Pagination
          page={page}
          size={state.size}
          count={rows.length}
          onPage={goToPage}
          onSize={(size) => update({ size })}
        />
      </>
    )
  }

  return (
    <div ref={pageBox} className="relative flex h-full flex-col">
      {isWorkloadType(kind) && <WorkloadTabs current={kind} />}
      {plugin && <PluginTabs served={plugin} current={kind} />}
      {phone ? (
        // On a phone: the filter with its two buttons, then what's listed and how it's doing.
        <div className="shrink-0 border-b border-line px-4 pt-3">
          <div className="flex gap-2">
            <SearchInput
              value={state.q}
              onChange={(q) => update({ q })}
              onArrowDown={() => gridRef.current?.focus()}
              placeholder={`Filter ${noun}`}
              className="min-w-0 flex-1"
            />
            <LabelSelector
              ref={labelsRef}
              value={state.labels}
              onApply={(labels) => update({ labels })}
              compact
            />
            <SortButton columns={shown} sort={{ id: column.id, desc }} onSort={onSort} />
            {chosen.button(rows)}
            {views}
          </div>
          <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-4 py-2">
            <span className="mr-1 text-[13px] text-ink-2">
              <span className="tabular-nums">{number.format(items.length)}</span>{' '}
              {items.length === 1 ? 'item' : 'items'}
            </span>
            <HealthChips
              counts={counts}
              active={state.health}
              onToggle={toggleHealth}
              name={(health) => healthName(kind, health)}
            />
          </div>
          {/* (The square says no name: the view open is said here, under the bar.) */}
          {opened && (
            <p className="-mt-1 truncate pb-2 text-[13px] text-ink-2">View: {viewWords(opened)}</p>
          )}
        </div>
      ) : (
        <ListBar
          count={`${number.format(items.length)} ${items.length === 1 ? 'item' : 'items'}`}
          views={views}
          chips={
            counts.size > 0 && (
              <HealthChips
                counts={counts}
                active={state.health}
                onToggle={toggleHealth}
                name={(health) => healthName(kind, health)}
              />
            )
          }
          before={!builtin && <PinButton kind={kind} label={resource.label} />}
          note={metrics.data?.available === false ? 'Live usage needs metrics-server' : undefined}
          labels={state.labels}
          onLabels={(labels) => update({ labels })}
          labelsRef={labelsRef}
          filter={state.q}
          noun={noun}
          onFilter={(q) => update({ q })}
          onArrowDown={() => gridRef.current?.focus()}
          after={
            <>
              {/* (A timeline has no columns to choose.) */}
              {!asTimeline && chosen.button(rows)}
              {timelineOffered && (
                <ShownAs
                  as={asTimeline ? 'timeline' : 'list'}
                  onAs={showAs}
                  compact={pageWidth < COMPACT_TOOLBAR}
                />
              )}
            </>
          }
        />
      )}

      {at && (
        <AtOneNote
          at={at}
          apiKind={resource.apiKind}
          namespaced={resource.namespaced}
          onClear={clearAt}
        />
      )}

      {totals?.truncated && (
        <p
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-5 py-2 text-xs text-ink-2"
        >
          <Info className="size-3.5 shrink-0 text-ink-3" />
          <span className="flex-1">
            Showing the first {number.format(totals.loaded)}
            {totals.total ? ` of ${number.format(totals.total)}` : ''} {noun}. Choose a namespace or
            use a label selector to see the rest.
          </span>
          <button
            type="button"
            onClick={() => labelsRef.current?.focus()}
            className="font-medium text-accent-strong hover:underline"
          >
            Filter by label
          </button>
        </p>
      )}

      {body}
    </div>
  )
}

/** Pins a kind to the sidebar, above the custom resources, in every cluster that has it. */
function PinButton({ kind, label }: { kind: ResourceKind; label: string }) {
  const pinned = usePrefs((prefs) => prefs.pinned.includes(kind))
  const setPinned = usePrefs((prefs) => prefs.setPinned)
  return (
    <IconButton
      label={pinned ? `Unpin ${label} from the sidebar` : `Pin ${label} to the sidebar`}
      onClick={() => setPinned(kind, !pinned)}
    >
      {pinned ? <PinOff /> : <Pin />}
    </IconButton>
  )
}
