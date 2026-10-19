/**
 * One declaration, and everything that says what a plugin's page may hold reads it: the door
 * (`DECLARED`, src/shared/kit/parts.ts), the checker of plugins (which builds the door with it,
 * and reads `PLUGIN_SINCE` for what each part and property first came with), the kit's own types
 * (`PropsOf`, worked out from it) and the pages for whoever writes a plugin (docs/plugin-kit.json,
 * which their own check holds the kit's reference to). None of them can gain a part, a property
 * or a limit the others don't know: each is made from the declaration, or compared with it here.
 *
 * `npm run plugin-kit` writes docs/plugin-kit.json again after a part, a property or a limit
 * changes. Plain data and plain functions: nothing is built or launched.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '../temp-folders.ts'
import prettier from 'prettier'
import type { Kind, Part, PropsOf } from '../../src/shared/kit/declare.ts'
import { GRAPH_LIMITS, type GraphProps } from '../../src/shared/kit/graph.ts'
import {
  FRAME_LIMITS,
  type CardProps,
  type CountsProps,
  type HeaderProps,
  type PairProps,
  type SplitProps,
  type TilesProps,
} from '../../src/shared/kit/page.ts'
import { DECLARED } from '../../src/shared/kit/parts.ts'
import { SHOWN_LIMITS } from '../../src/shared/kit/shown.ts'
import { TABLE_LIMITS, type TableProps } from '../../src/shared/kit/table.ts'
import { DOOR_LIMITS } from '../../src/shared/plugin-door.ts'
import { EVENT_MESSAGE_CUTS, READ_LIMITS } from '../../src/shared/plugin-reads.ts'
import { SERVER_LIMITS } from '../../src/shared/plugin-server.ts'
import { PLUGIN_SINCE } from '../../src/shared/plugin-since.ts'

type Parts = Readonly<Record<string, Part>>

/** Where the declarations are written out for the docs' own check: this repository's main. */
const FILE = 'docs/plugin-kit.json'

/**
 * The declarations as data anyone can read without Lumovi's code: of each part, what it may hold,
 * its properties and which are required, its events, and how many there may be; and every limit
 * the door, a read, an ask of a tool's server and the parts have. And, under `kinds`, each
 * part's properties and what its events carry as they're declared, kind for kind (a declaration
 * is data): a text's most, a list's items, a choice's variants. So a property that keeps its
 * name and changes its kind is a different file too.
 */
function described(parts: Parts = DECLARED) {
  return {
    parts: Object.fromEntries(
      Object.entries(parts).map(([name, part]) => [
        name,
        {
          holds: part.holds,
          props: Object.keys(part.props).sort(),
          required: [...(part.required ?? [])].sort(),
          events: Object.keys(part.events ?? {}).sort(),
          ...(part.holdsMost !== undefined ? { holdsMost: part.holdsMost } : {}),
          ...(part.holdsLeast !== undefined ? { holdsLeast: part.holdsLeast } : {}),
          ...(part.most !== undefined ? { most: part.most } : {}),
        },
      ]),
    ),
    kinds: Object.fromEntries(
      Object.entries(parts).map(([name, part]) => [
        name,
        { props: part.props, ...(part.events ? { events: part.events } : {}) },
      ]),
    ),
    // (Where an event's message is cut before it's handed: what the kit page says exactly.)
    eventMessageCuts: EVENT_MESSAGE_CUTS,
    limits: {
      door: DOOR_LIMITS,
      reads: READ_LIMITS,
      frame: FRAME_LIMITS,
      table: TABLE_LIMITS,
      graph: GRAPH_LIMITS,
      server: SERVER_LIMITS,
      shown: SHOWN_LIMITS,
    },
  }
}

/** `described`, as the file holds it: formatted as the repository is. */
const written = async (parts: Parts = DECLARED) =>
  prettier.format(JSON.stringify(described(parts)), {
    ...(await prettier.resolveConfig(FILE)),
    filepath: FILE,
  })

/** The named values a step of a path is looked up in: a record's, or each of a choice's. */
const fieldsOf = (kind: Kind): Readonly<Record<string, Kind>>[] =>
  kind.kind === 'record' ? [kind.fields] : kind.kind === 'choice' ? Object.values(kind.of) : []

/**
 * Whether the door's declarations have what a `PLUGIN_SINCE.props` key names: a part, then a path
 * into its properties as the checker reads one (`says`, in the plugins' own checks): a name for a
 * property, `[]` after it for each item of a list, and `kind=time` for a choice's variant.
 */
function declares(key: string, parts: Parts = DECLARED): boolean {
  const [name, ...steps] = key.split('.')
  const part = parts[name!]
  if (!part || steps.length === 0) return false
  let at: Kind[] = [{ kind: 'record', fields: part.props }]
  for (const step of steps) {
    const [word, is] = step.split('=')
    if (is !== undefined) {
      // One of a choice's variants, by the word its `by` field holds.
      at = at.flatMap((kind) =>
        kind.kind === 'choice' && kind.by === word && Object.hasOwn(kind.of, is)
          ? [{ kind: 'record', fields: kind.of[is]! } as const]
          : [],
      )
      continue
    }
    const each = word!.endsWith('[]')
    const field = each ? word!.slice(0, -2) : word!
    const found = at
      .flatMap(fieldsOf)
      .flatMap((fields) => (Object.hasOwn(fields, field) ? [fields[field]!] : []))
    // (`[]` is said of a list, and only of one: the checker steps into a list's items by it.)
    at = each
      ? found.flatMap((kind) => (kind.kind === 'list' ? [kind.of] : []))
      : found.filter((kind) => kind.kind !== 'list' || step === steps.at(-1))
  }
  return at.length > 0
}

