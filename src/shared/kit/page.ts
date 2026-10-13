/**
 * A plugin's page, as its parts are placed, declared in the Table's way (`table.ts`): what a
 * plugin may say, the door's check of it, and the parts' types worked out from it.
 *
 * Three arrangements and nothing else hold the parts: a stack (one under another), a pair (two
 * cards side by side) and a split (a pick list at its side, then a stack that follows what's
 * picked; nothing holds a split, so a page has one at most). No width, gap or position is a
 * plugin's to give. A stack is told nothing; a pair is told only which of its two is wider; a split
 * is told its list. Beside them: a row of tiles, the header that names what's picked, a card that
 * holds one part under a title, and counts (shares of a whole, as bars).
 *
 * Between a plugin and the components stands the door: every text a plugin wrote reaches them as
 * a `Their`, drawn in pieces; what a tile opens is, as a plugin says it, a token Lumovi gave it
 * with an object it read; and what a person presses is a handler, called with what its event
 * carries.
 */
import { VIEW_ICON_NAMES } from '../plugins'
import {
  cut,
  handler,
  list,
  number,
  object,
  oneOf,
  record,
  text,
  yesOrNo,
  type Part,
  type PropsOf,
  type WrittenProps,
} from './declare'
import { HEALTHS, lead, state, TABLE_LIMITS } from './table'

/** How much may be said: counted where a description is taken in. */
export const FRAME_LIMITS = {
  /** Tiles in a row: fewer than two is no row, more than four doesn't fit one. */
  tiles: { least: 2, most: 4 },
  /** A header's buttons: three show, the rest are behind "…". */
  buttons: 8,
  /** Rows of a pick list. */
  picks: 1_000,
  /** Characters of a key: as many as a Table row's, so a namespace and a name fit one. */
  key: TABLE_LIMITS.text,
  /** Characters of a name, a label, a value or a button. */
  text: 253,
  /** Characters of the line under a tile's value. */
  line: 500,
  /** Groups of counts, and the values in one. */
  counts: { groups: 6, rows: 50 },
} as const

/** Past this many rows a pick list scrolls inside its side, with a filter above it. */
export const PICKS_BEFORE_FILTER = 12
/** How many of a header's buttons show; with more, "…" holds the rest. */
export const BUTTONS_SHOWN = 3
/** How many of a group's counts show; with more, all but one of them, and "N more". */
export const COUNTS_SHOWN = 5

const key = text(FRAME_LIMITS.key)
const name = text(FRAME_LIMITS.text)
const line = text(FRAME_LIMITS.line)
/** As large as a count in a cluster comes. */
const LARGEST = Number.MAX_SAFE_INTEGER

/**
 * A level and its word, as a Table's status cell: never cut. (A level is one of Lumovi's own,
 * and every part that draws one rests on that being checked where a description is taken in.)
 */
const status = record({ level: oneOf(HEALTHS), word: name }, ['level', 'word'])

/** A headline: a figure or a few words, with what it's of and one line under. */
const tile = record(
  {
    /** Its own among its row's tiles. */
    key,
    /** One of the icons a plugin may name; none, and the label starts at the edge. */
    icon: oneOf(VIEW_ICON_NAMES),
    /** What the value is of. Cut at its end where it doesn't fit. */
    label: name,
    /**
     * The value: a `figure` is set large ("2/3", "17.2", "3h"); `words` (a name, "Never", "Off")
     * are set smaller on the same line and lose their middle where they don't fit.
     */
    value: record({ kind: oneOf(['figure', 'words'] as const), text: name }, ['kind', 'text']),
    /**
     * Its figure is counted from a read cut at Lumovi's limit: the token the door answered that
     * read with. Lumovi draws a "+" after the figure, and says so in the line under, from the
     * door's own numbers; a token it didn't make says nothing.
     */
    cut,
    /** One line under the value, with a dot in a level where one is given. */
    detail: line,
    level: oneOf(HEALTHS),
    /** The object it opens. A tile with one is pressed whole. */
    opens: object,
  },
  // (No value: still reading, or nothing to count. Its icon and label, the value's space kept.)
  ['key', 'label'],
)

