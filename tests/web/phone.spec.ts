/**
 * Lumovi's page on a phone: one column at 390 px, the sidebar behind a button, lists two lines
 * an object, a detail a page of its own, dialogs sheets, and a few things to do, each a
 * finger's size. Nothing scrolls sideways, held upright or on its side, in either theme.
 */
import type { Page } from '@playwright/test'
import { call, connect } from './assistant-client.ts'
import { DEMO, DEMO_TOKEN, expect, PEOPLE, signIn, test } from './fixtures.ts'
import {
  expectFingerSized,
  expectNoSidewaysScroll,
  PHONE,
  PHONE_ON_ITS_SIDE,
  REFUSED_CALL,
  signInNarrow,
} from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

// The gate that keeps a phone from changing more than it may is the last resort: no page here
// should ever run into it. A call it refused means something offered what a phone doesn't do.
const refused: string[] = []
test.beforeEach(({ page }) => {
  refused.length = 0
  page.on('console', (message) => {
    if (message.text().startsWith(REFUSED_CALL)) refused.push(message.text())
  })
})
test.afterEach(() => {
  expect(refused, 'calls the page refused itself').toEqual([])
})

const menu = (page: Page) => page.getByRole('button', { name: 'Menu' })
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Sidebar' })

/** Upright and on its side, light and dark: nothing sideways, and everything a finger's size. */
async function expectAPhonesPage(page: Page, where: string, check: () => Promise<void>) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const [held, size] of [
      ['upright', PHONE],
      ['on its side', PHONE_ON_ITS_SIDE],
    ] as const) {
      await page.setViewportSize(size)
      await check()
      await expectNoSidewaysScroll(page, `${where}, ${held}, ${colorScheme}`)
      await expectFingerSized(page, `${where}, ${held}, ${colorScheme}`)
    }
  }
  await page.setViewportSize(PHONE)
}

test('the sidebar is a drawer: behind a button, holding focus, closed by Escape or going somewhere', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  // No sidebar beside the page, and no back and forward of its own: the browser has them.
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Back|Forward) \(/ })).toHaveCount(0)
  await menu(page).click()
  await expect(drawer(page).getByRole('navigation', { name: 'Resources' })).toBeVisible()
  await expectFingerSized(page, 'the drawer')
  // Focus is in it, and stays in it.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab')
    expect(await drawer(page).evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  // Escape closes it, and focus is back on its button.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(menu(page)).toBeFocused()
  // Going somewhere closes it too.
  await menu(page).click()
  await drawer(page).getByRole('link', { name: 'Pods' }).click()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Pods' })).toBeVisible()
  // And a tap on what's left of the page does.
  await menu(page).click()
  // (Once it's there, and listening: a drawer starts listening for a tap outside it in a timer
  // set as it shows, and a browser handles a tap ahead of timers, so one sent the moment it's
  // visible can come before anything listens. A timer set from here runs after that one.)
  await expect(drawer(page)).toBeVisible()
  await page.evaluate(() => new Promise((done) => setTimeout(done)))
  await page.mouse.click(PHONE.width - 10, PHONE.height / 2)
  await expect(drawer(page)).toHaveCount(0)
})

test('the overview: where you are under the top bar, and nothing sideways', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  await expectAPhonesPage(page, 'the overview', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cluster', exact: true })).toContainText('demo')
    await expect(page.getByRole('button', { name: 'Namespace' })).toBeVisible()
  })
  // The namespace is picked from a sheet: its name on top, closed by Escape, focus kept in.
  await page.getByRole('button', { name: 'Namespace' }).click()
  const sheet = page.getByRole('dialog', { name: 'Namespace' })
  await expect(sheet.getByRole('heading', { name: 'Namespace' })).toBeVisible()
  await expectFingerSized(page, 'the namespace sheet')
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await sheet.getByRole('option', { name: 'shop', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Namespace' })).toContainText('shop')
})

