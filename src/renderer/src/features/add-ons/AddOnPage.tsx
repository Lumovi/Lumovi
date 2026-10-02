import { Info, SearchX } from 'lucide-react'
import { useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { kindOf } from '@shared/resources'
import { LinkTab, LinkTabs } from '@renderer/components/LinkTabs'
import { KindIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { useAddOns, type ServedAddOn } from '@renderer/hooks/add-ons'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useList, useListResponses } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import type { KubeApiError } from '@renderer/lib/api'
import { HEALTH_NAMES, HEALTH_RANK, statusOf } from '@renderer/lib/health'
import { addOnPath, kindPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { SelectionBar } from '../actions/BulkActions'
import {
  ageColumn,
  nameColumn,
  sortRows,
  withPriorities,
  type CellContext,
  type Column,
} from '../resources/columns'
import { useListState } from '../resources/list-state'
import { countBy, HealthChips, LabelSelector } from '../resources/ListToolbar'
import { Pagination } from '../resources/Pagination'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { rowKey } from '../workloads/columns'
import { ADD_ON_PAGES } from './integrations'

const number = new Intl.NumberFormat()
/** "Kustomizations, HelmReleases and GitRepositories": a list the way the app writes them. */
const list = new Intl.ListFormat('en-GB')

/** An add-on's page (`add-ons/:name`): its own overview, or everything of its kinds. */
export function AddOnPage() {
  const name = useParams().name!
  const resources = useResources()
  const served = useAddOns().find(({ addOn }) => addOn.name === name)
  if (served) {
    const integration = ADD_ON_PAGES[name]
    return (
      <div className="relative flex h-full flex-col">
        <AddOnTabs served={served} />
        {integration ? <integration.Page /> : <AddOnObjects served={served} />}
      </div>
    )
  }
  if (resources.isPending) return <Loading label="Looking at what the cluster serves…" />
  if (!resources.data) {
    return (
      <ErrorState
        error={resources.error as KubeApiError}
        onRetry={() => void resources.refetch()}
      />
    )
  }
  return (
    <EmptyState icon={SearchX} title="This cluster doesn’t have it">
      None of the kinds of “{name}” are served here: its CRDs may have been removed, or never
      installed in this cluster.
    </EmptyState>
  )
}

/**
 * An add-on's page and each of its kinds' lists (with that kind's columns and
 * actions), one tab apart.
 */
export function AddOnTabs({ served, current }: { served: ServedAddOn; current?: string }) {
  const { context } = useCluster()
  const { addOn, kinds } = served
  return (
    <LinkTabs label={addOn.label}>
      <LinkTab
        to={addOnPath(context, addOn.name)}
        active={!current}
        label={ADD_ON_PAGES[addOn.name]?.label ?? 'All'}
      />
      {kinds.map((resource) => (
        <KindTab
          key={resource.kind}
          kind={resource.kind}
          label={resource.label}
          namespaced={resource.namespaced}
          active={resource.kind === current}
        />
      ))}
    </LinkTabs>
  )
}

function KindTab({
  kind,
  label,
  namespaced,
  active,
}: {
  kind: string
  label: string
  namespaced: boolean
  active: boolean
}) {
  const { context } = useCluster()
  const count = useList(kind, { namespace: namespaced ? undefined : null }).data?.length
  return <LinkTab to={kindPath(context, kind)} active={active} label={label} count={count} />
}

/** What an object's status says beyond its label, like why it failed. */
const messageColumn: Column = {
  id: 'message',
  header: 'Message',
  width: 'minmax(200px, 2fr)',
  cell: (o) => {
    const { detail } = statusOf(kindOf(o), o)
    return detail ? (
      <span className="truncate text-ink-2" title={detail}>
        {detail}
      </span>
    ) : (
      <span className="text-ink-3">—</span>
    )
  },
  sort: (o) => statusOf(kindOf(o), o).detail ?? '',
}

/** The columns of an add-on's objects, whatever their kind; messages only when there are any. */
function objectColumns(showNamespace: boolean, messages: boolean): Column[] {
  return withPriorities([
    nameColumn(showNamespace),
    {
      id: 'type',
      header: 'Type',
      width: 'minmax(150px, 0.8fr)',
      cell: (o) => (
        <span className="flex min-w-0 items-center gap-2 text-ink-2">
          <KindIcon kind={kindOf(o)} className="size-3.5 shrink-0 text-ink-3" />
          <span className="truncate">{o.kind}</span>
        </span>
      ),
      sort: (o) => o.kind!,
    },
    {
      id: 'status',
      header: 'Status',
      width: 'minmax(168px, 1fr)',
      cell: (o) => <StatusPill status={statusOf(kindOf(o), o)} />,
      sort: (o) => HEALTH_RANK[statusOf(kindOf(o), o).health],
    },
    ...(messages ? [messageColumn] : []),
    ageColumn,
  ])
}

/** The text the filter box matches: names, namespaces, kinds, labels and what the status says. */
function searchText(object: KubeObject): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const status = statusOf(kindOf(object), object)
  return [
    object.metadata.name,
    object.metadata.namespace,
    object.kind,
    ...labels,
    status.label,
    status.detail,
  ]
    .join(' ')
    .toLowerCase()
}

/** Every object of an add-on's kinds in one list, the ones in trouble first. */
function AddOnObjects({ served }: { served: ServedAddOn }) {
  const { addOn, kinds } = served
  const { namespace } = useCluster()
  const [params] = useSearchParams()
  const [state, update] = useListState('status')
  const gridRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLInputElement>(null)
  const open = useOpenObject()
  // Rows picked for bulk actions, for this namespace only.
  const [picked, setPicked] = useState<{ scope: string | null; keys: ReadonlySet<string> }>({
    scope: namespace,
    keys: new Set(),
  })
  if (picked.scope !== namespace) setPicked({ scope: namespace, keys: new Set() })

  const lists = useListResponses(kinds, state.labels || undefined)
  const all = kinds.map((resource, i) => [resource, lists[i]!] as const)
  const objects = all.flatMap(([, q]) => q.data?.items ?? [])
  const columns = objectColumns(
    namespace === null && kinds.some((r) => r.namespaced),
    objects.some((o) => statusOf(kindOf(o), o).detail),
  )
  // Ages are relative to the last refresh, which keeps rendering pure.
  const ctx: CellContext = { now: Math.max(...all.map(([, q]) => q.dataUpdatedAt)) }
  const counts = countBy(objects, (o) => statusOf(kindOf(o), o).health)
  const needle = state.q.trim().toLowerCase()
  const column = columns.find((c) => c.id === state.sort) ?? columns[0]!
  const matching = objects
    .filter(
      (o) => state.health.length === 0 || state.health.includes(statusOf(kindOf(o), o).health),
    )
    .filter((o) => !needle || searchText(o).includes(needle))
  const rows = sortRows(matching, column, state.desc, ctx)
  const pages = Math.max(1, Math.ceil(rows.length / state.size))
  const page = Math.min(state.page, pages)
  const pageRows = rows.slice((page - 1) * state.size, page * state.size)
  const goToPage = (next: number) => update({ page: Math.max(1, Math.min(pages, next)) })

  // Lists that couldn't be read leave their kind out; ones that couldn't be refreshed keep it.
  const unread = all.filter(([, q]) => q.isError && !q.data)
  const stale = all.find(([, q]) => q.isError && q.data)?.[1]
  const truncated = all.some(([, q]) => q.data?.truncated)
  const retry = () => all.forEach(([, q]) => void q.refetch())
  const scope = namespace ? `in ${namespace}` : 'in this cluster'

  let body
  if (all.some(([, q]) => q.isPending)) {
    body = <TableSkeleton columns={columns} label={`Loading ${addOn.label}`} />
  } else if (unread.length === all.length) {
    body = <ErrorState error={unread[0]![1].error as KubeApiError} onRetry={retry} />
  } else if (objects.length === 0) {
    body = (
      <EmptyState icon={SearchX} title={`Nothing from ${addOn.label} ${scope}`}>
        {state.labels
          ? `Nothing matches the label selector “${state.labels}”.`
          : `${list.format(kinds.map((r) => r.label))} show up here.`}
      </EmptyState>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        Nothing from {addOn.label} matches the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <>
        <ResourceTable
          resetKey={`${page}/${state.size}`}
          ref={gridRef}
          label={addOn.label}
          columns={columns}
          rows={pageRows}
          ctx={ctx}
          rowKey={rowKey}
          selected={params.get('open') ?? undefined}
          sort={{ id: column.id, desc: state.desc }}
          onSort={(id) => update({ sort: id, desc: state.sort === id ? !state.desc : false })}
          onOpen={(o) => open(kindOf(o), o.metadata.name, o.metadata.namespace)}
          onPage={(delta) => goToPage(page + delta)}
          followSelection={params.has('open')}
          picked={picked.keys}
          onPick={(keys) => setPicked({ scope: namespace, keys })}
        />
        <SelectionBar
          noun="objects"
          // Only what's on screen: rows hidden by a filter since stay out of it.
          objects={rows.filter((o) => picked.keys.has(rowKey(o)))}
          onClear={() => setPicked({ scope: namespace, keys: new Set() })}
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
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-1 text-[13px] text-ink-2 tabular-nums">
          {number.format(objects.length)} {objects.length === 1 ? 'object' : 'objects'}
        </span>
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
          name={(health) => HEALTH_NAMES[health]}
        />
        <div className="flex-1" />
        <LabelSelector
          ref={labelsRef}
          value={state.labels}
          onApply={(labels) => update({ labels })}
        />
        <SearchInput
          value={state.q}
          onChange={(q) => update({ q })}
          onArrowDown={() => gridRef.current?.focus()}
          placeholder={`Filter ${addOn.label}`}
          className="w-60"
        />
      </div>
      {unread.length > 0 && unread.length < all.length && (
        <div role="status" className="shrink-0 border-b border-warn/25 bg-warn/10 px-5 py-1.5">
          {unread.map(([resource, q]) => (
            <p key={resource.kind} className="truncate text-xs text-warn-text">
              Couldn’t list {resource.label}: {(q.error as KubeApiError).message}
            </p>
          ))}
        </div>
      )}
      {stale && (
        <StaleNotice error={stale.error as KubeApiError} onRetry={() => void stale.refetch()} />
      )}
      {truncated && (
        <p
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-5 py-2 text-xs text-ink-2"
        >
          <Info className="size-3.5 shrink-0 text-accent-strong" />
          <span className="flex-1">
            Some lists are too long to load whole, so some objects may be missing. Choose a
            namespace or use a label selector to see them all.
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
    </>
  )
}
