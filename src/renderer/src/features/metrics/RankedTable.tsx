import { ArrowDown, ArrowUp } from 'lucide-react'
import { useState } from 'react'
import type { ResourceKind } from '@shared/resources'
import { formatValue } from '@renderer/components/charts/scale'
import { useOpenObject } from '@renderer/hooks/open-object'
import { cn } from '@renderer/lib/cn'
import type { Unit } from '@renderer/lib/promql'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import type { Group } from './MetricsPage'
import { hasMetrics } from './MetricsTab'

export interface Row {
  key: string
  name: string
  namespace?: string
  /** What to open for it; unknown for workloads whose pods are gone. */
  kind?: ResourceKind
  /** Average over the window (total restarts, for restarts). */
  avg: number
  max?: number
  now?: number
}

type Column = 'name' | 'now' | 'avg' | 'max'

const count = new Intl.NumberFormat()

/** How many rows show before "Show more". */
const PAGE = 50

/**
 * Every group ranked, with its share of the total. Charted rows wear their
 * series' color; clicking a row opens it on its Metrics tab.
 */
export function RankedTable({
  rows,
  total,
  unit,
  group,
  restarts,
  color,
  filtered,
  onClearFilter,
}: {
  rows: Row[]
  total: number
  unit: Unit
  group: Group
  restarts: boolean
  color: (row: Row) => string | undefined
  filtered: boolean
  onClearFilter: () => void
}) {
  const openObject = useOpenObject()
  const showTab = useActionsUi((state) => state.showTab)
  const [sort, setSort] = useState<{ column: Column; desc: boolean }>({ column: 'avg', desc: true })
  const [limit, setLimit] = useState(PAGE)
  const value = (row: Row, column: Column) => (column === 'name' ? row.name : (row[column] ?? -1))
  const sorted = [...rows].sort((a, b) => {
    const [x, y] = [value(a, sort.column), value(b, sort.column)]
    const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)
    return sort.desc ? -order : order
  })
  const columns: { id: Column; label: string }[] = [
    { id: 'name', label: group[0]!.toUpperCase() + group.slice(1) },
    ...(restarts
      ? [{ id: 'avg' as const, label: 'Restarts' }]
      : [
          { id: 'now' as const, label: 'Now' },
          { id: 'avg' as const, label: 'Average' },
          { id: 'max' as const, label: 'Peak' },
        ]),
  ]
  // Namespaces open on their overview; everything else on its usage history.
  const open = ({ kind, name, namespace }: Row) => {
    openObject(kind!, name, namespace)
    if (hasMetrics(kind!)) showTab(formatRef({ kind: kind!, name, namespace }), 'metrics')
  }

  return (
    <div>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink-1">
          Ranked by {restarts ? 'restarts' : 'average'}
        </h2>
        {filtered && (
          <button
            type="button"
            onClick={onClearFilter}
            className="text-xs font-medium text-accent-strong hover:underline"
          >
            Show all
          </button>
        )}
      </header>
      <table className="w-full table-fixed text-left text-xs">
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.id}
                aria-sort={
                  sort.column === column.id ? (sort.desc ? 'descending' : 'ascending') : undefined
                }
                className={cn(
                  'py-1.5 font-medium',
                  column.id === 'name' ? 'w-[46%]' : 'text-right',
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    setSort({
                      column: column.id,
                      desc: sort.column === column.id ? !sort.desc : column.id !== 'name',
                    })
                  }
                  className={cn(
                    'inline-flex items-center gap-1 text-2xs tracking-wider uppercase transition-colors hover:text-ink-1',
                    sort.column === column.id ? 'text-ink-1' : 'text-ink-3',
                  )}
                >
                  {column.label}
                  {sort.column === column.id &&
                    (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                </button>
              </th>
            ))}
            <th className="w-[18%] py-1.5 text-right text-2xs font-medium tracking-wider text-ink-3 uppercase">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, limit).map((row) => {
            const swatch = color(row)
            const share = total > 0 ? row.avg / total : 0
            return (
              <tr
                key={row.key}
                className="group border-b border-line last:border-0 hover:bg-surface-3/50"
              >
                <td className="py-1.5 pr-2">
                  <button
                    type="button"
                    disabled={!row.kind}
                    onClick={() => open(row)}
                    title={
                      row.kind ? `Open ${row.name}` : `${row.name} has no running pods to open`
                    }
                    className="flex w-full min-w-0 items-center gap-2 text-left disabled:cursor-default"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-2.5 shrink-0 rounded-[3px]',
                        !swatch && 'border border-line-strong',
                      )}
                      style={swatch ? { background: swatch } : undefined}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-ink-1 group-hover:underline">
                        {row.name}
                      </span>
                      {row.namespace && group !== 'namespace' && (
                        <span className="block truncate text-2xs text-ink-3">{row.namespace}</span>
                      )}
                    </span>
                  </button>
                </td>
                {columns.slice(1).map(({ id }) => {
                  const cell = row[id as 'now' | 'avg' | 'max']
                  return (
                    <td key={id} className="py-1.5 text-right text-ink-1 tabular-nums">
                      {cell === undefined ? '—' : formatValue(cell, unit)}
                    </td>
                  )
                })}
                <td className="py-1.5 pl-2">
                  <span className="flex items-center justify-end gap-2">
                    <span className="h-1.5 w-12 overflow-hidden rounded-full bg-accent-track">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{ width: `${share * 100}%` }}
                      />
                    </span>
                    <span className="w-9 text-right text-ink-2 tabular-nums">
                      {Math.round(share * 100)}%
                    </span>
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sorted.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="mt-2 text-xs font-medium text-accent-strong hover:underline"
        >
          Show {Math.min(PAGE, sorted.length - limit)} more of {count.format(sorted.length)}
        </button>
      )}
    </div>
  )
}
