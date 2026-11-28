/**
 * Finding in YAML on a phone (LMV-404), where there's no ⌘F: the YAML tab's Find opens the bar,
 * the whole width, its field taking the keyboard; every part of it a finger's size; and with
 * the on-screen keyboard up (the page shorter by it), the bar and the match stepped to in sight.
 */
import { placed } from '../placed.ts'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import type { Locator } from '@playwright/test'
import { expectFingerSized, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

/** Whether the bar holds all it has, inside the screen (the YAML's own text scrolls sideways). */
const fits = (bar: Locator) =>
  bar.evaluate(
    (element) =>
      element.scrollWidth <= element.clientWidth &&
      [...element.querySelectorAll('*')].every(
        (part) => part.getBoundingClientRect().right <= window.innerWidth,
      ),
  )

/** A phone's height with its keyboard up: what's left above it. */
const KEYBOARD_UP = { width: PHONE.width, height: 500 }

test('on a phone, Find opens the bar the whole width, a finger’s size, and with the keyboard up it and the match stay in sight', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(
    page,
    `${served.url}cluster/demo/configmaps?open=ConfigMap/shop/storefront-config`,
    DEMO_TOKEN,
  )
  const detail = page.getByRole('complementary', { name: 'ConfigMap storefront-config' })
  await detail.getByRole('tab', { name: 'YAML' }).click()
  const find = detail.getByRole('button', { name: 'Find', exact: true })
  await find.tap()
  const bar = detail.getByRole('search', { name: 'Find in YAML' })
  const field = bar.getByRole('textbox', { name: 'Find in YAML' })
  await expect(field).toBeFocused()
  await expect(find).toHaveAttribute('aria-expanded', 'true')
  // The whole width of what it searches.
  expect((await placed(bar)).width).toBe(
    (await placed(detail.getByRole('tabpanel', { name: 'YAML' }))).width,
  )
  await expectFingerSized(page, 'the find bar')
  expect(await fits(bar)).toBe(true)

  // The keyboard up: the page shorter by it.
  await page.setViewportSize(KEYBOARD_UP)
  await page.keyboard.type('pageSize')
  await page.keyboard.press('Enter')
  await expect(bar).toContainText('1 of 1')
  await expect(bar).toBeInViewport()
  // The match, the YAML's last line, brought up into sight under the bar (and kept there as the
  // page settles to its new height).
  expect(
    await page.evaluate(() => [...CSS.highlights.get('lumovi-find-current')!][0]!.toString()),
  ).toBe('pageSize')
  const under = await placed(bar)
  await expect(async () => {
    const match = await page.evaluate(() => {
      const range = [...CSS.highlights.get('lumovi-find-current')!][0] as Range
      const { top, bottom } = range.getBoundingClientRect()
      return { top, bottom }
    })
    expect(match.top).toBeGreaterThanOrEqual(under.y + under.height)
    expect(match.bottom).toBeLessThanOrEqual(KEYBOARD_UP.height)
  }).toPass()
  expect(await fits(bar)).toBe(true)
  // Its close: the bar gone, the keyboard back on Find.
  await bar.getByRole('button', { name: 'Close find' }).tap()
  await expect(bar).toHaveCount(0)
  await expect(find).toBeFocused()
  await served.stop()
})
