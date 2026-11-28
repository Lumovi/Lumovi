/**
 * Finding in YAML and diffs (LMV-404): what ⌘F (Ctrl+F) opens, and where a find's matches are.
 *
 * A find looks only at the text that's drawn: each line's `[data-find-text]` element, its text
 * nodes as they are on the page. What isn't shown (a Secret's values, masked) isn't in them, so
 * it can't be found, and nothing is put on the page for a find's sake. A mark drawn for a
 * character (`Pieces`) is a break: a match never runs through one.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { whyNot } from './log-search'

/** A view that can be searched: its element, and what opens its search (or its field again). */
interface Finder {
  element: () => HTMLElement | null
  open: () => void
}

const finders = new Set<Finder>()

/** While it's on the page, ⌘F can open this view's search. */
export function useFinder(element: () => HTMLElement | null, open: () => void): void {
  const latest = useRef({ element, open })
  useEffect(() => {
    latest.current = { element, open }
  })
  useEffect(() => {
    const finder: Finder = {
      element: () => latest.current.element(),
      open: () => latest.current.open(),
    }
    finders.add(finder)
    return () => void finders.delete(finder)
  }, [])
}

/** How a view's bar is opened and closed, by whoever holds the view (Findable, an editor). */
interface Bound {
  /** Opens it (or puts the keyboard in its field again): closed, the keyboard goes to `back`. */
  open: (back: Element | null) => void
  /** Closes it, the keyboard back where it was (`giveBack`) or left where it is. */
  close: (giveBack: boolean) => void
}

/**
 * A view's find, for a button outside it (its toolbar's Find): whether its bar is open, and the
 * press that opens or closes it. The view binds to it, and says when its bar opens and closes.
 */
export interface FindControl {
  open: boolean
  /** The bar's id, for the button that opens it. */
  barId: string
  bind: (bound: Bound | null) => void
  shown: (open: boolean) => void
  /** The button's press: opens the bar (closed, the keyboard back on the button), or closes it. */
  press: (button: HTMLElement) => void
}

export function useFindControl(): FindControl {
  const [open, setOpen] = useState(false)
  const bound = useRef<Bound | null>(null)
  const barId = useId()
  return useMemo(
    () => ({
      open,
      barId,
      bind: (to) => void (bound.current = to),
      shown: setOpen,
      press: (button) => {
        if (!open) return bound.current?.open(button)
        // (Closed by its button: the keyboard stays on it.)
        bound.current?.close(false)
        button.focus()
      },
    }),
    [open, barId],
  )
}

const DIALOGS = '[role="dialog"], [role="alertdialog"]'

/**
 * Opens the search of the view in front: in the topmost open dialog, or (with none open) on the
 * page; the one with the keyboard, else the first that's in sight. Whether there was one.
 */
export function openFind(): boolean {
  const dialogs = document.querySelectorAll(DIALOGS)
  const top = dialogs[dialogs.length - 1]
  const shown = [...finders].flatMap((finder) => {
    const element = finder.element()
    if (!element?.isConnected || !element.checkVisibility()) return []
    // (Behind an open dialog, nothing is found: its own views, or none.)
    const inDialog = element.closest(DIALOGS)
    if (top ? inDialog !== top : inDialog) return []
    return [{ finder, element }]
  })
  const focused = document.activeElement
  const chosen =
    shown.find(({ element }) => focused && element.contains(focused)) ??
    shown
      .filter(({ element }) => inSight(element))
      .sort(({ element: a }, { element: b }) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )[0]
  chosen?.finder.open()
  return chosen !== undefined
}

function inSight(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect()
  return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
}

/** Whether Escape here is a search's (it closes the search), not the dialog's around it. */
export function escapeIsSearchs(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-panel, [data-find-bar]') !== null
}

/** The most matches a find marks: past them it counts no further. */
export const MOST_FOUND = 10_000

/** What a find looks for, and how: as the logs' search, without its lines that don't match. */
export interface FindQuery {
  text: string
  matchCase: boolean
  regex: boolean
}

export const NO_FIND: FindQuery = { text: '', matchCase: false, regex: false }

/**
 * A find, made ready: nothing to look for, a pattern (plain text is one of its own letters), or
 * why what's typed isn't a regular expression.
 */
export function patternOf(query: FindQuery): RegExp | { why: string } | undefined {
  if (!query.text) return undefined
  const flags = query.matchCase ? 'g' : 'gi'
  if (!query.regex) return new RegExp(query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  try {
    return new RegExp(query.text, flags)
  } catch {
    return { why: whyNot(query.text) }
  }
}

/**
 * Lines a view keeps folded away (a diff's unchanged ones): their text as it would be shown,
 * found where they'd be, and what unfolds them. Nothing of them is on the page until then.
 */
export interface Fold {
  texts: readonly string[]
  unfold: () => void
}

/** A match in a fold: which, and where in which of its lines. */
export interface Folded {
  fold: Fold
  element: Element
  line: number
}

/** A match: on the page, or in a fold. */
export type Found = Range | Folded

/**
 * Where a find's pattern is under `root`, in order, folds' lines among the rest: at most
 * `MOST_FOUND`. (A YAML view's text is short, and an editor's search runs its expressions here
 * too: no worker, unlike the logs'.)
 */
export function findIn(
  root: HTMLElement,
  pattern: RegExp,
  folds: ReadonlyMap<Element, Fold> = new Map(),
): Found[] {
  const found: Found[] = []
  for (const line of root.querySelectorAll<HTMLElement>('[data-find-text], [data-find-fold]')) {
    const fold = folds.get(line)
    if (fold) {
      for (const [index, text] of fold.texts.entries()) {
        for (const match of text.matchAll(pattern)) {
          if (match[0].length === 0) continue
          found.push({ fold, element: line, line: index })
          if (found.length >= MOST_FOUND) return found
        }
      }
      continue
    }
    // The line's runs of text: what's between its marks.
    for (const run of runsOf(line)) {
      const joined = run.map((node) => node.data).join('')
      // (Each after the last, not inside it: "••••" is in a mask of eight twice, not five
      // times. One that matches nothing marks nothing.)
      for (const match of joined.matchAll(pattern)) {
        if (match[0].length === 0) continue
        found.push(rangeOf(run, match.index, match.index + match[0].length))
        if (found.length >= MOST_FOUND) return found
      }
    }
  }
  return found
}

/**
 * A line's text nodes, in runs a mark (`[data-mark]`) breaks; without what's the line's own
 * and not its text (`[data-find-skip]`: a diff line's sign).
 */
function runsOf(line: HTMLElement): Text[][] {
  const runs: Text[][] = [[]]
  const visit = (node: Node) => {
    for (const child of node.childNodes) {
      if (child instanceof Text) runs[runs.length - 1]!.push(child)
      else if (child instanceof Element && child.hasAttribute('data-mark')) runs.push([])
      else if (child instanceof Element && child.hasAttribute('data-find-skip')) continue
      else visit(child)
    }
  }
  visit(line)
  return runs.filter((run) => run.length > 0)
}

/** A range over characters `start` to `end` (past it) of a run's joined text. */
function rangeOf(run: Text[], start: number, end: number): Range {
  const range = document.createRange()
  let at = 0
  let begun = false
  for (const node of run) {
    const length = node.data.length
    if (!begun && start < at + length) {
      range.setStart(node, start - at)
      begun = true
    }
    if (begun && end <= at + length) {
      range.setEnd(node, end - at)
      break
    }
    at += length
  }
  return range
}
