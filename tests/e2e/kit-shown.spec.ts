/**
 * A Secret's value shown on a plugin's page, on the page the tests' build has for the kit's
 * parts. No value is in a title, an expectation or an output here: a value is known by its
 * length, and a read by the cluster having been asked.
 */
import type { Locator, Page } from '@playwright/test'
import { clipboardText, DEMO, expect, openCluster, test } from './fixtures.ts'
import { holds } from '../holds.ts'

const MASK = '••••••••'

/**
 * Whether a key's box shows the dots or something else: asked as yes or no, so that where it
 * fails nothing of what the box held is printed.
 */
const expectHidden = (box: Locator, hidden: boolean) =>
  expect
    .poll(async () => (await box.locator('pre').innerText()) === MASK, {
      message: hidden ? 'the box should show its dots' : 'the box should show its value',
    })
    .toBe(hidden)

async function shown(page: Page) {
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/kit/shown'
  })
  await expect(page.getByRole('region', { name: 'Storefront certificate' })).toBeVisible()
}

test('a Secret’s value on a plugin’s page: nothing read until a press, and a box holds what its own press brought', async ({
  page,
  clusters,
}) => {
  const reads = (name: string) =>
    clusters.demo.requests.filter((r) => r.path.endsWith(`/secrets/${name}`)).length
  await shown(page)
  const card = page.getByRole('region', { name: 'Storefront certificate' })
  // The plugin's title, whose eyes it's for, and the Secret's own name and namespace, from
  // Lumovi: a title is the plugin's to choose.
  await expect(card).toContainText('Shown by Lumovi. Sample plugin can’t see it.')
  await expect(card).toContainText('Secret storefront-tls in shop')
  // A box for each key the file names, hidden: eight dots, no size. And nothing was read: not
  // this Secret nor any other card's.
  const box = (key: string) => card.getByRole('group', { name: key, exact: true })
  for (const key of ['tls.crt', 'tls.key', 'token']) {
    await expectHidden(box(key), true)
    await expect(box(key)).not.toContainText(/\d\s?(B|KB|MB)\b/)
  }
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path)).length).toBe(0)

  // Reveal is a press: one read, and its box shows the value with its size while it does.
  await box('tls.crt').getByRole('button', { name: 'Reveal tls.crt' }).click()
  await expectHidden(box('tls.crt'), false)
  expect((await box('tls.crt').locator('pre').innerText()).length).toBeGreaterThan(MASK.length)
  // (Asked of the size alone: a check of the whole box would print the value where it fails.)
  await expect(box('tls.crt').locator('.tabular-nums')).toHaveText(/^\d+(\.\d+)?\s?(B|KB)$/)
  expect(reads('storefront-tls')).toBe(1)
  // The other boxes are as they were: what the read brought was for the pressed key alone.
  await expectHidden(box('tls.key'), true)
  // Hide puts the box back as it was, and lets the value go: the next Reveal reads again.
  await box('tls.crt').getByRole('button', { name: 'Hide tls.crt' }).click()
  await expectHidden(box('tls.crt'), true)
  // (Asked of the size's own place: where this fails, nothing of the box is printed.)
  await expect(box('tls.crt').locator('.tabular-nums')).toHaveCount(0)
  expect(reads('storefront-tls')).toBe(1)
  await box('tls.crt').getByRole('button', { name: 'Reveal tls.crt' }).click()
  await expectHidden(box('tls.crt'), false)
  expect(reads('storefront-tls')).toBe(2)

  // Copy on a hidden box reads, copies and leaves the box hidden.
  await box('tls.key').getByRole('button', { name: 'Copy tls.key' }).click()
  await expect.poll(async () => (await clipboardText(page)).length).toBeGreaterThan(MASK.length)
  await expectHidden(box('tls.key'), true)
  expect(reads('storefront-tls')).toBe(3)
  // Copy on a shown box copies what's shown: no read.
  await box('tls.crt').getByRole('button', { name: 'Copy tls.crt' }).click()
  expect(reads('storefront-tls')).toBe(3)

  // Reveal all is a press on every box still hidden: one read. A key the Secret doesn't have
  // says so in its box, by name, with no buttons left.
  await card.getByRole('button', { name: 'Reveal all' }).click()
  await expect(box('token')).toContainText('Secret storefront-tls in shop has no key named token.')
  await expect(box('token').getByRole('button')).toHaveCount(0)
  await expectHidden(box('tls.key'), false)
  expect(reads('storefront-tls')).toBe(4)
  await card.getByRole('button', { name: 'Hide all' }).click()
  for (const key of ['tls.crt', 'tls.key']) await expectHidden(box(key), true)
  expect(reads('storefront-tls')).toBe(4)

  // While a read is on its way its box can't be pressed again, nor can Reveal all: an answer
  // belongs to its press, and nothing arrives after a Hide to put a value back.
  const slow = clusters.demo.fail('/api/v1/namespaces/shop/secrets/storefront-tls', {
    delayMs: 1500,
  })
  await box('tls.key').getByRole('button', { name: 'Reveal tls.key' }).click()
  await expect(card.getByRole('button', { name: 'Reveal all' })).toBeDisabled()
  await expect(box('tls.key').getByRole('button', { name: 'Copy tls.key' })).toBeDisabled()
  await expectHidden(box('tls.key'), false)
  slow()
  await box('tls.key').getByRole('button', { name: 'Hide tls.key' }).click()
  await expectHidden(box('tls.key'), true)
  await holds(
    async () => (await box('tls.key').locator('pre').innerText()) === MASK,
    500,
    'tls.key stays hidden',
  )

  // A read that's still out when the plugin points the card elsewhere is used for nothing: it
  // isn't copied, and it doesn't land in the new Secret's boxes.
  const copiedBefore = (await clipboardText(page)).length
  const held = clusters.demo.fail('/api/v1/namespaces/shop/secrets/storefront-tls', {
    delayMs: 1500,
  })
  await box('tls.crt').getByRole('button', { name: 'Copy tls.crt' }).click()
  await page.getByRole('button', { name: 'Point the first card elsewhere' }).click()
  await expect(card).toContainText('Secret registry-pull in shop')
  held()
  await holds(
    async () => (await clipboardText(page)).length === copiedBefore,
    2500,
    'nothing is copied from the read that was out',
  )
  for (const key of ['tls.crt', 'tls.key', 'token']) await expectHidden(box(key), true)
  await expect(card.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Point the first card back' }).click()
  await expect(card).toContainText('Secret storefront-tls in shop')

  // The plugin points the card at another Secret with the same keys: everything a press brought
  // belonged to the first, so the card is as it opens, and nothing was read for the new one.
  await box('tls.crt').getByRole('button', { name: 'Reveal tls.crt' }).click()
  await expectHidden(box('tls.crt'), false)
  const before = clusters.demo.requests.filter((r) => /\/secrets\//.test(r.path)).length
  await page.getByRole('button', { name: 'Point the first card elsewhere' }).click()
  await expect(card).toContainText('Secret registry-pull in shop')
  for (const key of ['tls.crt', 'tls.key', 'token']) await expectHidden(box(key), true)
  await expect(box('token').getByRole('button')).toHaveCount(2)
  expect(clusters.demo.requests.filter((r) => /\/secrets\//.test(r.path)).length).toBe(before)
  await page.getByRole('button', { name: 'Point the first card back' }).click()
  await expect(card).toContainText('Secret storefront-tls in shop')
  await expectHidden(box('tls.crt'), true)

  // A description narrows the file's keys and can't add to them.
  const narrowed = page.getByRole('region', { name: 'Only the certificate' })
  await expect(narrowed.getByRole('group')).toHaveCount(1)
  await expect(narrowed.getByRole('group', { name: 'tls.crt' })).toBeVisible()
})

test('a Secret that can’t be shown: what a press comes back with, and what’s known without one', async ({
  page,
  clusters,
}) => {
  await shown(page)
  // A Secret that isn't there is found by the press, and the boxes give way to it, by name.
  const gone = page.getByRole('region', { name: 'Gone', exact: true })
  await expectHidden(gone.getByRole('group', { name: 'token' }), true)
  await gone.getByRole('button', { name: 'Reveal token' }).click()
  await expect(gone).toContainText(
    'There’s no Secret named no-such-secret in shop. Sample plugin’s page points at it.',
  )
  await expect(gone.getByRole('group')).toHaveCount(0)
  await expect(gone).toContainText('Secret no-such-secret in shop')
  // There's a way back: the Secret may be there a minute later. The boxes return, hidden, and
  // the next press reads again.
  await gone.getByRole('button', { name: 'Try again' }).click()
  await expectHidden(gone.getByRole('group', { name: 'token' }), true)
  // One the cluster refuses: said as the account's, and that the plugin's page asked.
  const refuse = clusters.demo.fail('/api/v1/namespaces/data/secrets/postgres-credentials', {
    status: 403,
    body: JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403 }),
    contentType: 'application/json',
  })
  const password = page.getByRole('region', { name: 'Database password' })
  await password.getByRole('button', { name: 'Copy password' }).click()
  await expect(password).toContainText(
    'Your account isn’t allowed to read this Secret. Sample plugin’s page asks Lumovi to show it here.',
  )
  await expect(password.getByRole('group')).toHaveCount(0)
  refuse()
  // Another failure is said in the pressed box, in Lumovi's words, with its buttons kept: the
  // press can be tried again, and then it reads.
  const card = page.getByRole('region', { name: 'Storefront certificate' })
  const box = card.getByRole('group', { name: 'tls.crt', exact: true })
  const broken = clusters.demo.fail('/api/v1/namespaces/shop/secrets/storefront-tls', {
    status: 500,
  })
  await box.getByRole('button', { name: 'Reveal tls.crt' }).click()
  await expect(box.getByRole('alert')).toHaveText('Lumovi couldn’t read this Secret.')
  await expectHidden(box, true)
  broken()
  await box.getByRole('button', { name: 'Reveal tls.crt' }).click()
  await expectHidden(box, false)
  await expect(box.getByRole('alert')).toHaveCount(0)

  // Known without a read, so said as the page opens, with no boxes.
  const off = page.getByRole('region', { name: 'Not on this server' })
  await expect(off).toContainText(
    'Your organization’s policy doesn’t let plugins show what’s in Secrets.',
  )
  await expect(off).toContainText('Secret storefront-tls in shop')
  await expect(off.getByRole('group')).toHaveCount(0)
  // A description that asks only for keys the file doesn't allow leaves none: said, not blank.
  const left = page.getByRole('region', { name: 'No keys left' })
  await expect(left).toContainText('Sample plugin’s page asks for none of this Secret’s keys.')
  await expect(left.getByRole('button')).toHaveCount(0)
  // What a plugin pointed at may be gone when the page is drawn: each card says so, quietly.
  await expect(page.getByRole('region', { name: 'Logs of nothing' })).toContainText(
    'The pod these logs were of isn’t there any more.',
  )
  await expect(page.getByRole('region', { name: 'Events of nothing' })).toContainText(
    'What these events were about isn’t there any more.',
  )
  const none = page.getByRole('region', { name: 'Names none' })
  await expect(none).toContainText('This Certificate names no Secret.')
  await expect(none.getByRole('button')).toHaveCount(0)
})