/** A row of tiles: two to four, of equal width. */
export const tiles = {
  name: 'Tiles',
  holds: 'nothing',
  props: {
    tiles: list(tile, FRAME_LIMITS.tiles.most),
    /** Pressed a tile that opens something (Lumovi opens the object itself). */
    onOpen: handler('open'),
  },
  required: ['tiles'],
  events: { open: { tile: key } },
  also: (props) => tilesProblem(props.tiles as Keyed[]),
} as const satisfies Part

/** Something a person can do with what's picked. */
const button = record(
  {
    /** Its own among the header's buttons. */
    key,
    name,
    /**
     * It changes the cluster: a phone doesn't draw it, and says where it is. This is the plugin's
     * own word about its button and decides only what's drawn: it is not what keeps a plugin from
     * changing anything on a phone. That's held where a change is asked for, by what the press
     * does.
     */
    changes: yesOrNo,
    /** It asks before it does anything: its name is drawn ending in "…". */
    asks: yesOrNo,
  },
  ['key', 'name'],
)

/**
 * The second-level header: what's picked, its status, and what can be done with it. The button
 * that matters most is the last, and the only filled one.
 */
export const header = {
  name: 'Header',
  holds: 'nothing',
  props: {
    name,
    status,
    buttons: list(button, FRAME_LIMITS.buttons),
    /** Pressed one of its buttons. */
    onPress: handler('press'),
  },
  required: ['name'],
  events: { press: { button: key } },
  also: (props) => headerProblem((props.buttons ?? []) as Keyed[]),
} as const satisfies Part

/** A row of a pick list: a Table's lead with a status at its right. */
const pick = record(
  {
    /** Its own among the list's rows, and the same from one description to the next. */
    key,
    lead,
    status,
  },
  ['key', 'lead'],
)

/** A list that one thing is always picked from; the rest of the page follows what's picked. */
const pickList = record(
  {
    /** What's listed: said above it with how many, and what a screen reader calls it. */
    title: name,
    rows: list(pick, FRAME_LIMITS.picks),
    /** The row that's picked as the page opens; the first, unless said (or it isn't a row). */
    picked: key,
    /** The rows stand as they're given; unless said, the worst status is first. */
    asGiven: yesOrNo,
    /** In place of rows, when there are none to show (the Table's own states). */
    state,
  },
  ['title', 'rows'],
)

/**
 * A split: its pick list at its side, then the stack it holds, which follows what's picked. A
 * page has one at most, and nothing holds it.
 */
export const split = {
  name: 'Split',
  holds: ['Stack'],
  props: {
    list: pickList,
    /** Picked a row of its list: the rest of the page is then described for it. */
    onPick: handler('pick'),
  },
  required: ['list'],
  events: { pick: { row: key } },
  holdsMost: 1,
  most: 1,
  also: (props) => pickListProblem((props.list as { rows: Keyed[] }).rows),
} as const satisfies Part

/**
 * A card: a title, a quiet note at its right if one's given (words too, "20 · 3 still starting"),
 * and one part under them. Never an arrangement, so cards don't hold pages.
 */
export const card = {
  name: 'Card',
  holds: ['Table', 'Graph', 'Counts'],
  holdsMost: 1,
  props: { title: name, note: name },
  required: ['title'],
} as const satisfies Part

/**
 * Two cards side by side, exactly two: `wider`, the first is seven parts of twelve; `even` (unless
 * said), each half. Lumovi sets the widths; on a narrow page or a phone the two stand one under
 * the other, the first on top. (One alone is a card in the stack; three or four equal things are
 * tiles.)
 */
export const pair = {
  name: 'Pair',
  holds: ['Card'],
  holdsLeast: 2,
  holdsMost: 2,
  props: { first: oneOf(['wider', 'even'] as const) },
} as const satisfies Part

