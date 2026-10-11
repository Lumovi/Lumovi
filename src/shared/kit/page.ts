/**
 * A plugin's page, as its parts are placed. Three arrangements and nothing else hold the parts:
 * a stack (one under another), a row of tiles (two to four) and a split (a pick list at its side,
 * then a stack that follows what's picked; nothing holds a split, so a page has one at most).
 * No width, gap or position is a plugin's to give. A stack and a split are told nothing: they
 * draw the parts they hold (a split, the first pick list and the first stack it holds, and
 * nothing else). A row of tiles is one part, and its tiles are what it's told. Here is what the
 * pick list, the header that names what's picked, and the tiles are given. Data only, as the
 * Table's (`table.ts`).
 *
 * This is what the components are given. Between a plugin and them stands the door: what a tile
 * opens is, as a plugin says it, a token Lumovi gave it with an object it read; what a person
 * presses is a handler (`FrameCarries`), each called with one object of what it carries.
 */
import type { Health } from '../health'
import type { ViewIconName } from '../plugins'
import type { ObjectRef, TableLead, TableState } from './table'

/** How much may be said: counted where a description is taken in. */
export const FRAME_LIMITS = {
  /** Tiles in a row: fewer than two is no row, more than four doesn't fit one. */
  tiles: { least: 2, most: 4 },
  /** A header's buttons: three show, the rest are behind "…". */
  buttons: 8,
  /** Rows of a pick list. */
  picks: 1_000,
  /** Characters of a key. */
  key: 64,
  /** Characters of a name, a label, a value or a button. */
  text: 253,
  /** Characters of the line under a tile's value. */
  line: 500,
} as const

/** Past this many rows a pick list scrolls inside its side, with a filter above it. */
export const PICKS_BEFORE_FILTER = 12
/** How many of a header's buttons show; with more, "…" holds the rest. */
export const BUTTONS_SHOWN = 3

/**
 * A level and its word, as a Table's status cell: never cut. (A level is one of Lumovi's own,
 * and every part that draws one rests on that being checked where a description is taken in.)
 */
export interface Status {
  level: Health
  word: string
}

/** A headline: a figure or a few words, with what it's of and one line under. */
export interface Tile {
  /** Its own among its row's tiles. */
  key: string
  /** One of the icons a plugin may name; none, and the label starts at the edge. */
  icon?: ViewIconName
  /** What the value is of. Cut at its end where it doesn't fit. */
  label: string
  /**
   * The value: a `figure` is set large ("2/3", "17.2", "3h"); `words` (a name, "Never", "Off")
   * are set smaller on the same line and lose their middle where they don't fit.
   */
  value: { kind: 'figure' | 'words'; text: string }
  /** One line under the value, with a dot in a level where one is given. */
  detail?: string
  level?: Health
  /** The object it opens. A tile with one is pressed whole. */
  opens?: ObjectRef
}

/** Something a person can do with what's picked. */
export interface HeaderButton {
  /** Its own among the header's buttons. */
  key: string
  name: string
  /**
   * It changes the cluster: a phone doesn't draw it, and says where it is. This is the plugin's
   * own word about its button and decides only what's drawn: it is not what keeps a plugin from
   * changing anything on a phone. That's held where a change is asked for, by what the press
   * does.
   */
  changes?: boolean
  /** It asks before it does anything: its name is drawn ending in "…". */
  asks?: boolean
}

/**
 * The second-level header: what's picked, its status, and what can be done with it. The button
 * that matters most is the last, and the only filled one.
 */
export interface Header {
  name: string
  status?: Status
  buttons?: HeaderButton[]
}

/** A row of a pick list: a Table's lead with a status at its right. */
export interface Pick {
  /** Its own among the list's rows, and the same from one description to the next. */
  key: string
  lead: TableLead
  status?: Status
}

/** A list that one thing is always picked from; the rest of the page follows what's picked. */
export interface PickList {
  /** What's listed: said above it with how many, and what a screen reader calls it. */
  title: string
  rows: Pick[]
  /** The row that's picked as the page opens; the first, unless said (or it isn't a row). */
  picked?: string
  /** The rows stand as they're given; unless said, the worst status is first. */
  asGiven?: boolean
  /** In place of rows, when there are none to show (the Table's own states). */
  state?: TableState
}

/** What a person can press, and what each handler is called with. */
export interface FrameCarries {
  /** Picked a row of the pick list: its key. The rest of the page is then described for it. */
  pick: { row: string }
  /** Pressed one of the header's buttons: its key. */
  press: { button: string }
  /** Pressed a tile that opens something (Lumovi opens the object itself): the tile's key. */
  openTile: { tile: string }
}

/** The places (from 1) of the first two of these that are the same, if any are. */
function clash(keys: string[]): [number, number] | undefined {
  const seen = new Map<string, number>()
  for (const [index, key] of keys.entries()) {
    const first = seen.get(key)
    if (first !== undefined) return [first, index + 1]
    seen.set(key, index + 1)
  }
  return undefined
}

/*
 * What's wrong with a part that its kinds can't say, for whoever wrote it: where, counted from
 * 1 as they wrote it (both places, where two clash), then what, then what it should be. Each is
 * one line of Lumovi's own words that quotes nothing the part holds; nothing, when the part can
 * be drawn as it's described.
 */

/** A row of tiles: two to four, each with a key of its own. `row`: which of the page's, from 1. */
export function tilesProblem(tiles: Tile[], row?: number): string | undefined {
  const { least, most } = FRAME_LIMITS.tiles
  if (tiles.length < least || tiles.length > most) {
    return `A row of tiles has ${tiles.length} tile${tiles.length === 1 ? '' : 's'}; it takes ${least} to ${most}.`
  }
  const same = clash(tiles.map((tile) => tile.key))
  if (!same) return undefined
  return row === undefined
    ? `Tiles ${same[0]} and ${same[1]} of a row have the same key.`
    : `In tile row ${row}, tiles ${same[0]} and ${same[1]} have the same key.`
}

export function headerProblem(header: Header): string | undefined {
  const same = clash((header.buttons ?? []).map((button) => button.key))
  return same && `Header buttons ${same[0]} and ${same[1]} have the same key.`
}

/**
 * (A `picked` that isn't one of the rows is not refused: the picked thing may simply be gone
 * from the cluster by the next description, and the list then takes its first row.)
 */
export function pickListProblem(list: PickList): string | undefined {
  const same = clash(list.rows.map((row) => row.key))
  return same && `Pick list rows ${same[0]} and ${same[1]} have the same key.`
}
