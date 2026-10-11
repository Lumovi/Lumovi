/**
 * Lumovi's page on a phone: one column at 390 px, the sidebar behind a button, lists two lines
 * an object, a detail a page of its own, dialogs sheets, and a few things to do, each a
 * finger's size. Nothing scrolls sideways, held upright or on its side, in either theme.
 */
import type { Locator, Page } from '@playwright/test'
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

/** Starts noting when an Approve button is there, and whether it can be pressed. */
const watchApprove = (page: Page) =>
  page.evaluate(() => {
    const seen: [number, boolean][] = []
    ;(window as unknown as { approveSeen: typeof seen }).approveSeen = seen
    const look = () => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        /^Approve/.test(b.textContent ?? ''),
      )
      if (button) seen.push([performance.now(), button.disabled])
    }
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    })
  })
/** How long (ms) the Approve button last shown couldn't be pressed, from when it appeared. */
const approveCameAlive = (page: Page) =>
  page.evaluate(() => {
    const { approveSeen } = window as unknown as { approveSeen: [number, boolean][] }
    const alive = approveSeen.findLastIndex(([, disabled]) => !disabled)
    let from = alive
    while (from > 0 && approveSeen[from - 1]![1]) from--
    return from === alive ? 0 : approveSeen[alive]![0] - approveSeen[from]![0]
  })

const menu = (page: Page) => page.getByRole('button', { name: 'Menu' })
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Sidebar' })

/**
 * How far one thing's top is under another's, in px; nothing, while either isn't drawn (a
 * page that has just changed its size draws again: a box read then is no box).
 */
async function apart(upper: Locator, lower: Locator): Promise<number> {
  const [from, to] = [await upper.boundingBox(), await lower.boundingBox()]
  return from && to ? to.y - from.y : 0
}

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
  // Upright again, and drawn so before it's left: whoever asked reads the page next.
  await page.setViewportSize(PHONE)
  await check()
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

