/**
 * The namespace picker picking several namespaces: lists follow them, the address carries them, a
 * link shows them without changing what's remembered, at most 20 are picked, and someone who
 * can't list namespaces types them.
 */
import type { Page } from '@playwright/test'
import { LARGE } from '../mock-cluster/fixtures/large.ts'
import { CONTEXTS, expect, hoverForTooltip, openCluster, rows, test } from './fixtures.ts'

const picker = (page: Page) => page.getByRole('button', { name: 'Namespace' })
const menu = (page: Page) => page.getByRole('dialog', { name: 'Namespaces' })
const find = (page: Page) => page.getByPlaceholder('Find a namespace…')
const box = (page: Page, name: string) => menu(page).getByRole('checkbox', { name, exact: true })
const address = (page: Page) => page.evaluate(() => decodeURIComponent(window.location.hash))
const go = (page: Page, to: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash
  }, to)

/** Adds a namespace from the keyboard: found by its name, then ⌘Enter (Ctrl+Enter off a Mac). */
async function add(page: Page, name: string) {
  await find(page).fill(name)
  await page.keyboard.press('ControlOrMeta+Enter')
}

/** The namespaces of a list's rows, each once, in name order. */
async function namespacesListed(page: Page, label: string, among: string[]) {
  const texts = await rows(page, label).allTextContents()
  return among.filter((name) => texts.some((text) => text.includes(name)))
}

test('several namespaces, picked and cleared from the keyboard: the list, the address and the button follow', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await picker(page).click()
  // Adding keeps the menu open, and the page follows at once.
  await add(page, 'shop')
  await expect(box(page, 'shop')).toHaveAttribute('aria-checked', 'true')
  await expect(find(page)).toHaveValue('shop')
  await add(page, 'data')
  await expect(menu(page)).toBeVisible()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods?namespaces=data,shop')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(picker(page)).toHaveText('data, shop')
  // Each namespace's list, read one at a time, and both in one list with their namespaces.
  await expect
    .poll(() => namespacesListed(page, 'Pods', ['data', 'default', 'kube-system', 'shop']))
    .toEqual(['data', 'shop'])
  const asked = clusters.demo.requests.map((request) => request.path)
  expect(asked).toContain('/api/v1/namespaces/shop/pods')
  expect(asked).toContain('/api/v1/namespaces/data/pods')

  // Three: counted, the tooltip naming them all; the picked first as the menu opens.
  await picker(page).click()
  await add(page, 'default')
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveText('3 namespaces')
  await hoverForTooltip(picker(page), 'datadefaultshop')
  await picker(page).click()
  const options = menu(page).getByRole('option')
  await expect(options.first()).toHaveText('All namespaces')
  expect((await options.allTextContents()).slice(1, 5)).toEqual([
    'data',
    'default',
    'shop',
    'argocd',
  ])
  // Taken away, it stays where it is while the menu is open.
  await box(page, 'default').click()
  await expect(box(page, 'default')).toHaveAttribute('aria-checked', 'false')
  await expect(options.nth(2)).toHaveText('default')
  await expect(picker(page)).toHaveText('data, shop')

  // Enter, or a click on the name, picks only that one and closes.
  await find(page).fill('batch')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await expect(picker(page)).toHaveText('batch')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods?namespaces=batch')
  // And Enter on All namespaces clears.
  await picker(page).click()
  await find(page).fill('all namespaces')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveText('All namespaces')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods')
})

test('Workloads and Events follow the picked namespaces, and say where they looked', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/events?namespaces=data,shop')
  await expect(picker(page)).toHaveText('data, shop')
  await expect
    .poll(() => namespacesListed(page, 'Events', ['data', 'default', 'kube-system', 'shop']))
    .toEqual(['data', 'shop'])
  const asked = () => clusters.demo.requests.map((request) => request.path)
  expect(asked()).toContain('/api/v1/namespaces/shop/events')
  expect(asked()).toContain('/api/v1/namespaces/data/events')
  // (The address stays as the pages change: what's picked is the cluster's, not the page's.)
  await go(page, '#/cluster/demo/workloads')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/workloads?namespaces=data,shop')
  await expect
    .poll(() => namespacesListed(page, 'Workloads', ['batch', 'data', 'kube-system', 'shop']))
    .toEqual(['data', 'shop'])
  // Two with nothing in them: said by name.
  await go(page, '#/cluster/demo/workloads?namespaces=nothing-here,nothing-else')
  await expect(page.getByText('No workloads in nothing-else and nothing-here')).toBeVisible()
  await go(page, '#/cluster/demo/workloads?namespaces=empty-a,empty-b,empty-c')
  await expect(page.getByText('No workloads in 3 namespaces')).toBeVisible()
})

