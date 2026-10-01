import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Copy, PanelRightOpen, Terminal } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from 'react'
import type { KubeObject } from '@shared/api'
import { objectKey } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { keepFocusInActionDialog } from '@renderer/state/actions'
import { RowActions } from '../actions/ActionSurfaces'
import { actionsFor } from '../actions/catalog'
import { menuContent, menuItem } from '../shell/menu-styles'
import type { CellContext, Column } from './columns'

const ROW_HEIGHT = 46
/** The checkbox column of tables that can pick rows. */
const PICK_WIDTH = 40
/** Rows skipped by PageUp/PageDown. */
const PAGE_JUMP = 10

export interface SortState {
  id: string
  desc: boolean
}

/** Sum of the columns' minimum widths, so narrow windows scroll instead of squashing cells. */
function minWidth(columns: Column[]): number {
  return columns.reduce((sum, column) => sum + Number(/(\d+)px/.exec(column.width)![1]), 0)
}

/**
 * Drops columns one at a time, least important and rightmost first, until the
 * rest fit the available width. Essential columns always stay.
 */
export function fitColumns(columns: Column[], width: number): Column[] {
  const visible = [...columns]
  while (minWidth(visible) > width && visible.some((column) => column.priority! > 1)) {
    const lowest = Math.max(...visible.map((column) => column.priority!))
    visible.splice(
      visible.findLastIndex((column) => column.priority === lowest),
      1,
    )
  }
  return visible
}

/**
 * A virtualized, keyboard-driven data grid. The grid itself takes focus and
 * tracks an active row (aria-activedescendant): arrow keys or j/k move it,
 * Enter opens it, and ←/→ ask for the previous/next page.
 */
