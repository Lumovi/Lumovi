/**
 * What on a page doesn't stay in its place, for tests/e2e/long-text.spec.ts:
 *
 * - text that spills out of its box (over what's beside it);
 * - text cut short where it's clipped, with no ellipsis to say so (and no way to scroll to it);
 * - text drawn over other text;
 * - long text squeezed into a column so narrow it's a few characters a line, and a short label
 *   (“Rows per page”) wrapped in a row of things that should share a line;
 * - a page or panel that scrolls down, scrolling sideways too: something in it is too wide.
 *
 * Only what can be seen counts: text under a dialog, scrolled away or out of the window doesn't.
 */
import type { Page } from '@playwright/test'

export async function misplaced(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Map<string, string>()
    const style = (el: Element) => getComputedStyle(el)
    /** Where an element is, for a person to find it: its tag and classes, in its landmark. */
    const describe = (el: Element) => {
      const own = `${el.tagName.toLowerCase()}${
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
          : ''
      }`
      const landmark = el.closest('[aria-label]')
      const named = landmark
        ? ` in ${landmark.getAttribute('role') ?? landmark.tagName.toLowerCase()} “${landmark
            .getAttribute('aria-label')!
            .slice(0, 40)}”`
        : ''
      return own + named
    }
    const say = (problem: string, el: Element, text: string) => {
      const where = describe(el)
      found.set(
        `${problem}|${where}`,
        `${problem}: “${text.length > 50 ? `${text.slice(0, 50)}…` : text}” (${where})`,
      )
    }
    const clips = (s: CSSStyleDeclaration) => s.overflowX !== 'visible' || s.overflowY !== 'visible'
    const scrolls = (s: CSSStyleDeclaration) =>
      ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY)
    /** Whether something cut there says so: an ellipsis, a clamp of lines, or a scroll. */
    const saysSo = (s: CSSStyleDeclaration) =>
      s.textOverflow === 'ellipsis' ||
      (s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '') ||
      scrolls(s)
    const hidden = (el: Element) => {
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const s = style(e)
        if (s.visibility === 'hidden' || s.opacity === '0' || s.display === 'none') return true
      }
      return false
    }
    // Skipped: the terminal (it draws its own), charts, the editor's own layout, and what's only
    // for screen readers.
    const skip = (el: Element) =>
      !!el.closest('.xterm, svg, .cm-gutters, .sr-only, [aria-hidden="true"]')

    interface Piece {
      el: Element
      text: string
      rect: DOMRect
    }
    const pieces: Piece[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent!.replace(/\s+/g, ' ').trim()
      const el = node.parentElement
      if (!text || !el || skip(el) || hidden(el)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
      if (!rects.length) continue
      // Seen where it starts: not under a dialog, scrolled away or out of the window.
      const first = rects[0]!
      const x = first.left + Math.min(3, first.width / 2)
      const y = first.top + first.height / 2
      const top = document.elementFromPoint(x, y)
      if (!top || !(el.contains(top) || top.contains(el))) continue
      // Squeezed: four lines or more, of a few characters each.
      const lines = new Set(rects.map((r) => Math.round(r.top))).size
      if (text.length > 30 && lines >= 4 && text.length / lines < 14) {
        say('squeezed into a narrow column', el, text)
      }
      const row = (e: Element | null) =>
        !!e && style(e).display.endsWith('flex') && style(e).flexDirection.startsWith('row')
      let item: Element = el
      while (item.parentElement && style(item.parentElement).display.startsWith('inline')) {
        item = item.parentElement
      }
      if (text.length <= 24 && /\s/.test(text) && lines >= 2 && row(item.parentElement)) {
        say('a short label wraps', el, text)
      }
      // The box it should stay in: the nearest element that isn't inline.
      let box: Element = el
      while (box.parentElement && style(box).display.startsWith('inline')) box = box.parentElement
      const boxRect = box.getBoundingClientRect()
      for (const rect of rects) {
        // What clips it, from its own element out; the first one it reaches past.
        let cutBy: Element | undefined
        let visible = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity }
        for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
          const s = style(e)
          if (!clips(s)) continue
          const r = e.getBoundingClientRect()
          const slack = Math.max(3, rect.height / 4)
          const past =
            rect.right > r.right + 1.5 ||
            rect.left < r.left - 1.5 ||
            rect.bottom > r.bottom + slack ||
            rect.top < r.top - slack
          if (past && !cutBy) {
            cutBy = e
            if (!saysSo(s)) say('cut without an ellipsis', el, text)
          }
          visible = {
            left: Math.max(visible.left, r.left),
            right: Math.min(visible.right, r.right),
            top: Math.max(visible.top, r.top),
            bottom: Math.min(visible.bottom, r.bottom),
          }
        }
        // Past its own box, where that can be seen: over what's beside it. (Below it by less than
        // a quarter of a line is how tightly set text is drawn, not a spill; past its end by a
        // space is a space where spaces are kept, hanging at the line's end.)
        const slack = Math.max(3, rect.height / 4)
        const font = parseFloat(style(el).fontSize)
        const hang = style(box).whiteSpace.startsWith('pre') ? font * 0.7 : 1.5
        const beyond =
          (rect.right > boxRect.right + hang && boxRect.right < visible.right - 1) ||
          (rect.left < boxRect.left - 1.5 && boxRect.left > visible.left + 1) ||
          (rect.bottom > boxRect.bottom + slack && boxRect.bottom < visible.bottom - 1)
        if (beyond) say('spills out of its box', el, text)
        const shown = new DOMRect(
          Math.max(rect.left, visible.left),
          Math.max(rect.top, visible.top),
          Math.min(rect.right, visible.right) - Math.max(rect.left, visible.left),
          Math.min(rect.bottom, visible.bottom) - Math.max(rect.top, visible.top),
        )
        if (shown.width > 1 && shown.height > 1) pieces.push({ el, text, rect: shown })
      }
    }
    // Sideways: what scrolls down (a page, a panel) and is wider than it is, but for what's made
    // to scroll (lists, tables, code, logs).
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      const s = style(el)
      if (!['auto', 'scroll'].includes(s.overflowY) || el.clientHeight < 100) continue
      if (el.scrollWidth <= el.clientWidth + 2 || hidden(el)) continue
      const made = '[role="grid"], table, pre, code, .cm-editor, .xterm, [role="log"]'
      if (el.matches(made) || el.closest(made) || el.querySelector(made)) continue
      say('scrolls sideways', el, `${el.scrollWidth - el.clientWidth}px too wide`)
    }
    // Text over text: two pieces whose shown parts cross by more than an edge.
    pieces.sort((a, b) => a.rect.left - b.rect.left)
    for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i]!
      for (let j = i + 1; j < pieces.length && pieces[j]!.rect.left < a.rect.right - 2; j++) {
        const b = pieces[j]!
        if (a.el === b.el) continue
        // One drawn on something solid above the other (a popover, a sticky header) hides it.
        const common = (() => {
          for (let e: Element | null = a.el; e; e = e.parentElement) if (e.contains(b.el)) return e
          return document.body
        })()
        const solid = (el: Element) => {
          for (let e: Element | null = el; e && e !== common; e = e.parentElement) {
            const color = style(e).backgroundColor
            const alpha = /rgba?\(([^)]+)\)/.exec(color)?.[1]?.split(',')[3]
            if (color !== 'transparent' && (alpha === undefined || Number(alpha) > 0.5)) return true
          }
          return false
        }
        if (solid(a.el) || solid(b.el)) continue
        const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
        const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
        if (w > 2 && h > 3) say(`over “${b.text.slice(0, 30)}”`, a.el, a.text)
      }
    }
    return [...found.values()]
  })
}
