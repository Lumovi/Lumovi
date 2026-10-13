/**
 * A list's saved views: what it shows (its filter, health, labels, sort, columns and namespaces)
 * saved under a name and opened again as it was, never changing the cluster's own namespaces;
 * "changed" once it's no longer that, and saved again; renamed in place, moved, deleted with an
 * undo; a taken name and the caps refused in Lumovi's words; and in the palette.
 */
import type { Page } from '@playwright/test'
import { toasts } from './action-helpers.ts'
import { expect, openCluster, rows, test } from './fixtures.ts'

const go = (page: Page, to: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash
  }, to)
const views = (page: Page) => page.getByRole('button', { name: /^Views\b/ })
const menu = (page: Page) => page.getByRole('dialog', { name: 'Views' })
const saved = (page: Page) =>
  menu(page).getByRole('list', { name: 'Saved views' }).getByRole('listitem')
const header = (page: Page, name: string) =>
  page.getByRole('grid', { name: 'Pods' }).getByRole('columnheader', { name, exact: true })
const filter = (page: Page) => page.getByPlaceholder(/^Filter/)
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })

/** What the desktop app remembers of a cluster's namespaces, as it keeps it. */
const remembered = (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('lumovi:prefs')!) as { state: { namespaces: object } }).state
        .namespaces,
  )

/** Saves what the list shows as a view of that name, and closes the menu. */
async function saveView(page: Page, name: string) {
  await views(page).click()
  await menu(page).getByRole('button', { name: 'Save view…' }).click()
  await menu(page).getByPlaceholder('Name this view').fill(name)
  await page.keyboard.press('Enter')
  await expect(views(page)).toHaveAccessibleName(`Views: ${name}`)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
}

