/**
 * A Secret's value on a plugin's own page, on a server: shown and not held, in each browser a
 * server's page runs in, and on a phone. Its code names the Secret by its token; Lumovi draws its
 * card, reads a value as the person on their press alone, and sends the code nothing of it.
 *
 * What its code is sent with no press at all is its read's answer, and that answer again each
 * time Lumovi reads its list again. So the proof is not a count that stands still: it's that
 * whatever the person reveals, hides or copies, and whether the read is refused, every message
 * is that first answer to the letter, and none comes sooner than Lumovi's own next read would
 * (tests/plugin-secret-page.ts). A press that does tell the code something fails both.
 *
 * No value is in a title, an expectation or an output here (tests/plugin-secret-page.ts).
 */
import { chromium, firefox, webkit, type Locator, type Page } from '@playwright/test'
import {
  APART,
  code,
  expectHidden,
  included,
  keyed,
  PARTS,
  SECRET,
  TELLS,
  toldOf,
} from '../plugin-secret-page.ts'
import { audited, DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/**
 * A server with Toys in it, as if it came with Lumovi (it knows its own address, for the box):
 * with `proof`, its code says what it could tell from the messages it was sent.
 */
async function served(serve: Serve, proof = false) {
  const port = await freePort()
  return serve({
    port,
    env: {
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(code(PARTS, proof)),
    },
  })
}

const body = (page: Page) => page.locator('[data-plugin-body="toys"]')
const card = (page: Page, title: string) =>
  body(page).getByRole('region', { name: title, exact: true })
const box = (of: Locator, key: string) => of.getByRole('group', { name: key, exact: true })
/** What its code says of the messages it was sent. */
const told = async (page: Page) =>
  toldOf((await body(page).locator('h2').first().textContent()) ?? '')

for (const [name, browsers] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test.describe(`a Secret on a plugin’s page in ${name}`, () => {
    test('it’s read on the person’s press alone, and nothing of it goes back to the code: every message is its read’s answer again, whatever is revealed, hidden, copied or refused', async ({
      serve,
      clusters,
    }) => {
      // Chromium is every run's. The other two are CI's Browsers job's, which says so
      // (LUMOVI_E2E_BROWSERS=all): there, one that isn't installed or doesn't start fails the
      // test. Elsewhere they run where they can, and are skipped where they can't.
      const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
      test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
      keyed(clusters.demo)
      const reads = () => clusters.demo.requests.filter((r) => r.path === SECRET).length
      const server = await served(serve, true)
      const browser = await browsers.launch().catch((error: unknown) => {
        if (must) throw error
        return undefined
      })
      test.skip(!browser, `${name} doesn’t start on this computer`)
      try {
        const page = await browser!.newPage()
        await signIn(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
        const keys = card(page, 'Widget keys')
        await expect(keys).toContainText('Shown by Lumovi. Toys can’t see it.', { timeout: 30_000 })
        await expect(keys.getByRole('group')).toHaveCount(4)
        for (const key of ['password', 'note', 'empty', 'turned']) {
          await expectHidden(box(keys, key), true)
        }
        expect(reads()).toBe(0)
        // With no press at all, its code is sent its read's answer, and the same answer again
        // each time Lumovi reads its list again: that much, at rest.
        const again = async () => (await told(page)).again
        await expect.poll(again, { timeout: 30_000 }).toBeGreaterThan(0)
        expect((await told(page)).unlike).toBe(0)

        // Reveal, hide, and all of them at once: a long value, an empty one, and one with a
        // character that turns a line round.
        await box(keys, 'password').getByRole('button', { name: 'Reveal password' }).click()
        await expectHidden(box(keys, 'password'), false)
        expect(reads()).toBe(1)
        await box(keys, 'password').getByRole('button', { name: 'Hide password' }).click()
        await expectHidden(box(keys, 'password'), true)
        await keys.getByRole('button', { name: 'Reveal all' }).click()
        for (const key of ['password', 'note', 'empty', 'turned']) {
          await expectHidden(box(keys, key), false)
        }
        await keys.getByRole('button', { name: 'Hide all' }).click()
        // Copy is a press and a read too, whatever this browser then lets the page copy.
        await box(keys, 'note').getByRole('button', { name: 'Copy note' }).click()
        await expect.poll(reads).toBe(3)
        // A read the cluster refuses the person: said on the card, to the person.
        const refuse = clusters.demo.fail(SECRET, {
          status: 403,
          body: JSON.stringify({
            kind: 'Status',
            status: 'Failure',
            reason: 'Forbidden',
            code: 403,
          }),
          contentType: 'application/json',
        })
        const one = card(page, 'Only its password')
        await box(one, 'password').getByRole('button', { name: 'Reveal password' }).click()
        await expect(one).toContainText('Your account isn’t allowed to read this Secret.')
        refuse()
        // Once Lumovi has read the list again after the last press, whatever a press sent has
        // been sent. Through all of it, every message its code got was its read's first answer
        // again, to the letter: nothing of the Secret, nor that it was revealed, hidden, copied or
        // refused. And none came sooner after the one before than Lumovi's own next read would:
        // no press started one.
        const pressed = await again()
        await expect.poll(again, { timeout: 30_000 }).toBeGreaterThan(pressed)
        const after = await told(page)
        expect(after.unlike, 'messages unlike its read’s first answer').toBe(0)
        expect(after.least, 'the least time between two messages, ms').toBeGreaterThanOrEqual(APART)
        // A token that isn't a Secret's shows none, in Lumovi's words.
        await expect(card(page, 'Made up')).toContainText('This object names no Secret.')
        // The server's history has each read as the person's, with the plugin: never a value.
        const recorded = audited(server, 'secret.read')
        expect(recorded.length).toBeGreaterThan(0)
        for (const entry of recorded) expect(entry.details).toMatchObject({ plugin: 'toys' })
        expect(JSON.stringify(recorded)).not.toContain('stand-in')
        // The proof can fail: a press of the plugin's own button, which Lumovi does tell its
        // code of, is a message unlike the answer, and sooner than a read.
        await body(page).getByRole('button', { name: TELLS }).click()
        await expect.poll(async () => (await told(page)).unlike).toBe(1)
        await expect
          .poll(async () => (await told(page)).least, { timeout: 30_000 })
          .toBeLessThan(APART)
      } finally {
        await browser!.close()
      }
    })
  })
}

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

  test('a plugin’s page shows a Secret on a phone: showing is a read, so it’s offered, a finger’s size, and nothing runs off the side', async ({
    serve,
    page,
    clusters,
  }) => {
    keyed(clusters.demo)
    const server = await served(serve)
    await signInNarrow(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
    const keys = card(page, 'Widget keys')
    await expect(keys).toContainText('Shown by Lumovi. Toys can’t see it.', { timeout: 30_000 })
    await expect(keys.getByRole('group')).toHaveCount(4)
    await keys.scrollIntoViewIfNeeded()
    await expectHidden(box(keys, 'password'), true)
    await box(keys, 'password').getByRole('button', { name: 'Reveal password' }).tap()
    await expectHidden(box(keys, 'password'), false)
    expect(clusters.demo.requests.filter((r) => r.path === SECRET).length).toBe(1)
    await box(keys, 'password').getByRole('button', { name: 'Hide password' }).tap()
    await expectHidden(box(keys, 'password'), true)
    await expectFingerSized(page, 'a Secret’s card on a plugin’s page, on a phone')
    await expectNoSidewaysScroll(page, 'a Secret’s card on a plugin’s page, on a phone')
  })
})
