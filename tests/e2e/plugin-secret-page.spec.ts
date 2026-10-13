/**
 * A Secret's value on a plugin's own page, shown and not held: its code names the Secret by the
 * token it was handed with the object that names it, Lumovi draws its card, and reads a value as
 * the person on their press alone, recorded with the plugin. Nothing of it goes back to the code:
 * whatever the person reveals, hides or copies, and whether the read is refused, every message it
 * is sent is its read's answer again, to the letter, and none comes sooner than Lumovi's own next
 * read of its list would. A token that isn't a Secret's shows none and asks nothing; a key its
 * file doesn't name stops the page.
 *
 * No value is in a title, an expectation or an output here: a box is asked whether it shows its
 * dots, and a read is known by the cluster having been asked.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { READ_REFUSED } from '../../src/shared/plugin-reads.ts'
import {
  APART,
  code,
  expectHidden,
  included,
  keyed,
  PARTS,
  SECRET,
  sha,
  TELLS,
  toldOf,
  TOYS,
} from '../plugin-secret-page.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const PAGE = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
const body = (page: Page) => page.locator('[data-plugin-body="toys"]')
const card = (page: Page, title: string) =>
  body(page).getByRole('region', { name: title, exact: true })
const box = (of: Locator, key: string) => of.getByRole('group', { name: key, exact: true })
/** How many messages its code says it has been sent. */
const told = async (page: Page) =>
  toldOf((await body(page).locator('h2').first().textContent()) ?? '')

test('a plugin’s page shows a Secret its own kind names, by its token: read on the person’s press alone, as the person, and recorded with the plugin', async ({
  launch,
  clusters,
}) => {
  keyed(clusters.demo)
  const reads = () => clusters.demo.requests.filter((r) => r.path === SECRET).length
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(code(PARTS)) },
  })
  await openCluster(page)
  await go(page, PAGE)
  // Lumovi's card: the plugin's title, whose eyes it's for, the Secret's own name, and a box for
  // each key its file names, hidden. Nothing of the Secret was read to draw it.
  const keys = card(page, 'Widget keys')
  await expect(keys).toContainText('Shown by Lumovi. Toys can’t see it.', { timeout: 20_000 })
  await expect(keys).toContainText('Secret widget-keys in default')
  await expect(keys.getByRole('group')).toHaveCount(4)
  for (const key of ['password', 'note', 'empty', 'turned'])
    await expectHidden(box(keys, key), true)
  // Its `keys` only narrows them.
  await expect(card(page, 'Only its password').getByRole('group')).toHaveCount(1)
  expect(reads()).toBe(0)

  // Reveal is the person's press: one read, of that key, and its box shows what came.
  await box(keys, 'password').getByRole('button', { name: 'Reveal password' }).click()
  await expectHidden(box(keys, 'password'), false)
  await expectHidden(box(keys, 'note'), true)
  expect(reads()).toBe(1)
  await box(keys, 'password').getByRole('button', { name: 'Hide password' }).click()
  await expectHidden(box(keys, 'password'), true)
  // The history has it as the person's read, with the plugin whose page showed it and what its
  // code was handed with: never a value.
  const { events } = await page.evaluate(() =>
    window.lumovi!.audit.query({ actions: ['secret.read'] }),
  )
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    outcome: 'success',
    target: { kind: 'Secret', namespace: 'default', name: 'widget-keys' },
    details: {
      plugin: 'toys',
      pluginVersion: '1.2.0',
      pluginDigest: sha(TOYS),
      codeDigest: sha(code(PARTS)),
    },
  })
  expect(JSON.stringify(events[0])).not.toContain('stand-in')

  // A token that's made up, an object's own token, and no token at all: no Secret, said in
  // Lumovi's words, with nothing to press and nothing asked of the cluster.
  for (const title of ['Made up', 'An object, not a Secret', 'Names none']) {
    await expect(card(page, title)).toContainText('This object names no Secret.')
    await expect(card(page, title).getByRole('button')).toHaveCount(0)
  }
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path)).length).toBe(1)
})