test('a list is two lines an object, sorted from a sheet, and opens a page', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  const list = page.getByRole('list', { name: 'Pods' })
  await expectAPhonesPage(page, 'the list of pods', async () => {
    // (On its side a phone is as wide as a tablet, and has the table.)
    await expect(
      list
        .getByRole('listitem')
        .first()
        .or(page.getByRole('grid', { name: 'Pods' })),
    ).toBeVisible()
  })
  // No table: no header row to sort by, nothing to tick.
  await expect(page.getByRole('grid')).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  const first = list.getByRole('listitem').first()
  await expect(first).toContainText(/\d+\/\d+ ready · \d+ restarts?/)
  // Every namespace is listed, so each row says its own; with one chosen, none does.
  await expect(first).toContainText(/^[\w-]+.* · \d+\/\d+ ready/)
  // Sorted from a sheet: by name, then the other way.
  await page.getByRole('button', { name: /^Sort/ }).click()
  const sort = page.getByRole('dialog', { name: 'Sort by' })
  await expectFingerSized(page, 'the sort sheet')
  await sort.getByRole('option', { name: 'Name' }).click()
  await expect(sort).toHaveCount(0)
  const names = () =>
    list
      .getByRole('listitem')
      .evaluateAll((rows) =>
        rows.slice(0, 5).map((row) => row.querySelector('.text-transparent')!.textContent),
      )
  const ascending = await names()
  expect([...ascending].sort()).toEqual(ascending)
  // Chosen again it turns around, and the sheet stays to say which way, in the column's words.
  const turned = async (column: RegExp, first: string, then: string) => {
    await page.getByRole('button', { name: /^Sort/ }).click()
    const option = sort.getByRole('option', { name: column })
    if ((await option.getAttribute('aria-selected')) !== 'true') {
      await option.click()
      await expect(sort).toHaveCount(0)
      await page.getByRole('button', { name: /^Sort/ }).click()
    }
    await expect(option).toContainText(first)
    await option.click()
    await expect(option).toContainText(then)
    await page.keyboard.press('Escape')
    await expect(sort).toHaveCount(0)
  }
  await turned(/^Name/, 'A to Z', 'Z to A')
  const descending = await names()
  expect([...descending].sort().reverse()).toEqual(descending)
  await turned(/^Status/, 'Worst first', 'Best first')
  await turned(/^Age/, 'Newest first', 'Oldest first')
  await turned(/^Restarts/, 'Least first', 'Most first')
  // A tap opens it as a page with Back, which comes back to the list.
  await first.getByRole('button').click()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: /^Pod / })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('complementary', { name: /^Pod / })).toHaveCount(0)
  await expect(list).toBeVisible()
})

