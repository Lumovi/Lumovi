/**
 * Keyboard shortcuts (LMV-358): every command with keys of its own, where its keys work, and
 * its keys by default on each platform. The menus, the palette, the ? sheet, tooltips and each
 * place's key handling read them from here, the person's own keys (Settings' `shortcuts`) over
 * the defaults, and the organization's over both.
 *
 * A key is a chord, written "Mod+Shift+K": modifiers in the order Mod, Ctrl, Alt, Shift, then
 * one key. Mod is ⌘ on a Mac and Ctrl elsewhere; Ctrl is ⌃ on a Mac (and the same as Mod
 * elsewhere). A key is a letter or digit as it's placed (so ⌥P is P whatever ⌥ makes of it), a
 * named key ("Escape", "Backspace", "ArrowUp", "F2"…), or a sign. Typed without Ctrl, Alt or Mod,
 * a sign is the one typed ("?" is Shift and /, on a US keyboard), as a filter's / is today.
 */

import { GO_KEYS, navLabel, QUICK_NAV } from './navigation'

/**
 * Where a command's keys work. Everywhere meets every other place, and there the narrower
 * place's key wins while it has the keyboard; of the others, a list and an open object beside
 * it meet, while the Clusters page and a terminal meet nothing but everywhere.
 */
export type Place = 'everywhere' | 'list' | 'object' | 'clusters' | 'terminal'

export const PLACE_NAMES: Record<Place, string> = {
  everywhere: 'Everywhere',
  list: 'In a list',
  object: 'In an open object',
  clusters: 'On the Clusters page',
  terminal: 'In a terminal',
}

/** As the ? sheet groups them. */
export type ShortcutGroup = 'General' | 'Lists' | 'Open object' | 'Clusters page' | 'Terminal'

export interface Shortcut {
  id: string
  label: string
  place: Place
  group: ShortcutGroup
  /** Its keys by default off a Mac, and on one where they differ. */
  keys: string[]
  mac?: string[]
  /** The desktop app's alone (a browser keeps its keys, or there's nothing there to do). */
  desktop?: true
  /** Shift as well does the same, further (X selects a row; with Shift, a range). */
  shiftExtends?: true
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'palette',
    label: 'Command palette',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+K'],
  },
  { id: 'filter', label: 'Filter the list', place: 'everywhere', group: 'General', keys: ['/'] },
  { id: 'refresh', label: 'Refresh', place: 'everywhere', group: 'General', keys: ['Mod+R'] },
  {
    id: 'create',
    label: 'Create…',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+N'],
    desktop: true,
  },
  { id: 'back', label: 'Back', place: 'everywhere', group: 'General', keys: ['Mod+['] },
  { id: 'forward', label: 'Forward', place: 'everywhere', group: 'General', keys: ['Mod+]'] },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    place: 'everywhere',
    group: 'General',
    keys: ['?', 'Mod+/'],
  },
  {
    id: 'settings',
    label: 'Settings',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+,'],
    desktop: true,
  },
  {
    id: 'clusters',
    label: 'All clusters',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+Shift+C'],
    desktop: true,
  },
  {
    id: 'new-window',
    label: 'New window',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+Shift+N'],
    desktop: true,
  },
  // (Off a Mac, a terminal keeps Ctrl+Shift+F while it has the keyboard.)
  {
    id: 'search',
    label: 'Search the cluster',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+Shift+F'],
  },
  {
    id: 'list.select',
    label: 'Select the row (Shift for a range)',
    place: 'list',
    group: 'Lists',
    keys: ['X'],
    shiftExtends: true,
  },
  {
    id: 'list.select-all',
    label: 'Select every row on the page',
    place: 'list',
    group: 'Lists',
    keys: ['Mod+A'],
  },
  {
    id: 'object.actions',
    label: 'Actions: scale, restart, edit…',
    place: 'object',
    group: 'Open object',
    keys: ['.'],
  },
  {
    id: 'object.delete',
    label: 'Delete',
    place: 'object',
    group: 'Open object',
    keys: ['Mod+Backspace'],
  },
  {
    id: 'object.review',
    label: 'Review a YAML edit',
    place: 'object',
    group: 'Open object',
    keys: ['Mod+S'],
  },
  {
    id: 'object.pin',
    label: 'Pin or unpin the open object',
    place: 'object',
    group: 'Open object',
    keys: ['Alt+P'],
  },
  {
    id: 'clusters.actions',
    label: 'A cluster’s actions',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['.'],
    desktop: true,
  },
  {
    id: 'clusters.settings',
    label: 'A cluster’s settings',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['Mod+I'],
    desktop: true,
  },
  {
    id: 'clusters.add',
    label: 'Add a cluster',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['Mod+N'],
    desktop: true,
  },
  {
    id: 'clusters.remove',
    label: 'Remove one added in Lumovi',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['Mod+Backspace'],
    desktop: true,
  },
  {
    id: 'terminal',
    label: 'Show or hide the terminal',
    place: 'everywhere',
    group: 'Terminal',
    keys: ['Mod+`'],
    mac: ['Ctrl+`'],
    desktop: true,
  },
  {
    id: 'new-terminal',
    label: 'New terminal',
    place: 'everywhere',
    group: 'Terminal',
    keys: ['Mod+Shift+`'],
    mac: ['Ctrl+Shift+`'],
    desktop: true,
  },
  {
    id: 'terminal.new',
    label: 'New terminal, from a terminal',
    place: 'terminal',
    group: 'Terminal',
    keys: ['Mod+Shift+T'],
    mac: ['Mod+T', 'Mod+N', 'Ctrl+Shift+T'],
    desktop: true,
  },
  {
    id: 'terminal.close',
    label: 'Close the terminal',
    place: 'terminal',
    group: 'Terminal',
    keys: ['Mod+Shift+W'],
    mac: ['Mod+W', 'Ctrl+Shift+W'],
    desktop: true,
  },
  {
    id: 'terminal.clear',
    label: 'Clear the terminal',
    place: 'terminal',
    group: 'Terminal',
    keys: [],
    mac: ['Mod+K'],
    desktop: true,
  },
  {
    id: 'terminal.next',
    label: 'Next terminal',
    place: 'terminal',
    group: 'Terminal',
    keys: ['Mod+PageDown'],
    mac: ['Mod+Shift+]', 'Ctrl+PageDown'],
    desktop: true,
  },
  {
    id: 'terminal.previous',
    label: 'Previous terminal',
    place: 'terminal',
    group: 'Terminal',
    keys: ['Mod+PageUp'],
    mac: ['Mod+Shift+[', 'Ctrl+PageUp'],
    desktop: true,
  },
]

