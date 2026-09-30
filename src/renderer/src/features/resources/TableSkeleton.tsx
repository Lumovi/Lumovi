import type { Column } from './columns'

const ROWS = 12

/** Placeholder rows shaped like the real table, shown while a list loads for the first time. */
export function TableSkeleton({ columns, label }: { columns: Column[]; label: string }) {
  const template = columns.map((c) => c.width).join(' ')
  return (
    <div role="status" aria-label={label} className="min-h-0 flex-1 overflow-hidden">
      <div
        className="grid h-9 items-center border-b border-line px-3"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((column) => (
          <span
            key={column.id}
            className="px-3 text-2xs font-medium tracking-wider text-ink-3 uppercase"
          >
            {column.header}
          </span>
        ))}
      </div>
      {Array.from({ length: ROWS }, (_, row) => (
        <div
          key={row}
          className="grid h-[46px] items-center border-b border-line px-3"
          style={{ gridTemplateColumns: template, opacity: 1 - row / ROWS }}
        >
          {columns.map((column, index) => (
            <span key={column.id} className="px-3">
              <span
                className="block h-3 animate-shimmer rounded-full bg-surface-3"
                style={{ width: `${index === 0 ? 70 : 45 + ((row * 7 + index * 13) % 40)}%` }}
              />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