test('a pod’s logs and an object’s events on a plugin’s page: Lumovi’s own views, read once they’re in view', async ({
  page,
  clusters,
}) => {
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await page.evaluate((name) => {
    window.location.hash = `#/cluster/demo/kit/shown?pod=${name}`
  }, pod)
  await expect(page.getByRole('region', { name: 'Storefront certificate' })).toBeVisible()
  const asked = (what: RegExp) => clusters.demo.requests.filter((r) => what.test(r.path)).length
  // Below the fold as the page opens: no pod read for them, no log, no events.
  const logs = page.getByRole('region', { name: 'Logs', exact: true })
  const events = page.getByRole('region', { name: 'Events', exact: true })
  await expect(logs).toContainText('Shown by Lumovi: Sample plugin’s code never sees them.')
  // Waiting for a place, on its page and of its plugin: said, and nothing read.
  await expect(
    page.getByRole('region', { name: 'Logs waiting on its page' }).locator('[data-logs-waiting]'),
  ).toHaveText(
    'Not shown: a plugin’s page shows 4 logs at once. This one starts when another closes.',
  )
  await expect(
    page.getByRole('region', { name: 'Logs waiting on its plugin' }).locator('[data-logs-waiting]'),
  ).toHaveText(
    'Not shown: Sample plugin shows 8 logs at once, across its pages and tabs. This one starts when another closes.',
  )
  // (For a moment: anything that would have been asked would have been.)
  await holds(
    () => asked(/\/pods\/[^/]+\/log$/) + asked(new RegExp(`/pods/${pod}$`)) === 0,
    1000,
    'nothing below the fold is read',
  )
  expect(asked(/\/pods\/[^/]+\/log$/)).toBe(0)
  expect(asked(new RegExp(`/pods/${pod}$`))).toBe(0)
  expect(asked(/\/pods\/gone-pod$/)).toBe(0)
  // (The events' refusal is set up now, before anything brings their card into view.)
  expect(asked(/\/namespaces\/shop\/events$/)).toBe(0)
  const refuse = clusters.demo.fail(/\/events$/, {
    status: 403,
    body: JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403 }),
    contentType: 'application/json',
  })

  // Scrolled to, the logs are the app's own log view of that pod, which the card names.
  await logs.scrollIntoViewIfNeeded()
  await expect(logs).toContainText(pod)
  await expect.poll(() => asked(new RegExp(`/pods/${pod}/log$`))).toBeGreaterThan(0)
  await expect(logs.getByPlaceholder(/Search/)).toBeVisible()
  // A pod that isn't there is said so, by name.
  const gone = page.getByRole('region', { name: 'Logs of a pod that’s gone' })
  await gone.scrollIntoViewIfNeeded()
  await expect(gone).toContainText(
    'There’s no pod named gone-pod in shop: it may have been deleted.',
  )
  // Events: where the account may not read them, the card says so and that the plugin's page
  // asked; where it may, they're the detail's own list, of the object the card names.
  await events.scrollIntoViewIfNeeded()
  await expect(events).toContainText('Deployment storefront')
  await expect(events).toContainText(
    'Your account isn’t allowed to read these events. Sample plugin’s page asks Lumovi to show them here.',
  )
  refuse()
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(
    events.getByRole('list', { name: 'Events' }).getByRole('listitem').first(),
  ).toBeVisible()
})