test('a link picks what it names that are namespaces’ names, for that visit; what’s remembered stays', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  // Picked in the picker: remembered.
  await picker(page).click()
  await find(page).fill('default')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveText('default')
  // A link, with names that are namespaces' and others that aren't, which aren't asked for.
  const before = clusters.demo.requests.length
  await go(page, '#/cluster/demo/pods?namespaces=shop,DATA,..%2Fsecrets,a%20b,%3Cb%3E,data')
  await expect(picker(page)).toHaveText('data, shop')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods?namespaces=data,shop')
  const asked = clusters.demo.requests.slice(before).map((request) => request.path)
  expect(asked.filter((path) => /DATA|secrets|a b|<b>|%/.test(decodeURIComponent(path)))).toEqual(
    [],
  )
  await expect(page.getByText('DATA', { exact: true })).toHaveCount(0)
  // A link naming nothing that's a namespace's name picks nothing: what's remembered shows.
  await go(page, '#/cluster/demo/pods?namespaces=Shop,..')
  await expect(picker(page)).toHaveText('default')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods?namespaces=default')
  // Another cluster and back, fresh: what was remembered.
  await go(page, '#/cluster/sandbox')
  await expect(picker(page)).toBeVisible()
  await go(page, '#/cluster/demo/pods')
  await expect(picker(page)).toHaveText('default')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/pods?namespaces=default')
})

test('a remembered pick of names that aren’t namespaces’ opens where the cluster opens', async ({
  page,
}) => {
  // As a browser's storage might hold it: a name typed before names were held to the rule.
  await openCluster(page, CONTEXTS.large)
  await page.evaluate((context) => {
    const kept = JSON.parse(localStorage.getItem('lumovi:prefs')!)
    kept.state.namespaces[context] = ['Bad Name', 42]
    localStorage.setItem('lumovi:prefs', JSON.stringify(kept))
  }, CONTEXTS.large)
  await page.reload()
  await expect(picker(page)).toHaveText(LARGE.namespace)
})

test('at most 20: a link naming more picks the first 20 by name, and says so once', async ({
  page,
}) => {
  await openCluster(page)
  const names = Array.from({ length: 23 }, (_, i) => `team-${String(i + 1).padStart(2, '0')}`)
  await go(page, `#/cluster/demo/pods?namespaces=${[...names].reverse().join(',')}`)
  await expect(picker(page)).toHaveText('20 namespaces')
  await expect
    .poll(() => address(page))
    .toBe(`#/cluster/demo/pods?namespaces=${names.slice(0, 20).join(',')}`)
  await picker(page).click()
  await expect(
    menu(page).getByText('The link named 23 namespaces. The first 20, in name order, are picked.'),
  ).toBeVisible()
  await expect(
    menu(page).getByText('20 namespaces at most. Take one away to add another.'),
  ).toBeVisible()
  // (Not listed by the cluster: typed, as a link's are.)
  await expect(menu(page).getByRole('option', { name: 'team-01' })).toContainText('typed')
  // An unpicked one can't be added; one taken away makes room.
  await expect(box(page, 'shop')).toBeDisabled()
  await box(page, 'team-01').click()
  await expect(box(page, 'shop')).toBeEnabled()
  await box(page, 'shop').click()
  await expect(box(page, 'shop')).toHaveAttribute('aria-checked', 'true')
  // The link's line is said the first time only.
  await page.keyboard.press('Escape')
  await picker(page).click()
  await expect(menu(page).getByText(/The link named/)).toHaveCount(0)
})

