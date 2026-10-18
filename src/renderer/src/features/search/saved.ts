/**
 * Saved searches (LMV-171): what was typed into Search, kept as typed, the person's for every
 * cluster (in Settings, on this computer; on a server, per person). The first nine have keys,
 * ⌥⇧1–⌥⇧9 (Alt+Shift+1–9; on Windows, where Alt+Shift switches the input language,
 * Ctrl+Shift+1–9), firing where pins' keys fire: never while something is being typed, nor with a
 * dialog or menu open, nor on a phone or in a browser on Linux. By the key's place: ⌥⇧ and a
 * digit types a character of its own on some layouts.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { usePreferences, useSetPreferences } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { useLayout } from '@renderer/lib/layout'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { isEditable } from '../actions/ActionSurfaces'
import { PINS_NUMBERED } from '../shell/PinnedObjects'

const MAC = api.platform === 'darwin'
const WINDOWS = api.platform === 'win32'

/** A saved search's key as its caps: ["⌥", "⇧", "1"], ["Ctrl", "⇧", "1"] on Windows. */
export const savedKeyCaps = (number: number) => [
  MAC ? '⌥' : WINDOWS ? 'Ctrl' : 'Alt',
  '⇧',
  String(number),
]

/** And as a sentence says it: "⌥⇧1", "Ctrl+Shift+1". */
export const savedKey = (number: number) =>
  MAC ? `⌥⇧${number}` : `${WINDOWS ? 'Ctrl' : 'Alt'}+Shift+${number}`

/** The saved search a key runs (1–9), by the key's place; none for any other key. */
export function savedNumber(
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
): number | undefined {
  const digit = /^Digit([1-9])$/.exec(event.code)
  const held = WINDOWS ? event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey
  if (!digit || !held || !event.shiftKey || event.metaKey) return undefined
  return Number(digit[1])
}

/** Whether saved searches have keys here: as pins have theirs. */
export const savedKeysHere = (phone: boolean) => PINS_NUMBERED && !phone

/** The search page's address, running `text` (or before typing). */
export const searchPath = (context: string, text?: string) =>
  `/cluster/${encodeURIComponent(context)}/search${text ? `?q=${encodeURIComponent(text)}` : ''}`

/** The person's saved searches, and saving and removing them. */
export function useSavedSearches() {
  const saved = usePreferences().searches
  const set = useSetPreferences()
  return {
    saved,
    has: (text: string) => saved.includes(text.trim()),
    save: (text: string) => {
      // (Offered only for a search that isn't saved.)
      void set({ searches: [...saved, text.trim()] })
    },
    remove: (text: string) => {
      // (Offered only for a saved search.)
      const at = saved.indexOf(text)
      const before = saved
      void set({ searches: saved.filter((search) => search !== text) })
      // The later ones move up a key: said, with the key they have now.
      const moved = saved.slice(at + 1, 9)
      toast({
        tone: 'success',
        title: `Removed ${text}`,
        ...(moved.length > 0 && savedKeysHere(false)
          ? {
              description:
                moved.length === 1
                  ? `Saved search ${at + 2} is now ${savedKey(at + 1)}.`
                  : `Saved searches ${at + 2} to ${at + 1 + moved.length} are now ${savedKey(at + 1)} to ${savedKey(at + moved.length)}.`,
            }
          : {}),
        action: { label: 'Undo', run: () => void set({ searches: before }) },
      })
    },
  }
}

/** ⌥⇧1–⌥⇧9 run the first nine saved searches, in the cluster open and its namespaces. */
export function useSavedSearchKeys() {
  const { saved } = useSavedSearches()
  const { context } = useCluster()
  const navigate = useNavigate()
  const phone = useLayout() === 'phone'
  useEffect(() => {
    if (!savedKeysHere(phone)) return
    const onKeyDown = (event: KeyboardEvent) => {
      const number = savedNumber(event)
      if (
        number === undefined ||
        isEditable(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return
      const search = saved[number - 1]
      if (!search) return
      event.preventDefault()
      void navigate(searchPath(context, search))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saved, context, navigate, phone])
}

/** The saved searches' keys, where a cluster is open. */
export function SavedSearchKeys() {
  useSavedSearchKeys()
  return null
}
