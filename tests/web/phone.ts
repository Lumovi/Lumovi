/**
 * What a phone asks of a page, checked the same way wherever it's asked: nothing scrolls
 * sideways, and everything that's pressed is a finger's size.
 */
import { expect, type Page } from '@playwright/test'

/** A phone held upright, and on its side. */
export const PHONE = { width: 390, height: 844 }
export const PHONE_ON_ITS_SIDE = { width: 844, height: 390 }
/** How the page's console says it refused itself a call (web/connection.ts's `REFUSED_CALL`). */
export const REFUSED_CALL = 'Lumovi didn’t send a call the page may not make:'
/** The smallest a thing to press may be, each way. */
export const FINGER = 44

/**
 * Signs in with a token on a narrow page, where who's signed in is said in the drawer: the page
 * is there once its menu button is.
 */
export async function signInNarrow(page: Page, url: string, token: string): Promise<void> {
  await page.goto(url)
  await page.getByPlaceholder('Paste a token').fill(token)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
}

/**
 * Nothing on the page is wider than what shows it: not the page, and not anything in it that
 * scrolls. (A strip of tabs scrolls inside itself, and says so: `data-scrolls-sideways`.)
 */
export async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  // (Asked until it holds: a table drops the columns that don't fit a frame after it's measured.)
  await expect.poll(() => sideways(page), { message: `${where} scrolls sideways` }).toEqual([])
}

function sideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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
}

/**
 * Everything there is to press that shows answers on at least a finger's size, each way: at
 * its middle, and 21 px above, below and to either side of it (what answers may be more than
 * what's drawn: a chip 28 px high takes the 8 px above and below it too).
 */
export async function expectFingerSized(page: Page, where: string): Promise<void> {
  await expect
    .poll(() => missed(page), { message: `${where} has targets a finger would miss` })
    .toEqual([])
}

function missed(page: Page): Promise<string[]> {
  return page.evaluate((least) => {
    const pressed =
      'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], summary'
    const reach = least / 2 - 1
    const found: string[] = []
    for (const element of document.querySelectorAll<HTMLElement>(pressed)) {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue
      // What's only for a keyboard, or disabled, or under something else isn't a thing to press.
      if (element.closest('[aria-hidden="true"], [inert]') || element.matches(':disabled')) continue
      // Nor is what its cell answers for (a row's checkbox, whose cell takes the tap).
      if (element.tabIndex < 0) continue
      const at = (dx: number, dy: number) => {
        const px = x + dx
        const py = y + dy
        // (Past the screen's edge there's nothing to miss it by.)
        if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) return true
        const hit = document.elementFromPoint(px, py)
        return hit !== null && (element.contains(hit) || labelOf(hit) === element)
      }
      const labelOf = (hit: Element) => hit.closest('label')?.querySelector(pressed)
      if (!at(0, 0)) continue // Scrolled away, or covered: not there to press now.
      // Nor is what's half scrolled out of what scrolls it (a drawer's last link showing): the
      // rest of it is a scroll away, not missing.
      const cut = (() => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (!/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue
          const frame = parent.getBoundingClientRect()
          if (box.top < frame.top - 1 || box.bottom > frame.bottom + 1) return true
        }
        return false
      })()
      if (cut) continue
      // Nor is what a detail over the list has half covered: the detail is what's pressed there.
      const under = (dx: number, dy: number) => {
        const over = document.elementFromPoint(x + dx, y + dy)?.closest('[data-over]')
        return over !== null && over !== undefined && !over.contains(element)
      }
      if ([-reach, reach].some((d) => under(d, 0) || under(0, d))) continue
      const misses = [
        [0, -reach],
        [0, reach],
        [-reach, 0],
        [reach, 0],
      ].filter(([dx, dy]) => !at(dx!, dy!))
      if (misses.length) {
        const name =
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
        found.push(
          `${element.tagName.toLowerCase()} “${name}”: ${Math.round(box.width)} × ${Math.round(box.height)}`,
        )
      }
    }
    return found
  }, FINGER)
}
