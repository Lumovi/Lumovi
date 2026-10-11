/**
 * A note ("Scaled cart to 3 replicas") on a phone: across the bottom when nothing is open, above
 * the pill of changes that wait; and while a sheet is open, the sheet's own first line and never
 * over it, so what an approval shows of its change is whole while Approve can be pressed.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Browser, Locator, Page } from '@playwright/test'
import { call, connect } from './assistant-client.ts'
import { DEMO, expect, PEOPLE, signIn, test } from './fixtures.ts'
import { PHONE } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const scale = (client: Client, name: string, replicas: number, options?: { signal: AbortSignal }) =>
  call(
    client,
    'scale',
    { cluster: 'demo', kind: 'deploy', namespace: 'shop', name, replicas, reason: 'Busy.' },
    options,
  )
const sheetOf = (page: Page, title: string | RegExp) => page.getByRole('dialog', { name: title })
const strip = (sheet: Locator) => sheet.locator('[data-note-strip]')
/** The notes that float over the page: not shown at all while one is a sheet's first line. */
const floating = (page: Page) => page.locator('section[aria-label="Notifications"]')
const box = async (locator: Locator) => (await locator.boundingBox())!
const approveOf = (sheet: Locator) => sheet.getByRole('button', { name: /^Approve/ })

/** An assistant connected (from a computer), and the page a phone's. */
async function onAPhone(page: Page, served: { url: string }, at = 'cluster/demo') {
  await page.setViewportSize({ width: 1440, height: 920 })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served as never)
  await page.setViewportSize(PHONE)
  await page.goto(`${served.url}${at}`)
  return client
}

/** The same person at a computer: a change approved there is a note on the phone too. */
async function atADesk(browser: Browser, served: { url: string }) {
  const desk = await browser.newContext({
    viewport: { width: 1440, height: 920 },
    hasTouch: false,
    isMobile: false,
  })
  const page = await desk.newPage()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  return {
    page,
    approve: (title: string) => approveOf(sheetOf(page, title)).click(),
    close: () => desk.close(),
  }
}

test('a note that comes while a sheet is open is the sheet’s first line: its words, its place, and several at once', async ({
  page,
  serve,
  clusters,
}) => {
  const long =
    'checkout-payments-reconciliation-worker-with-ledger-export-and-settlement-retries-eu-west-1-blue-canary'
  const cart = clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!
  for (const name of [long, 'gone-by-then']) {
    clusters.demo.upsert({ ...cart, metadata: { ...cart.metadata, name, uid: undefined } })
  }
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const client = await onAPhone(page, served)
  await scale(client, DEMO.deployments.cart, 4)
  await scale(client, 'gone-by-then', 4)
  await scale(client, long, 4)
  // (A deletion's sheet is the tallest: the whole object, and a name to type.)
  await call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.storefront,
    reason: 'Unused.',
  })
  await page.getByRole('button', { name: /4 changes from Claude Code wait for you/ }).tap()

  // The first: no note yet. Where its two answers are is where they stay.
  const first = sheetOf(page, 'Scale Deployment cart to 4 replicas')
  await expect(approveOf(first)).toBeEnabled()
  await expect(strip(first)).toHaveCount(0)
  const reject = await box(first.getByRole('button', { name: 'Reject…' }))
  const approve = await box(approveOf(first))
  // (The second is gone from the cluster by the time it's approved: it fails.)
  clusters.demo.remove('Deployment', 'shop', 'gone-by-then')
  await approveOf(first).tap()

  // The second's sheet, with the first's outcome as its first line: said as about another
  // change, in the sheet and not over it, a status of its own.
  const second = sheetOf(page, 'Scale Deployment gone-by-then to 4 replicas')
  await expect(strip(second)).toBeVisible()
  await expect(second.getByRole('status')).toHaveText(
    /^The change before: scaled cart to 4 replicas, in demo\./,
  )
  await expect(floating(page)).toBeHidden()
  const inFirst = await box(strip(second))
  expect(inFirst.height).toBe(32)
  expect(inFirst.y + inFirst.height).toBeLessThanOrEqual((await box(second.getByRole('heading'))).y)
  // Its answers haven't moved for it, while it shows…
  await expect(approveOf(second)).toBeEnabled()
  expect(await box(second.getByRole('button', { name: 'Reject…' }))).toEqual(reject)
  expect(await box(approveOf(second))).toEqual(approve)
  // …nor when it has gone, after its six seconds (and it took no Dismiss to press).
  await expect(strip(second).getByRole('button')).toHaveCount(0)
  await expect(strip(second)).toHaveCount(0, { timeout: 10_000 })
  expect(await box(approveOf(second))).toEqual(approve)

  // Approved, it fails; and the third is approved right after: two notes at once. The failure
  // is the one shown, and the other is only counted.
  await approveOf(second).tap()
  const third = sheetOf(page, `Scale Deployment ${long} to 4 replicas`)
  await expect(approveOf(third)).toBeEnabled()
  await approveOf(third).tap()
  const last = sheetOf(page, `Delete Deployment ${DEMO.deployments.storefront}`)
  await expect(last.getByRole('alert')).toHaveText(
    /^The change before failed: scale Deployment gone-by-then to 4 replicas, in demo\./,
  )
  await expect(strip(last)).toContainText('and 1 more')
  await expect(strip(last)).not.toContainText('canary')
  // In the tallest sheet too it's a line of the sheet: nothing floats over any of it, and it
  // is above the heading, the change and the wait.
  await expect(floating(page)).toBeHidden()
  await expect(async () => {
    const inLast = await box(strip(last))
    const sheet = await box(last)
    expect(sheet.y).toBeGreaterThanOrEqual(24)
    expect(sheet.y + sheet.height).toBe(PHONE.height)
    expect(inLast.y).toBeGreaterThanOrEqual(sheet.y)
    expect(inLast.y + inLast.height).toBeLessThanOrEqual((await box(last.getByRole('heading'))).y)
  }, 'the tallest sheet come to rest, its note above its heading').toPass({ timeout: 5_000 })
})