test('a link to another object is a finger’s size: alone, and one under another', async ({
  page,
  serve,
  clusters,
}) => {
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'deploys', namespace: 'shop' },
    secrets: [{ name: 'deploys-token' }, { name: 'deploys-registry' }],
  })
  const served = await serve()
  // A pod's node, its account and what owns it: each a line of text, reached from around it.
  const pod = DEMO.pods.storefront[0]!
  await signInNarrow(page, `${served.url}cluster/demo/pods?open=Pod/shop/${pod}`, DEMO_TOKEN)
  const detail = page.getByRole('complementary', { name: `Pod ${pod}` })
  const node = detail.getByRole('button', { name: /^Node\// })
  await expectAPhonesPage(page, 'a pod’s page', async () => {
    await expect(node).toBeVisible()
    await expect(detail.getByRole('button', { name: 'ServiceAccount/storefront' })).toBeVisible()
  })
  // (Drawn no taller than its text: the row doesn't grow for it.)
  // (Asked until it's so: the page has just been turned back upright, and draws again.)
  await expect.poll(async () => (await node.boundingBox())?.height ?? Infinity).toBeLessThan(20)
  await node.tap()
  await expect(page.getByRole('complementary', { name: /^Node / })).toBeVisible()

  // Two in one value are a finger's height apart, so neither is pressed for the other.
  await page.goto(`${served.url}cluster/demo/serviceaccounts?open=ServiceAccount/shop/deploys`)
  const account = page.getByRole('complementary', { name: 'ServiceAccount deploys' })
  const token = account.getByRole('button', { name: 'Secret/deploys-token' })
  const registry = account.getByRole('button', { name: 'Secret/deploys-registry' })
  await expectAPhonesPage(page, 'a service account’s page', async () => {
    await expect(registry).toBeVisible()
  })
  await expect.poll(() => apart(token, registry)).toBeGreaterThanOrEqual(44)

  // With room for a table (a tablet), its rows of links are a finger's height apart too.
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto(`${served.url}cluster/demo/serviceaccounts?open=ServiceAccount/shop/storefront`)
  const bindings = page
    .getByRole('complementary', { name: 'ServiceAccount storefront' })
    .getByRole('table', { name: 'Bindings' })
  await expect(bindings.getByRole('row')).toHaveCount(4)
  const links = bindings.getByRole('button', { name: /^RoleBinding\// })
  await expect(links).toHaveCount(3)
  await expect.poll(() => apart(links.nth(0), links.nth(1))).toBeGreaterThanOrEqual(44)
  await expect.poll(() => apart(links.nth(1), links.nth(2))).toBeGreaterThanOrEqual(44)
})

test('a role’s rules are cards that say what its table says, and its bindings links to press', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(
    page,
    `${served.url}cluster/demo/roles?open=Role/shop/config-reader`,
    DEMO_TOKEN,
  )
  const role = page.getByRole('complementary', { name: 'Role config-reader' })
  const granted = role.getByRole('button', { name: 'RoleBinding/checkout-reads-config' })
  await expectAPhonesPage(page, 'a role’s page', async () => {
    await expect(granted).toBeVisible()
  })
  // A card a rule, with every column of the table's row: the names that narrow it among them.
  // A rule has no name: its API groups are a fact like the others.
  const rules = role.getByRole('list', { name: 'Rules' }).getByRole('listitem')
  await expect(rules).toHaveText([
    'API groupscoreResourcesconfigmapsVerbsgetlistwatch',
    'API groupscoreResourcessecretsonly those named payments-credentialsVerbsget',
    'API groupsbatchResourcesjobsVerbscreatedelete',
  ])
  // No name is broken while there's a line for it: one fact a line, where one wouldn't fit.
  const named = rules.nth(1).getByText('payments-credentials')
  await expect.poll(async () => (await named.boundingBox())?.height ?? Infinity).toBeLessThan(20)
  await expect
    .poll(() =>
      rules
        .nth(1)
        .locator('dt')
        .evaluateAll((all) => new Set(all.map((dt) => dt.getBoundingClientRect().left)).size),
    )
    .toBe(1)
  // Who it's granted to, and the way there: the first card's link, pressed from its edge.
  const card = role.getByRole('list', { name: 'Granted by' }).getByRole('listitem')
  await expect(card).toHaveText([
    'Binding: RoleBinding/checkout-reads-configToServiceAccount shop/checkoutInshop',
  ])
  // (Where it is, read in one look at the page once it's there to see.)
  await expect(granted).toBeVisible()
  const above = await granted.evaluate((link) => {
    link.scrollIntoView({ block: 'center' })
    const box = link.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y - 12 }
  })
  await page.touchscreen.tap(above.x, above.y)
  await expect(
    page.getByRole('complementary', { name: 'RoleBinding checkout-reads-config' }),
  ).toBeVisible()
  // A binding's subjects: an account that's an object is a link, on a line of its own.
  const subjects = page
    .getByRole('complementary', { name: 'RoleBinding checkout-reads-config' })
    .getByRole('list', { name: 'Subjects' })
  await expectAPhonesPage(page, 'a binding’s page', async () => {
    await expect(page.getByRole('button', { name: 'ServiceAccount/checkout' }).last()).toBeVisible()
  })
  await expect(subjects.getByRole('listitem')).toHaveText([
    'Kind: ServiceAccountNameServiceAccount/checkoutNamespaceshop',
  ])
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
  // It comes as the pill: nothing opens under a finger by itself.
  const arrived = page.getByRole('button', { name: /1 change from Claude Code waits for you/ })
  await expect(arrived).toBeVisible()
  await expect(sheet).toHaveCount(0)
  await watchApprove(page)
  await arrived.click()
  // For a moment after it opens Approve can't be pressed (a tap meant for the pill answers
  // nothing); Reject… can, which only leads to a second step.
  await expect(sheet.getByRole('button', { name: /^Approve/ })).toBeEnabled()
  expect(await approveCameAlive(page)).toBeGreaterThanOrEqual(550)
  await expect(sheet.getByRole('button', { name: 'Reject…' })).toBeEnabled()
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
  // Dragged down by its grabber, the same (once it has come to rest).
  await expect(sheet.getByRole('button', { name: /^Approve/ })).toBeEnabled()
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

test('of two changes waiting, a double tap approves one; a long name is cut, never what’s asked', async ({
  page,
  serve,
  clusters,
}) => {
  // (A name may be 253 characters; this one is 103.)
  const long =
    'checkout-payments-reconciliation-worker-with-ledger-export-and-settlement-retries-eu-west-1-blue-canary'
  // Some kinds' names (a role's, a binding's) aren't held to letters and dashes: they may hold
  // what means something to a text replacement. The stand-in has no roles, so a Deployment put
  // there under such a name stands for one (a cluster would refuse to make it; deleting it is
  // asked of the name alone).
  const odd =
    "ledger$&-export-and-settlement\\retries-for-checkout-payments-reconciliation-in-eu-west-1-blue-c$'ary"
  const cart = clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!
  for (const name of [long, odd]) {
    clusters.demo.upsert({ ...cart, metadata: { ...cart.metadata, name, uid: undefined } })
  }
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  await page.setViewportSize({ width: 1440, height: 920 })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  await page.setViewportSize(PHONE)
  await page.goto(`${served.url}cluster/demo`)
  for (const name of [DEMO.deployments.cart, long]) {
    await call(client, 'scale', {
      cluster: 'demo',
      kind: 'deploy',
      namespace: 'shop',
      name,
      replicas: 4,
      reason: 'Busy.',
    })
  }
  await page.getByRole('button', { name: /2 changes from Claude Code wait for you/ }).click()
  // The one that has waited longest comes first. A title that fits is whole.
  const first = page.getByRole('dialog', { name: 'Scale Deployment cart to 4 replicas' })
  await expect(first.getByRole('heading').locator('[aria-hidden]')).toHaveText(
    'Scale Deployment cart to 4 replicas',
  )
  // The next one's title: three lines at most, the name cut in its middle with its end kept,
  // and what's asked whole. All of the name is in the body.
  await first.getByRole('button', { name: 'Next change' }).click()
  const second = page.getByRole('dialog', { name: `Scale Deployment ${long} to 4 replicas` })
  // (The dialog is still called by all of it.)
  const title = second.getByRole('heading').locator('[aria-hidden]')
  await expect(title).toHaveText(/^Scale Deployment checkout-.+…canary to 4 replicas$/)
  const lines = await title.evaluate(
    (node) => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
  )
  expect(lines).toBeLessThanOrEqual(3.1)
  await expect(second).toContainText(long)
  await expectNoSidewaysScroll(page, 'a long name’s approval')
  // Moved to another change, Approve can't be pressed for a moment again.
  await watchApprove(page)
  await second.getByRole('button', { name: 'Previous change' }).click()
  await expect(first.getByRole('button', { name: /^Approve/ })).toBeEnabled()
  expect(await approveCameAlive(page)).toBeGreaterThanOrEqual(550)
  // Tapped twice, with a finger: the first answers this one; the second, where the next one's
  // Approve is coming to be, answers nothing. That one still waits: in its sheet, or put aside
  // (if the tap met the page behind the sheet as it came up).
  const spot = (await first.getByRole('button', { name: /^Approve/ }).boundingBox())!
  await page.touchscreen.tap(spot.x + spot.width / 2, spot.y + spot.height / 2)
  await page.touchscreen.tap(spot.x + spot.width / 2, spot.y + spot.height / 2)
  await expect(first).toHaveCount(0)
  const aside = page.getByRole('button', { name: /1 change from Claude Code waits for you/ })
  await expect(second.or(aside)).toBeVisible()
  // (The note that the first was made goes from over the sheet's foot by itself: a finger
  // doesn't hold it there, as a mouse resting on it would.)
  await expect(page.getByText('As Claude Code asked, in demo.')).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(second.or(aside)).toBeVisible()
  if (await aside.isVisible()) await aside.tap()
  await second.getByRole('button', { name: /^Approve/ }).tap()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('As Claude Code asked, in demo.')).toHaveCount(0, {
    timeout: 15_000,
  })
  // A name with characters of its own is cut the same, and is still itself: nothing in it is
  // taken for anything but the name.
  await call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: odd,
    reason: 'Unused.',
  })
  await page.getByRole('button', { name: /1 change from Claude Code waits for you/ }).tap()
  const deletion = page.getByRole('dialog', { name: `Delete Deployment ${odd}` })
  const [start, end] = (await deletion
    .getByRole('heading')
    .locator('[aria-hidden]')
    .textContent())!.split('…')
  expect(start!.length).toBeGreaterThan('Delete Deployment ledger$&'.length)
  expect(`Delete Deployment ${odd}`.startsWith(start!)).toBe(true)
  expect(end).toBe(odd.slice(-6))
})

