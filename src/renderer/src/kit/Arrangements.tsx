/**
 * How a plugin's page places its parts: a stack, a pair, a split, and nothing else; and a row of
 * tiles. No width, gap or position is a plugin's to give: these are Lumovi's. Each takes what its
 * declaration (`@shared/kit/page`) says, as the door hands it: a plugin's texts as `Their`.
 */
import { ArrowLeft } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { spelled } from '@shared/kit/characters'
import type { ListDestination, ReachDestination, Their } from '@shared/kit/declare'
import type {
  PairProps,
  PickList as PickListSaid,
  SplitProps,
  Tile as TileSaid,
  TilesProps,
} from '@shared/kit/page'
import { VIEW_ICONS } from '@renderer/components/KindIcon'
import { Tile } from '@renderer/components/Tile'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { TILE_ROW, tileSpan } from '@renderer/lib/tile-rows'
import { offered, reachTip } from '@renderer/plugins/reach'
import { TheirText } from '@renderer/plugins/TheirText'
import { useUi } from '@renderer/state/ui'
import { NamedAbove } from './PageHeader'
import { PickList, standing } from './PickList'
import { counted, keyOf, NOTHING_WRITTEN, when } from './Table'

/** One under another, 16 px apart: what a page is when nothing else is said. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>
}

/** A moment as Lumovi says it ("3h", "in 4m"), kept current as time goes on. */
function Moment({ time }: { time: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return <>{when(time, now)}</>
}

/**
 * A tile's value: the plugin's figure or words; with a cut read under it, the figure and a "+"
 * (said "4,980 or more"); with none, its space kept (no dash: it's still reading, or there's
 * nothing to count), so a row of tiles doesn't jump when it comes.
 */
function valueOf(tile: TileSaid): ReactNode | Their {
  if (!tile.value) return '\u00a0'
  if (tile.value.kind === 'time') return <Moment time={tile.value.time} />
  if (!tile.cut || tile.value.kind !== 'figure') return tile.value.text
  return (
    <>
      <span aria-hidden>
        <TheirText text={tile.value.text} inline />+
      </span>
      <span className="sr-only">{spelled(tile.value.text.their)} or more</span>
    </>
  )
}

/**
 * A row of tiles: two to four, of equal width and the same height. On a phone they're two
 * across and wrap; one left alone on its line takes the width.
 */
export function Tiles({
  tiles,
  go,
  onOpen,
}: {
  tiles: readonly TileSaid[]
  /** Opens the list a tile names, as the door made it: Lumovi's own to do. */
  go?: (to: ListDestination | ReachDestination) => void
  onOpen?: TilesProps['onOpen']
}) {
  const across = Math.max(2, Math.min(4, tiles.length)) as 2 | 3 | 4
  // (A tile that links to a place Lumovi doesn't have here opens nothing.)
  const layout = useLayout()
  return (
    // (Laid out as Lumovi's own rows of tiles are: by the width it's given, not the window's.)
    <div className="@container min-w-0">
      <div className={cn('grid min-w-0 gap-4 phone:gap-3', TILE_ROW[across])}>
        {tiles.map((tile, index) => (
          <div
            // (By its place too: whatever keys it was given, a row draws.)
            key={`${index}:${keyOf(tile)}`}
            className={cn('min-w-0', tileSpan(index, tiles.length))}
          >
            <Tile
              icon={tile.icon && VIEW_ICONS[tile.icon]}
              label={tile.label}
              value={valueOf(tile)}
              words={tile.value?.kind === 'words' && !tile.cut}
              detail={
                // (Counted from a cut read, the line under is Lumovi's, never the plugin's.)
                tile.cut ? (
                  `Counted from the first ${counted(tile.cut.at)} Lumovi read.`
                ) : tile.detail?.their ? (
                  <Parts text={tile.detail} />
                ) : undefined
              }
              // (A cut's line is Lumovi's saying where the count stops, not a level: no dot.)
              status={tile.cut ? undefined : tile.level}
              // (Its label and value are cut at their ends; the line under wraps, never cut: a row
              // of tiles never draws one too narrow to say it.)
              wraps
              cut
              onOpen={
                tile.opens && (tile.opens.to !== 'reach' || offered(tile.opens.at, layout))
                  ? () => {
                      go?.(tile.opens!)
                      onOpen?.({ tile: tile.key })
                    }
                  : undefined
              }
              {...(tile.opens?.to === 'reach' ? { opensTip: reachTip(tile.opens) } : {})}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Two cards side by side, the first seven parts of twelve (`wider`) or half: Lumovi's widths.
 * Below 960 px of page, or on a phone, they stand one under the other, the first on top. It
 * holds exactly two cards: the door refuses a page that leaves it with fewer or puts in more.
 */
export function Pair({ first, children }: PairProps & { children: ReactNode }) {
  // (Measured by its own width: the page's, as a pair stands in a stack or at the top.)
  return (
    <div className="@container min-w-0">
      <div
        className={cn(
          'grid min-w-0 items-start gap-4',
          first === 'wider'
            ? '@[960px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]'
            : '@[960px]:grid-cols-2',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The least width a split stands side by side in: the list's 300 px, the gap, and room for the
 * rest (its tiles still two across).
 */
const SIDE_BY_SIDE = 640

/**
 * A split: a pick list at its side, 300 px wide, then the rest, which follows what's picked.
 * One row is always picked: the one the list says, or its first. On a phone it's two pages:
 * the list, then what a tap opens, with Back and the picked thing's name in the top bar. Given
 * less than `SIDE_BY_SIDE` (beside a row's panel), it's two pages in its own pane, with Back
 * above what's picked.
 */
export function Split({
  list,
  onPick,
  children,
}: {
  list: PickListSaid
  onPick?: SplitProps['onPick']
  /** The rest of the page, for what's picked. */
  children: ReactNode
}) {
  const phone = useLayout() === 'phone'
  const setInside = useUi((ui) => ui.setInside)
  // What a person picked; until then, or when it's no longer a row, the list's own or its first.
  const [chosen, setChosen] = useState<string>()
  const [opened, setOpened] = useState(false)
  // Its own width, not the window's: narrow, it's two pages in its pane. Narrowing takes nothing
  // away from someone using it (what was beside the list stays, with Back: a row they pressed
  // opened a panel); arriving narrow starts at the list, however it was laid out on the way.
  const [holder, setHolder] = useState<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  const wasNarrow = useRef<boolean>(undefined)
  const narrowed = useRef(false)
  const used = useRef(false)
  useLayoutEffect(() => {
    if (!holder) return
    const measure = () => {
      const now = holder.clientWidth < SIDE_BY_SIDE
      if (wasNarrow.current === false && now && used.current) {
        setOpened(true)
        narrowed.current = true
      }
      wasNarrow.current = now
      setNarrow(now)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(holder)
    return () => observer.disconnect()
  }, [holder])
  // Narrowed with the picked one's page kept: the row last pressed in it (a table's, as its
  // panel opened) stays in view, wherever the narrower page puts it.
  useEffect(() => {
    if (!narrow || !narrowed.current || !holder) return
    narrowed.current = false
    holder.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [narrow, holder])
  // Back stays in view as the picked one's page scrolls: at the pane's top, with a rule under it
  // while it stands there (where a phone's top bar is).
  const [back, setBack] = useState<HTMLDivElement | null>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    if (!back) return
    let pane = back.parentElement
    while (pane && !['auto', 'scroll'].includes(getComputedStyle(pane).overflowY)) {
      pane = pane.parentElement
    }
    if (!pane) return
    const look = () =>
      setStuck(back.getBoundingClientRect().top <= pane.getBoundingClientRect().top + 1)
    look()
    pane.addEventListener('scroll', look, { passive: true })
    return () => pane.removeEventListener('scroll', look)
  }, [back])
  // Where the keyboard goes as one page gives way to the other: Back, or the list.
  const focusNext = useRef<'back' | 'list'>(undefined)
  useEffect(() => {
    const to = focusNext.current
    focusNext.current = undefined
    if (!to || !holder) return
    holder
      .querySelector<HTMLElement>(to === 'back' ? '[data-split-back]' : '[role="listbox"]')
      ?.focus()
  })
  const rows = list.rows
  const has = (key: string | undefined) =>
    key !== undefined && rows.some((row) => keyOf(row) === key)
  const said = list.picked?.their
  const first = standing(list)[0]
  const picked = has(chosen) ? chosen : has(said) ? said : first && keyOf(first)
  const row = rows.find((each) => keyOf(each) === picked)
  const pick = (key: string) => {
    setChosen(key)
    setOpened(true)
    if (narrow) focusNext.current = 'back'
    const pressed = rows.find((each) => keyOf(each) === key)
    if (key !== picked) onPick?.({ row: pressed?.key ?? NOTHING_WRITTEN })
  }

  // On a phone, what's picked is a page of its own, with Back to the list in the top bar. The
  // bar is Lumovi's, and is handed only Back: the picked one's name is its plugin's text, and
  // is drawn here, in the plugin's page, as that page's first line.
  const inside = phone && opened && row !== undefined
  // (Back from it, the list has the keyboard on the row that was opened.)
  const [cameFrom, setCameFrom] = useState<string>()
  useEffect(() => {
    if (!inside) return
    setInside({
      back: () => {
        setCameFrom(picked)
        setOpened(false)
      },
    })
    return () => setInside(undefined)
  }, [inside, picked, setInside])

  if (phone) {
    return inside ? (
      <NamedAbove value>
        <div className="min-w-0">
          {/* Whole, wrapping where it must, on as many lines as it takes: the list cut it in its
              middle, and this is where a finger reads it. Set as a header's name is on a phone;
              what follows starts as far under it as a header's status does. (A line's end in
              it is a space: a name can't push the page down.) */}
          <h2 className="mb-3 min-w-0 text-[17px] leading-6 font-semibold text-ink-1">
            <TheirText text={row.lead.name} />
          </h2>
          <Stack>{children}</Stack>
        </div>
      </NamedAbove>
    ) : (
      <PickList list={list} onPick={pick} {...(cameFrom === undefined ? {} : { cameFrom })} />
    )
  }
  // Narrow, one page or the other: the list, or Back above what's picked. (Each in its own place
  // at every width, so what's drawn for the picked one stays as it is when the width changes.)
  const detail = !narrow || (opened && row !== undefined)
  return (
    <div
      ref={setHolder}
      onPointerDownCapture={() => (used.current = true)}
      onKeyDownCapture={() => (used.current = true)}
      className={cn(
        'min-w-0',
        narrow ? 'flex flex-col gap-3' : 'grid grid-cols-[300px_minmax(0,1fr)] items-start gap-4',
      )}
    >
      {!(narrow && detail) && <PickList list={list} picked={picked} onPick={pick} />}
      {narrow && detail && (
        // (Across the whole pane, its 16 px sides included, so nothing shows past it.)
        <div
          ref={setBack}
          className={cn(
            'sticky top-0 z-10 -mx-4 border-b bg-surface px-4',
            stuck ? 'border-line' : 'border-transparent',
          )}
        >
          <button
            type="button"
            data-split-back
            onClick={() => {
              setOpened(false)
              focusNext.current = 'list'
            }}
            className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ink-2 outline-none hover:bg-surface-3/60 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ArrowLeft className="size-4 shrink-0 text-ink-3" aria-hidden />
            <span className="sr-only">Back to </span>
            <TheirText text={list.title} inline />
          </button>
        </div>
      )}
      {/* With nothing to list, the rest of the page shows nothing. */}
      {detail && (row ? <Stack>{children}</Stack> : <div />)}
    </div>
  )
}

/**
 * A tile's line, as a plugin wrote it: where it's in parts (" · "), wrapped only between them,
 * each held whole where it fits on a line ("1 degraded · / 1 progressing", never "· 1 /
 * progressing"). One with no parts wraps as any text does.
 */
function Parts({ text }: { text: Their }) {
  const parts = text.their.split(' · ')
  if (parts.length < 2) return <TheirText text={text} inline />
  // (One text in the line, which may wrap: its parts in it, each held whole where it fits.)
  return (
    <span className="min-w-0">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <span data-part className="inline-block max-w-full">
            <TheirText text={part} inline />
          </span>
        </Fragment>
      ))}
    </span>
  )
}