test('a sentence too long for a line takes two, and only the name in it is cut', async ({
  page,
  serve,
  clusters,
}) => {
  const long =
    'checkout-payments-reconciliation-worker-with-ledger-export-and-settlement-retries-eu-west-1-blue-canary'
  const cart = clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!
  clusters.demo.upsert({ ...cart, metadata: { ...cart.metadata, name: long, uid: undefined } })
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const client = await onAPhone(page, served)
  await scale(client, long, 4)
  await scale(client, DEMO.deployments.cart, 4)
  await page.getByRole('button', { name: /2 changes from Claude Code wait for you/ }).tap()
  await approveOf(sheetOf(page, `Scale Deployment ${long} to 4 replicas`)).tap()
  const next = sheetOf(page, 'Scale Deployment cart to 4 replicas')
  const line = strip(next)
  await expect(line).toBeVisible()
  expect((await box(line)).height).toBe(48)
  // What shows: who it's about and where are whole; the name's middle is what gave way.
  const shown = (await line.locator('span[aria-hidden]').textContent())!
  expect(shown).toMatch(/^The change before: scaled checkout-.+…canary to 4 replicas, in demo\.$/)
  // What's read out is all of it.
  await expect(next.getByRole('status')).toContainText(`scaled ${long} to 4 replicas, in demo.`)
})