/** Opens a view's "…" and chooses one of its items. */
async function more(page: Page, view: string, item: string) {
  await menu(page)
    .getByRole('button', { name: `More for the view “${view}”` })
    .click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test('what a list shows is saved as a view, and opened again as it was, the cluster’s own namespaces kept', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  const before = await remembered(page)
  await filter(page).fill('checkout')
  await header(page, 'Restarts').getByRole('button').click()
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Columns' })
    .getByRole('checkbox', { name: /^Node/ })
    .click()
  await page.keyboard.press('Escape')
  await expect(header(page, 'Node')).toHaveCount(0)

  await views(page).click()
  await expect(menu(page)).toContainText(
    'No saved views. Save what this list shows to come back to it.',
  )
  await menu(page).getByRole('button', { name: 'Save view…' }).click()
  await expect(menu(page)).toContainText(
    'Keeps what this list shows now: its filter, health, labels, sort, columns and namespaces.',
  )
  await menu(page).getByPlaceholder('Name this view').fill('Crashing checkout')
  await page.keyboard.press('Enter')
  await expect(views(page)).toHaveAccessibleName('Views: Crashing checkout')
  await expect(saved(page)).toHaveCount(1)
  await expect(
    saved(page).getByRole('button', { name: 'Crashing checkout', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')

  // The list afresh, as the cluster has it: no view, its own columns kept as chosen.
  await go(page, '#/cluster/demo/nodes')
  await expect(page.getByRole('grid', { name: 'Nodes' })).toBeVisible()
  await go(page, '#/cluster/demo/pods')
  await expect(views(page)).toHaveAccessibleName('Views')
  await expect(filter(page)).toHaveValue('')
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  await page.getByRole('dialog', { name: 'Columns' }).getByRole('button', { name: 'Reset' }).click()
  await page.keyboard.press('Escape')
  await expect(header(page, 'Node')).toHaveCount(1)

  // Opened: as it was saved, its namespaces in the address only.
  await views(page).click()
  await saved(page).getByRole('button', { name: 'Crashing checkout', exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(views(page)).toHaveAccessibleName('Views: Crashing checkout')
  await expect(filter(page)).toHaveValue('checkout')
  await expect(header(page, 'Node')).toHaveCount(0)
  await expect(header(page, 'Restarts')).toHaveAttribute('aria-sort', /ending$/)
  await expect(page).toHaveURL(/[?&]namespaces=shop(&|$)/)
  expect(await remembered(page)).toEqual(before)

  // Changed, it says so, and its changes can be saved to it.
  await filter(page).fill('check')
  await expect(views(page)).toHaveAccessibleName('Views: Crashing checkout · changed')
  await views(page).click()
  await menu(page).getByRole('button', { name: 'Save changes to “Crashing checkout”' }).click()
  await expect(views(page)).toHaveAccessibleName('Views: Crashing checkout')
  await expect(menu(page).getByRole('button', { name: /^Save changes/ })).toHaveCount(0)
})

test('a view is renamed in place, moved and deleted with an undo; a name its kind has is refused', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await filter(page).fill('cart')
  await saveView(page, 'One')
  await filter(page).fill('redis')
  await saveView(page, 'Two')

  // A name the kind's views have.
  await views(page).click()
  await menu(page).getByRole('button', { name: 'Save view…' }).click()
  await menu(page).getByPlaceholder('Name this view').fill('One')
  await page.keyboard.press('Enter')
  await expect(menu(page).getByRole('alert')).toHaveText(
    'There’s already a view of pods called “One”.',
  )
  // Escape lets go of the name, not the menu.
  await page.keyboard.press('Escape')
  await expect(menu(page).getByPlaceholder('Name this view')).toHaveCount(0)
  await expect(menu(page)).toBeVisible()

  // Renamed in place, its name chosen to type over; the open view's new name is the address's.
  await more(page, 'Two', 'Rename')
  const field = menu(page).getByRole('textbox', { name: 'Rename the view “Two”' })
  await expect(field).toHaveValue('Two')
  await page.keyboard.type('One')
  await page.keyboard.press('Enter')
  await expect(menu(page).getByRole('alert')).toHaveText(
    'There’s already a view of pods called “One”.',
  )
  await field.fill('Redis')
  await page.keyboard.press('Enter')
  await expect(views(page)).toHaveAccessibleName('Views: Redis')
  await expect(page).toHaveURL(/[?&]view=Redis(&|$)/)
  await expect(saved(page)).toHaveText(['One', 'Redis'])

  // Moved up; the first can't go further.
  await more(page, 'Redis', 'Move up')
  await expect(saved(page)).toHaveText(['Redis', 'One'])
  await menu(page).getByRole('button', { name: 'More for the view “Redis”' }).click()
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await page.keyboard.press('Escape')

  // Deleted at once, with an undo that puts it back in its place.
  await more(page, 'Redis', 'Delete')
  await expect(saved(page)).toHaveText(['One'])
  await expect(toasts(page)).toContainText('Deleted the view “Redis”')
  await page.keyboard.press('Escape')
  await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
  await views(page).click()
  await expect(saved(page)).toHaveText(['Redis', 'One'])
})

test('the palette has the list’s views first, and every kind’s once something’s typed', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/deployments?namespaces=shop')
  await expect(rows(page, 'Deployments').first()).toBeVisible()
  await filter(page).fill('cart')
  await saveView(page, 'The cart')
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await filter(page).fill('redis')
  await saveView(page, 'Redis pods')
  await go(page, '#/cluster/demo/pods')
  await expect(views(page)).toHaveAccessibleName('Views')

  await page.keyboard.press('ControlOrMeta+k')
  const group = (name: string) =>
    palette(page).getByRole('group', { name, exact: true }).getByRole('option')
  await expect(group('Views of Pods')).toHaveText(['Redis podsPods'])
  await expect(group('Views')).toHaveCount(0)
  await page.keyboard.type('cart')
  await expect(group('Views')).toHaveText(['The cartDeployments'])
  await group('Views').first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deployments')
  await expect(views(page)).toHaveAccessibleName('Views: The cart')
  await expect(filter(page)).toHaveValue('cart')
})

test('twenty views of a kind and fifty of a cluster are the most, each said in Lumovi’s words', async ({
  page,
}) => {
  await openCluster(page)
  const seed = (views: { name: string; kind: string }[]) =>
    page.evaluate((views) => {
      const kept = JSON.parse(localStorage.getItem('lumovi:prefs')!) as {
        state: { marks: Record<string, unknown> }
      }
      kept.state.marks = { demo: { pins: [], views } }
      localStorage.setItem('lumovi:prefs', JSON.stringify(kept))
    }, views)
  const named = (kind: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `${kind} ${i + 1}`, kind }))
  const save = () => menu(page).getByRole('button', { name: 'Save view…' })

  await seed(named('Pod', 20))
  await page.reload()
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await views(page).click()
  await expect(saved(page)).toHaveCount(20)
  await expect(save()).toBeDisabled()
  await expect(menu(page)).toContainText(
    '20 views of pods are saved, the most there can be. Delete one to save this.',
  )
  await page.keyboard.press('Escape')

  await seed([...named('Deployment', 20), ...named('Service', 20), ...named('Node', 10)])
  await page.reload()
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await views(page).click()
  await expect(save()).toBeDisabled()
  await expect(menu(page)).toContainText(
    '50 views of this cluster are saved, the most there can be. Delete one to save this.',
  )
})
