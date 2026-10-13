/**
 * Pins and saved views on a server: each signed-in person's own, kept by the server with who's
 * signed in (never in the browser), the same in any browser they sign in from, and kept across a
 * restart where the server keeps its state. Past the server's budget, or not what Lumovi keeps,
 * a change is refused in Lumovi's words.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, PEOPLE, signIn, test } from './fixtures.ts'

const pins = (page: Page) =>
  page.getByRole('list', { name: 'Pinned objects' }).getByRole('listitem')
const CART = 'cluster/demo/deployments?namespaces=shop&open=Deployment/shop/cart'

test('each person’s pins and views are their own, the same in any browser they sign in from, and kept across a restart', async ({
  page,
  browser,
  serve,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({ env: { LUMOVI_DATA_DIR: data } })
  await signIn(page, `${served.url}${CART}`, PEOPLE.alice.token)
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(pins(page)).toHaveCount(1)
  await page.getByRole('button', { name: 'Views', exact: true }).click()
  const menu = page.getByRole('dialog', { name: 'Views' })
  await expect(menu).toContainText(
    'Kept for you on this server, so they’re the same in any browser you sign in from.',
  )
  await menu.getByRole('button', { name: 'Save view…' }).click()
  await menu.getByPlaceholder('Name this view').fill('The shop')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Views: The shop' })).toBeVisible()
  // The browser keeps none of it.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(stored).not.toContain('The shop')
  expect(stored).not.toMatch(/"pins":\[\{/)

  // Bob has none of hers.
  const bob = await (await browser.newContext()).newPage()
  await signIn(bob, `${served.url}cluster/demo/deployments?namespaces=shop`, PEOPLE.bob.token)
  await expect(bob.getByRole('button', { name: 'Views', exact: true })).toBeVisible()
  await expect(bob.getByRole('list', { name: 'Pinned objects' })).toHaveCount(0)
  await bob.getByRole('button', { name: 'Views', exact: true }).click()
  await expect(bob.getByRole('dialog', { name: 'Views' })).toContainText('No saved views.')

  // Alice, in another browser, has them.
  const elsewhere = await (await browser.newContext()).newPage()
  await signIn(
    elsewhere,
    `${served.url}cluster/demo/deployments?namespaces=shop`,
    PEOPLE.alice.token,
  )
  await expect(pins(elsewhere)).toHaveCount(1)
  await expect(pins(elsewhere).first()).toContainText('cart')

  // And after a restart.
  await served.stop()
  await serve({ env: { LUMOVI_DATA_DIR: data }, port: served.port })
  await page.reload()
  await expect(pins(page)).toHaveCount(1)
  await page.getByRole('button', { name: /^Views/ }).click()
  await expect(page.getByRole('dialog', { name: 'Views' })).toContainText('The shop')
})

test('what isn’t Lumovi’s to keep, a cluster that isn’t this server’s, and past the budget: refused in Lumovi’s words', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const set = (context: string, marks: unknown) =>
    page.evaluate(
      ([context, marks]) =>
        window.lumovi!.marks!.set(context as string, marks as never) as Promise<{
          ok: boolean
          error?: { message: string }
        }>,
      [context, marks] as const,
    )

  const odd = await set('demo', { pins: [{ kind: 'Deployment', name: 'a/b' }], views: [] })
  expect(odd.ok).toBe(false)
  await expect(set('nowhere', { pins: [], views: [] })).rejects.toThrow(
    'This server has no cluster called “nowhere” that you can see.',
  )

  // One person's in one cluster: at most what the server's budget gives them.
  const view = (i: number) => ({
    name: `View ${i}`,
    kind: 'Pod',
    q: 'x'.repeat(1000),
    labels: 'y'.repeat(1000),
  })
  const over = await set('demo', { pins: [], views: Array.from({ length: 20 }, (_, i) => view(i)) })
  expect(over).toEqual({
    ok: false,
    error: expect.objectContaining({
      message:
        'This server keeps no more of your pins and views in this cluster. Unpin or delete some to save this.',
    }),
  })
  // Under it, kept.
  const under = await set('demo', { pins: [], views: Array.from({ length: 5 }, (_, i) => view(i)) })
  expect(under.ok).toBe(true)
  const read = await page.evaluate(() => window.lumovi!.marks!.get('demo'))
  expect(read).toEqual({
    ok: true,
    data: expect.objectContaining({ views: expect.arrayContaining([expect.anything()]) }),
  })
})

test('what a page sends is held to the shapes Lumovi keeps, each part of it; a whole one is kept', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const set = (marks: unknown) =>
    page.evaluate(
      (marks) =>
        window.lumovi!.marks!.set('demo', marks as never) as Promise<{
          ok: boolean
          error?: { message: string }
        }>,
      marks,
    )
  const NOT = 'Isn’t what Lumovi keeps.'
  const pin = { kind: 'Deployment', name: 'cart', namespace: 'shop' }
  const view = { name: 'Shop', kind: 'Pod' }
  const withView = (changed: object) => ({ pins: [], views: [{ ...view, ...changed }] })
  const withColumns = (columns: unknown) => withView({ columns })
  for (const [said, marks, refused] of [
    ['not named values', null, NOT],
    ['a key of its own', { pins: [], views: [], more: 1 }, NOT],
    ['pins not a list', { pins: {}, views: [] }, NOT],
    [
      'past twenty pins',
      { pins: Array.from({ length: 21 }, (_, i) => ({ ...pin, name: `p${i}` })), views: [] },
      '20 objects are pinned in this cluster, the most there can be. Unpin one to pin another.',
    ],
    ['a pin with a key of its own', { pins: [{ ...pin, more: 1 }], views: [] }, NOT],
    [
      'a pin whose kind isn’t one there can be',
      { pins: [{ ...pin, kind: 'not a kind' }], views: [] },
      NOT,
    ],
    ['a pin with no name', { pins: [{ ...pin, name: '' }], views: [] }, NOT],
    ['a pin named ".."', { pins: [{ ...pin, name: '..' }], views: [] }, NOT],
    ['a pin past 253', { pins: [{ ...pin, name: 'x'.repeat(254) }], views: [] }, NOT],
    ['a pin with a control character', { pins: [{ ...pin, name: 'a\u0007b' }], views: [] }, NOT],
    [
      'a pin in no namespace there can be',
      { pins: [{ ...pin, namespace: 'Shop_1' }], views: [] },
      NOT,
    ],
    ['a pin whose namespace is a number', { pins: [{ ...pin, namespace: 5 }], views: [] }, NOT],
    ['the same pin twice', { pins: [pin, { ...pin }], views: [] }, NOT],
    [
      'past fifty views',
      { pins: [], views: Array.from({ length: 51 }, (_, i) => ({ name: `v${i}`, kind: 'Pod' })) },
      '50 views of this cluster are saved, the most there can be. Delete one to save this.',
    ],
    ['a view that isn’t named values', { pins: [], views: ['Shop'] }, NOT],
    ['a view with a key of its own', withView({ more: 1 }), NOT],
    ['a view with a blank name', withView({ name: '   ' }), NOT],
    ['a view named past 80', withView({ name: 'x'.repeat(81) }), NOT],
    ['a view whose kind isn’t one there can be', withView({ kind: 'not a kind' }), NOT],
    ['a filter past 1,000', withView({ q: 'x'.repeat(1001) }), NOT],
    ['a level Lumovi has no word for', withView({ health: ['fine'] }), NOT],
    ['labels that aren’t text', withView({ labels: 5 }), NOT],
    ['a sort that isn’t text', withView({ sort: ['name'] }), NOT],
    ['a direction that isn’t yes or no', withView({ desc: 'yes' }), NOT],
    ['a namespace there can’t be', withView({ namespaces: ['Shop_1'] }), NOT],
    ['namespaces that aren’t a list', withView({ namespaces: 'shop' }), NOT],
    ['columns that aren’t named values', withColumns(['name']), NOT],
    ['columns with a key of their own', withColumns({ more: 1 }), NOT],
    ['a column order that isn’t ids', withColumns({ order: [5] }), NOT],
    ['widths that aren’t named values', withColumns({ widths: [120] }), NOT],
    ['a width that isn’t a number', withColumns({ widths: { name: '120' } }), NOT],
    ['a width past 10,000', withColumns({ widths: { name: 10_001 } }), NOT],
    ['a width under nothing', withColumns({ widths: { name: -1 } }), NOT],
    ['added columns that aren’t a list', withColumns({ added: { from: 'label' } }), NOT],
    ['an added column of neither kind', withColumns({ added: [{ from: 'env', key: 'a' }] }), NOT],
    [
      'an added column with a key of its own',
      withColumns({ added: [{ from: 'label', key: 'a', more: 1 }] }),
      NOT,
    ],
    ['two views of a kind with one name', { pins: [], views: [view, { ...view }] }, NOT],
    [
      'past twenty views of a kind',
      { pins: [], views: Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, kind: 'Pod' })) },
      '20 views of one kind are saved, the most there can be. Delete one to save this.',
    ],
  ] as const) {
    expect(await set(marks), said).toEqual({
      ok: false,
      error: expect.objectContaining({ message: refused }),
    })
  }
  // Whole, with every part a view can have: kept, and read back as it was sent.
  const whole = {
    pins: [pin, { kind: 'Node', name: 'worker-1' }],
    views: [
      {
        name: 'Failing in the shop',
        kind: 'Pod',
        q: 'cart',
        health: ['critical', 'warning'],
        labels: 'app=cart',
        sort: 'age',
        desc: true,
        namespaces: ['shop'],
        columns: {
          order: ['name', 'status'],
          hidden: ['node'],
          widths: { name: 240 },
          added: [{ from: 'label', key: 'app.kubernetes.io/name' }],
        },
      },
      { name: 'Everywhere', kind: 'Deployment', namespaces: null },
    ],
  }
  expect(await set(whole)).toEqual({ ok: true, data: whole })
  expect(await page.evaluate(() => window.lumovi!.marks!.get('demo'))).toEqual({
    ok: true,
    data: whole,
  })
  // Opened, every part of it is in the list's address.
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.getByRole('button', { name: /^Views\b/ }).click()
  await page
    .getByRole('dialog', { name: 'Views' })
    .getByRole('list', { name: 'Saved views' })
    .getByRole('button', { name: 'Failing in the shop', exact: true })
    .click()
  for (const part of [
    /[?&]q=cart\b/,
    /[?&]health=critical%2Cwarning\b/,
    /[?&]labels=app%3Dcart\b/,
    /[?&]sort=age\b/,
    /[?&]desc=1\b/,
    /[?&]namespaces=shop\b/,
  ]) {
    await expect(page).toHaveURL(part)
  }
})