/**
 * Keys built in, which can't be changed: ranges, sequences and the keys every list and dialog
 * has. Settings lists them where the sheet does, and refuses them while recording.
 */
export interface BuiltIn {
  label: string
  place: Place
  group: ShortcutGroup | 'Go to'
  /** The chords it holds, off a Mac and on one. */
  keys: string[]
  /** What it does, as a refusal says it: "it moves down a list". */
  says: string
  /** What the sheet shows, each a chord's caps (or one written for a range: "Mod+1–6"). */
  shown?: string[]
  desktop?: true
}

export const BUILT_INS: BuiltIn[] = [
  {
    label: 'Open a pinned object (the first nine)',
    place: 'everywhere',
    group: 'General',
    keys: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Alt+${n}`),
    shown: ['Alt+1–9'],
    says: 'it opens a pinned object',
  },
  {
    label: 'Run a saved search (the first nine)',
    place: 'everywhere',
    group: 'General',
    keys: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Alt+Shift+${n}`),
    shown: ['Alt+Shift+1–9'],
    says: 'it runs a saved search',
  },
  {
    label: 'Approve an AI assistant’s change',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+Enter'],
    says: 'it approves an AI assistant’s change',
    desktop: true,
  },
  {
    label: 'Actual size, zoom in and out',
    place: 'everywhere',
    group: 'General',
    keys: ['Mod+0', 'Mod+=', 'Mod+-', 'Mod+Shift+='],
    shown: ['Mod+0', 'Mod+=', 'Mod+-'],
    says: 'it sets the text size',
    desktop: true,
  },
  {
    label: 'Move through rows (or J / K)',
    place: 'list',
    group: 'Lists',
    keys: ['ArrowUp', 'ArrowDown', 'J', 'K'],
    shown: ['ArrowUp', 'ArrowDown'],
    says: 'it moves through a list',
  },
  {
    label: 'Open the selected row',
    place: 'list',
    group: 'Lists',
    keys: ['Enter'],
    says: 'it opens a list’s selected row',
  },
  {
    label: 'Previous / next page',
    place: 'list',
    group: 'Lists',
    keys: ['ArrowLeft', 'ArrowRight'],
    says: 'it turns a list’s page',
  },
  {
    label: 'First / last row',
    place: 'list',
    group: 'Lists',
    keys: ['Home', 'End'],
    says: 'it goes to a list’s first or last row',
  },
  {
    label: 'Close the detail panel',
    place: 'list',
    group: 'Lists',
    keys: ['Escape'],
    says: 'it closes what’s open',
  },
  {
    label: 'Move through clusters',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['ArrowUp', 'ArrowDown'],
    says: 'it moves through the clusters',
    desktop: true,
  },
  {
    label: 'Open the selected cluster',
    place: 'clusters',
    group: 'Clusters page',
    keys: ['Enter'],
    says: 'it opens the selected cluster',
    desktop: true,
  },
  {
    label: 'Rename the terminal (on its tab)',
    place: 'terminal',
    group: 'Terminal',
    keys: ['F2'],
    says: 'it renames a terminal',
    desktop: true,
  },
  ...GO_KEYS.map(({ key, target }, i): BuiltIn => ({
    label: navLabel(target),
    place: 'everywhere',
    group: 'Go to',
    // (G holds them all: the first says so.)
    keys: i === 0 ? ['G'] : [],
    shown: ['G', key.toUpperCase()],
    says: 'it starts a go-to key: G, then a letter',
  })),
  {
    label: `${QUICK_NAV.map(navLabel).join(', ')}`,
    place: 'everywhere',
    group: 'Go to',
    keys: QUICK_NAV.map((_, i) => `Mod+${i + 1}`),
    shown: [`Mod+1–${QUICK_NAV.length}`],
    says: 'it goes to one of the places the Go menu numbers',
    desktop: true,
  },
]