test('on a touch screen of any width Approve waits its moment, which always ends; with a mouse it doesn’t wait', async ({
  page,
  browser,
  serve,
}) => {
  const TABLET = { width: 820, height: 1180 }
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  await page.setViewportSize({ width: 1440, height: 920 })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  // The same person at a screen of the same width, with a mouse.
  const desk = await browser.newContext({
    viewport: { width: 1440, height: 920 },
    hasTouch: false,
    isMobile: false,
  })
  const mouse = await desk.newPage()
  await signIn(mouse, `${served.url}cluster/demo`, PEOPLE.alice.token)
  await mouse.setViewportSize(TABLET)
  await page.setViewportSize(TABLET)
  await page.goto(`${served.url}cluster/demo`)
  await watchApprove(page)
  await watchApprove(mouse)
  await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  // Wider than a phone, the change opens by itself, as on a desktop: on both.
  for (const [where, least, most] of [
    [page, 550, Infinity],
    [mouse, 0, 0],
  ] as const) {
    const dialog = where.getByRole('dialog', { name: 'Scale Deployment cart to 3 replicas' })
    await expect(dialog.getByRole('button', { name: /^Approve/ })).toBeEnabled()
    const waited = await approveCameAlive(where)
    expect(waited).toBeGreaterThanOrEqual(least)
    expect(waited).toBeLessThanOrEqual(most)
  }
  // The moment always ends, whatever the screen does inside it. A phone turned on its side as
  // the sheet opens (put aside first, to open it from the pill):
  await page.setViewportSize(PHONE)
  const sheet = page.getByRole('dialog', { name: 'Scale Deployment cart to 3 replicas' })
  await sheet.getByRole('button', { name: 'Later' }).click()
  await page.getByRole('button', { name: /1 change from Claude Code waits for you/ }).click()
  await page.setViewportSize(PHONE_ON_ITS_SIDE)
  await expect(sheet.getByRole('button', { name: /^Approve/ })).toBeEnabled({ timeout: 1500 })
  // A window as narrow as a phone, made wider across 640 px as it opens:
  const windowed = mouse.getByRole('dialog', { name: 'Scale Deployment cart to 3 replicas' })
  await windowed.getByRole('button', { name: 'Later' }).click()
  await mouse.setViewportSize({ width: 600, height: 900 })
  await mouse.getByRole('button', { name: /1 change from Claude Code waits for you/ }).click()
  await expect(windowed.getByRole('button', { name: /^Approve/ })).toBeDisabled()
  await mouse.setViewportSize({ width: 900, height: 900 })
  await expect(windowed.getByRole('button', { name: /^Approve/ })).toBeEnabled({ timeout: 1500 })
  await desk.close()
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
