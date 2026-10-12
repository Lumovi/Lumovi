import { Info, Plug, SearchX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { kindOf } from '@shared/resources'
import { LinkTab, LinkTabs } from '@renderer/components/LinkTabs'
import { KindIcon } from '@renderer/components/KindIcon'
import {
  EmptyState,
  ErrorState,
  Loading,
  StaleNotice,
  UnreadNotice,
} from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { Button } from '@renderer/components/Button'
import { useGo } from '@renderer/hooks/go'
import { useOpenPluginPage, useServedPlugins, type ServedPlugin } from '@renderer/hooks/plugins'
import { listedPlugins, type ListedPlugin } from '@renderer/lib/plugins'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useList, useListResponses } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import type { KubeApiError } from '@renderer/lib/api'
import { HEALTH_NAMES, HEALTH_RANK, statusOf } from '@renderer/lib/health'
import { namespacesParam, readOf, scopeOf, unreadOf } from '@renderer/lib/namespaces'
import { pluginAsksPath, pluginPagePath, pluginPath, kindPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { SelectionBar } from '../actions/BulkActions'
import {
  ageColumn,
  nameColumn,
  sortedBy,
  sortRows,
  withPriorities,
  type CellContext,
  type Column,
} from '../resources/columns'
import { useListColumns } from '../resources/ColumnsMenu'
import { useListState } from '../resources/list-state'
import { countBy, HealthChips, ListBar, type LabelSelectorHandle } from '../resources/ListToolbar'
import { Pagination } from '../resources/Pagination'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { rowKey } from '../workloads/columns'
import { PLUGIN_PAGES } from './integrations'
import { PluginBody } from './PluginBody'

const number = new Intl.NumberFormat()
/** "Kustomizations, HelmReleases and GitRepositories": a list the way the app writes them. */
const list = new Intl.ListFormat('en-GB')

/**
 * A plugin's page (`plugins/:name`, and `plugins/:name/:page` for one of its own pages): its pages
 * first, then its kinds; or its own overview, or everything of its kinds, for one with no pages.
 */
export function PluginPage() {
  const { name, page } = useParams() as { name: string; page?: string }
  const { context } = useCluster()
  const resources = useResources()
  const served = useServedPlugins().find(({ plugin }) => plugin.name === name)
  // What was shown here while this was open: if the plugin stops being in use, its title stays
  // and Lumovi says so in place of its tabs, until the person goes elsewhere.
  const [shown, setShown] = useState<{ context: string; plugin: ListedPlugin }>()
  // (By its name and version: what's listed is made anew each time it's read.)
  const withPages = served && served.plugin.added.pages.length > 0 ? served : undefined
  if (
    withPages &&
    (shown?.context !== context ||
      withPages.plugin.name !== shown.plugin.name ||
      withPages.plugin.version !== shown.plugin.version)
  ) {
    setShown({ context, plugin: withPages.plugin })
  }
  // (Told to the header, which keeps its title while the page does.)
  useEffect(() => {
    if (!shown) return
    useOpenPluginPage.setState({ open: shown })
    return () => useOpenPluginPage.setState({ open: undefined })
  }, [shown])
  if (withPages) return <PluginPages served={withPages} page={page} />
  // (Its pages went, while this was open: it isn't in use, or one without pages is in its place.)
  if (shown?.context === context && shown.plugin.name === name) {
    return (
      <EmptyState
        icon={Plug}
        title={`${shown.plugin.label} isn’t in use any more.`}
        footer={<GoToPlugins name={name} />}
      >
        Its pages, its tabs and its commands were taken away while this was open. Plugins says why.
      </EmptyState>
    )
  }
  // An address to a plugin with pages that isn't in use here (another cluster's, or turned off).
  const elsewhere = !served && listedPlugins().find((plugin) => plugin.name === name)
  if (elsewhere && elsewhere.added.pages.length > 0) {
    return (
      <EmptyState
        icon={Plug}
        title={`${elsewhere.label} isn’t in use here.`}
        footer={<GoToPlugins name={elsewhere.name} />}
      >
        Its pages are shown only where it’s in use. Plugins says where it is, and why it isn’t here.
      </EmptyState>
    )
  }
  // An address to a page of one that has no pages at all: Lumovi's "no such page".
  if (served && page !== undefined) {
    return (
      <EmptyState
        icon={SearchX}
        title={`${served.plugin.label} has no such page.`}
        footer={<OpenPlugin plugin={served.plugin} />}
      >
        {served.plugin.label} {served.plugin.version} has no page at this address. A link made with
        another version of it can name a page this one doesn’t have.
      </EmptyState>
    )
  }
  if (served) {
    const integration = PLUGIN_PAGES[name]
    return (
      <div className="relative flex h-full flex-col">
        <PluginTabs served={served} />
        {integration ? <integration.Page /> : <PluginObjects served={served} />}
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

/** To the Plugins page, with this plugin's row opened. */
export function GoToPlugins({ name }: { name: string }) {
  const { context } = useCluster()
  const go = useGo()
  return <Button onClick={() => go(pluginAsksPath(context, name))}>Go to Plugins</Button>
}

/** To a plugin's own address: its first page, or its page of its kinds. */
function OpenPlugin({ plugin }: { plugin: ListedPlugin }) {
  const { context } = useCluster()
  const go = useGo()
  const first = plugin.added.pages[0]
  return (
    <Button
      onClick={() =>
        go(
          first ? pluginPagePath(context, plugin.name, first.id) : pluginPath(context, plugin.name),
        )
      }
    >
      Open {plugin.label}
    </Button>
  )
}

/** A plugin's own pages, as tabs before its kinds' lists: the one asked for, or the first. */
function PluginPages({ served, page }: { served: ServedPlugin; page?: string }) {
  const { plugin } = served
  const pages = plugin.added.pages
  const current = page === undefined ? pages[0] : pages.find((each) => each.id === page)
  return (
    <div className="relative flex h-full flex-col">
      <PluginTabs served={served} current={current ? `page:${current.id}` : 'none'} />
      {current ? (
        <PluginBody key={current.id} plugin={plugin} page={current.id} />
      ) : (
        <EmptyState
          icon={SearchX}
          title={`${plugin.label} has no such page.`}
          footer={<OpenPlugin plugin={plugin} />}
        >
          {plugin.label} {plugin.version} has no page at this address. A link made with another
          version of it can name a page this one doesn’t have.
        </EmptyState>
      )}
    </div>
  )
}

/**
 * A plugin's page and each of its kinds' lists (with that kind's columns and
 * actions), one tab apart.
 */
export function PluginTabs({ served, current }: { served: ServedPlugin; current?: string }) {
  const { context } = useCluster()
  const { plugin, kinds } = served
  const pages = plugin.added.pages
  // One page and no kinds of its own: no strip, the page is under the title.
  if (pages.length === 1 && kinds.length === 0) return null
  return (
    <LinkTabs label={plugin.label}>
      {pages.length > 0 ? (
        // Its own pages, first and in its order: each marked as the plugin's, with whose it is.
        pages.map((each) => (
          <LinkTab
            key={each.id}
            to={pluginPagePath(context, plugin.name, each.id)}
            active={current === `page:${each.id}`}
            label={each.title}
            icon={<Plug aria-hidden className="size-3.5 shrink-0" />}
            tooltip={`From the plugin ${plugin.label} ${plugin.version}`}
          />
        ))
      ) : (
        <LinkTab
          to={pluginPath(context, plugin.name)}
          active={!current}
          label={PLUGIN_PAGES[plugin.name]?.label ?? 'All'}
        />
      )}
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

/** The columns of a plugin's objects, whatever their kind; messages only when there are any. */
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

/** Every object of a plugin's kinds in one list, the ones in trouble first. */
function PluginObjects({ served }: { served: ServedPlugin }) {
  const { plugin, kinds } = served
  const { namespace, namespaces } = useCluster()
  // (Picked rows are the namespaces' that were picked when they were: another pick, other rows.)
  const where = namespacesParam(namespaces) ?? null
  const [params] = useSearchParams()
  const [state, update] = useListState('status')
  const gridRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<LabelSelectorHandle>(null)
  const open = useOpenObject()
  // Rows picked for bulk actions, for this namespace only.
  const [picked, setPicked] = useState<{ scope: string | null; keys: ReadonlySet<string> }>({
    scope: where,
    keys: new Set(),
  })
  if (picked.scope !== where) setPicked({ scope: where, keys: new Set() })

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
  // The columns as the person chose them for this plugin's list in this cluster.
  const chosen = useListColumns({
    list: `plugin:${plugin.name}`,
    columns,
    listed: objects,
    ctx,
    title: plugin.label,
    count: (n) => `${n} ${n === 1 ? 'object' : 'objects'}`,
    namespaced: kinds.some((r) => r.namespaced),
  })
  const shown = chosen.columns
  const needle = state.q.trim().toLowerCase()
  const { column, desc } = sortedBy(shown, state, 'status', columns)
  const matching = objects
    .filter(
      (o) => state.health.length === 0 || state.health.includes(statusOf(kindOf(o), o).health),
    )
    .filter((o) => !needle || searchText(o).includes(needle))
  const rows = sortRows(matching, column, desc, ctx)
  const pages = Math.max(1, Math.ceil(rows.length / state.size))
  const page = Math.min(state.page, pages)
  const pageRows = rows.slice((page - 1) * state.size, page * state.size)
  // Only what's on screen: rows hidden by a filter since stay out of it.
  const pickedRows = rows.filter((o) => picked.keys.has(rowKey(o)))
  const goToPage = (next: number) => update({ page: Math.max(1, Math.min(pages, next)) })

  // Lists that couldn't be read leave their kind out; ones that couldn't be refreshed keep it.
  const unread = all.filter(([, q]) => q.isError && !q.data)
  const stale = all.find(([, q]) => q.isError && q.data)?.[1]
  const truncated = all.some(([, q]) => q.data?.truncated)
  const retry = () => all.forEach(([, q]) => void q.refetch())
  // Picked namespaces any kind's list couldn't read: said, and not counted where nothing was found.
  const unreadNamespaces = unreadOf(all.map(([, q]) => q.data))
  const scope = scopeOf(readOf(namespaces, unreadNamespaces))

  let body
  if (all.some(([, q]) => q.isPending)) {
    body = <TableSkeleton columns={shown} label={`Loading ${plugin.label}`} />
  } else if (unread.length === all.length) {
    body = <ErrorState error={unread[0]![1].error as KubeApiError} onRetry={retry} />
  } else if (objects.length === 0) {
    body = (
      <EmptyState icon={SearchX} title={`Nothing from ${plugin.label} ${scope}`}>
        {state.labels
          ? `Nothing matches the label selector “${state.labels}”.`
          : `${list.format(kinds.map((r) => r.label))} show up here.`}
      </EmptyState>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        Nothing from {plugin.label} matches the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <>
        <ResourceTable
          resetKey={`${page}/${state.size}`}
          ref={gridRef}
          label={plugin.label}
          columns={shown}
          rows={pageRows}
          ctx={ctx}
          rowKey={rowKey}
          selected={params.get('open') ?? undefined}
          sort={{ id: column.id, desc }}
          onSort={(id) => update({ sort: id, desc: column.id === id ? !desc : false })}
          onOpen={(o) => open(kindOf(o), o.metadata.name, o.metadata.namespace)}
          onPage={(delta) => goToPage(page + delta)}
          followSelection={params.has('open')}
          picked={picked.keys}
          onPick={(keys) => setPicked({ scope: where, keys })}
          layout={chosen.layout}
          onCopy={() => chosen.copy(pickedRows)}
        />
        <SelectionBar
          noun="objects"
          objects={pickedRows}
          onClear={() => setPicked({ scope: where, keys: new Set() })}
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
    <>
      <ListBar
        count={`${number.format(objects.length)} ${objects.length === 1 ? 'object' : 'objects'}`}
        chips={
          counts.size > 0 && (
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
          )
        }
        labels={state.labels}
        onLabels={(labels) => update({ labels })}
        labelsRef={labelsRef}
        filter={state.q}
        noun={plugin.label}
        onFilter={(q) => update({ q })}
        onArrowDown={() => gridRef.current?.focus()}
        after={chosen.button(rows)}
      />
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
      <UnreadNotice unread={unreadNamespaces} noun={`objects from ${plugin.label}`} />
      {truncated && (
        <p
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-5 py-2 text-xs text-ink-2"
        >
          <Info className="size-3.5 shrink-0 text-ink-3" />
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
