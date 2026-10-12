import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Columns3, Copy, EyeOff, PanelRightOpen, Terminal } from 'lucide-react'
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
import { spelled } from '@shared/kit/characters'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { Tooltip } from '@renderer/components/Tooltip'
import { MiddleCut } from '@renderer/kit/MiddleCut'
import { kindOf } from '@shared/resources'
import { objectKey } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { keepFocusInActionDialog } from '@renderer/state/actions'
import { RowActions } from '../actions/ActionSurfaces'
import { actionsFor } from '../actions/catalog'
import { menuContent, menuItem } from '../shell/menu-styles'
import { useLayout } from '@renderer/lib/layout'
import { ALWAYS_SHOWN, fitInOrder, NARROWEST, NARROWEST_NAME, WIDTH_STEP } from './column-choices'
import type { TableLayout } from './ColumnsMenu'
import { TheirCell, type CellContext, type Column } from './columns'
import { ResourceRows } from './ResourceRows'

const ROW_HEIGHT = 46
/** The checkbox column of tables that can pick rows. */
const PICK_WIDTH = 40
/** Each row's padding (px-3 on either side), which its columns' room doesn't include. */
const ROW_PADDING = 24
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

export interface ResourceTableProps {
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
  /**
   * The person's choices of columns (`useListColumns`): how the columns give way, and what the
   * header's menu and its edges do.
   */
  layout?: TableLayout
  /** Copies the picked rows: ⌘C, while rows are picked. */
  onCopy?: () => void
}

/**
 * A list of objects: a grid with a column for each thing worth knowing where there's room, and
 * on a phone two lines an object (ResourceRows), from the same columns.
 */
export function ResourceTable(props: ResourceTableProps) {
  return useLayout() === 'phone' ? <ResourceRows {...props} /> : <ResourceGrid {...props} />
}

/**
 * A virtualized, keyboard-driven data grid. The grid itself takes focus and
 * tracks an active row (aria-activedescendant): arrow keys or j/k move it,
 * Enter opens it, and ←/→ ask for the previous/next page.
 */