test('a list’s second line says what its kind is read for: a job’s completions, when a cron job runs', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/jobs`, DEMO_TOKEN)
  await expect(
    page.getByRole('list', { name: 'Jobs' }).getByRole('listitem').first(),
  ).toContainText(/\d+\/\d+ completed/)
  await page.goto(`${served.url}cluster/demo/cronjobs`)
  await expect(
    page.getByRole('list', { name: 'CronJobs' }).getByRole('listitem').first(),
  ).toContainText(/ · At \d\d:\d\d [AP]M · in \d/)
})

test('a detail is a page: which cluster, two actions at most, and its tabs', async ({
  page,
  serve,
}) => {
  const served = await serve()
  const name = DEMO.deployments.storefront
  await signInNarrow(
    page,
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${name}`,
    DEMO_TOKEN,
  )
  const detail = page.getByRole('complementary', { name: `Deployment ${name}` })
  await expectAPhonesPage(page, 'a deployment’s page', async () => {
    await expect(detail.getByRole('button', { name: 'Scale' })).toBeVisible()
  })
  // Its header says where it is: this is where Restart and Scale are.
  await expect(detail).toContainText('Deployment · shop · demo')
  await expect(detail.getByRole('button', { name: 'Restart' })).toBeVisible()
  // No menu of more, and nothing in the page that isn't offered: not hidden, not there.
  await expect(detail.getByRole('button', { name: 'More actions' })).toHaveCount(0)
  for (const gone of ['Delete', 'Edit YAML', 'Roll back', 'Change image', 'Edit labels']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${gone}`) })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: new RegExp(`^${gone}`) })).toHaveCount(0)
  }
  // Nor by the keys that open the menu or start a delete where there's a keyboard.
  await page.keyboard.press('.')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Backspace')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Its tabs: neither a shell nor a map.
  await expect(detail.getByRole('tab')).toHaveText([
    'Overview',
    'Pods',
    'Logs',
    'Metrics',
    'Events',
    'Audit',
    'YAML',
  ])
  // Scrolled, the top bar says which object this is, and the tabs stay.
  await detail.locator('[data-detail-page]').evaluate((scroller) => scroller.scrollTo(0, 400))
  await expect(detail.locator('header').first().locator('.text-transparent')).toHaveText(name)
  await expect(detail.getByRole('tab', { name: 'Overview' })).toBeInViewport()
  // Scale, behind its own dialog: a sheet, Cancel at one edge and Scale at the other.
  await detail.locator('[data-detail-page]').evaluate((scroller) => scroller.scrollTo(0, 0))
  await detail.getByRole('button', { name: 'Scale' }).click()
  const scale = page.getByRole('dialog', { name: `Scale ${name}` })
  await expect(scale).toBeVisible()
  await expectNoSidewaysScroll(page, 'the scale sheet')
  await expectFingerSized(page, 'the scale sheet')
  const cancel = (await scale.getByRole('button', { name: 'Cancel' }).boundingBox())!
  const confirm = (await scale.getByRole('button', { name: 'Scale', exact: true }).boundingBox())!
  expect(confirm.x - (cancel.x + cancel.width)).toBeGreaterThan(80)
  await scale.getByRole('button', { name: 'Cancel' }).click()
  // With room for them (a tablet), every action is back, and the page is a panel again.
  await page.setViewportSize({ width: 800, height: 1000 })
  await detail.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: /^Delete/ })).toBeVisible()
})

test('logs wrap, and what’s done to them is a finger’s size', async ({ page, serve }) => {
  const served = await serve()
  const pod = DEMO.pods.storefront[0]!
  await signInNarrow(page, `${served.url}cluster/demo/pods?open=Pod/shop/${pod}`, DEMO_TOKEN)
  const detail = page.getByRole('complementary', { name: `Pod ${pod}` })
  await detail.getByRole('tab', { name: 'Logs' }).click()
  const log = detail.getByRole('log')
  await expectAPhonesPage(page, 'a pod’s logs', async () => {
    await expect(log).toContainText(/\S/)
  })
  // Lines wrap: there's no toggle to say otherwise, and the time each was written starts off.
  await expect(detail.getByRole('button', { name: 'Wrap lines' })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'Timestamps' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(detail.getByRole('button', { name: 'Follow' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // The rest is in a sheet.
  await detail.getByRole('button', { name: 'More' }).click()
  const more = page.getByRole('dialog', { name: 'Logs' })
  await expect(more.getByRole('button')).toHaveCount(4)
  for (const name of ['Close', 'Show the previous container', 'Copy logs', 'Download']) {
    await expect(more.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(more).toHaveCount(0)
})

test('an assistant’s change is approved from a sheet; put aside, it waits', async ({
  page,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  // (An assistant is connected from a computer.)
  await page.setViewportSize({ width: 1440, height: 920 })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  await page.setViewportSize(PHONE)
  await page.goto(`${served.url}cluster/demo`)
  await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const sheet = page.getByRole('dialog', { name: 'Scale Deployment cart to 3 replicas' })
  await expectAPhonesPage(page, 'an approval', async () => {
    await expect(sheet).toContainText('Claude Code asks')
  })
  // The diff wraps inside the sheet, and the two answers are at its two edges.
  const reject = (await sheet.getByRole('button', { name: 'Reject…' }).boundingBox())!
  const approve = (await sheet.getByRole('button', { name: /^Approve/ }).boundingBox())!
  expect(approve.x - (reject.x + reject.width)).toBeGreaterThan(100)
  expect(approve.height).toBeGreaterThanOrEqual(44)
  expect(approve.width).toBeGreaterThanOrEqual(120)
  // The wait is on a line of its own, above them.
  const wait = (await sheet.getByText(/^Waits \d+:\d\d more$/).boundingBox())!
  expect(wait.y + wait.height).toBeLessThanOrEqual(reject.y)
  // A tap outside it puts it aside: it isn't an answer, and it waits.
  await page.mouse.click(PHONE.width / 2, 10)
  await expect(sheet).toHaveCount(0)
  const waiting = page.getByRole('button', { name: /1 change from Claude Code waits for you/ })
  await expect(waiting).toBeVisible()
  await expectNoSidewaysScroll(page, 'the waiting pill')
  await waiting.click()
  // Dragged down by its grabber, the same.
  const grabber = (await sheet.locator('[data-sheet-grabber]').boundingBox())!
  await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + 6)
  await page.mouse.down()
  await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + 220, { steps: 6 })
  await page.mouse.up()
  await expect(sheet).toHaveCount(0)
  await expect(waiting).toBeVisible()
  // Approved, it's made.
  await waiting.click()
  await sheet.getByRole('button', { name: /^Approve/ }).click()
  await expect(sheet).toHaveCount(0)
  await expect(waiting).toHaveCount(0)
})

test('a tablet keeps the table, with the drawer and a detail over the list', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await page.setViewportSize({ width: 768, height: 1024 })
  await signInNarrow(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await expect(page.getByRole('grid', { name: 'Pods' })).toBeVisible()
  await expect(menu(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create from YAML' })).toBeVisible()
  await expectNoSidewaysScroll(page, 'a tablet’s list')
  await expectFingerSized(page, 'a tablet’s list')
  await page.getByRole('grid', { name: 'Pods' }).getByRole('row').nth(1).click()
  const detail = page.getByRole('complementary', { name: /^Pod / })
  await expect(detail).toBeVisible()
  // A panel from the right, 600 px wide, over the list.
  expect((await detail.boundingBox())!.width).toBe(600)
  await expect(detail.getByRole('button', { name: 'More actions' })).toBeVisible()
  await expectNoSidewaysScroll(page, 'a tablet’s detail')
})

test('at the desktop app’s smallest, nothing of this applies', async ({ page, serve }) => {
  const served = await serve()
  await page.setViewportSize({ width: 1024, height: 700 })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Back \(/ })).toBeVisible()
  await expect(page.getByRole('grid', { name: 'Pods' })).toBeVisible()
})
