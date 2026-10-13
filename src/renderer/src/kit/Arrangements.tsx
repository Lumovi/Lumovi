/**
 * How a plugin's page places its parts: a stack, a pair, a split, and nothing else; and a row of
 * tiles. No width, gap or position is a plugin's to give: these are Lumovi's. Each takes what its
 * declaration (`@shared/kit/page`) says, as the door hands it: a plugin's texts as `Their`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { spelled } from '@shared/kit/characters'
import type { ListDestination, Their } from '@shared/kit/declare'
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
  go?: (list: ListDestination) => void
  onOpen?: TilesProps['onOpen']
}) {
  const across = Math.max(2, Math.min(4, tiles.length)) as 2 | 3 | 4
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
                  <TheirText text={tile.detail} inline />
                ) : undefined
              }
              // (A cut's line is Lumovi's saying where the count stops, not a level: no dot.)
              status={tile.cut ? undefined : tile.level}
              wraps={tile.cut !== undefined}
              cut
              onOpen={
                tile.opens
                  ? () => {
                      go?.(tile.opens!)
                      onOpen?.({ tile: tile.key })
                    }
                  : undefined
              }
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
 * A split: a pick list at its side, 300 px wide, then the rest, which follows what's picked.
 * One row is always picked: the one the list says, or its first. On a phone it's two pages:
 * the list, then what a tap opens, with Back and the picked thing's name in the top bar.
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
    const pressed = rows.find((each) => keyOf(each) === key)
    if (key !== picked) onPick?.({ row: pressed?.key ?? NOTHING_WRITTEN })
  }

  // On a phone, what's picked is a page of its own: named in the top bar, with Back to the list.
  const inside = phone && opened && row !== undefined
  const name = row?.lead.name.their
  useEffect(() => {
    if (!inside || name === undefined) return
    setInside({ title: spelled(name), back: () => setOpened(false) })
    return () => setInside(undefined)
  }, [inside, name, setInside])

  if (phone) {
    return inside ? (
      <NamedAbove value>
        <Stack>{children}</Stack>
      </NamedAbove>
    ) : (
      <PickList list={list} onPick={pick} />
    )
  }
  return (
    <div className="grid min-w-0 grid-cols-[300px_minmax(0,1fr)] items-start gap-4">
      <PickList list={list} picked={picked} onPick={pick} />
      {/* With nothing to list, the rest of the page shows nothing. */}
      {row ? <Stack>{children}</Stack> : <div />}
    </div>
  )
}
