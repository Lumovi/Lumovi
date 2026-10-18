/**
 * Search (LMV-171): any object of a kind the person may list, by part of its name or by its
 * labels, grouped by kind with its status, in the namespaces picked; a large kind read only so
 * far, and said so; saved searches a keystroke away; and the palette finding objects as you type.
 */
import type { Page } from '@playwright/test'
import { holds } from '../holds.ts'
import { toasts } from './action-helpers.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'

async function openSearch(page: Page, context: string = CONTEXTS.demo) {
  await page.evaluate(
    (context) => (location.hash = `#/cluster/${encodeURIComponent(context)}/search`),
    context,
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search')
}

const field = (page: Page) => page.getByRole('textbox', { name: 'Search the cluster' })
const group = (page: Page, label: string) =>
  page.getByRole('table', { name: 'Found' }).getByRole('rowgroup', { name: label, exact: true })
const said = (page: Page) => page.getByRole('main').getByRole('status').first()

test('any listed kind is found by part of its name, grouped by kind with its status, and opens beside', async ({
  page,
  clusters,
}) => {
  clusters.demo.deny({ verb: 'list', resource: 'secrets' })
  await openCluster(page)
  await openSearch(page)
  // The field has the keyboard; before typing, what can be typed.
  await expect(field(page)).toBeFocused()
  await expect(page.getByRole('region', { name: 'What you can type' })).toContainText('team=*')

  await field(page).fill('checkout')
  await expect(said(page)).toContainText(/objects? in \d+ kinds?/)
  const deployments = group(page, 'Deployments')
  await expect(deployments.getByRole('row').filter({ hasText: /^checkout/ })).toHaveCount(1)
  await expect(deployments.locator('[data-health]')).toHaveCount(1)
  await expect(group(page, 'Pods').getByRole('row')).toHaveCount(1 + 3)
  await expect(group(page, 'Pods')).toContainText('restarts')
  await expect(group(page, 'Service Accounts')).toContainText('checkout')
  // What was searched, and what wasn't: the kinds the person's access doesn't list.
  await expect(page.getByRole('main')).toContainText('Searched')
  await expect(page.getByRole('main')).toContainText(
    'Not searched: Secrets, which your access doesn’t list.',
  )
  // A row opens beside, as a list's does.
  await deployments
    .getByRole('row')
    .filter({ hasText: /^checkout/ })
    .click()
  await expect(panel(page, 'Deployment', 'checkout')).toBeVisible()
  await page.keyboard.press('Escape')

  // Several words, each marked; one found; a DaemonSet's and a StatefulSet's readiness.
  await field(page).fill('')
  await field(page).pressSequentially('jzhdh hqnnn')
  await field(page).press('Enter')
  await expect(group(page, 'Pods').locator('mark')).toHaveCount(2)
  await field(page).fill('node-exporter')
  await field(page).press('Enter')
  await expect(group(page, 'DaemonSets')).toContainText('ready')
  await field(page).fill('checkout-canary')
  await field(page).press('Enter')
  await expect(said(page)).toContainText(/^1object in 1 kind/)
  await field(page).fill('redis')
  await field(page).press('Enter')
  await expect(group(page, 'StatefulSets')).toContainText('ready')
  // Cleared: what can be typed again.
  await field(page).fill('')
  await expect(page.getByRole('region', { name: 'What you can type' })).toBeVisible()

  // Nothing found: said, with where it looked.
  await field(page).fill('checout')
  await field(page).press('Enter')
  await expect(page.getByText('No object’s name has “checout”.')).toBeVisible()

  // Namespaces picked: only those, and kinds outside namespaces not at all.
  await page.evaluate(() => (location.hash = '#/cluster/demo/search?q=checkout&namespaces=batch'))
  await expect(page.getByText('No object’s name has “checkout”.')).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'Kinds outside namespaces are searched with All namespaces.',
  )
})

