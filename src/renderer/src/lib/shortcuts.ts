/**
 * The keyboard shortcuts as they are here (LMV-358): each command's keys, the person's over the
 * defaults (shared/shortcuts.ts), for this platform. Key handling asks `pressed`; what shows a
 * key (the sheet, the palette, tooltips) uses `useKeys`, which follows a change at once.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  accelerator,
  chordCaps,
  chordOf,
  chordText,
  effectiveKeys,
  normalChord,
  pressed as pressedChord,
  shortcutOf,
  type KeyPress,
} from '@shared/shortcuts'
import { usePreferences } from '@renderer/hooks/settings'
import { api } from './api'

export const MAC = api.platform === 'darwin'

/** The desktop app's commands are here. */
export const DESKTOP = api.host === 'desktop'

let keys = effectiveKeys({}, MAC)

/** The person's keys, as Settings has them now (set as the page renders: Applied.tsx). */
export function setShortcutSettings(own: Record<string, string[]>): void {
  keys = effectiveKeys(own, MAC)
}

/** Whether a key press is one of a command's keys here. */
export function pressed(event: KeyPress, id: string): boolean {
  if (shortcutOf(id).desktop && !DESKTOP) return false
  return pressedChord(event, id, keys, MAC)
}

/** The commands of narrower places live now (their place has the keyboard), and what each does. */
const claims = new Map<string, () => void>()

/**
 * While it's shown, a place's command holds its keys over an everywhere command's: that one's
 * keys, and the menu's item for it, do this instead (⌘N adds a cluster on the Clusters page).
 */
export function useClaim(id: string, run: () => void, live = true): void {
  const latest = useRef(run)
  useEffect(() => {
    latest.current = run
  })
  useEffect(() => {
    if (!live) return
    const claim = () => latest.current()
    claims.set(id, claim)
    return () => {
      if (claims.get(id) === claim) claims.delete(id)
    }
  }, [id, live])
}

/** A live narrower place's command holding a chord, to run instead of an everywhere one's. */
function claimed(chord: string | undefined): (() => void) | undefined {
  if (!chord) return undefined
  for (const [id, run] of claims) {
    if (keys[id]!.some((key) => normalChord(key, MAC) === chord)) return run
  }
  return undefined
}

/** A key press a live narrower place holds: its command, run instead. */
export const claimedPress = (event: KeyPress) => claimed(chordOf(event, MAC))

/** What the menu's item for a command does where a live narrower place holds its key. */
export function claimedMenu(id: string): (() => void) | undefined {
  // (The menu holds a command's first key it can.)
  const held = keys[id]?.find((key) => accelerator(key) !== undefined)
  return held ? claimed(normalChord(held, MAC)) : undefined
}

/** Each command's keys, as they are now, and its first as caps or as a tooltip says it. */
export function useKeys() {
  const own = usePreferences().shortcuts
  return useMemo(() => {
    const all = effectiveKeys(own, MAC)
    // (None for one of the desktop app's, in a browser.)
    const first = (id: string): string | undefined =>
      shortcutOf(id).desktop && !DESKTOP ? undefined : all[id]![0]
    return {
      all,
      /** Its first key's caps, or none where it has no keys. */
      caps: (id: string) => {
        const chord = first(id)
        return chord ? chordCaps(chord, MAC) : undefined
      },
      /** Its first key as a tooltip says it, or none. */
      text: (id: string) => {
        const chord = first(id)
        return chord ? chordText(chord, MAC) : undefined
      },
      /** "Refresh (⌘R)", or "Refresh" where it has no keys. */
      label: (label: string, id: string) => {
        const chord = first(id)
        return chord ? `${label} (${chordText(chord, MAC)})` : label
      },
    }
  }, [own])
}
