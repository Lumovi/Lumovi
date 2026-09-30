import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useRef } from 'react'
import type { KubeObject } from '@shared/api'
import { objectKey } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import type { CellContext, Column } from './columns'

const ROW_HEIGHT = 46

export interface SortState {
  id: string
  desc: boolean
}

/** Sum of the columns' minimum widths, so narrow windows scroll instead of squashing cells. */
function minWidth(columns: Column[]): number {
  return columns.reduce((sum, column) => sum + Number(/(\d+)px/.exec(column.width)![1]), 0)
}

export function ResourceTable({
  label,
  columns,
  rows,
  ctx,
  selected,
  sort,
  onSort,
  onOpen,
}: {
  label: string
  columns: Column[]
  rows: KubeObject[]
  ctx: CellContext
  selected?: string
  sort: SortState
  onSort: (id: string) => void
  onOpen: (object: KubeObject) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const grid = {
    gridTemplateColumns: columns.map((c) => c.width).join(' '),
    minWidth: minWidth(columns),
  }

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      className="min-h-0 flex-1 overflow-auto"
    >
      <div
        role="rowgroup"
        className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur"
        style={{ minWidth: grid.minWidth }}
      >
        <div role="row" className="grid h-9 items-center px-3" style={grid}>
          {columns.map((column) => {
            const active = sort.id === column.id
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
                className={cn('flex min-w-0 px-3', column.align === 'right' && 'justify-end')}
              >
                {column.sort ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.id)}
                    className={cn(
                      'flex items-center gap-1 text-2xs font-medium tracking-wider uppercase transition-colors hover:text-ink-1',
                      active ? 'text-ink-1' : 'text-ink-3',
                    )}
                  >
                    {column.header}
                    {active &&
                      (sort.desc ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ArrowUp className="size-3" />
                      ))}
                  </button>
                ) : (
                  <span className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
                    {column.header}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div
        role="rowgroup"
        className="relative"
        style={{ height: virtualizer.getTotalSize(), minWidth: grid.minWidth }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const object = rows[item.index]!
          const key = objectKey(object)
          return (
            <div
              key={key}
              role="row"
              tabIndex={0}
              aria-rowindex={item.index + 2}
              aria-selected={key === selected}
              onClick={() => onOpen(object)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onOpen(object)
              }}
              className="group absolute inset-x-0 top-0 grid items-center border-b border-line px-3 transition-colors duration-75 outline-none hover:bg-surface-3/50 focus-visible:bg-surface-3/70 aria-selected:bg-accent-soft"
              style={{ ...grid, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              {columns.map((column) => (
                <div
                  key={column.id}
                  role="cell"
                  className={cn(
                    'flex min-w-0 items-center px-3',
                    column.align === 'right' && 'justify-end',
                  )}
                >
                  {column.cell(object, ctx)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
