/**
 * The kit's Graph: things that lead to other things (an application's resources, a workflow's
 * steps, who talks to whom), drawn by Lumovi from a description (`@shared/kit/graph`). A plugin
 * gives cards and the lines between them; where they go is Lumovi's: in rows by the lines'
 * direction (`graph-layout`), as its own map of a workload is laid out, each card the map's card.
 *
 * The same cards are a table (`graph-table`), the kit's own Table with its rows nesting as deep
 * as the lines go: what a phone shows, what's shown past the ceiling (`GRAPH_LIMITS.drawn`), and
 * what a person may switch to. One order serves the picture, the table, the keys and a screen
 * reader: the table's. Tab reaches each card in it; the arrows follow lines (down to the first
 * card a line leads to, up to what leads here, left and right along a row); Enter opens. A screen
 * reader hears the cards as a nested list, never as a picture.
 *
 * Its filter is its own: a card matches by its name or its kind word (in the table, its cells
 * too), and the cards above a match stay, dashed and quieter, so its place reads.
 */
import { Plus } from 'lucide-react'
import {
  createElement,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { Health } from '@shared/health'
import { inPieces, spelled, type Piece } from '@shared/kit/characters'
import type { ListDestination, ObjectRef, ReachDestination, Their } from '@shared/kit/declare'
import { GRAPH_LIMITS, type GraphProps } from '@shared/kit/graph'
import type { ResourceKind } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { kindIcon, VIEW_ICONS } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'
import {
  CARD_HEIGHT,
  keptOf,
  layoutGraph,
  orderRows,
  type PlacedCard,
  type Shape,
} from '@renderer/lib/graph-layout'
import {
  cardsOf,
  filterRows,
  tableOf,
  type Card,
  type Kept,
  type Line,
} from '@renderer/lib/graph-table'
import { useLayout } from '@renderer/lib/layout'
import { offered } from '@renderer/plugins/reach'
import { TheirText } from '@renderer/plugins/TheirText'
import { MiddleCut, tooltip } from './MiddleCut'
import type { DrawnRow } from '@shared/kit/table'
import { InCard } from './Card'
import { CARD } from './Lead'
import { Nothing, Table } from './Table'

/** What a card's Status says in its level's own colour: what's wrong, and nothing calmer. */
const LOUD = new Set<Health>(['critical', 'warning'])

/** A line's colour, by the card it leads to: a warning or worse takes its level's. */
const STROKE: Partial<Record<Health, string>> = {
  critical: 'var(--critical)',
  warning: 'var(--warn)',
}

export function Graph({
  title,
  legend,
  columns,
  nodes,
  edges,
  state,
  go,
  onOpen,
  onRetry,
}: GraphProps & {
  /** Opens the object a card names: Lumovi's own to do, never the plugin's (and not declared). */
  go?: (to: ObjectRef | ListDestination | ReachDestination) => void
}) {
  const layout = useLayout()
  const phone = layout === 'phone'
  // Inside a card, which says the title: no frame or heading of its own.
  const inCard = useContext(InCard)
  const [sought, setSought] = useState('')
  const [as, setAs] = useState<'graph' | 'table'>('graph')
  const { cards, lines } = useMemo(() => cardsOf(nodes, edges), [nodes, edges])
  const total = cards.length
  const tooMany = total > GRAPH_LIMITS.drawn.cards || lines.length > GRAPH_LIMITS.drawn.lines
  const table = phone || tooMany || as === 'table'
  // Once for each graph: its rows, ordered as the picture would be (past the ceiling, where
  // there's no picture, by its rows alone), and the table made from them.
  const shape = useMemo(
    () => orderRows(cards, lines, { placed: !tooMany }),
    [cards, lines, tooMany],
  )
  // (A marked card's row says what a mark is, beside its name: the legend's word.)
  const rows = useMemo(() => tableOf(shape, legend?.marked), [shape, legend?.marked])
  // For each letter typed: what the filter keeps of those rows, never the graph worked out again.
  const {
    rows: kept,
    kept: keptCards,
    matches,
  } = useMemo(() => filterRows(rows, sought, { cells: table }), [rows, sought, table])
  const named = spelled(title.their)
  const filtering = sought.trim() !== ''
  const count = filtering
    ? `${matches.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
    : total.toLocaleString('en-US')
  const open = (card: Card) => {
    const { opens, goes, key, context } = card.node
    const to = opens ?? goes
    if (!to || context) return
    // (A link to a place Lumovi doesn't have here opens its object, as a Table's row does: a
    // shell's on a phone, a forward's where there are none.)
    go?.('to' in to && to.to === 'reach' && !offered(to.at, layout) ? to.object : to)
    onOpen?.({ node: key })
  }

  const heading = (
    <h3 className="flex items-center px-4 pt-3.5 pb-1.5 text-[13px] font-semibold text-ink-1 phone:px-0 phone:pt-0 phone:pb-2.5">
      <TheirText text={title} />
      <small className="ml-auto text-xs font-normal text-ink-3 tabular-nums">{count}</small>
    </h3>
  )

  // Nothing to show: the app's empty state, with the plugin's words, and nothing to switch to.
  if (total === 0 || state) {
    return (
      <section aria-label={named} className={cn(!phone && !inCard && CARD)}>
        {!inCard && heading}
        <Nothing state={state ?? { is: 'empty' }} of={title} onRetry={() => onRetry?.({})} />
      </section>
    )
  }

  const filter = (
    <SearchInput
      value={sought}
      onChange={setSought}
      onArrowDown={() => undefined}
      placeholder="Filter"
      // (Its title a screen reader's, as written: lowered in the field it would break names.)
      name={`Filter ${named}`}
      hint={false}
      hotkey={false}
      className={cn('h-7 w-56 phone:h-11 phone:w-full')}
    />
  )
  const nothingMatches = filtering && matches === 0 && (
    <div className="flex min-h-[132px] flex-col items-center justify-center gap-2 p-4 text-center text-[13px] text-ink-3">
      <span>
        Nothing matches “<TheirText text={sought} inline />
        ”.
      </span>
      <Button variant="secondary" className="h-7 text-xs" onClick={() => setSought('')}>
        Clear filter
      </Button>
    </div>
  )
  const asTable = (
    <Table
      // (Filtered, its rows start open, so what matches is in view: a table of its own.)
      key={filtering ? 'filtered' : 'whole'}
      title={title}
      columns={columns}
      headings
      rows={kept}
      bare
      startOpen={filtering}
      go={go}
      onOpen={({ row }) => onOpen?.({ node: row })}
    />
  )

  if (phone) {
    return (
      <section aria-label={named} className="min-w-0">
        {!inCard && heading}
        <div className="mb-2.5">{filter}</div>
        {nothingMatches || asTable}
      </section>
    )
  }

  return (
    <section aria-label={named} className={cn(!inCard && CARD)}>
      {!inCard && heading}
      <div className="flex items-center gap-3 px-4 pb-3.5 text-xs text-ink-3">
        {filter}
        {!table && <Legend legend={legend} />}
        <Switch
          as={table ? 'table' : 'graph'}
          onSwitch={setAs}
          graphless={tooMany}
          className="ml-auto"
        />
      </div>
      {tooMany && (
        <p className="mx-4 mb-2 flex items-start gap-2 text-xs leading-[18px] text-ink-2">
          {total > GRAPH_LIMITS.drawn.cards
            ? `${total.toLocaleString('en-US')} are too many to draw as a graph (${GRAPH_LIMITS.drawn.cards} at most)`
            : `Their ${lines.length.toLocaleString('en-US')} links are too many to draw as a graph (${GRAPH_LIMITS.drawn.lines} at most)`}
          , so they’re listed. Filter the list to see fewer.
        </p>
      )}
      {nothingMatches ||
        (table ? (
          asTable
        ) : (
          <Picture
            shape={shape}
            kept={keptCards}
            rows={kept}
            named={named}
            sought={filtering ? sought : undefined}
            open={open}
            {...(legend?.marked ? { marked: legend.marked } : {})}
          />
        ))}
    </section>
  )
}

/**
 * What a solid line means, and a dashed one: a stroke of each, and the plugin's words; and what
 * a marked card is, beside an edge of its colour.
 */
function Legend({ legend }: { legend?: GraphProps['legend'] }) {
  const sample = (dashed: boolean) => (
    <svg width="18" height="2" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="1"
        x2="18"
        y2="1"
        stroke="var(--line-strong)"
        strokeWidth="1.5"
        strokeDasharray={dashed ? '4 4' : undefined}
      />
    </svg>
  )
  return (
    <span className="flex min-w-0 items-center gap-3">
      {legend?.solid?.their && (
        <span className="flex min-w-0 items-center gap-1.5">
          {sample(false)}
          <TheirText text={legend.solid} inline />
        </span>
      )}
      {legend?.dashed?.their && (
        <span className="flex min-w-0 items-center gap-1.5">
          {sample(true)}
          <TheirText text={legend.dashed} inline />
        </span>
      )}
      {legend?.marked?.their && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 shrink-0 rounded-[3px] border-2 border-warn" />
          <TheirText text={legend.marked} inline />
        </span>
      )}
    </span>
  )
}

/** Graph | Table: what the part shows. Past the ceiling, only the table can be chosen. */
function Switch({
  as,
  onSwitch,
  graphless,
  className,
}: {
  as: 'graph' | 'table'
  onSwitch: (as: 'graph' | 'table') => void
  graphless: boolean
  className?: string
}) {
  const option = (value: 'graph' | 'table', words: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={as === value}
      disabled={value === 'graph' && graphless}
      onClick={() => onSwitch(value)}
      className={cn(
        'flex h-6 items-center rounded-md px-2.5 text-xs text-ink-2 disabled:opacity-45',
        as === value && 'bg-surface-2 font-medium text-ink-1 shadow-[0_1px_2px_rgb(0_0_0/0.12)]',
      )}
    >
      {words}
    </button>
  )
  return (
    <span
      role="radiogroup"
      aria-label="Show as"
      className={cn('inline-flex shrink-0 rounded-lg bg-surface-3 p-0.5', className)}
    >
      {option('graph', 'Graph')}
      {option('table', 'Table')}
    </span>
  )
}

/** A card's place in the one order (the table's), how deep it is there, and how many it leads to. */
interface Order {
  index: Map<string, number>
  depth: Map<string, number>
}

/**
 * The table's order of the cards, each where it's listed first, and how deep: walked, never
 * called for each level.
 */
function orderOf(rows: readonly DrawnRow[]): Order {
  const index = new Map<string, number>()
  const depth = new Map<string, number>()
  const todo = [...rows].reverse().map((row) => ({ row, d: 0 }))
  while (todo.length > 0) {
    const { row, d } = todo.pop()!
    if (row.again) continue
    const key = row.key.their
    index.set(key, index.size)
    depth.set(key, d)
    const inside = row.rows ?? []
    for (let i = inside.length - 1; i >= 0; i--) todo.push({ row: inside[i]!, d: d + 1 })
  }
  return { index, depth }
}

/** The picture: cards in rows and the lines between them, laid out as wide as there's room. */
function Picture({
  shape,
  kept,
  rows,
  named,
  sought,
  open: openCard,
  marked,
}: {
  /** What a marked card is, in the plugin's words: said with it to a screen reader. */
  marked?: Their
  /** The whole graph's, in its order: what's kept of it is placed, never ordered again. */
  shape: Shape<Card, Line>
  kept: ReadonlyMap<string, Kept>
  rows: readonly DrawnRow[]
  named: string
  /** What the filter has typed, if anything: set in bold in a matching card's name. */
  sought?: string
  open: (card: Card) => void
}) {
  const shown = useMemo(() => keptOf(shape, kept), [shape, kept])
  const { lines } = shown
  const cards = useMemo(() => shown.rows.flat(), [shown])
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  // The card the pointer or the keyboard is on: its own lines lit, the rest faded.
  const [lit, setLit] = useState<string>()
  const elements = useRef(new Map<string, HTMLElement>())
  useLayoutEffect(() => {
    const element = box.current!
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(
    () => (width > 0 ? layoutGraph(shown, width, opened) : undefined),
    [shown, width, opened],
  )
  const order = useMemo(() => orderOf(rows), [rows])
  const leadsTo = useMemo(() => {
    const out = new Map<string, Set<string>>()
    for (const line of lines) {
      if (line.from === line.to) continue
      out.set(line.from, (out.get(line.from) ?? new Set()).add(line.to))
    }
    return out
  }, [lines])
  const levelOf = useMemo(() => new Map(cards.map((card) => [card.key, card.level])), [cards])

  if (!layout) return <div ref={box} className="mx-4 mb-4 h-14" />

  // The cards in the one order: each card where its row is listed first; a row's "+N more" after it.
  const at = (card: PlacedCard<Card>) =>
    card.node
      ? order.index.get(card.key)!
      : Math.max(
          -1,
          ...layout.cards
            .filter((each) => each.node && each.y === card.y)
            .map((each) => order.index.get(each.key)!),
        ) + 0.5
  const placed = [...layout.cards].sort((a, b) => at(a) - at(b))
  const near = lit
    ? new Set(
        layout.edges.flatMap((edge) =>
          edge.from === lit || edge.to === lit ? [edge.from, edge.to] : [],
        ),
      )
    : undefined
  const isLit = (edge: { from: string; to: string }) => lit === edge.from || lit === edge.to

  /** The next card from `key` by the keys: down a line, up one, or along its row. */
  const next = (key: string, way: string): string | undefined => {
    const card = layout.cards.find((each) => each.key === key)
    if (!card) return undefined
    const byOrder = (keys: string[]) =>
      keys.sort((a, b) => (order.index.get(a) ?? 0) - (order.index.get(b) ?? 0))[0]
    if (way === 'ArrowDown') {
      return byOrder(layout.edges.filter((e) => e.from === key && !e.back).map((e) => e.to))
    }
    if (way === 'ArrowUp') {
      return byOrder(layout.edges.filter((e) => e.to === key && !e.back).map((e) => e.from))
    }
    const row = layout.cards
      .filter((each) => Math.abs(each.y - card.y) < 1)
      .sort((a, b) => a.x - b.x)
    const i = row.indexOf(card)
    return row[way === 'ArrowLeft' ? i - 1 : i + 1]?.key
  }
  const onKeyDown = (event: KeyboardEvent, card: PlacedCard<Card>) => {
    if (event.key === 'Enter' && card.node) {
      event.preventDefault()
      openCard(card.node)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const to = next(card.key, event.key)
    if (to) elements.current.get(to)?.focus()
  }

  return (
    <div ref={box} className="mx-4 mb-4">
      <div
        role="list"
        aria-label={named}
        className="relative"
        style={{ height: layout.height }}
        onPointerLeave={() => setLit(undefined)}
      >
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <marker
              id="graph-head"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--line-strong)" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const level = levelOf.get(edge.edge.to)
            // (Filtered: only a line that ends at a match is in full; the rest is context.)
            const context = kept.get(edge.edge.to) !== 'match'
            return (
              <path
                key={edge.key}
                d={edge.path}
                fill="none"
                strokeLinejoin="round"
                stroke={
                  isLit(edge) ? 'var(--accent)' : (level && STROKE[level]) || 'var(--line-strong)'
                }
                strokeWidth={isLit(edge) ? 2 : 1.5}
                strokeDasharray={edge.edge.edge.style === 'dashed' ? '4 4' : undefined}
                markerEnd={edge.back ? 'url(#graph-head)' : undefined}
                opacity={lit && !isLit(edge) ? 0.2 : context ? 0.55 : 1}
              />
            )
          })}
        </svg>
        {layout.edges.map(
          (edge) =>
            edge.label && (
              <span
                key={`label:${edge.key}`}
                aria-hidden
                // (Cut, it's whole in its tooltip, spelled: as much as a tooltip shows.)
                title={
                  Array.from(edge.edge.edge.label?.their ?? '').length > GRAPH_LIMITS.label
                    ? tooltip(edge.edge.edge.label?.their ?? '')
                    : undefined
                }
                style={{ left: edge.label.x, top: edge.label.y }}
                className={cn(
                  'absolute -translate-x-1/2 -translate-y-1/2 rounded bg-surface px-1.5 text-[11px] leading-4 whitespace-nowrap',
                  isLit(edge) ? 'text-accent-strong' : 'text-ink-3',
                  lit && !isLit(edge) && 'opacity-20',
                )}
              >
                <Label text={edge.edge.edge.label} />
              </span>
            ),
        )}
        {placed.map((card) =>
          card.more ? (
            <div key={card.key} role="listitem" style={place(card)} className="absolute">
              <button
                type="button"
                ref={(element) => {
                  if (element) elements.current.set(card.key, element)
                  else elements.current.delete(card.key)
                }}
                onClick={() => setOpened((was) => new Set(was).add(card.more!.row))}
                onKeyDown={(event) => onKeyDown(event, card)}
                className="flex size-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong text-[13px] font-medium text-ink-2 hover:bg-surface-3/60"
              >
                <Plus className="size-4" aria-hidden />
                {card.more.count} more
              </button>
            </div>
          ) : (
            <CardDrawn
              key={card.key}
              card={card}
              kept={kept.get(card.key)}
              faded={near !== undefined && !near.has(card.key)}
              said={saidOf(card.node!, kept.get(card.key), order, leadsTo, cards.length, marked)}
              level={order.depth.get(card.key) ?? 0}
              bold={kept.get(card.key) === 'match' ? sought : undefined}
              onLit={setLit}
              onOpen={() => openCard(card.node!)}
              onKeyDown={(event) => onKeyDown(event, card)}
              ref={(element) => {
                if (element) elements.current.set(card.key, element)
                else elements.current.delete(card.key)
              }}
            />
          ),
        )}
      </div>
    </div>
  )
}

const place = (card: PlacedCard<Card>) => ({
  left: card.x,
  top: card.y,
  width: card.width,
  height: CARD_HEIGHT,
})

/**
 * What a screen reader hears of a card: "Deployment cart, Degraded, 2 of 9, leads to 3"; a card
 * kept above a match, "Application shop, shown for context".
 */
function saidOf(
  card: Card,
  kept: Kept | undefined,
  order: Order,
  leadsTo: ReadonlyMap<string, ReadonlySet<string>>,
  of: number,
  marked?: Their,
): string {
  const { node } = card
  const name = spelled(node.name.their)
  const kind = spelled(node.kind?.their ?? '')
  // (What a mark is, in the plugin's words, after its status: "Out of sync".)
  const mark = node.marked && marked?.their ? spelled(marked.their) : undefined
  if (kept === 'context') {
    return [[kind, name].filter(Boolean).join(' '), 'shown for context'].join(', ')
  }
  if (node.context) {
    return [
      [kind, name].filter(Boolean).join(' '),
      node.status?.word?.their ? spelled(node.status.word.their) : undefined,
      mark,
      'shown for context: it opens nothing',
    ]
      .filter(Boolean)
      .join(', ')
  }
  const leads = leadsTo.get(card.key)?.size ?? 0
  return [
    [kind, name].filter(Boolean).join(' '),
    node.status?.word?.their ? spelled(node.status.word.their) : undefined,
    mark,
    `${(order.index.get(card.key) ?? 0) + 1} of ${of}`,
    leads > 0 ? `leads to ${leads}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * A line's label: its first 16 characters, in pieces on one line, and past them "…" and the marks
 * of what was cut, by the kit's rule, as many as there are.
 */
function Label({ text }: { text?: Their }) {
  const kept: Piece[] = []
  const after: Piece[] = []
  let left: number = GRAPH_LIMITS.label
  for (const piece of inPieces(text?.their ?? '')) {
    if (typeof piece !== 'string') {
      ;(left > 0 ? kept : after).push(piece)
      continue
    }
    const letters = Array.from(piece.replace(/[\n\t]/g, ' '))
    if (left > 0) kept.push(letters.slice(0, left).join(''))
    if (letters.length > left && after.length === 0) after.push('…')
    left = Math.max(0, left - letters.length)
  }
  if (after.length > 0 && after[0] !== '…') after.unshift('…')
  return <TheirText pieces={[...kept, ...after]} inline />
}

/** A card's icon: the kind's own, of an object Lumovi gave; else the one the plugin named; else none. */
function CardIcon({ node }: { node: Card['node'] }) {
  // (One that goes somewhere has its destination's kind's icon: a list's kind, or a place's
  // object's.)
  const goesKind =
    node.goes?.to === 'list'
      ? node.goes.kind
      : node.goes?.to === 'reach'
        ? node.goes.object.kind
        : undefined
  const icon = node.opens
    ? kindIcon(node.opens.kind as ResourceKind)
    : goesKind
      ? kindIcon(goesKind as ResourceKind)
      : node.icon
        ? VIEW_ICONS[node.icon]
        : undefined
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 [.context_&]:opacity-55">
      {icon && createElement(icon, { className: 'size-[15px]', 'aria-hidden': true })}
    </span>
  )
}

/**
 * A card, the map's card: a kind's icon in a tile; on its first line the kind, quiet, and at the
 * right a Status; under it the name, cut in its middle with its marks kept. One that opens an
 * object is a button; another opens nothing, and isn't one.
 */
function CardDrawn({
  card,
  kept,
  faded,
  said,
  level,
  onLit,
  onOpen,
  onKeyDown,
  ref,
  bold,
}: {
  card: PlacedCard<Card>
  kept?: Kept
  faded: boolean
  said: string
  level: number
  onLit: (key: string | undefined) => void
  onOpen: () => void
  onKeyDown: (event: KeyboardEvent) => void
  ref: (element: HTMLElement | null) => void
  /** What a filter found in its name. */
  bold?: string
}) {
  const { node } = card.node!
  const status = node.status
  const body: ReactNode = (
    <>
      <CardIcon node={node} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center text-[11px] leading-4 whitespace-nowrap text-ink-3">
          <span className="min-w-0 truncate [.context_&]:opacity-70">
            <TheirText text={node.kind} inline />
            {node.beside?.their && (
              <>
                {' · '}
                <TheirText text={node.beside} inline />
              </>
            )}
          </span>
          {status && (
            <span
              className={cn(
                'ml-auto flex shrink-0 items-center gap-1 pl-2 font-medium',
                LOUD.has(status.level) ? HEALTH_STYLE[status.level].text : 'text-ink-2',
              )}
            >
              <span className={cn('size-1.5 rounded-full', HEALTH_STYLE[status.level].dot)} />
              <TheirText text={status.word} inline />
            </span>
          )}
        </span>
        <MiddleCut
          text={node.name}
          tip={false}
          bold={bold}
          className="text-[13px] leading-5 font-medium text-ink-1"
        />
      </span>
    </>
  )
  const frame = cn(
    'flex size-full items-center gap-2.5 rounded-xl border bg-surface-2 px-3 text-left outline-none',
    kept === 'context' || node.context
      ? 'context border-dashed border-line'
      : 'border-line shadow-panel',
    // A marked card's edge in the warning colour, dashed too where it's shown for context.
    node.marked && 'border-warn shadow-[0_0_0_1px_var(--warn)]',
    'focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]',
    faded && 'opacity-35',
  )
  const shared = {
    ref,
    'aria-label': said,
    title: tooltip(node.name.their),
    onKeyDown,
    onPointerEnter: () => onLit(card.key),
    onFocus: () => onLit(card.key),
    onBlur: () => onLit(undefined),
    className: frame,
  }
  return (
    <div role="listitem" aria-level={level + 1} style={place(card)} className="absolute">
      {(node.opens || node.goes) && !node.context ? (
        <button type="button" onClick={onOpen} {...shared}>
          {body}
        </button>
      ) : (
        <div tabIndex={0} role="group" {...shared}>
          {body}
        </div>
      )}
    </div>
  )
}