export const SHORTCUT_IDS = new Set(SHORTCUTS.map((shortcut) => shortcut.id))

const BY_ID = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]))

export const shortcutOf = (id: string): Shortcut => BY_ID.get(id)!

/** A command's keys by default on this platform. */
export const defaultKeys = (id: string, mac: boolean): string[] => {
  const shortcut = shortcutOf(id)
  return (mac && shortcut.mac) || shortcut.keys
}

/** Each command's keys: the person's own (and the organization's) over the defaults. */
export function effectiveKeys(
  own: Record<string, string[]> | undefined,
  mac: boolean,
): Record<string, string[]> {
  return Object.fromEntries(
    SHORTCUTS.map(({ id }) => [
      id,
      (own && Object.hasOwn(own, id) ? own[id] : undefined) ?? defaultKeys(id, mac),
    ]),
  )
}

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const

const NAMED = new Set([
  'Escape',
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/** By its place, the signs a chord with Ctrl, Alt or Mod names. */
const SIGNS: Record<string, string> = {
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
}

const KEY = /^([A-Z0-9]|F([1-9]|1[0-2])|[^\sA-Za-z0-9+])$/

/** Whether a chord is written as this file says. */
export function isChord(chord: unknown): chord is string {
  if (typeof chord !== 'string' || chord.length > 32) return false
  const parts = chord.split('+')
  // ("+" alone, or a modifier and "+": its last part is empty.)
  const key = chord.endsWith('++') ? '+' : parts.pop()!
  if (chord.endsWith('++')) parts.splice(-2)
  if (!(NAMED.has(key) || KEY.test(key) || key === '+')) return false
  let at = -1
  for (const part of parts) {
    const index = MODIFIERS.indexOf(part as (typeof MODIFIERS)[number])
    if (index <= at) return false
    at = index
  }
  return true
}

/** The modifiers and key of a chord. */
function parts(chord: string): { mods: Set<string>; key: string } {
  const all = chord.endsWith('++')
    ? [...chord.slice(0, -2).split('+').filter(Boolean), '+']
    : chord.split('+')
  const key = all.pop()!
  return { mods: new Set(all), key }
}

/** The same chord as this platform has it: off a Mac, Ctrl is Mod. */
export function normalChord(chord: string, mac: boolean): string {
  if (mac) return chord
  const { mods, key } = parts(chord)
  if (mods.delete('Ctrl')) mods.add('Mod')
  return [...MODIFIERS.filter((mod) => mods.has(mod)), key].join('+')
}

/** A key press, as a page's KeyboardEvent has it. */
export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** The chord a key press is, or none (a modifier alone, or the Windows key). */
export function chordOf(event: KeyPress, mac: boolean): string | undefined {
  if (['Shift', 'Control', 'Alt', 'Meta', 'OS', 'CapsLock'].includes(event.key)) return undefined
  const mods = new Set<string>()
  // (Off a Mac, the ⊞ or ⌘ key is Ctrl's stand-in too, as it always was in Lumovi.)
  if (event.ctrlKey || (!mac && event.metaKey)) mods.add(mac ? 'Ctrl' : 'Mod')
  if (event.altKey) mods.add('Alt')
  if (mac && event.metaKey) mods.add('Mod')
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit([0-9])$/.exec(event.code)?.[1]
  let key: string | undefined
  if (letter) key = letter
  else if (event.key === ' ') key = 'Space'
  else if (NAMED.has(event.key) || /^F([1-9]|1[0-2])$/.test(event.key)) key = event.key
  else if (mods.size === 0 && event.key.length === 1) {
    // A sign as typed: its Shift is in it.
    return event.key
  } else key = SIGNS[event.code] ?? (event.key.length === 1 ? event.key : undefined)
  if (!key) return undefined
  if (event.shiftKey) mods.add('Shift')
  return [...MODIFIERS.filter((mod) => mods.has(mod)), key].join('+')
}

/** Whether a key press is one of a command's keys. */
export function pressed(
  event: Parameters<typeof chordOf>[0],
  id: string,
  keys: Record<string, string[]>,
  mac: boolean,
): boolean {
  const chord = chordOf(event, mac)
  if (!chord) return false
  const own = keys[id]!.map((key) => normalChord(key, mac))
  if (own.includes(chord)) return true
  // On a Mac, Ctrl stands in for ⌘ where it isn't a key of its own (⌃K is ⌘K), as it always did.
  if (mac && event.ctrlKey && !event.metaKey && own.includes(chord.replace(/^Ctrl\+/, 'Mod+'))) {
    return true
  }
  // (X, and with Shift a range.)
  return Boolean(shortcutOf(id).shiftExtends) && own.includes(chord.replace(/(^|\+)Shift\+/, '$1'))
}

const MAC_CAPS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
const CAPS: Record<string, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: '⇧', Mod: 'Ctrl' }
const KEY_CAPS: Record<string, string> = {
  Escape: 'Esc',
  Enter: '↵',
  Backspace: '⌫',
  Delete: 'Del',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

/** A chord as its key caps: ["⌘", "⇧", "K"]. */
export function chordCaps(chord: string, mac: boolean): string[] {
  const { mods, key } = parts(normalChord(chord, mac))
  return [
    ...MODIFIERS.filter((mod) => mods.has(mod)).map((mod) => (mac ? MAC_CAPS : CAPS)[mod]!),
    KEY_CAPS[key] ?? key,
  ]
}

/** A chord as a tooltip says it: "⌘K" on a Mac, "Ctrl+Shift+T" off one. */
export function chordText(chord: string, mac: boolean): string {
  if (mac) return chordCaps(chord, true).join('')
  const caps = chordCaps(chord, false)
  return [...caps.slice(0, -1).map((cap) => (cap === '⇧' ? 'Shift' : cap)), caps.at(-1)].join('+')
}

/** A chord as Electron's menu has it, or none for one the page alone hears (no Ctrl, Alt or Mod). */
export function accelerator(chord: string): string | undefined {
  const { mods, key } = parts(chord)
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Mod')) return undefined
  const named: Record<string, string> = {
    Escape: 'Esc',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    '+': 'Plus',
  }
  const electron: Record<string, string> = {
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Mod: 'CmdOrCtrl',
  }
  return [
    ...MODIFIERS.filter((mod) => mods.has(mod)).map((mod) => electron[mod]),
    named[key] ?? key,
  ].join('+')
}

/** The system's own keys, which no command of Lumovi's takes (but a terminal's ⌘W, its default). */
export const SYSTEM_KEYS = {
  mac: [
    'Mod+C',
    'Mod+V',
    'Mod+X',
    'Mod+Z',
    'Mod+Shift+Z',
    'Mod+Q',
    'Mod+W',
    'Mod+H',
    'Mod+Alt+H',
    'Mod+M',
    'Mod+`',
  ],
  other: ['Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Y', 'Alt+F4'],
}

/** What a system key does, as Settings says it. */
const SYSTEM_SAYS: Record<string, string> = {
  'Mod+C': 'it copies',
  'Mod+V': 'it pastes',
  'Mod+X': 'it cuts',
  'Mod+Z': 'it undoes',
  'Mod+Shift+Z': 'it redoes',
  'Mod+Y': 'it redoes',
  'Mod+Q': 'it quits Lumovi',
  'Mod+W': 'it closes the window',
  'Mod+H': 'it hides Lumovi',
  'Mod+Alt+H': 'it hides the others',
  'Mod+M': 'it minimizes the window',
  'Mod+`': 'it goes to the next window',
  'Alt+F4': 'it closes the window',
}

/** Two places' keys can both work at once. */
export const meet = (a: Place, b: Place) =>
  a === b ||
  a === 'everywhere' ||
  b === 'everywhere' ||
  (a !== 'clusters' && a !== 'terminal' && b !== 'clusters' && b !== 'terminal')

/**
 * What giving a command a chord meets: refused (with why), or another command holding it where
 * both work (in the same place, or one everywhere and the other narrower), or nothing.
 */
export type Clash =
  | { kind: 'refused'; why: string }
  | { kind: 'taken'; by: string }
  | { kind: 'narrower'; by: string }
  | { kind: 'wider'; by: string }

export function clashOf(
  id: string,
  chord: string,
  {
    keys,
    mac,
    desktop,
    locked = [],
  }: {
    keys: Record<string, string[]>
    mac: boolean
    /** The desktop app's commands are there too. */
    desktop: boolean
    /** Commands whose keys the organization sets. */
    locked?: string[]
  },
): Clash | undefined {
  const normal = normalChord(chord, mac)
  const shortcut = shortcutOf(id)
  const own = defaultKeys(id, mac).map((key) => normalChord(key, mac))
  const system = (mac ? SYSTEM_KEYS.mac : SYSTEM_KEYS.other).find(
    (key) => normalChord(key, mac) === normal,
  )
  if (system && !own.includes(normal)) {
    return { kind: 'refused', why: `stays the system’s: ${SYSTEM_SAYS[system]}.` }
  }
  // A terminal's own keys: what's typed, and Ctrl and a letter (⌃C and the like; elsewhere,
  // Ctrl without Shift).
  if (shortcut.place === 'terminal') {
    const { mods, key } = parts(normal)
    const typed = !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Mod')
    const control = mac ? mods.has('Ctrl') : !mods.has('Shift') && key.length === 1
    if (typed || control) {
      return { kind: 'refused', why: 'is the terminal’s while it has the keyboard.' }
    }
  }
  const here = (other: { place: Place; desktop?: true }) =>
    (desktop || !other.desktop) && meet(shortcut.place, other.place)
  const built = BUILT_INS.find(
    (other) => here(other) && other.keys.some((key) => normalChord(key, mac) === normal),
  )
  if (built) return { kind: 'refused', why: `is built in: ${built.says}.` }
  for (const other of SHORTCUTS) {
    if (other.id === id || !here(other)) continue
    if (!keys[other.id]!.some((key) => normalChord(key, mac) === normal)) continue
    if (locked.includes(other.id)) {
      return { kind: 'refused', why: `is ${other.label}’s, which your organization set.` }
    }
    if (
      other.place === shortcut.place ||
      (shortcut.place !== 'everywhere' && other.place !== 'everywhere')
    ) {
      return { kind: 'taken', by: other.id }
    }
    return { kind: shortcut.place === 'everywhere' ? 'narrower' : 'wider', by: other.id }
  }
  return undefined
}

/**
 * What keys as a change leaves them can't be: one refused, or one doing two things where both
 * work. (A command's own defaults are always fine.) None, if they're fine.
 */
export function shortcutProblems(
  keys: Record<string, string[]>,
  mac: boolean,
  desktop: boolean,
): string[] {
  const problems: string[] = []
  for (const { id, label } of SHORTCUTS) {
    const own = defaultKeys(id, mac)
    for (const key of keys[id]!) {
      if (own.includes(key)) continue
      const clash = clashOf(id, key, { keys, mac, desktop })
      if (clash?.kind === 'refused') problems.push(`shortcuts: ${key} ${clash.why}`)
      else if (clash?.kind === 'taken') {
        problems.push(
          `shortcuts: ${key} can’t be both ${label}’s and ${shortcutOf(clash.by).label}’s.`,
        )
      }
    }
  }
  return problems
}
