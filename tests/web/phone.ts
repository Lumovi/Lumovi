/**
 * What a phone asks of a page, checked the same way wherever it's asked: nothing scrolls
 * sideways, and everything that's pressed is a finger's size.
 */
import { expect, type Page } from '@playwright/test'

/** A phone held upright, and on its side. */
export const PHONE = { width: 390, height: 844 }
export const PHONE_ON_ITS_SIDE = { width: 844, height: 390 }
/** The smallest a thing to press may be, each way. */
export const FINGER = 44

/**
 * Nothing on the page is wider than what shows it: not the page, and not anything in it that
 * scrolls. (A strip of tabs scrolls inside itself, and says so: `data-scrolls-sideways`.)
 */
export async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const wide = await page.evaluate(() => {
    const found: string[] = []
    const named = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
        element.getAttribute('aria-label') ? `[${element.getAttribute('aria-label')}]` : ''
      }.${String(element.className).split(' ').slice(0, 4).join('.')}`
    for (const element of [document.documentElement, ...document.querySelectorAll('body *')]) {
      if (element.closest('[data-scrolls-sideways]')) continue
      const { overflowX } = getComputedStyle(element)
      const scrolls = element === document.documentElement || /auto|scroll/.test(overflowX)
      if (scrolls && element.scrollWidth > element.clientWidth + 1) {
        found.push(`${named(element)}: ${element.scrollWidth} in ${element.clientWidth}`)
      }
    }
    // Nor does anything reach past the screen's right edge, where the page would cut it off.
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect()
      const shown =
        box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
      if (
        shown &&
        box.right > window.innerWidth + 1 &&
        !element.closest('[data-scrolls-sideways]')
      ) {
        const clipped = [...ancestors(element)].some((parent) =>
          /hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX),
        )
        if (!clipped) found.push(`${named(element)}: reaches ${Math.round(box.right)}`)
      }
    }
    function* ancestors(element: Element) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) yield parent
    }
    return found
  })
  expect(wide, `${where} scrolls sideways`).toEqual([])
}

/** Everything there is to press that shows is at least a finger's size, each way. */
export async function expectFingerSized(page: Page, where: string): Promise<void> {
  const small = await page.evaluate((least) => {
    const pressed =
      'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], summary'
    const found: string[] = []
    for (const element of document.querySelectorAll<HTMLElement>(pressed)) {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const shown =
        box.width > 0 &&
        box.height > 0 &&
        style.visibility !== 'hidden' &&
        box.bottom > 0 &&
        box.top < window.innerHeight &&
        box.right > 0 &&
        box.left < window.innerWidth
      // What's only for a keyboard (it shows on focus alone) isn't a thing to press.
      if (!shown || element.closest('[aria-hidden="true"]') || element.tabIndex < 0) continue
      if (box.width < least - 0.5 || box.height < least - 0.5) {
        const name =
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
        found.push(
          `${element.tagName.toLowerCase()} “${name}”: ${Math.round(box.width)} × ${Math.round(box.height)}`,
        )
      }
    }
    return found
  }, FINGER)
  expect(small, `${where} has targets under ${FINGER} px`).toEqual([])
}
