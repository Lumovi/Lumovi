import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { IconButton } from '@renderer/components/Button'
import { PAGE_SIZES } from './list-state'

const number = new Intl.NumberFormat()

export function Pagination({
  page,
  size,
  count,
  onPage,
  onSize,
}: {
  page: number
  size: number
  /** Rows across all pages. */
  count: number
  onPage: (page: number) => void
  /** Omit to hide the page-size menu. */
  onSize?: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(count / size))
  const from = (page - 1) * size + 1
  const to = Math.min(page * size, count)
  return (
    <nav
      aria-label="Pagination"
      className="flex h-11 shrink-0 items-center gap-4 border-t border-line px-5 text-xs text-ink-2"
    >
      {onSize && (
        <label className="flex items-center gap-2">
          Rows per page
          <select
            aria-label="Rows per page"
            value={size}
            onChange={(event) => onSize(Number(event.target.value))}
            className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
          >
            {PAGE_SIZES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="flex-1" />
      <span className="tabular-nums">
        {number.format(from)}–{number.format(to)} of {number.format(count)}
      </span>
      <span className="flex items-center gap-0.5">
        <IconButton label="First page" disabled={page <= 1} onClick={() => onPage(1)}>
          <ChevronsLeft />
        </IconButton>
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </IconButton>
        <span className="px-2 tabular-nums">
          Page {page} of {pages}
        </span>
        <IconButton label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </IconButton>
        <IconButton label="Last page" disabled={page >= pages} onClick={() => onPage(pages)}>
          <ChevronsRight />
        </IconButton>
      </span>
    </nav>
  )
}