test('nothing of it goes back to the code: every message is its read’s answer again, whatever the person reveals, hides or copies, and whether the read is refused', async ({
  launch,
  clusters,
}) => {
  keyed(clusters.demo)
  const reads = () => clusters.demo.requests.filter((r) => r.path === SECRET).length
  // (Its code says what it could tell from the messages it was sent: tests/plugin-secret-page.ts.)
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(code(PARTS, true)) },
  })
  await openCluster(page)
  await go(page, PAGE)
  const keys = card(page, 'Widget keys')
  await expect(keys.getByRole('group')).toHaveCount(4, { timeout: 20_000 })
  // With no press at all, its code is sent its read's answer, and the same answer again each
  // time Lumovi reads its list again: that much, at rest.
  const again = async () => (await told(page)).again
  await expect.poll(again, { timeout: 30_000 }).toBeGreaterThan(0)
  expect((await told(page)).unlike).toBe(0)

  // Reveal, hide, copy; a long value, an empty one and one that turns a line round; all at once.
  await box(keys, 'password').getByRole('button', { name: 'Reveal password' }).click()
  await expectHidden(box(keys, 'password'), false)
  await box(keys, 'password').getByRole('button', { name: 'Hide password' }).click()
  await box(keys, 'note').getByRole('button', { name: 'Copy note' }).click()
  await expect.poll(reads).toBe(2)
  await keys.getByRole('button', { name: 'Reveal all' }).click()
  for (const key of ['password', 'note', 'empty', 'turned'])
    await expectHidden(box(keys, key), false)
  await keys.getByRole('button', { name: 'Hide all' }).click()
  for (const key of ['password', 'note', 'empty', 'turned'])
    await expectHidden(box(keys, key), true)
  expect(reads()).toBe(3)
  // A read the cluster refuses the person: said on the card, to the person.
  const refuse = clusters.demo.fail(SECRET, {
    status: 403,
    body: JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403 }),
    contentType: 'application/json',
  })
  const one = card(page, 'Only its password')
  await box(one, 'password').getByRole('button', { name: 'Reveal password' }).click()
  await expect(one).toContainText('Your account isn’t allowed to read this Secret.')
  refuse()

  // Once Lumovi has read the list again after the last press, whatever a press sent has been
  // sent. Through all of it, every message its code got was its read's first answer again, to
  // the letter: nothing of the Secret, nor that it was revealed, hidden, copied or refused. And
  // none came sooner after the one before than Lumovi's own next read would: no press started one.
  const pressed = await again()
  await expect.poll(again, { timeout: 30_000 }).toBeGreaterThan(pressed)
  const after = await told(page)
  expect(after.unlike, 'messages unlike its read’s first answer').toBe(0)
  expect(after.least, 'the least time between two messages, ms').toBeGreaterThanOrEqual(APART)
  // The proof can fail: a press of the plugin's own button, which Lumovi does tell its code of,
  // is a message unlike the answer, and sooner than a read.
  await body(page).getByRole('button', { name: TELLS }).click()
  await expect.poll(async () => (await told(page)).unlike).toBe(1)
  await expect.poll(async () => (await told(page)).least, { timeout: 30_000 }).toBeLessThan(APART)
})

test('a key its file doesn’t name stops the page, and asked straight the read is refused: nothing of the Secret is read', async ({
  launch,
  clusters,
}) => {
  keyed(clusters.demo)
  const js = code(`[{ title: 'Another key', secret: T, keys: ['password', 'other'] }]`)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(js) } })
  await openCluster(page)
  await go(page, PAGE)
  // At the door: an ask its file doesn't grant, so the page stops, and nothing is drawn of it.
  const ended = body(page).getByTestId('plugin-ended')
  await expect(ended).toContainText('It sent something a plugin can’t.', { timeout: 20_000 })
  await expect(card(page, 'Another key')).toHaveCount(0)
  // Behind the door: a page that skipped it, and asked for that key in the plugin's name with
  // everything else as it should be, is refused too.
  const asked = (keys: string[], path = 'spec.secretName') =>
    page.evaluate((query) => window.lumovi!.kube.secretValues(query as never), {
      context: CONTEXTS.demo,
      namespace: 'default',
      name: 'widget-keys',
      keys,
      forPlugin: 'toys',
      namedBy: { kind: 'Widget.example.com', name: 'keyed', path },
      digest: sha(TOYS),
      codeDigest: sha(js),
    })
  expect(await asked(['other'])).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(await asked(['password', 'other'])).toMatchObject({
    ok: false,
    error: { code: 'not-allowed' },
  })
  // A path its file doesn't declare names no Secret of its own, whatever keys are asked.
  expect(await asked(['password'], 'spec.color')).toMatchObject({
    ok: false,
    error: { code: 'not-allowed' },
  })
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path))).toEqual([])
})