// (Sizes of name that a line and a half hold alone, and don't beside "and 1 more".)
for (const [index, name] of [
  'ledger-export-retries-eu',
  'settlement-reconciliation-worker-blue',
].entries()) {
  test(`a failure’s line is fitted again when the count beside it comes and when it goes: where it is stays whole (a name of ${name.length})`, async ({
    page,
    serve,
    clusters,
  }) => {
    const cart = clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!
    clusters.demo.upsert({ ...cart, metadata: { ...cart.metadata, name, uid: undefined } })
    const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
    const client = await onAPhone(page, served)
    const replicas = 4 + index
    await scale(client, name, replicas)
    await scale(client, DEMO.deployments.cart, replicas)
    await scale(client, DEMO.deployments.storefront, replicas)
    await page.getByRole('button', { name: /3 changes from Claude Code wait for you/ }).tap()
    // The first fails (it's gone by then), and the next is approved right after.
    clusters.demo.remove('Deployment', 'shop', name)
    const first = sheetOf(page, `Scale Deployment ${name} to ${replicas} replicas`)
    await expect(approveOf(first)).toBeEnabled()
    await approveOf(first).tap()
    const second = sheetOf(page, `Scale Deployment cart to ${replicas} replicas`)
    const alone = strip(second).locator('span[aria-hidden]')
    await expect(alone).toHaveText(/^The change before failed: .+, in demo\.$/)
    const height = (await box(strip(second))).height
    await expect(approveOf(second)).toBeEnabled()
    await approveOf(second).tap()

    // The failure is still the one shown, now with the count beside it: in the lines it had,
    // where it happened whole, and only the name shorter if anything is.
    const last = sheetOf(
      page,
      `Scale Deployment ${DEMO.deployments.storefront} to ${replicas} replicas`,
    )
    const line = strip(last)
    const words = line.locator('span[aria-hidden]')
    const whole = async (step: string) =>
      expect(async () => {
        expect((await box(line)).height).toBe(height)
        expect((await box(words)).height).toBeLessThanOrEqual(height === 48 ? 32 : 16)
        const shown = (await words.textContent())!
        expect(shown).toMatch(/^The change before failed: scale Deployment .+, in demo\.$/)
        expect(shown).toContain(` to ${replicas} replicas, in demo.`)
      }, step).toPass({ timeout: 5_000 })
    await expect(line).toContainText('and 1 more')
    await whole('the failure’s line fitted beside the count')
    const beside = (await words.textContent())!
    // The other note's time ends first (six seconds to the failure's ten): the count goes, and
    // the line has its room back.
    await expect(line).not.toContainText('and 1 more', { timeout: 8_000 })
    await whole('the failure’s line fitted again without the count')
    expect((await words.textContent())!.length).toBeGreaterThanOrEqual(beside.length)
    await expect(last.getByRole('alert')).toContainText(
      `scale Deployment ${name} to ${replicas} replicas, in demo.`,
    )
  })
}

test('a note arriving doesn’t put Approve off again; with too little height it waits for the sheet to close', async ({
  page,
  browser,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const client = await onAPhone(page, served)
  const desk = await atADesk(browser, served)
  // A scale that's approved at the desk meanwhile (asked first, so it's the one in front
  // there), and a deletion to look at here: a namespace's asks for its name to be typed.
  await scale(client, DEMO.deployments.cart, 7)
  await call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'namespace',
    name: 'batch',
    reason: 'Unused.',
  })
  await page.getByRole('button', { name: /2 changes from Claude Code wait for you/ }).tap()
  await sheetOf(page, 'Scale Deployment cart to 7 replicas')
    .getByRole('button', { name: 'Next change' })
    .tap()
  const deletion = sheetOf(page, 'Delete Namespace batch')
  const name = deletion.getByRole('textbox')
  await name.fill('batch')
  await expect(approveOf(deletion)).toBeEnabled()
  // Whether Approve is ever off again from here on.
  await page.evaluate(() => {
    const seen: boolean[] = []
    ;(window as unknown as { offAgain: boolean[] }).offAgain = seen
    new MutationObserver(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        /^Approve/.test(b.textContent ?? ''),
      )
      if (button?.disabled) seen.push(true)
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled'] })
  })
  const place = await box(approveOf(deletion))
  await desk.approve('Scale Deployment cart to 7 replicas')
  // The note of that comes into this sheet: its first line. Approve is as it was, where it was.
  await expect(strip(deletion)).toContainText('The change before: scaled cart to 7 replicas')
  await expect(approveOf(deletion)).toBeEnabled()
  expect(await box(approveOf(deletion))).toEqual(place)
  expect(
    await page.evaluate(() => (window as unknown as { offAgain: boolean[] }).offAgain),
  ).toEqual([])

  // A window with little height, the name's field in use. With just enough for the sheet (376 px
  // to itself): the strip, the field and both answers, all whole.
  const whole = [name, deletion.getByRole('button', { name: 'Reject…' }), approveOf(deletion)]
  await page.setViewportSize({ width: 600, height: 400 })
  // (In use: brought into view as typing in it would.)
  await name.focus()
  await name.scrollIntoViewIfNeeded()
  for (const part of [strip(deletion), ...whole]) await expect(part).toBeInViewport({ ratio: 1 })
  // With less (356 px): no strip, the field and both answers whole. The note isn't lost: it
  // shows when the sheet has closed, and for its whole time from then.
  await page.setViewportSize({ width: 600, height: 380 })
  // (In use: brought into view as typing in it would.)
  await name.focus()
  await name.scrollIntoViewIfNeeded()
  await expect(strip(deletion)).toHaveCount(0)
  await expect(floating(page)).toBeHidden()
  for (const part of whole) await expect(part).toBeInViewport({ ratio: 1 })
  await page.waitForTimeout(3000)
  await deletion.getByRole('button', { name: 'Later' }).tap()
  const kept = floating(page).getByText('Scaled cart to 7 replicas')
  await expect(kept).toBeVisible()
  await page.waitForTimeout(4000)
  await expect(kept).toBeVisible()
  await desk.close()
})

