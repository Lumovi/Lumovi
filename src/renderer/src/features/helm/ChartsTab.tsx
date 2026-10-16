import { ArrowLeft, ExternalLink, Library, PackagePlus, SearchX, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { HelmRepository, KubeObject, RepositoryChart } from '@shared/api'
import { Button, IconButton } from '@renderer/components/Button'
import { EmptyState, ErrorState } from '@renderer/components/States'
import { useChartIcon, useHelmRepositories } from '@renderer/hooks/helm'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { api } from '@renderer/lib/api'
import { opensExternally } from '@shared/external'
import { sortRows, type CellContext, type Column } from '../resources/columns'
import { ListBar } from '../resources/ListToolbar'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { DeployDialog } from './DeployDialog'

/** A chart as a table row: one per chart in each repository (one in two is two rows). */
type Row = KubeObject & { chart: RepositoryChart; repository: HelmRepository }

const rowOf = (o: KubeObject) => o as Row
const latestOf = (chart: RepositoryChart) => chart.versions[0]

/** A chart's icon, as its repository names it and Lumovi's backend fetched it; else its initial. */
export function ChartIcon({ chart, className }: { chart: RepositoryChart; className?: string }) {
  const icon = useChartIcon(chart.repository, chart.name, chart.icon)
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface text-xs font-semibold text-ink-2 uppercase',
        className,
      )}
    >
      {icon.data ? (
        <img src={icon.data} alt="" className="size-full object-contain p-0.5" />
      ) : (
        chart.name.slice(0, 1)
      )}
    </span>
  )
}

const COLUMNS: Column[] = [
  {
    id: 'name',
    header: 'Chart',
    width: 'minmax(220px, 2fr)',
    priority: 1,
    cell: (o) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <ChartIcon chart={rowOf(o).chart} />
        <span className="min-w-0">
          <span className="block truncate">
            <span className="font-medium text-ink-1">{rowOf(o).chart.name}</span>
            <span className="ml-1.5 text-xs text-ink-3">{rowOf(o).repository.name}</span>
          </span>
          {rowOf(o).chart.description && (
            <span className="block truncate text-xs text-ink-2">{rowOf(o).chart.description}</span>
          )}
        </span>
      </span>
    ),
    text: (o) => `${rowOf(o).chart.name} (${rowOf(o).repository.name})`,
    sort: (o) => `${rowOf(o).chart.name} ${rowOf(o).repository.name}`,
  },
  {
    id: 'latest',
    header: 'Latest',
    width: '96px',
    priority: 1,
    cell: (o) => <span className="font-mono text-xs">{latestOf(rowOf(o).chart)?.version}</span>,
    sort: (o) => latestOf(rowOf(o).chart)?.version ?? '',
  },
  {
    id: 'app',
    header: 'App',
    width: '96px',
    priority: 2,
    cell: (o) => (
      <span className="font-mono text-xs">{latestOf(rowOf(o).chart)?.appVersion ?? '—'}</span>
    ),
    sort: (o) => latestOf(rowOf(o).chart)?.appVersion ?? '',
  },
  {
    id: 'updated',
    header: 'Updated',
    width: '80px',
    align: 'right',
    priority: 3,
    cell: (o, ctx) => {
      const created = latestOf(rowOf(o).chart)?.created
      return (
        <span className="text-ink-2 tabular-nums">{created ? age(created, ctx.now) : '—'}</span>
      )
    },
    sort: (o) => Date.parse(latestOf(rowOf(o).chart)?.created ?? '') || 0,
  },
]

/**
 * The Helm page's Charts tab: every chart in the repositories Lumovi keeps, searched by name,
 * keyword and description; one opened shows its versions, and Install opens the Install dialog
 * with it filled in.
 */