test('someone who can’t list namespaces types them, and each is read on its own', async ({
  page,
  clusters,
}) => {
  // Access to some namespaces, not to the cluster: no namespaces listed, no list across them all.
  clusters.demo.fail('/api/v1/namespaces', { status: 403 })
  clusters.demo.fail('/api/v1/pods', { status: 403 })
  await openCluster(page)
  await go(page, '#/cluster/demo/pods')
  await picker(page).click()
  await expect(
    menu(page).getByText('Namespaces couldn’t be listed. Type a name to use it.'),
  ).toBeVisible()
  await find(page).fill('shop')
  await expect(menu(page).getByRole('option', { name: 'Use namespace “shop”' })).toBeVisible()
  // ⌘Enter adds it, and the field empties for the next.
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(find(page)).toHaveValue('')
  await expect(box(page, 'shop')).toHaveAttribute('aria-checked', 'true')
  await expect(menu(page).getByRole('option', { name: 'shop' })).toContainText('typed')
  await add(page, 'data')
  await find(page).fill('')
  await expect(box(page, 'data')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveText('data, shop')
  await expect
    .poll(() => namespacesListed(page, 'Pods', ['data', 'default', 'shop']))
    .toEqual(['data', 'shop'])
  // Only a name a namespace could have is offered: two at once, or one with a space, isn't. (Text
  // no row matches: ⌘Enter on a row it does match takes that row away.)
  await picker(page).click()
  for (const [notAName, said] of [
    ['shop,data', /^Type one namespace at a time\. (⌘|Ctrl)↵ adds it and keeps the menu open\.$/],
    [
      'Batch',
      /^A namespace’s name is lowercase letters, digits and hyphens, 63 at most, starting and ending with a letter or a digit\.$/,
    ],
  ] as const) {
    await find(page).fill(notAName)
    await expect(menu(page).getByRole('option', { name: /^Use namespace/ })).toHaveCount(0)
    await expect(menu(page).getByText(said)).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Enter')
  }
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveText('data, shop')
  // Enter on a typed name uses it alone, as it always has.
  await picker(page).click()
  await find(page).fill('batch')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveText('batch')
})

test('the palette picks one namespace, or clears, and checks what’s picked', async ({ page }) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=data,shop')
  await expect(picker(page)).toHaveText('data, shop')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('namespace')
  const option = (name: string) => page.getByRole('option', { name: new RegExp(`^${name}`) })
  await expect(option('shop').locator('.text-accent')).toHaveCount(1)
  await expect(option('default').locator('.text-accent')).toHaveCount(0)
  await option('default').click()
  await expect(picker(page)).toHaveText('default')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('all namespaces')
  await option('All namespaces').click()
  await expect(picker(page)).toHaveText('All namespaces')
})

test('a picked namespace that can’t be read is said, and the rest are shown', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail('/api/v1/namespaces/data/pods', { status: 403 })
  clusters.demo.fail('/api/v1/namespaces/legacy/pods', { status: 404 })
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=data,shop')
  await expect(
    page.getByText('Pods in data aren’t shown: your account isn’t allowed to list them there.'),
  ).toBeVisible()
  await expect
    .poll(() => namespacesListed(page, 'Pods', ['data', 'default', 'shop']))
    .toEqual(['shop'])
  // Two, for two reasons: counted, each named with its reason.
  await go(page, '#/cluster/demo/pods?namespaces=data,legacy,shop')
  const line = page.getByText('Pods in 2 of the picked namespaces aren’t shown.')
  await hoverForTooltip(
    line,
    'data: your account isn’t allowed to list pods therelegacy: isn’t there any more',
  )
  // Nothing in what was read: the page says where it looked, not where it couldn't.
  clusters.demo.fail('/api/v1/namespaces/shop/pods', {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: {}, items: [] }),
  })
  await go(page, '#/cluster/demo/pods?namespaces=data,shop')
  await expect(page.getByRole('heading', { name: 'No pods in shop' })).toBeVisible()
  await expect(
    page.getByText('Pods in data aren’t shown: your account isn’t allowed to list them there.'),
  ).toBeVisible()
  // And when none can be read, the page's error, as for one.
  await go(page, '#/cluster/demo/pods?namespaces=data,legacy')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

test('several namespaces are read five at a time, the rest waiting their turn', async ({
  page,
  clusters,
}) => {
  const team = /^\/api\/v1\/namespaces\/team-\d+\/pods$/
  clusters.demo.fail(team, { delayMs: 400 })
  await openCluster(page)
  const names = Array.from({ length: 12 }, (_, i) => `team-${String(i + 1).padStart(2, '0')}`)
  const before = clusters.demo.requests.length
  await go(page, `#/cluster/demo/pods?namespaces=${names.join(',')}`)
  await expect(picker(page)).toHaveText('12 namespaces')
  await expect
    .poll(() => clusters.demo.requests.slice(before).filter((r) => team.test(r.path)).length)
    .toBeGreaterThanOrEqual(12)
  // When each of the first twelve arrived. (By arrivals alone: when an answer is counted as
  // sent, on a slow runner, can be later than the client had it and asked again.)
  const arrived = clusters.demo.requests
    .slice(before)
    .filter((request) => team.test(request.path))
    .slice(0, 12)
    .map((request) => request.at!)
    .sort((a, b) => a - b)
  // Five at a time, each answered 400 ms or more after it came: a read can come only once one
  // of the five before it was answered, so 400 ms at least after the fifth before it. (Less a
  // little, as a timer may round.)
  for (let i = 5; i < arrived.length; i++) {
    expect(arrived[i]! - arrived[i - 5]!, `read ${i + 1}`).toBeGreaterThanOrEqual(380)
  }
  // And not one at a time: the first two together.
  expect(arrived[1]! - arrived[0]!).toBeLessThan(400)
})