export function ResourceTable({
  ref,
  label,
  columns,
  rows,
  ctx,
  selected,
  sort,
  onSort,
  onOpen,
  onPage,
  followSelection = false,
  resetKey,
  picked,
  onPick,
  rowKey = objectKey,
}: {
  ref?: Ref<HTMLDivElement>
  label: string
  columns: Column[]
  rows: KubeObject[]
  ctx: CellContext
  selected?: string
  sort: SortState
  onSort: (id: string) => void
  onOpen: (object: KubeObject) => void
  /** Called with -1/+1 when the user asks for the previous/next page. */
  onPage?: (delta: number) => void
  /** Open the active row as it moves (when a detail panel is already showing). */
  followSelection?: boolean
  /** Changes when a different page is shown: selection and scroll start over. */
  resetKey?: string | number
  /** Rows picked for bulk actions, by object key; the table shows checkboxes when set. */
  picked?: ReadonlySet<string>
  onPick?: (keys: Set<string>) => void
  /** Each row's identity, for selection and picking: `namespace/name` unless kinds mix. */
  rowKey?: (object: KubeObject) => string
}) {
  const id = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => scrollRef.current!, [])
  const [active, setActive] = useState(-1)
  const [shownKey, setShownKey] = useState(resetKey)
  if (resetKey !== shownKey) {
    setShownKey(resetKey)
    setActive(-1)
  }
  const [width, setWidth] = useState(Infinity)
  const [menuRow, setMenuRow] = useState<KubeObject | null>(null)
  // Shift-click picks everything from the row picked last.
  const [anchor, setAnchor] = useState(-1)

  useEffect(() => {
    scrollRef.current!.scrollTo({ top: 0 })
  }, [resetKey])

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(scrollRef.current!)
    return () => observer.disconnect()
  }, [])
  const selectable = onPick !== undefined
  const visible = fitColumns(columns, width - (selectable ? PICK_WIDTH : 0))
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const grid = {
    gridTemplateColumns: [
      ...(selectable ? [`${PICK_WIDTH}px`] : []),
      ...visible.map((c) => c.width),
    ].join(' '),
    minWidth: minWidth(visible) + (selectable ? PICK_WIDTH : 0),
  }
  const keyOf = (index: number) => rowKey(rows[index]!)
  const pickedOnPage = rows.filter((object) => picked?.has(rowKey(object))).length
  const pick = (index: number, range: boolean) => {
    const next = new Set(picked)
    const on = !next.has(keyOf(index))
    const [from, to] =
      range && anchor >= 0 ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index]
    for (let i = from; i <= to; i++) {
      if (on) next.add(keyOf(i))
      else next.delete(keyOf(i))
    }
    setAnchor(index)
    onPick!(next)
  }
  // Picks every row on the page, or lets go of them all.
  const pickPage = (on: boolean) => {
    const next = new Set(picked)
    for (const object of rows) {
      if (on) next.add(rowKey(object))
      else next.delete(rowKey(object))
    }
    onPick!(next)
  }

  const move = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index))
    setActive(next)
    virtualizer.scrollToIndex(next)
    if (followSelection) onOpen(rows[next]!)
  }

  const down = () => move(active + 1)
  const up = () => move(active - 1)
  const keys: Record<string, () => void> = {
    ArrowDown: down,
    j: down,
    ArrowUp: up,
    k: up,
    Home: () => move(0),
    End: () => move(rows.length - 1),
    PageDown: () => move(active + PAGE_JUMP),
    PageUp: () => move(active - PAGE_JUMP),
    Enter: () => onOpen(rows[active]!),
    ArrowLeft: () => onPage?.(-1),
    ArrowRight: () => onPage?.(1),
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (selectable) {
      // x picks the active row, ⌘A the whole page, Escape lets go of everything.
      // The grid only shows with rows, and focusing it makes one active.
      if (event.key.toLowerCase() === 'x' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        pick(active, event.shiftKey)
        return
      }
      if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        pickPage(true)
        return
      }
      if (event.key === 'Escape' && picked!.size > 0) {
        // Only the selection goes; an open detail panel stays.
        event.preventDefault()
        onPick!(new Set())
        return
      }
    }
    const action = keys[event.key]
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    action()
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (active < 0) setActive(0)
      }}
      className={cn(
        'group/grid min-h-0 flex-1 overflow-auto outline-none',
        // Room to scroll the last rows out from under the selection bar.
        picked?.size && 'pb-16',
      )}
    >
      <div
        role="rowgroup"
        className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur"
        style={{ minWidth: grid.minWidth }}
      >
        <div role="row" className="grid h-9 items-center px-3" style={grid}>
          {selectable && (
            <div
              role="columnheader"
              className="flex h-full items-center justify-center"
              onClick={() => pickPage(pickedOnPage < rows.length)}
            >
              <Checkbox
                label="Select all rows on this page"
                checked={pickedOnPage === rows.length}
                indeterminate={pickedOnPage > 0 && pickedOnPage < rows.length}
              />
            </div>
          )}
          {visible.map((column) => {
            const isSorted = sort.id === column.id
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-sort={isSorted ? (sort.desc ? 'descending' : 'ascending') : undefined}
                className={cn('flex min-w-0 px-3', column.align === 'right' && 'justify-end')}
              >
                {column.sort ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => onSort(column.id)}
                    className={cn(
                      'flex items-center gap-1 text-2xs font-medium tracking-wider uppercase transition-colors hover:text-ink-1',
                      isSorted ? 'text-ink-1' : 'text-ink-3',
                    )}
                  >
                    {column.header}
                    {isSorted &&
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
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            role="rowgroup"
            className="relative"
            style={{ height: virtualizer.getTotalSize(), minWidth: grid.minWidth }}
            onContextMenu={(event: MouseEvent) => {
              const row = (event.target as HTMLElement).closest('[data-index]')!
              setMenuRow(rows[Number(row.getAttribute('data-index'))]!)
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const object = rows[item.index]!
              const key = rowKey(object)
              return (
                <div
                  key={key}
                  id={`${id}-${item.index}`}
                  data-index={item.index}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={key === selected}
                  data-active={item.index === active}
                  data-picked={picked?.has(key)}
                  onClick={() => {
                    setActive(item.index)
                    onOpen(object)
                  }}
                  className="absolute inset-x-0 top-0 grid cursor-default items-center border-b border-line px-3 transition-colors duration-75 hover:bg-surface-3/50 aria-selected:bg-accent-soft group-focus/grid:data-[active=true]:bg-surface-3/70 group-focus/grid:data-[active=true]:shadow-[inset_2px_0_0_var(--accent)] data-[picked=true]:bg-accent-soft/60"
                  style={{ ...grid, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  {selectable && (
                    <div
                      role="gridcell"
                      // The whole cell picks the row (with Shift, a range), without opening it.
                      className="flex h-full items-center justify-center"
                      onClick={(event) => {
                        event.stopPropagation()
                        pick(item.index, event.shiftKey)
                      }}
                    >
                      <Checkbox
                        label={`Select ${object.metadata.name}`}
                        checked={picked!.has(key)}
                      />
                    </div>
                  )}
                  {visible.map((column) => (
                    <div
                      key={column.id}
                      role="gridcell"
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
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={menuContent} onCloseAutoFocus={keepFocusInActionDialog}>
            <RowMenu object={menuRow!} onOpen={onOpen} />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  )
}

/** Right-click actions for a row. */
function RowMenu({ object, onOpen }: { object: KubeObject; onOpen: (object: KubeObject) => void }) {
  const { name, namespace } = object.metadata
  const kind = (object.kind as string).toLowerCase()
  const scope = namespace ? ` -n ${namespace}` : ''
  const copy = (text: string) => () => void navigator.clipboard.writeText(text)
  return (
    <>
      <ContextMenu.Item className={menuItem} onSelect={() => onOpen(object)}>
        <PanelRightOpen className="size-4 text-ink-3" /> Open
      </ContextMenu.Item>
      <ContextMenu.Separator className="my-1 h-px bg-line" />
      <ContextMenu.Item className={menuItem} onSelect={copy(name)}>
        <Copy className="size-4 text-ink-3" /> Copy name
      </ContextMenu.Item>
      {namespace && (
        <ContextMenu.Item className={menuItem} onSelect={copy(`${namespace}/${name}`)}>
          <Copy className="size-4 text-ink-3" /> Copy namespace/name
        </ContextMenu.Item>
      )}
      <ContextMenu.Item
        className={menuItem}
        onSelect={copy(`kubectl describe ${kind} ${name}${scope}`)}
      >
        <Terminal className="size-4 text-ink-3" /> Copy kubectl describe
      </ContextMenu.Item>
      {kind === 'pod' && (
        <ContextMenu.Item className={menuItem} onSelect={copy(`kubectl logs ${name}${scope}`)}>
          <Terminal className="size-4 text-ink-3" /> Copy kubectl logs
        </ContextMenu.Item>
      )}
      {actionsFor(object).length > 0 && <RowActions object={object} />}
    </>
  )
}

/** A checkbox for picking rows; its cell handles clicks, the keyboard goes through the grid. */
function Checkbox({
  label,
  checked,
  indeterminate = false,
}: {
  label: string
  checked: boolean
  indeterminate?: boolean
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      tabIndex={-1}
      checked={checked}
      ref={(input) => {
        if (input) input.indeterminate = indeterminate
      }}
      onChange={() => undefined}
      className="size-3.5 accent-[var(--accent)]"
    />
  )
}