test('with nothing open a note is at the bottom, above the pill; when a sheet opens it is the sheet’s line, never over it', async ({
  page,
  browser,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const client = await onAPhone(page, served, 'cluster/demo/pods')
  const desk = await atADesk(browser, served)
  const notes = floating(page).locator('[role="status"]')
  const pill = page.getByRole('button', { name: /1 change from Claude Code waits for you/ })
  /** The lowest note's place: across the screen, its foot `above` px over `what`'s top. */
  const rests = async (above: number, what: () => Promise<number>) =>
    expect(async () => {
      const at = await box(notes.last())
      expect(at.x).toBe(16)
      expect(at.width).toBe(PHONE.width - 32)
      expect(Math.round(at.y + at.height)).toBe(Math.round(await what()) - above)
    }, 'the note come to rest at the bottom').toPass({ timeout: 5_000 })
  // Whether a note is ever drawn floating while a sheet is there, from here on: asked each frame.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { over: string[] }).over = seen
    const look = () => {
      const sheet = document.querySelector('[role="dialog"]')
      const region = document.querySelector('section[aria-label="Notifications"]')
      if (sheet && region && region.getClientRects().length > 0) seen.push(sheet.textContent ?? '')
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })
  const over = () => page.evaluate(() => (window as unknown as { over: string[] }).over)

  // One note, a change waiting: the note is 8 px above the pill.
  await scale(client, DEMO.deployments.cart, 8)
  await scale(client, DEMO.deployments.storefront, 8)
  await desk.approve('Scale Deployment cart to 8 replicas')
  await expect(notes).toHaveCount(1)
  await rests(8, async () => (await box(pill)).y)
  // The pill opened with the note still there: the note is the sheet's first line from the
  // sheet's first frame, before Approve can be pressed and after.
  await pill.tap()
  const waiting = sheetOf(page, `Scale Deployment ${DEMO.deployments.storefront} to 8 replicas`)
  await expect(strip(waiting)).toContainText('The change before: scaled cart to 8 replicas')
  await expect(floating(page)).toBeHidden()
  await expect(approveOf(waiting)).toBeEnabled()
  expect(await over()).toEqual([])
  // Approved, nothing waits and the sheet closes: no pill, and the notes are 16 px above the
  // bottom edge.
  await approveOf(waiting).tap()
  await expect(waiting).toHaveCount(0)
  await expect(pill).toHaveCount(0)
  await expect(notes.last()).toContainText(`Scaled ${DEMO.deployments.storefront} to 8 replicas`)
  await rests(16, async () => PHONE.height)
  await expect(notes).toHaveCount(0, { timeout: 12_000 })

  // Three notes, on an object's page: the same, and the count in the strip.
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/shop/${DEMO.pods.cart[0]}`)
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { over: string[] }).over = seen
    const look = () => {
      const sheet = document.querySelector('[role="dialog"]')
      const region = document.querySelector('section[aria-label="Notifications"]')
      if (sheet && region && region.getClientRects().length > 0) seen.push(sheet.textContent ?? '')
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })
  await scale(client, DEMO.deployments.cart, 9)
  await scale(client, DEMO.deployments.checkout, 9)
  await scale(client, DEMO.deployments.storefront, 9)
  await scale(client, DEMO.deployments.cart, 10)
  await desk.approve('Scale Deployment cart to 9 replicas')
  await desk.approve(`Scale Deployment ${DEMO.deployments.checkout} to 9 replicas`)
  await desk.approve(`Scale Deployment ${DEMO.deployments.storefront} to 9 replicas`)
  await expect(notes).toHaveCount(3)
  await rests(8, async () => (await box(pill)).y)
  await pill.tap()
  const last = sheetOf(page, 'Scale Deployment cart to 10 replicas')
  await expect(strip(last)).toContainText(
    `The change before: scaled ${DEMO.deployments.storefront} to 9 replicas`,
  )
  await expect(strip(last)).toContainText('and 2 more')
  await expect(floating(page)).toBeHidden()
  await expect(approveOf(last)).toBeEnabled()
  expect(await over()).toEqual([])
  await desk.close()
})

test('an outcome nobody here answered says so in the sheet: withdrawn, made without asking', async ({
  page,
  browser,
  serve,
}) => {
  // (The assistant's calls stay open while they wait, as an assistant's do: one is given up.)
  const served = await serve()
  const client = await onAPhone(page, served)
  const desk = await atADesk(browser, served)
  const givenUp = new AbortController()
  void scale(client, DEMO.deployments.cart, 4).catch(() => {})
  await expect(
    page.getByRole('button', { name: /1 change from Claude Code waits for you/ }),
  ).toBeVisible()
  void scale(client, DEMO.deployments.storefront, 4, { signal: givenUp.signal }).catch(() => {})
  await page.getByRole('button', { name: /2 changes from Claude Code wait for you/ }).tap()
  const sheet = sheetOf(page, 'Scale Deployment cart to 4 replicas')
  await expect(approveOf(sheet)).toBeEnabled()
  givenUp.abort()
  await expect(sheet.getByRole('status')).toHaveText(
    new RegExp(
      `^Claude Code withdrew another change: scale Deployment ${DEMO.deployments.storefront} to 4 replicas, in demo\\.`,
    ),
  )
  // At her desk she lets assistants change demo without asking (a phone doesn't set that); the
  // next change is made, and the strip here doesn't read as if she'd approved it.
  await desk.page.evaluate(async () => {
    const { mine } = await window.lumovi!.aiPermissions!.get()
    await window.lumovi!.aiPermissions!.set({
      ...mine,
      defaults: { ...mine.defaults, changes: 'allow' },
    })
  })
  const restarted = await call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.checkout,
    reason: 'Stale.',
  })
  expect(restarted.text).toMatch(/^Restarted /)
  await expect(strip(sheet)).toContainText(
    `Changed without asking: restarted ${DEMO.deployments.checkout}, in demo.`,
  )
  await expect(strip(sheet)).not.toContainText('The change before')
  await expect(floating(page)).toBeHidden()
  await desk.close()
})

test('a change that ran out of time while another is looked at says it was another', async ({
  page,
  serve,
}) => {
  const served = await serve({
    env: { LUMOVI_APPROVAL_TIMEOUT_MS: '8000', LUMOVI_APPROVAL_SLICE_MS: '1000' },
  })
  const client = await onAPhone(page, served)
  await scale(client, DEMO.deployments.cart, 4)
  await page.waitForTimeout(4000)
  await scale(client, DEMO.deployments.storefront, 4)
  await page.getByRole('button', { name: /2 changes from Claude Code wait for you/ }).tap()
  // The older is in front, and runs out; the sheet goes on to the other, which says of the
  // first that it was another change, not this one.
  const next = sheetOf(page, `Scale Deployment ${DEMO.deployments.storefront} to 4 replicas`)
  await expect(next.getByRole('status')).toHaveText(
    /^Another change wasn’t approved in time: scale Deployment cart to 4 replicas, in demo\./,
    { timeout: 8_000 },
  )
  await expect(floating(page)).toBeHidden()
})

test('in a sheet that isn’t an assistant’s change the line says so: another change in an action’s dialog, its own sentence elsewhere', async ({
  page,
  browser,
  serve,
  clusters,
}) => {
  const cart = clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!
  clusters.demo.upsert({
    ...cart,
    metadata: { ...cart.metadata, name: 'gone-by-then', uid: undefined },
  })
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const client = await onAPhone(page, served, 'cluster/demo/pods')
  const desk = await atADesk(browser, served)
  const gone = () => expect(page.locator('[data-note-strip]')).toHaveCount(0, { timeout: 12_000 })

  // Sort by, a sheet about no change: the note's own sentence, and a failure's.
  await page.getByRole('button', { name: /^Sort/ }).tap()
  const sort = page.getByRole('dialog', { name: 'Sort by' })
  await expect(sort).toBeVisible()
  await scale(client, DEMO.deployments.cart, 5)
  await desk.approve('Scale Deployment cart to 5 replicas')
  await expect(sort.getByRole('status')).toHaveText(
    /^As Claude Code asked: scaled cart to 5 replicas, in demo\./,
  )
  await expect(floating(page)).toBeHidden()
  await gone()
  await scale(client, 'gone-by-then', 5)
  clusters.demo.remove('Deployment', 'shop', 'gone-by-then')
  await desk.approve('Scale Deployment gone-by-then to 5 replicas')
  await expect(sort.getByRole('alert')).toHaveText(
    /^Failed: scale Deployment gone-by-then to 5 replicas, in demo\./,
  )
  await gone()
  await page.keyboard.press('Escape')
  await expect(sort).toHaveCount(0)

  // Scale's own dialog, about a change of the person's: the note is said to be another.
  const name = DEMO.deployments.storefront
  await page.goto(`${served.url}cluster/demo/deployments?open=Deployment/shop/${name}`)
  await page
    .getByRole('complementary', { name: `Deployment ${name}` })
    .getByRole('button', { name: 'Scale' })
    .tap()
  const own = page.getByRole('dialog', { name: `Scale ${name}` })
  await expect(own).toBeVisible()
  await scale(client, DEMO.deployments.cart, 6)
  await desk.approve('Scale Deployment cart to 6 replicas')
  await expect(own.getByRole('status')).toHaveText(
    /^Another change: scaled cart to 6 replicas, in demo\./,
  )
  await expect(floating(page)).toBeHidden()
  await gone()
  clusters.demo.upsert({
    ...cart,
    metadata: { ...cart.metadata, name: 'gone-by-then', uid: undefined },
  })
  await scale(client, 'gone-by-then', 6)
  clusters.demo.remove('Deployment', 'shop', 'gone-by-then')
  await desk.approve('Scale Deployment gone-by-then to 6 replicas')
  await expect(own.getByRole('alert')).toHaveText(
    /^Another change failed: scale Deployment gone-by-then to 6 replicas, in demo\./,
  )
  await desk.close()
})

test('wider than a phone nothing of this applies: a note over a dialog is where it was', async ({
  browser,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  const desk = await browser.newContext({
    viewport: { width: 1440, height: 920 },
    hasTouch: false,
    isMobile: false,
  })
  const page = await desk.newPage()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto(`${served.url}cluster/demo`)
  await scale(client, DEMO.deployments.cart, 6)
  await scale(client, DEMO.deployments.storefront, 6)
  const first = sheetOf(page, 'Scale Deployment cart to 6 replicas')
  await approveOf(first).click()
  const second = sheetOf(page, `Scale Deployment ${DEMO.deployments.storefront} to 6 replicas`)
  await expect(second).toBeVisible()
  // No strip in the dialog; the note floats in the bottom right corner, as it always has.
  await expect(page.locator('[data-note-strip], [data-note-slot]')).toHaveCount(0)
  const note = floating(page).locator('[role="status"]')
  await expect(async () => {
    const at = await box(note)
    expect(Math.round(at.x + at.width)).toBe(900 - 16)
    expect(Math.round(at.y + at.height)).toBe(900 - 16)
  }, 'the note come to rest in the corner').toPass({ timeout: 5_000 })
  await desk.close()
})
