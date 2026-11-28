/**
 * A view of YAML or a diff that ⌘F (Ctrl+F) searches (LMV-404): the find bar above it, and its
 * matches marked where they're drawn. What it finds is the text on the page and nothing else
 * (`lib/find.ts`); it's marked by the page's highlights, so nothing is added to the text.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  findIn,
  NO_FIND,
  type Fold,
  type Found,
  patternOf,
  useFindControl,
  useFinder,
  type FindControl,
} from '@renderer/lib/find'
import { FindBar } from './FindBar'

/** Every view's matches, and the current one of each: one highlight of each for the page. */
const HIGHLIGHTS = typeof CSS !== 'undefined' && 'highlights' in CSS
const every = HIGHLIGHTS ? new Highlight() : undefined
const current = HIGHLIGHTS ? new Highlight() : undefined
if (every && current) {
  CSS.highlights.set('lumovi-find', every)
  // (Over every match, as it's one of them.)
  current.priority = 1
  CSS.highlights.set('lumovi-find-current', current)
}

/** Where a view's folds are told to the find round them: by each fold's element. */
const Folds = createContext<Map<Element, Fold> | null>(null)

/** How many matches each fold holds, while there's a search: by its element. */
const FoldCounts = createContext<ReadonlyMap<Element, number>>(new Map())

/** How many of a search's matches a fold holds (none while there's no search). */
export function useFoldCount(element: Element | null): number {
  const counts = useContext(FoldCounts)
  return (element && counts.get(element)) || 0
}

/**
 * A fold of lines (a diff's unchanged ones), for the find round it: its lines' text as it would
 * be shown, and what unfolds it. A match in it counts, and a step to one unfolds it.
 */
export function useFold(element: Element | null, fold: Fold): void {
  const folds = useContext(Folds)
  const latest = useRef(fold)
  useLayoutEffect(() => {
    latest.current = fold
  })
  useLayoutEffect(() => {
    const at = element
    if (!folds || !at) return
    folds.set(at, {
      get texts() {
        return latest.current.texts
      },
      unfold: () => latest.current.unfold(),
    })
    return () => void folds.delete(at)
  }, [folds, element])
}

const NONE: ReadonlyMap<Element, number> = new Map()

