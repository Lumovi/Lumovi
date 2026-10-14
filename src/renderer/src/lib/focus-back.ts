/**
 * Where the keyboard goes when what had it is drawn anew. A button that can be (busy once its
 * change is made, and back again when it's done: another element in its place each time) says
 * which it is (`data-focus-key`), and what's drawn in its place says the same. Whenever the one
 * with the keyboard goes and the keyboard is left on nothing (the page's body), it goes to the
 * one drawn in its place, as soon as it's there. And a dialog, closing, gives it back to the
 * button it was opened from, or to the one drawn in its place since. Never where the person has
 * put it since: their own press elsewhere ends it.
 */
import { useState } from 'react'

/** The element with a focus key that had the keyboard last, while nothing else has had it since. */
let keyed: HTMLElement | undefined

const keyOf = (element: unknown) =>
  element instanceof HTMLElement ? element.dataset.focusKey : undefined
const lost = () => document.activeElement === null || document.activeElement === document.body
const drawnFor = (key: string) =>
  document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) ?? undefined

/** What had the keyboard as a dialog opened: read as it's first drawn, before it takes it. */
export function useOpener(): Element | null {
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  return opener
}

/**
 * A dialog has closed: the keyboard goes back to what it was opened from, or to what's drawn in
 * its place, now or as soon as it is.
 */
export function focusBack(opener: Element | null): void {
  if (!(opener instanceof HTMLElement)) return
  const key = keyOf(opener)
  const to = opener.isConnected ? opener : key === undefined ? undefined : drawnFor(key)
  if (to) to.focus()
  // (Not drawn yet: it's the one the keyboard waits for.)
  else if (key !== undefined) keyed = opener
}

/**
 * Keeps the keyboard on a button drawn anew in its place, for the window's life: called once, as
 * Lumovi starts. What it returns stops it (the tests' own).
 */
export function keepFocusOnRedrawn(): () => void {
  const focused = (event: FocusEvent) => {
    keyed = keyOf(event.target) === undefined ? undefined : (event.target as HTMLElement)
  }
  // (The person's own press elsewhere: the keyboard is theirs to put, not Lumovi's to bring back.)
  const pressed = (event: PointerEvent) => {
    if (keyed && !(event.target instanceof Node && keyed.contains(event.target))) keyed = undefined
  }
  const watch = new MutationObserver(() => {
    if (!keyed || keyed.isConnected || !lost()) return
    const key = keyOf(keyed)
    const next = key === undefined ? undefined : drawnFor(key)
    next?.focus()
  })
  document.addEventListener('focusin', focused)
  document.addEventListener('pointerdown', pressed, true)
  watch.observe(document.body, { childList: true, subtree: true })
  return () => {
    document.removeEventListener('focusin', focused)
    document.removeEventListener('pointerdown', pressed, true)
    watch.disconnect()
    keyed = undefined
  }
}