test('labels: each term must match, a label key with any value or none, and the labels that matched shown', async ({
  page,
}) => {
  await openCluster(page)
  await openSearch(page)
  await field(page).fill('app.kubernetes.io/name=checkout')
  await field(page).press('Enter')
  const deployments = group(page, 'Deployments')
  await expect(deployments).toContainText('app.kubernetes.io/name=checkout')
  await expect(page.getByRole('columnheader', { name: 'Labels' })).toBeVisible()
  // Nothing with them.
  await field(page).fill('app.kubernetes.io/name=nothing-is-called-this')
  await field(page).press('Enter')
  await expect(
    page.getByText('Nothing has the labels app.kubernetes.io/name=nothing-is-called-this.'),
  ).toBeVisible()
  // With a part of a name too: both must match.
  await field(page).fill('cart app.kubernetes.io/name=checkout')
  await field(page).press('Enter')
  await expect(page.getByText('No object’s name has “cart” with the labels')).toBeVisible()
  // Has it, any value; and doesn't have it.
  await field(page).fill('checkout app.kubernetes.io/part-of=*')
  await field(page).press('Enter')
  await expect(group(page, 'Deployments')).toContainText('checkout')
  await field(page).fill('checkout !app.kubernetes.io/part-of tier!=db')
  await field(page).press('Enter')
  await expect(group(page, 'Deployments')).toHaveCount(0)
})

test('a saved search is a keystroke away, in the palette too, and removed with Undo', async ({
  page,
}) => {
  await openCluster(page)
  await openSearch(page)
  await field(page).fill('checkout')
  await field(page).press('Enter')
  await page.getByRole('button', { name: 'Save this search' }).click()
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const strip = page.getByRole('list', { name: 'Saved searches' })
  await expect(strip).toContainText('checkout')

  // ⌥⇧1 from anywhere nothing is being typed: the search, run in the cluster open.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit1' : 'Alt+Shift+Digit1',
  )
  await expect(field(page)).toHaveValue('checkout')
  await expect(group(page, 'Deployments')).toBeVisible()
  // Not while a field has the keyboard.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await page.getByPlaceholder('Filter pods').focus()
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit1' : 'Alt+Shift+Digit1',
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')

  // The palette, before typing: saved searches first, each its key; only a number it has.
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette.getByRole('group', { name: 'Saved searches' })).toContainText('checkout')
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit2' : 'Alt+Shift+Digit2',
  )
  await expect(palette).toBeVisible()
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit1' : 'Alt+Shift+Digit1',
  )
  await expect(palette).toHaveCount(0)
  await expect(field(page)).toHaveValue('checkout')

  // Typed, and within the moment typing waits, a saved search run: the saved search, not what
  // was typed, is what's searched, and stays.
  await page.evaluate(() => (location.hash = '#/cluster/demo/search?q=redis'))
  await expect(field(page)).toHaveValue('redis')
  await field(page).fill('checout')
  await page.getByRole('main').getByRole('columnheader', { name: 'Name', exact: true }).click()
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit1' : 'Alt+Shift+Digit1',
  )
  await expect(field(page)).toHaveValue('checkout')
  const address = () => page.evaluate(() => location.hash)
  await holds(
    async () =>
      (await address()).includes('q=checkout') && (await field(page).inputValue()) === 'checkout',
    600,
    'the saved search stays, not what was typed',
  )
  // And ↵, then another search by its address within that moment: the address's stays.
  await field(page).fill('checout')
  await field(page).press('Enter')
  await expect.poll(address).toContain('q=checout')
  await page.evaluate(() => (location.hash = '#/cluster/demo/search?q=redis'))
  await expect(field(page)).toHaveValue('redis')
  await holds(
    async () =>
      (await address()).includes('q=redis') && (await field(page).inputValue()) === 'redis',
    600,
    'the address’s search stays, not what was typed before it',
  )

  // Ctrl+Shift and a digit that types the digit (AZERTY's layouts) isn't the Go menu's Ctrl+1.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true }),
    ),
  )
  // (On Windows it's the first saved search's key, and that's what runs.)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    process.platform === 'win32' ? 'Search' : 'Pods',
  )

  // A key with no saved search for it does nothing.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press(
    process.platform === 'win32' ? 'Control+Shift+Digit5' : 'Alt+Shift+Digit5',
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')

  // Another saved; before typing, the page lists them with their keys.
  await page.evaluate(() => (location.hash = '#/cluster/demo/search?q=redis'))
  await page.getByRole('button', { name: 'Save this search' }).click()
  await field(page).fill('')
  const before = page.getByRole('region', { name: 'Saved searches' })
  await expect(before).toContainText('checkout')
  await expect(before).toContainText('redis')
  await expect(before.locator('kbd')).not.toHaveCount(0)

  // Removed, with Undo: the later ones move up a key, and its toast says so.
  await before.getByRole('button', { name: 'Remove the saved search checkout' }).click()
  await expect(toasts(page)).toContainText('Removed checkout')
  await expect(toasts(page)).toContainText('Saved search 2 is now')
  await expect(before).not.toContainText('checkout')
  await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
  await expect(before).toContainText('checkout')
  // Delete on a chip's × removes it too.
  await field(page).fill('redis')
  await field(page).press('Enter')
  await strip.getByRole('button', { name: 'Remove the saved search redis' }).focus()
  await page.keyboard.press('Delete')
  await expect(strip).not.toContainText('redis')

  // Past what can be kept, Save isn't offered, and says why.
  await field(page).fill(`checkout ${'x'.repeat(200)}`)
  await field(page).press('Enter')
  await expect(page.getByRole('button', { name: 'Save this search' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save this search' })).toHaveAttribute(
    'title',
    'A saved search is at most 200 characters.',
  )
  await page.evaluate(() =>
    window.lumovi!.app.setPreferences({
      searches: Array.from({ length: 50 }, (_, i) => `search-${i}`),
    }),
  )
  await field(page).fill('redis')
  await field(page).press('Enter')
  await expect(page.getByRole('button', { name: 'Save this search' })).toHaveAttribute(
    'title',
    '50 searches are saved, the most there can be. Remove one to save this.',
  )
})