export function Findable({
  label,
  inside = false,
  control: given,
  children,
}: {
  /** What's searched, as the bar names it: "YAML", "Changes". */
  label: string
  /**
   * What's searched is scrolled by what holds it, and laid out by it: the bar stays at the top
   * of that, and nothing else stands between the two.
   */
  inside?: boolean
  /** Its toolbar's Find, where it has one. */
  control?: FindControl
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  /** What had the keyboard as the bar opened: it goes back there as it closes. */
  const before = useRef<Element | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(NO_FIND)
  // The matches, and the current one: none until the person steps to one.
  const [found, setFound] = useState<{ ranges: Found[]; at: number }>({ ranges: [], at: -1 })
  const [folds] = useState(() => new Map<Element, Fold>())
  const [foldCounts, setFoldCounts] = useState<ReadonlyMap<Element, number>>(new Map())
  // A step to a match in a fold unfolds it: it's brought into sight once it's drawn.
  const unfolding = useRef(false)
  // Counts the page's changes under the view, so its matches are found again.
  const [drawn, setDrawn] = useState(0)
  // Counts the asks to open: each puts the keyboard in the field again, its text selected.
  const [asked, setAsked] = useState(0)

  const own = useFindControl()
  const control = given ?? own
  /** Opens the bar, or puts the keyboard in its field again; closed, it goes back to `back`. */
  const show = (back: Element | null) => {
    if (!open) before.current = back
    setOpen(true)
    setAsked((n) => n + 1)
  }
  const hide = (giveBack: boolean) => {
    setOpen(false)
    const back = before.current
    before.current = null
    if (giveBack && back instanceof HTMLElement && back.isConnected) back.focus()
  }
  useEffect(() => {
    control.bind({ open: show, close: hide })
    return () => control.bind(null)
  })
  useEffect(() => control.shown(open), [control, open])

  useFinder(
    // (Inside, there's no box of its own: its holder is where it's seen.)
    () => (inside ? root.current?.parentElement : root.current) ?? null,
    () => show(document.activeElement),
  )

  useEffect(() => {
    if (!open) return
    field.current?.focus()
    field.current?.select()
  }, [open, asked])

  // What's drawn changes (the object's newer version, a Secret's values shown): found again.
  useEffect(() => {
    if (!open) return
    // (Not the bar's own changes: its count.)
    const observer = new MutationObserver((records) => {
      const bar = root.current?.querySelector('[data-find-bar]')
      if (records.some(({ target }) => !bar?.contains(target))) setDrawn((n) => n + 1)
    })
    observer.observe(root.current!, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [open])

  const pattern = open ? patternOf(query) : undefined
  const problem = pattern && 'why' in pattern ? pattern.why : undefined
  const source = pattern instanceof RegExp ? pattern : undefined
  // A new search has no current match; the same one, redrawn, keeps its place.
  const searched = useRef('')
  const latest = useRef(found)
  useLayoutEffect(() => {
    latest.current = found
  })
  const sought = source ? `${source.flags}/${source.source}` : ''
  useLayoutEffect(() => {
    const fresh = searched.current !== sought
    searched.current = sought
    const ranges = sought ? findIn(root.current!, patternOf(query) as RegExp, folds) : []
    const was = latest.current.at
    setFound({ ranges, at: fresh || ranges.length === 0 ? -1 : Math.min(was, ranges.length - 1) })
    const counts = new Map<Element, number>()
    for (const match of ranges) {
      if (!(match instanceof Range)) counts.set(match.element, (counts.get(match.element) ?? 0) + 1)
    }
    // (Only told anew when they've changed: what a fold says is drawn, and seen again.)
    setFoldCounts((had) =>
      had.size === counts.size && [...counts].every(([at, n]) => had.get(at) === n) ? had : counts,
    )
    // (The query is what `sought` says of it.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sought, drawn])

  // Marked: this view's matches on the page, among every view's.
  useEffect(() => {
    if (!open || !every || !current) return
    const drawn = found.ranges.filter((match) => match instanceof Range)
    for (const range of drawn) every.add(range)
    const now = found.ranges[found.at]
    if (now instanceof Range) current.add(now)
    return () => {
      for (const range of drawn) every.delete(range)
      if (now instanceof Range) current.delete(now)
    }
  }, [open, found])

  // The view resized (a phone's keyboard up, the panel narrower): the current match kept in sight.
  useEffect(() => {
    const now = found.ranges[found.at]
    if (!open || !(now instanceof Range)) return
    const resized = new ResizeObserver(() =>
      reveal(now, root.current?.querySelector('[data-find-bar]')),
    )
    // (Inside, it has no box of its own to resize: its holder's is watched.)
    resized.observe(inside ? root.current!.parentElement! : root.current!)
    return () => resized.disconnect()
  }, [open, found, inside])

  // The match a step unfolded, drawn now: into sight.
  useEffect(() => {
    const now = found.ranges[found.at]
    if (!unfolding.current || !(now instanceof Range)) return
    unfolding.current = false
    reveal(now, root.current?.querySelector('[data-find-bar]'))
  }, [found])

  const barOf = () => root.current?.querySelector('[data-find-bar]')

  // Where its own view doesn't scroll (a phone's page does, under its tabs): the bar stays there.
  const [stuck, setStuck] = useState<number | undefined>()
  useLayoutEffect(() => {
    if (!open || inside) return
    setStuck(stickAt(root.current!))
  }, [open, inside])

  /** The next (or previous) match; the first step, from the first in sight. */
  const step = (by: 1 | -1) => {
    const { ranges, at } = found
    if (ranges.length === 0) return
    let next: number
    if (at >= 0) next = (at + by + ranges.length) % ranges.length
    else {
      const first = ranges.findIndex((match) => inView(match, barOf()))
      const from = first < 0 ? 0 : first
      next = by === 1 ? from : (from - 1 + ranges.length) % ranges.length
    }
    const to = ranges[next]!
    if (to instanceof Range) reveal(to, barOf())
    else {
      // (Unfolded, its lines are the same text, drawn: the same matches, in the same order.)
      unfolding.current = true
      to.fold.unfold()
    }
    setFound({ ranges, at: next })
  }

  return (
    <div ref={root} className={inside ? 'contents' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
      {open && (
        <FindBar
          label={label}
          query={query}
          onQuery={setQuery}
          found={source ? { at: found.at, total: found.ranges.length } : undefined}
          problem={problem}
          onStep={step}
          onClose={() => hide(true)}
          stickAt={inside ? 0 : stuck}
          id={control.barId}
          fieldRef={field}
        />
      )}
      <Folds.Provider value={folds}>
        <FoldCounts.Provider value={open ? foldCounts : NONE}>{children}</FoldCounts.Provider>
      </Folds.Provider>
    </div>
  )
}

/** The bar's bottom, where it's inside what scrolls (stuck at its top): what's under it is hidden. */
function shownFrom(scroller: HTMLElement, bar: Element | null | undefined): number {
  const top = scroller.getBoundingClientRect().top
  return bar && scroller.contains(bar) ? Math.max(top, bar.getBoundingClientRect().bottom) : top
}

/** Whether a match (a fold's, by its fold) is at or below the top of what its view shows. */
function inView(match: Found, bar: Element | null | undefined): boolean {
  const at = match instanceof Range ? match : match.element
  const scroller = scrollerOf(match instanceof Range ? match.startContainer : match.element, 'y')
  if (!scroller) return true
  return at.getBoundingClientRect().bottom >= shownFrom(scroller, bar)
}

/**
 * Brings a match into its view's sight, with some room round it: only as far as it must, by
 * each thing round it that scrolls, the nearest first (a phone's YAML, then its page).
 */
function reveal(range: Range, bar: Element | null | undefined): void {
  const [y, x] = [32, 48]
  for (let at = scrollerOf(range.startContainer, 'y'); at; at = scrollerOf(at, 'y')) {
    const match = range.getBoundingClientRect()
    const [top, bottom] = [shownFrom(at, bar), at.getBoundingClientRect().bottom]
    if (match.top < top + y) at.scrollTop -= top + y - match.top
    else if (match.bottom > bottom - y) at.scrollTop += match.bottom - (bottom - y)
  }
  for (let at = scrollerOf(range.startContainer, 'x'); at; at = scrollerOf(at, 'x')) {
    const match = range.getBoundingClientRect()
    const box = at.getBoundingClientRect()
    if (match.left < box.left + x) at.scrollLeft -= box.left + x - match.left
    else if (match.right > box.right - x) at.scrollLeft += match.right - (box.right - x)
  }
}

/** The nearest element round a node that scrolls, and has more than it shows, that way. */
function scrollerOf(start: Node, way: 'x' | 'y'): HTMLElement | null {
  for (let node = start.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const more =
      way === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth
    if (more && /auto|scroll/.test(way === 'y' ? style.overflowY : style.overflowX)) return node
  }
  return null
}

/**
 * Where a bar stays as what's round it scrolls (a phone's page): under what already stays at
 * that page's top (its tabs). None where its own view scrolls, as a desk's does.
 */
function stickAt(root: HTMLElement): number | undefined {
  const page = scrollerOf(root, 'y')
  if (!page) return undefined
  // (What already stays: the page's sticky parts outside the view, where they stay, as tall as
  // they are; wherever the page is scrolled to now.)
  let below = 0
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => (node === root ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const style = getComputedStyle(node as Element)
    if (style.position !== 'sticky') continue
    below = Math.max(below, (parseFloat(style.top) || 0) + (node as HTMLElement).offsetHeight)
  }
  return below
}
