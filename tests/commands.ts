/**
 * How a command is drawn in its box: which of its words are cut across two lines though they'd
 * fit on one (a command breaks only between its words: none should be), and what a person who
 * selects all of it gets. Measured on the text itself, however the box draws it.
 */
import type { Locator } from '@playwright/test'

export const cutWords = (code: Locator) =>
  code.evaluate((box) => {
    const cut: string[] = []
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of node.textContent!.matchAll(/\S+/g)) {
        const range = document.createRange()
        range.setStart(node, word.index)
        range.setEnd(node, word.index + word[0].length)
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)
        const lines = new Set(rects.map((rect) => Math.round(rect.top))).size
        const width = rects.reduce((sum, rect) => sum + rect.width, 0)
        // (A word wider than the whole line still wraps: that's not a cut.)
        if (lines > 1 && width <= box.clientWidth) cut.push(word[0])
      }
    }
    return cut
  })

export const selectedText = (code: Locator) =>
  code.evaluate((box) => {
    const selection = window.getSelection()!
    selection.selectAllChildren(box)
    const text = selection.toString()
    selection.removeAllRanges()
    return text
  })