/** Every kind of value the declarations hold, anywhere in a part's properties or events. */
function kindsIn(parts: Parts): Set<string> {
  const seen = new Set<string>()
  const walk = (kind: Kind): void => {
    seen.add(kind.kind)
    if (kind.kind === 'list') walk(kind.of)
    for (const fields of fieldsOf(kind)) Object.values(fields).forEach(walk)
  }
  for (const part of Object.values(parts)) {
    Object.values(part.props).forEach(walk)
    for (const carried of Object.values(part.events ?? {})) Object.values(carried).forEach(walk)
  }
  return seen
}

test('docs/plugin-kit.json is the declarations, written out: every part, what it holds and takes, and every limit', async () => {
  const now = await written()
  if (process.env.LUMOVI_PLUGIN_KIT === 'write') writeFileSync(FILE, now)
  // (Out of date after a part, a property or a limit changed: `npm run plugin-kit` writes it,
  // and the docs' own check then holds the kit's page to it.)
  expect(readFileSync(FILE, 'utf8')).toBe(now)
})

test('the checker’s list names the door’s parts, kinds and properties, and none the door doesn’t have', () => {
  expect(Object.keys(PLUGIN_SINCE.parts).sort()).toEqual(Object.keys(DECLARED).sort())
  const kinds = kindsIn(DECLARED)
  for (const kind of Object.keys(PLUGIN_SINCE.kinds)) expect(kinds.has(kind), kind).toBe(true)
  for (const key of Object.keys(PLUGIN_SINCE.props)) expect(declares(key), key).toBe(true)
  // (What `declares` refuses: a part there isn't, a property there isn't, a variant there isn't,
  // a list stepped into without its `[]`, and `[]` said of what's no list.)
  for (const key of [
    'Tabel.title',
    'Table',
    'Table.rows[].cells[].nope',
    'Tiles.tiles[].value.kind=nope',
    'Table.rows.cells[].mono',
    'Table.title[]',
  ]) {
    expect(declares(key), key).toBe(false)
  }
})

test('a part, a property or a limit in only one place fails: the file, the checker’s list and the door are held to each other', async () => {
  const file = readFileSync(FILE, 'utf8')
  // A part the door gains: the file no longer says what the door has, and the checker's list
  // (the release each part first came with) is short of it.
  const more: Parts = { ...DECLARED, Gauge: { name: 'Gauge', holds: 'nothing', props: {} } }
  expect(await written(more)).not.toBe(file)
  expect(Object.keys(PLUGIN_SINCE.parts).sort()).not.toEqual(Object.keys(more).sort())
  // A property a part gains, one it loses, one that becomes required, what it may hold, how
  // many there may be; and one that keeps its name and changes its kind, or only its most.
  const card = DECLARED.Card
  const changed: Part[] = [
    { ...card, props: { ...card.props, tone: { kind: 'yes-or-no' } } },
    { ...card, props: Object.fromEntries(Object.entries(card.props).slice(1)) },
    { ...card, required: Object.keys(card.props) },
    { ...card, holds: 'nothing' },
    { ...card, most: 3 },
    { ...card, props: { ...card.props, about: { kind: 'yes-or-no' } } },
    { ...card, props: { ...card.props, about: { kind: 'text', max: FRAME_LIMITS.about + 1 } } },
  ]
  for (const [i, part] of changed.entries()) {
    expect(await written({ ...DECLARED, Card: part }), `change ${i + 1}`).not.toBe(file)
  }
  // A property the checker's list names and the door hasn't (or has no longer).
  const fewer: Parts = { ...DECLARED, Card: changed[1]! }
  expect(declares(`Card.${Object.keys(card.props)[0]!}`)).toBe(true)
  expect(declares(`Card.${Object.keys(card.props)[0]!}`, fewer)).toBe(false)
  // A limit that moves is a different file too: each is written out as the door holds it.
  expect(file).toContain(JSON.stringify(DOOR_LIMITS.logStreamsPage))
  expect(JSON.parse(file)).toMatchObject({ limits: { door: DOOR_LIMITS, table: TABLE_LIMITS } })
})

/**
 * The kit's types, held by the compiler as this file is checked (`npm run typecheck`): what a
 * component of Lumovi's takes is its part's declaration, worked out and never written beside it,
 * so a type with a property its declaration hasn't (or without one it has) doesn't compile here.
 * (Stack, Logs and Secret have no type of their own exported to compare: what draws them takes
 * their properties as the door hands them. What draws each part is held the same way where it's
 * made: `DRAWN`, in the renderer's kit.tsx, has one for every part of `DECLARED` and no other.)
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Declared = typeof DECLARED
export const TYPES_ARE_THE_DECLARATIONS: [
  Same<TableProps, PropsOf<Declared['Table']>>,
  Same<GraphProps, PropsOf<Declared['Graph']>>,
  Same<TilesProps, PropsOf<Declared['Tiles']>>,
  Same<HeaderProps, PropsOf<Declared['Header']>>,
  Same<SplitProps, PropsOf<Declared['Split']>>,
  Same<CardProps, PropsOf<Declared['Card']>>,
  Same<PairProps, PropsOf<Declared['Pair']>>,
  Same<CountsProps, PropsOf<Declared['Counts']>>,
  // (And no property but the declared ones, part by part.)
  Same<keyof TableProps, keyof Declared['Table']['props']>,
  Same<keyof CardProps, keyof Declared['Card']['props']>,
] = [true, true, true, true, true, true, true, true, true, true]