export function ChartsTab({ onRepositories }: { onRepositories: () => void }) {
  const repositories = useHelmRepositories()
  const phone = useLayout() === 'phone'
  const [filter, setFilter] = useState('')
  const [only, setOnly] = useState('')
  const [sort, setSort] = useState({ id: 'name', desc: false })
  const [opened, setOpened] = useState<string>()
  const [installing, setInstalling] = useState<{ chart: RepositoryChart; version: string }>()
  const gridRef = useRef<HTMLDivElement>(null)
  const state = repositories.data
  const by = new Map((state?.repositories ?? []).map((r) => [r.id, r]))
  const rows: Row[] = (state?.charts ?? []).flatMap((chart) => {
    const repository = by.get(chart.repository)
    return repository
      ? [
          {
            metadata: { name: chart.name, uid: `${chart.repository}/${chart.name}` },
            chart,
            repository,
          },
        ]
      : []
  })
  const needle = filter.trim().toLowerCase()
  const ctx: CellContext = { now: repositories.dataUpdatedAt }
  const column = COLUMNS.find((c) => c.id === sort.id) ?? COLUMNS[0]!
  const shown = sortRows(
    rows
      .filter((r) => !only || r.repository.id === only)
      .filter((r) =>
        [r.chart.name, r.chart.description ?? '', ...(r.chart.keywords ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      ),
    column,
    sort.desc,
    ctx,
  )
  const open = rows.find((r) => r.metadata.uid === opened)

  let body
  if (repositories.isPending) {
    body = <TableSkeleton columns={COLUMNS} label="Loading charts" />
  } else if (!state) {
    body = (
      <ErrorState
        error={repositories.error as KubeApiError}
        onRetry={() => void repositories.refetch()}
      />
    )
  } else if (state.repositories.length === 0) {
    body = (
      <EmptyState icon={Library} title="No charts">
        Add a repository to browse its charts.
        {state.mayChange && !phone && (
          <Button variant="secondary" className="mt-3" onClick={onRepositories}>
            Add repository
          </Button>
        )}
      </EmptyState>
    )
  } else if (shown.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No charts match.
      </EmptyState>
    )
  } else {
    body = (
      <ResourceTable
        ref={gridRef}
        label="Charts"
        columns={COLUMNS}
        rows={shown}
        ctx={ctx}
        selected={opened}
        sort={{ id: column.id, desc: sort.desc }}
        onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
        onOpen={(o) => setOpened(o.metadata.uid)}
        rowKey={(o) => o.metadata.uid!}
        pins={false}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className={cn('relative flex min-w-0 flex-1 flex-col', phone && open && 'hidden')}>
        <ListBar
          count={`${rows.length} ${rows.length === 1 ? 'chart' : 'charts'}`}
          before={
            (state?.repositories.length ?? 0) > 1 && (
              <select
                aria-label="Repository"
                value={only}
                onChange={(event) => setOnly(event.target.value)}
                className="h-7 max-w-44 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
              >
                <option value="">All repositories</option>
                {state!.repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )
          }
          filter={filter}
          noun="charts"
          onFilter={setFilter}
          onArrowDown={() => gridRef.current?.focus()}
        />
        {body}
      </div>
      {open && (
        <ChartPanel
          row={open}
          phone={phone}
          onClose={() => setOpened(undefined)}
          onInstall={(version) => setInstalling({ chart: open.chart, version })}
        />
      )}
      {installing && (
        <DeployDialog
          fromRepository={{
            saved: installing.chart.repository,
            chart: installing.chart.name,
            version: installing.version,
          }}
          onClose={() => setInstalling(undefined)}
        />
      )}
    </div>
  )
}

/** A chart opened: its icon, name and repository, what it says of itself, and its versions. */
function ChartPanel({
  row,
  phone,
  onClose,
  onInstall,
}: {
  row: Row
  phone: boolean
  onClose: () => void
  onInstall: (version: string) => void
}) {
  const { chart, repository } = row
  const [picked, setPicked] = useState(latestOf(chart)?.version)
  const version = chart.versions.some((v) => v.version === picked)
    ? picked
    : latestOf(chart)?.version
  const links = [
    { label: 'Home', url: chart.home },
    { label: 'Source', url: chart.sources?.[0] },
  ].filter((link): link is { label: string; url: string } => opensExternally(link.url))
  return (
    <aside
      aria-label={`Chart ${chart.name}`}
      className={cn(
        'flex min-h-0 flex-col border-l border-line bg-surface',
        phone ? 'w-full border-l-0' : 'w-[420px] shrink-0',
      )}
    >
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        {phone && (
          <IconButton label="Back to charts" onClick={onClose} className="-ml-2">
            <ArrowLeft />
          </IconButton>
        )}
        <ChartIcon chart={chart} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3">Chart · {repository.name}</p>
          <h2 className="truncate text-[15px] font-semibold text-ink-1">{chart.name}</h2>
          {!phone && version && (
            <Button className="mt-2" onClick={() => onInstall(version)}>
              <PackagePlus /> Install {version}…
            </Button>
          )}
        </div>
        {!phone && (
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
        {chart.description && <p className="text-[13px] text-ink-2">{chart.description}</p>}
        {links.length > 0 && (
          <p className="flex gap-4 text-[13px]">
            {links.map((link) => (
              <button
                key={link.label}
                type="button"
                onClick={() => void api.app.openExternal(link.url)}
                className="inline-flex items-center gap-1 text-accent-strong hover:underline"
              >
                {link.label} <ExternalLink className="size-3.5" />
              </button>
            ))}
          </p>
        )}
        <section aria-label="Versions">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">
            Versions · {chart.versions.length}
          </h3>
          <div role="listbox" aria-label="Versions" className="divide-y divide-line">
            {chart.versions.map((v, i) => (
              <button
                key={v.version}
                type="button"
                role="option"
                aria-selected={v.version === version}
                onClick={() => setPicked(v.version)}
                className={cn(
                  'grid w-full grid-cols-[1fr_6rem_4rem] items-center rounded-md px-2 py-2 text-left text-[13px]',
                  v.version === version ? 'bg-accent-soft/60' : 'hover:bg-surface-3/50',
                )}
              >
                <span className="font-mono text-xs text-ink-1">
                  {v.version}
                  {i === 0 && <span className="ml-1.5 font-sans text-ink-3">Latest</span>}
                </span>
                <span className="font-mono text-xs text-ink-2">{v.appVersion ?? ''}</span>
                <span className="text-right text-xs text-ink-3 tabular-nums">
                  {v.created ? age(v.created) : ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}