test('the palette finds the cluster’s objects as you type, ⌘↵ searches the cluster, and ⌘⇧F opens Search', async ({
  page,
}) => {
  await openCluster(page)
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('checkout')
  const objects = palette.getByRole('group', { name: 'Objects' })
  await expect(
    objects.getByRole('option').filter({ hasText: 'Deployment · shop' }).first(),
  ).toBeVisible()
  await expect(objects.getByRole('option', { name: 'Search the cluster' })).toContainText(
    /\d+ found/,
  )
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(palette).toHaveCount(0)
  await expect(field(page)).toHaveValue('checkout')

  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search')
  await expect(field(page)).toBeFocused()
  // On Search already: its field again, its text selected.
  await field(page).fill('checkout')
  await page.getByRole('main').getByRole('columnheader', { name: 'Name', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(field(page)).toBeFocused()
  // On the start screen there's no cluster to search.
  await page.evaluate(() => (location.hash = '#/'))
  await expect(page.getByRole('combobox', { name: 'Clusters' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(page.getByRole('combobox', { name: 'Clusters' })).toBeVisible()
})

test('a kind past what Lumovi reads at once is said so, and a label reaches all of it, on 2,500 pods', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_MAX_LIST_ITEMS: '1000' } })
  await openCluster(page, CONTEXTS.large)
  await openSearch(page, CONTEXTS.large)
  const typed = Date.now()
  await field(page).fill('load-')
  await field(page).press('Enter')
  const pods = group(page, 'Pods')
  await expect(pods).toContainText('Searched the first 1,000 of 2,500')
  // (The first answer in good time, and the field never held up.)
  expect(Date.now() - typed).toBeLessThan(10_000)
  await expect(page.getByRole('main')).toContainText(
    'Pods: 2,500 is more than Lumovi reads at once, so 1,500 weren’t searched by name.',
  )
  await pods.getByRole('button', { name: 'Show all 1,000' }).click()
  await expect(pods.getByRole('row')).toHaveCount(1 + 1000)
  // A label that matches fewer: asked of the cluster by it, so all of them are searched.
  await field(page).fill('shard=3')
  await field(page).press('Enter')
  await expect(pods).toContainText('250')
  await expect(pods).not.toContainText('Searched the first')
  // One that matches them all: cut short again, and the cluster says no total.
  await field(page).fill('app.kubernetes.io/name=load')
  await field(page).press('Enter')
  await expect(pods).toContainText('Searched the first 1,000: there are more')
})

test('Stop lets go of the kinds still read; a kind that doesn’t answer in time is given up on, with Retry', async ({
  page,
  clusters,
}) => {
  clusters.demo.slowLists('services', 12_000)
  await openCluster(page)
  await openSearch(page)
  await field(page).fill('checkout')
  await field(page).press('Enter')
  await page.getByRole('main').getByRole('button', { name: 'Stop' }).click()
  const stopped = page.getByText(/Stopped before .*Services/)
  await expect(stopped).toBeVisible()
  // Searched again, and still not answering: given up on after a while.
  await stopped.getByRole('button', { name: 'Search them' }).click()
  await expect(page.getByRole('main')).toContainText('Searching')
  const late = page.getByText('Services didn’t answer in time')
  await expect(late).toBeVisible({ timeout: 15_000 })
  clusters.demo.slowLists('services')
  await late.getByRole('button', { name: 'Retry' }).click()
  await expect(group(page, 'Services')).toContainText('checkout')
})