function ResourceGrid({
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
  layout,
  onCopy,
}: ResourceTableProps) {
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
  // What the columns have: the table's width, less the rows' padding and the checkboxes.
  const frame = ROW_PADDING + (selectable ? PICK_WIDTH : 0)
  // A column being sized is at its new width at once: the last ones give way as it widens.
  const [sizing, setSizing] = useState<{ id: string; width: number }>()
  const sized = sizing
    ? columns.map((column) =>
        column.id === sizing.id ? { ...column, width: `${sizing.width}px` } : column,
      )
    : columns
  // As chosen, the columns give way in the person's order; otherwise by their priorities.
  const fitted = layout?.chosen
    ? fitInOrder(sized, width - frame)
    : (() => {
        const visible = fitColumns(sized, width - frame)
        return {
          visible,
          unfit: sized.filter((column) => !visible.includes(column)).map((column) => column.id),
        }
      })()
  const visible = fitted.visible
  const unfit = fitted.unfit.join('\n')
  const report = layout?.unfit
  useEffect(() => report?.(unfit ? unfit.split('\n') : []), [unfit, report])
  // The heading whose menu is open.
  const [heading, setHeading] = useState<Column>()

  // Sizing a column: by its heading's right edge, or from the keyboard on a focused heading.
  const sizingFrom = useRef<{ id: string; x: number; from: number; least: number }>(undefined)
  // The width a key gave a column last: the next key goes on from it, drawn yet or not.
  const keyed = useRef<{ id: string; width: number }>(undefined)
  const sizeKeys = (event: KeyboardEvent<HTMLElement>, column: Column) => {
    if (!layout || !event.altKey || event.metaKey || event.ctrlKey) return
    const cell = event.currentTarget
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      // (⌥← and ⌥→ are back and forward everywhere else.)
      event.stopPropagation()
      const step = event.key === 'ArrowRight' ? WIDTH_STEP : -WIDTH_STEP
      const now =
        keyed.current?.id === column.id ? keyed.current.width : cell.getBoundingClientRect().width
      const width = Math.max(leastOf(column, cell), Math.round(now + step))
      keyed.current = { id: column.id, width }
      layout.size(column.id, width)
    } else if (event.code === 'Digit0') {
      event.preventDefault()
      keyed.current = undefined
      layout.size(column.id, undefined)
    }
  }
  const endSizing = (commit: boolean) => {
    const from = sizingFrom.current
    sizingFrom.current = undefined
    if (from && sizing && commit) layout!.size(from.id, sizing.width)
    setSizing(undefined)
  }
  /**
   * A heading's right edge: 8 px to take hold of, a line under the pointer, the accent down the
   * table's height while it's dragged; a double-click gives the column its own width back.
   */
  const edge = (column: Column) => {
    const now = sizing?.id === column.id
    return (
      <span
        aria-hidden
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={() => {
          keyed.current = undefined
          layout!.size(column.id, undefined)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const cell = event.currentTarget.parentElement!
          const from = cell.getBoundingClientRect().width
          event.currentTarget.setPointerCapture(event.pointerId)
          keyed.current = undefined
          sizingFrom.current = {
            id: column.id,
            x: event.clientX,
            from,
            least: leastOf(column, cell),
          }
          setSizing({ id: column.id, width: Math.round(from) })
        }}
        onPointerMove={(event) => {
          const from = sizingFrom.current
          if (!from) return
          const width = Math.round(from.from + event.clientX - from.x)
          setSizing({ id: from.id, width: Math.max(from.least, width) })
        }}
        onPointerUp={() => endSizing(true)}
        onPointerCancel={() => endSizing(false)}
        className="group/edge absolute top-0 -right-1 bottom-0 z-10 w-2 cursor-col-resize touch:hidden"
      >
        <span
          className={cn(
            'absolute right-[3px] w-0.5 rounded-full',
            now
              ? 'top-0 bg-accent'
              : 'top-2 bottom-2 hidden bg-line-strong group-focus-within/head:block group-focus-within/head:bg-accent group-hover/edge:block',
          )}
          style={now ? { height: scrollRef.current?.clientHeight } : undefined}
        />
      </span>
    )
  }
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
    minWidth: minWidth(visible) + frame,
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
    // Keys on a column header (Enter or Space to sort) are its own.
    if ((event.target as Element).closest('[role="columnheader"]')) return
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
      if (event.key === 'c' && (event.metaKey || event.ctrlKey) && picked!.size > 0 && onCopy) {
        event.preventDefault()
        onCopy()
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
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild disabled={!layout}>
            <div
              role="row"
              className="grid h-9 items-center px-3 touch:h-11"
              style={grid}
              onContextMenu={(event: MouseEvent) => {
                const at = (event.target as HTMLElement).closest('[data-column]')
                setHeading(visible.find((column) => column.id === at?.getAttribute('data-column')))
              }}
            >
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
                const drawn =
                  column.headerCut === 'middle' ? (
                    <span data-words className="flex min-w-0">
                      {column.headerTheirs ? (
                        <MiddleCut
                          text={{ their: column.header }}
                          tip={false}
                          className="min-w-0"
                        />
                      ) : (
                        <MiddleTruncate text={column.header} className="min-w-0" />
                      )}
                    </span>
                  ) : column.headerTheirs ? (
                    <span data-words className="flex min-w-0">
                      <TheirCell text={column.header} />
                    </span>
                  ) : (
                    <span data-words className="truncate">
                      {column.header}
                    </span>
                  )
                // (A tooltip of more than the header is drawn, not a title: it can hold marks.)
                const words = column.headerTip ? (
                  <Tooltip content={column.headerTip}>{drawn}</Tooltip>
                ) : (
                  drawn
                )
                // (Else a title: words not Lumovi's spelled, as a title can't draw a mark.)
                const title = column.headerTip
                  ? undefined
                  : column.headerTheirs
                    ? spelled(column.header)
                    : column.header
                return (
                  <div
                    key={column.id}
                    role="columnheader"
                    data-column={column.id}
                    aria-sort={isSorted ? (sort.desc ? 'descending' : 'ascending') : undefined}
                    onKeyDown={(event) => sizeKeys(event, column)}
                    // (Sized another way meanwhile, the keys go on from what's drawn.)
                    onBlur={() => (keyed.current = undefined)}
                    className={cn(
                      'group/head relative flex h-full min-w-0 items-center px-3',
                      column.align === 'right' && 'justify-end',
                    )}
                  >
                    {column.sort ? (
                      <button
                        type="button"
                        onClick={() => onSort(column.id)}
                        // A header keeps to its line: cut short in a narrow column, its arrow kept.
                        className={cn(
                          'flex min-w-0 items-center gap-1 text-2xs font-medium tracking-wider whitespace-nowrap uppercase transition-colors hover:text-ink-1 touch:finger touch:h-11',
                          isSorted ? 'text-ink-1' : 'text-ink-3',
                        )}
                        title={title}
                      >
                        {words}
                        {isSorted &&
                          (sort.desc ? (
                            <ArrowDown className="size-3 shrink-0" />
                          ) : (
                            <ArrowUp className="size-3 shrink-0" />
                          ))}
                      </button>
                    ) : (
                      <span
                        // (A stop of its own where it can be sized from the keyboard.)
                        tabIndex={layout ? 0 : undefined}
                        className="flex min-w-0 text-2xs font-medium tracking-wider whitespace-nowrap text-ink-3 uppercase outline-none focus-visible:text-ink-1"
                        title={title}
                      >
                        {words}
                      </span>
                    )}
                    {layout && edge(column)}
                  </div>
                )
              })}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              className={menuContent}
              // (Where the focus goes next is the menu's, or the list's.)
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <ContextMenu.Item
                className={menuItem}
                disabled={!heading || heading.id === ALWAYS_SHOWN}
                onSelect={() => heading && layout!.hide(heading.id)}
              >
                <EyeOff className="size-4 text-ink-3" /> Hide this column
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={() => layout!.openMenu()}>
                <Columns3 className="size-4 text-ink-3" /> Columns…
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
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
                      // What a column's cell can't fit is cut at its edge, never drawn over the next.
                      className={cn(
                        'flex min-w-0 items-center overflow-hidden px-3',
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
  const { context } = useCluster()
  const { name, namespace } = object.metadata
  const kind = kindOf(object)
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
        // As the dialogs' commands: for this cluster, and a custom kind with its group.
        onSelect={copy(kubectl(context, namespace, 'describe', objectArg(kind, name)))}
      >
        <Terminal className="size-4 text-ink-3" /> Copy kubectl describe
      </ContextMenu.Item>
      {kind === 'Pod' && (
        <ContextMenu.Item
          className={menuItem}
          onSelect={copy(kubectl(context, namespace, 'logs', name))}
        >
          <Terminal className="size-4 text-ink-3" /> Copy kubectl logs
        </ContextMenu.Item>
      )}
      {actionsFor(object).length > 0 && <RowActions object={object} />}
    </>
  )
}

let measuring: CanvasRenderingContext2D | null | undefined

/**
 * The least a column can be sized to: 64 px, or its heading's first word, whichever is wider; a
 * name 160 px. (Measured as the heading draws it, in its own padding.)
 */
function leastOf(column: Column, cell: HTMLElement): number {
  if (column.id === ALWAYS_SHOWN) return NARROWEST_NAME
  const words = cell.querySelector<HTMLElement>('[data-words]')
  measuring ??= document.createElement('canvas').getContext('2d')
  if (!words || !measuring) return NARROWEST
  const style = getComputedStyle(words)
  measuring.font = style.font
  const word = (column.header.split(/\s+/)[0] ?? '').toUpperCase()
  const spacing = (parseFloat(style.letterSpacing) || 0) * word.length
  const padding = parseFloat(getComputedStyle(cell).paddingLeft) * 2
  return Math.max(NARROWEST, Math.ceil(measuring.measureText(word).width + spacing + padding))
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
