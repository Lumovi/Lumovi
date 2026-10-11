/**
 * How a plugin's page places its parts: a stack, a row of tiles, a split, and nothing else. No
 * width, gap or position is a plugin's to give: these are Lumovi's.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { FrameCarries, PickList as PickListSaid, Tile as TileSaid } from '@shared/kit/page'
import type { ObjectRef } from '@shared/kit/table'
import { VIEW_ICONS } from '@renderer/components/KindIcon'
import { Tile } from '@renderer/components/Tile'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { useUi } from '@renderer/state/ui'
import { NamedAbove } from './PageHeader'
import { PickList, standing } from './PickList'

/** One under another, 16 px apart: what a page is when nothing else is said. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>
}

const ACROSS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' } as const

/**
 * A row of tiles: two to four, of equal width and the same height. On a phone they're two
 * across and wrap; one left alone on its line takes the width.
 */
export function Tiles({
  tiles,
  go,
  onOpen,
}: {
  tiles: TileSaid[]
  /** Opens the object a tile names: Lumovi's own to do. */
  go?: (object: ObjectRef) => void
  onOpen?: (carries: FrameCarries['openTile']) => void
}) {
  const across = Math.max(2, Math.min(4, tiles.length)) as 2 | 3 | 4
  return (
    <div className={cn('grid min-w-0 gap-4 phone:grid-cols-2 phone:gap-3', ACROSS[across])}>
      {tiles.map((tile, index) => (
        <div
          // (By its place too: whatever keys it was given, a row draws.)
          key={`${index}:${tile.key}`}
          className={cn(
            'min-w-0',
            tiles.length % 2 === 1 && index === tiles.length - 1 && 'phone:col-span-2',
          )}
        >
          <Tile
            icon={tile.icon && VIEW_ICONS[tile.icon]}
            label={tile.label}
            value={tile.value.text}
            words={tile.value.kind === 'words'}
            detail={tile.detail}
            status={tile.level}
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
  onPick?: (carries: FrameCarries['pick']) => void
  /** The rest of the page, for what's picked. */
  children: ReactNode
}) {
  const phone = useLayout() === 'phone'
  const setInside = useUi((ui) => ui.setInside)
  // What a person picked; until then, or when it's no longer a row, the list's own or its first.
  const [chosen, setChosen] = useState<string>()
  const [opened, setOpened] = useState(false)
  const has = (key: string | undefined) => list.rows.some((row) => row.key === key)
  const picked = has(chosen) ? chosen : has(list.picked) ? list.picked : standing(list)[0]?.key
  const row = list.rows.find((each) => each.key === picked)
  const pick = (key: string) => {
    setChosen(key)
    setOpened(true)
    if (key !== picked) onPick?.({ row: key })
  }

  // On a phone, what's picked is a page of its own: named in the top bar, with Back to the list.
  const inside = phone && opened && row !== undefined
  const name = row?.lead.name
  useEffect(() => {
    if (!inside || name === undefined) return
    setInside({ title: name, back: () => setOpened(false) })
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