test('a read in a plugin’s name with no hand-over behind it is refused, and nothing is read: no page of a plugin’s reads a Secret as the person’s own', async ({
  launch,
  clusters,
}) => {
  keyed(clusters.demo)
  const js = code(PARTS)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(js) } })
  await openCluster(page)
  await go(page, PAGE)
  await expect(card(page, 'Widget keys').getByRole('group')).toHaveCount(4, { timeout: 20_000 })
  // Everything as a press on its page would send it, but for what its code was handed with:
  // none at all, empty, half of it, or another code's. Each names a plugin whose page Lumovi
  // didn't hand that code to.
  const asked = (handed: object, more: object = {}) =>
    page.evaluate((query) => window.lumovi!.kube.secretValues(query as never), {
      context: CONTEXTS.demo,
      namespace: 'default',
      name: 'widget-keys',
      keys: ['password'],
      forPlugin: 'toys',
      namedBy: { kind: 'Widget.example.com', name: 'keyed', path: 'spec.secretName' },
      ...handed,
      ...more,
    })
  for (const handed of [
    {},
    { digest: '', codeDigest: '' },
    { digest: sha(TOYS) },
    { codeDigest: sha(js) },
    { digest: sha(TOYS), codeDigest: sha(code('[]')) },
  ]) {
    expect(await asked(handed), JSON.stringify(Object.keys(handed))).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: READ_REFUSED.changed },
    })
  }
  // With its hand-over and nothing said of what named the Secret: no read either.
  const whole = { digest: sha(TOYS), codeDigest: sha(js) }
  expect(await asked(whole, { namedBy: undefined })).toMatchObject({
    ok: false,
    error: { code: 'invalid' },
  })
  // A name that's no plugin's (an empty one is no "nobody's": it's refused, never read as the
  // person's own), or a plugin Lumovi doesn't have: refused as plainly.
  for (const forPlugin of ['', '../toys']) {
    expect(await asked(whole, { forPlugin }), JSON.stringify(forPlugin)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
  }
  expect(await asked(whole, { forPlugin: 'nope' })).toMatchObject({
    ok: false,
    error: { code: 'not-allowed' },
  })
  // Through all of it the cluster was asked nothing of any Secret.
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path))).toEqual([])
  // (And the same ask with the hand-over it was really given is the one that reads.)
  expect(await asked(whole)).toMatchObject({ ok: true })
  expect(clusters.demo.requests.filter((r) => r.path === SECRET).length).toBe(1)
})

test('under a policy that lets no plugin show what’s in Secrets, its card says so, with nothing to press and nothing read', async ({
  launch,
  clusters,
}) => {
  keyed(clusters.demo)
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginSecrets: 'off' }))
  const js = code(PARTS)
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(js), LUMOVI_POLICY: policy },
  })
  await openCluster(page)
  await go(page, PAGE)
  const keys = card(page, 'Widget keys')
  await expect(keys).toContainText(
    'Your organization’s policy doesn’t let plugins show what’s in Secrets.',
    { timeout: 20_000 },
  )
  await expect(keys.getByRole('group')).toHaveCount(0)
  await expect(keys.getByRole('button')).toHaveCount(0)
  // Asked straight, it's refused with the same words.
  const asked = await page.evaluate((query) => window.lumovi!.kube.secretValues(query as never), {
    context: CONTEXTS.demo,
    namespace: 'default',
    name: 'widget-keys',
    keys: ['password'],
    forPlugin: 'toys',
    namedBy: { kind: 'Widget.example.com', name: 'keyed', path: 'spec.secretName' },
    digest: sha(TOYS),
    codeDigest: sha(js),
  })
  expect(asked).toMatchObject({
    ok: false,
    error: { message: 'Your organization’s policy doesn’t let plugins show what’s in Secrets.' },
  })
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path))).toEqual([])
})
