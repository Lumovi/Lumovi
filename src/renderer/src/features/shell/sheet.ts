import { BUILT_INS, chordCaps, SHORTCUTS, type ShortcutGroup } from '@shared/shortcuts'
import { DESKTOP, MAC, useKeys } from '@renderer/lib/shortcuts'
import { PINS_NUMBERED } from './PinnedObjects'

export interface SheetRow {
  label: string
  /** A command's, whose keys can be changed; none for one built in. */
  id?: string
  /** Its keys: each a chord's caps (or keys pressed one after the other). */
  keys: string[][]
  /** Its keys are separate commands' (zoom's three), not two ways to one: drawn apart, no "or". */
  apart?: true
}

export interface SheetSection {
  title: ShortcutGroup | 'Go to'
  rows: SheetRow[]
  /** Said under its shortcuts. */
  note?: string
}

const GROUPS: SheetSection['title'][] = [
  'General',
  'Lists',
  'Open object',
  'Clusters page',
  'Terminal',
  'Go to',
]

/**
 * Every key Lumovi has here, as the ? sheet and Settings group them: each command's as the
 * person has them, and those built in.
 */
export function useSheet(): SheetSection[] {
  const { all } = useKeys()
  const here = (entry: { desktop?: true }) => DESKTOP || !entry.desktop
  return GROUPS.map((title) => {
    const commands = SHORTCUTS.filter((shortcut) => shortcut.group === title && here(shortcut)).map(
      ({ id, label }): SheetRow => ({
        id,
        label,
        // (Two at most: a third, kept as it always worked, isn't said where there's no room.)
        keys: all[id]!.slice(0, 2).map((chord) => chordCaps(chord, MAC)),
      }),
    )
    const built = BUILT_INS.filter(
      (entry) =>
        entry.group === title &&
        here(entry) &&
        // (Where they'd switch the browser's tabs, pins have none.)
        (PINS_NUMBERED || !entry.keys.includes('Alt+1')),
    ).map((entry): SheetRow => {
      const chords = (entry.shown ?? entry.keys).map((key) => chordCaps(key, MAC))
      // Single keys (↑ ↓, G then O) read as one; chords of their own (⌘0, ⌘=, ⌘-) stand apart.
      return chords.every((caps) => caps.length === 1)
        ? { label: entry.label, keys: [chords.flat()] }
        : { label: entry.label, keys: chords, apart: true }
    })
    return {
      title,
      // (A list's and the Clusters page's moving keys first, as they're met.)
      rows:
        title === 'Lists' || title === 'Clusters page'
          ? [...built, ...commands]
          : [...commands, ...built],
      ...(title === 'General' && !PINS_NUMBERED
        ? {
            note: 'In a browser on Linux, Alt+1 to 8 switch the browser’s tabs, so pinned objects have no number keys here: open them from the sidebar or the command palette.',
          }
        : {}),
    }
  }).filter((section) => section.rows.length > 0)
}