/** A value, and how many have it: a row of counts. */
const count = record({ value: name, count: number(0, LARGEST, true) }, ['value', 'count'])

/**
 * Shares of a whole, as bars: groups, each a title and its values with how many have each, the
 * largest first. Never a meter: a bar is a share of its group, in one colour, and never a level.
 */
export const counts = {
  name: 'Counts',
  holds: 'nothing',
  props: {
    groups: list(
      record(
        {
          title: name,
          /** The values are code (an instance type, a zone): set in mono. */
          code: yesOrNo,
          rows: list(count, FRAME_LIMITS.counts.rows),
        },
        ['title', 'rows'],
      ),
      FRAME_LIMITS.counts.groups,
    ),
  },
  required: ['groups'],
} as const satisfies Part

/** One under another, 16 px apart: what a page is when nothing else is said. */
export const stack = {
  name: 'Stack',
  // (Every part but a split, which nothing holds.)
  holds: ['Tiles', 'Header', 'Card', 'Pair', 'Table', 'Graph', 'Counts'],
  props: {},
} as const satisfies Part

/** The frame's parts, as their components take them: worked out from their declarations. */
export type TilesProps = PropsOf<typeof tiles>
export type Tile = NonNullable<TilesProps['tiles']>[number]
export type HeaderProps = PropsOf<typeof header>
export type HeaderButton = NonNullable<HeaderProps['buttons']>[number]
export type SplitProps = PropsOf<typeof split>
export type PickList = NonNullable<SplitProps['list']>
export type Pick = NonNullable<PickList['rows']>[number]
export type CardProps = PropsOf<typeof card>
export type PairProps = PropsOf<typeof pair>
export type CountsProps = PropsOf<typeof counts>
export type CountsGroup = NonNullable<CountsProps['groups']>[number]

/** The same, as a plugin writes them, before the door hands them over. */
export type WrittenTiles = WrittenProps<typeof tiles>
export type WrittenHeader = WrittenProps<typeof header>
export type WrittenSplit = WrittenProps<typeof split>
export type WrittenPickList = NonNullable<WrittenSplit['list']>
export type WrittenPick = NonNullable<WrittenPickList['rows']>[number]
export type WrittenCounts = WrittenProps<typeof counts>

/** What a person can press, and what each handler is called with. */
export interface FrameCarries {
  /** Picked a row of the pick list: its key. The rest of the page is then described for it. */
  pick: { row: string }
  /** Pressed one of the header's buttons: its key. */
  press: { button: string }
  /** Pressed a tile that opens something (Lumovi opens the object itself): the tile's key. */
  openTile: { tile: string }
}

/** Something written with a key of its own, as far as the checks below read it. */
interface Keyed {
  key: string
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
 * be drawn as it's described. Each reads a part whose kinds already passed.
 */

/** A row of tiles: two to four, each with a key of its own. */
export function tilesProblem(tiles: readonly Keyed[]): string | undefined {
  const { least, most } = FRAME_LIMITS.tiles
  if (tiles.length < least || tiles.length > most) {
    return `A row of tiles has ${tiles.length} tile${tiles.length === 1 ? '' : 's'}; it takes ${least} to ${most}.`
  }
  const same = clash(tiles.map((each) => each.key))
  return same && `Tiles ${same[0]} and ${same[1]} of a row have the same key.`
}

export function headerProblem(buttons: readonly Keyed[]): string | undefined {
  const same = clash(buttons.map((each) => each.key))
  return same && `Header buttons ${same[0]} and ${same[1]} have the same key.`
}

/**
 * (A `picked` that isn't one of the rows is not refused: the picked thing may simply be gone
 * from the cluster by the next description, and the list then takes its first row.)
 */
export function pickListProblem(rows: readonly Keyed[]): string | undefined {
  const same = clash(rows.map((each) => each.key))
  return same && `Pick list rows ${same[0]} and ${same[1]} have the same key.`
}
