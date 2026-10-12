/**
 * The kit's Table, on the page the tests' build has for the kit's parts: the cases that break a
 * table first, as design drew them.
 */
import type { Page } from '@playwright/test'
import { expect, openCluster, test } from './fixtures.ts'

async function kit(page: Page) {
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/kit'
  })
  await expect(page.getByRole('grid', { name: 'Certificates' })).toBeVisible()
}

/** The rows' names, whole (a cut name is all there for a screen reader), top to bottom. */
const names = (page: Page, table: string) =>
  page
    .getByRole('grid', { name: table })
    .getByRole('row')
    .evaluateAll((rows) =>
      rows.slice(1).map((row) => row.querySelector('.font-medium > span')?.textContent ?? ''),
    )

test('a table’s rows: what each is called, columns from one scale, and a name that keeps its end', async ({
  page,
}) => {
  await kit(page)
  // Named for a screen reader: the table, its headings (said even where none show), each cell.
  const pools = page.getByRole('grid', { name: 'Node pools' })
  await expect(pools.getByRole('columnheader')).toHaveText([
    'Name',
    'Nodes',
    'CPU',
    'Status',
    'Age',
  ])
  const general = pools.getByRole('row').filter({ hasText: 'general' })
  await expect(general).toContainText('On demand and spot')
  await expect(general).toContainText('7 nodes')
  await expect(general.getByRole('meter', { name: 'CPU: 24 of 64 cores' })).toBeVisible()
  await expect(general).toContainText('Ready')
  await expect(general).toContainText('41d')
  // A meter with no limit has no bar to read, and says so in its words.
  await expect(pools.getByRole('row').filter({ hasText: 'gpu' })).toContainText('no limit')
  // Every row's columns start where the others' do: one grid for all of them.
  const lefts = await pools
    .getByRole('row')
    .evaluateAll((rows) =>
      rows
        .slice(1)
        .map((row) =>
          [...row.children]
            .slice(0, 5)
            .map((cell) => Math.round(cell.getBoundingClientRect().left)),
        ),
    )
  expect(new Set(lefts.map((row) => row.join(','))).size).toBe(1)

  // The longest name loses its middle and keeps its end; whole in its title.
  const long = 'worker-eu-west-1a-m6i-2xlarge-on-demand-7f3a9c2d-b1e4-1c9aa7'
  const nodes = page.getByRole('grid', { name: 'Nodes' })
  await expect(nodes.getByTitle(long).locator('[aria-hidden]')).toHaveText(/^worker-eu-\S+…1c9aa7$/)
  // A row's last cell may take the rest of the row.
  await expect(nodes.getByRole('row').filter({ hasText: 'worker-2' })).toContainText(
    'Ready · 4 cores',
  )
  // A note runs under the whole row, two lines at most.
  const note = page
    .getByRole('grid', { name: 'Waiting for a node' })
    .getByText(/^0\/9 nodes are available: 3 Insufficient memory/)
  const lines = await note.evaluate(
    (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
  )
  expect(Math.round(lines)).toBe(2)
  // A row with a cell more than there are columns is drawn by its columns: the rest isn't shown.
  const waiting = page.getByRole('grid', { name: 'Waiting for a node' })
  await expect(waiting.getByRole('row').filter({ hasText: 'reports-nightly-28931' })).toContainText(
    '0/9 nodes are available: 9 Insufficient cpu.',
  )
  await expect(page.getByText('one cell too many')).toHaveCount(0)
  // A screen reader is told of the rows it can reach: a group's heading isn't counted as one.
  await expect(page.getByRole('grid', { name: 'Resources' })).toHaveAttribute('aria-rowcount', '6')
})

test('a table’s keys are those of Lumovi’s own lists; a status sorts worst first', async ({
  page,
}) => {
  await kit(page)
  const certificates = page.getByRole('grid', { name: 'Certificates' })
  const active = () =>
    certificates.evaluate((grid) => {
      const id = grid.getAttribute('aria-activedescendant')
      return id ? (document.getElementById(id)?.textContent ?? '') : ''
    })
  // One stop: Tab lands on the rows, with the first of them active.
  await certificates.focus()
  await expect.poll(active).toContain('api-tls')
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('payments-tls')
  await page.keyboard.press('j')
  await expect.poll(active).toContain('grafana-tls')
  await page.keyboard.press('k')
  await expect.poll(active).toContain('payments-tls')
  await page.keyboard.press('End')
  await expect.poll(active).toContain('storefront-tls')
  await page.keyboard.press('Home')
  await expect.poll(active).toContain('api-tls')
  await page.keyboard.press('PageDown')
  await expect.poll(active).toContain('storefront-tls')
  await page.keyboard.press('PageUp')
  await expect.poll(active).toContain('api-tls')
  // Nothing is picked here, and the table is never paged: these do nothing.
  for (const key of ['x', 'ArrowRight', 'ArrowLeft', 'Escape']) await page.keyboard.press(key)
  await expect.poll(active).toContain('api-tls')
  // Space is no row's key: it opens nothing and the active row stays where it is.
  const pressed = page.getByRole('list', { name: 'What was pressed' })
  await page.keyboard.press('Space')
  await expect.poll(active).toContain('api-tls')
  await expect(pressed.getByRole('listitem')).toHaveCount(0)
  // Enter opens the row, as a click anywhere on it does.
  await page.keyboard.press('Enter')
  // (Lumovi opens the object itself, by the reference it was given; whoever described the table
  // is told which row.)
  await expect(pressed).toContainText(
    'Certificates: go {"kind":"Certificate.cert-manager.io","name":"api-tls","namespace":"platform"}',
  )
  await expect(pressed).toContainText('Certificates: open {"row":"platform/api-tls"}')
  await certificates.getByRole('row').filter({ hasText: 'grafana-tls' }).click()
  await expect(pressed).toContainText('Certificates: open {"row":"monitoring/grafana-tls"}')

  // The headings that sort are stops after the rows: Tab goes from the table to the first.
  await certificates.focus()
  await page.keyboard.press('Tab')
  await expect(certificates.getByRole('button', { name: 'Name' })).toBeFocused()
  // A first press sorts ascending, with the arrow Lumovi's lists have for it.
  await page.keyboard.press('Enter')
  await expect(certificates.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await expect
    .poll(() => names(page, 'Certificates'))
    .toEqual(['api-tls', 'grafana-tls', 'payments-tls', 'storefront-tls'])
  await page.keyboard.press('Tab')
  await expect(certificates.getByRole('button', { name: 'Status' })).toBeFocused()
  // A status sorts by its level and not its word, and its first sort is the worst first:
  // descending; again, and it's the other way.
  await page.keyboard.press('Enter')
  await expect(certificates.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  await expect(certificates.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute(
    'aria-sort',
  )
  await expect
    .poll(() => names(page, 'Certificates'))
    .toEqual(['payments-tls', 'storefront-tls', 'api-tls', 'grafana-tls'])
  // The active row is still the one it was, wherever sorting put it.
  await expect.poll(active).toContain('grafana-tls')
  await page.keyboard.press('Space')
  await expect(certificates.getByRole('columnheader', { name: 'Status' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await expect.poll(async () => (await names(page, 'Certificates')).at(-1)).toBe('payments-tls')
  // A moment sorts by the moment: what renews soonest, first. Nothing to renew is last,
  // whichever way the rest is sorted.
  await certificates.getByRole('button', { name: 'Renews' }).click()
  await expect
    .poll(() => names(page, 'Certificates'))
    .toEqual(['storefront-tls', 'api-tls', 'grafana-tls', 'payments-tls'])
  await certificates.getByRole('button', { name: 'Renews' }).click()
  await expect
    .poll(() => names(page, 'Certificates'))
    .toEqual(['grafana-tls', 'api-tls', 'storefront-tls', 'payments-tls'])
  // A table without headings has none to press, and its rows open nothing.
  await expect(page.getByRole('grid', { name: 'Node pools' }).getByRole('button')).toHaveCount(0)
})

test('groups, rows that hold rows, and the rows that wait behind “Show all”', async ({ page }) => {
  await kit(page)
  const resources = page.getByRole('grid', { name: 'Resources' })
  const section = page.getByRole('region', { name: 'Resources table' })
  // How many show, of how many: counted in rows at the top level.
  await expect(section).toContainText('5 of 23')
  await expect(resources.getByRole('heading', { name: /^Workloads/ })).toContainText('3')
  await expect(resources.getByRole('heading', { name: /^Network/ })).toContainText('20')
  await expect(resources.getByRole('row')).toHaveCount(6)
  // A group's heading is not a stop: down from the last workload goes to the first of Network.
  const active = () =>
    resources.evaluate(
      (grid) =>
        document.getElementById(grid.getAttribute('aria-activedescendant') ?? '')?.textContent ??
        '',
    )
  await resources.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('cart')
  // Right opens a row that holds rows, and they're rows like any other; left closes it.
  await page.keyboard.press('ArrowRight')
  await expect(resources.getByRole('row').filter({ hasText: 'cart' }).first()).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(resources.getByRole('row').filter({ hasText: 'CrashLoopBackOff' })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('cart-6c9d7f5b44-8xk2p')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowLeft')
  await expect(resources.getByRole('row').filter({ hasText: 'CrashLoopBackOff' })).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('storefrontService')
  // Its chevron does the same for a pointer.
  await resources.getByRole('button', { name: 'Open storefront' }).first().click()
  await expect(
    resources.getByRole('row').filter({ hasText: 'storefront-7d9f8c6b5-2xk4p' }),
  ).toBeVisible()
  // "Show all" opens the rest in place, and is a button after the rows.
  await section.getByRole('button', { name: 'Show all 23' }).click()
  await expect(section).not.toContainText('5 of 23')
  await expect(resources.getByRole('row').filter({ hasText: 'route-18' })).toBeVisible()
  await expect(section.getByRole('button', { name: /^Show all/ })).toHaveCount(0)
})

test('nothing to list: busy, failed, empty and quiet, each in its own words', async ({ page }) => {
  await kit(page)
  await expect(
    page
      .getByRole('region', { name: 'Loading certificates' })
      .getByRole('status', { name: 'Loading' }),
  ).toBeVisible()
  const failed = page.getByRole('region', { name: 'Forbidden certificates' })
  await expect(failed.getByRole('alert')).toContainText('Couldn’t list certificates')
  await expect(failed).toContainText(
    'certificates.cert-manager.io is forbidden for jane@example.com in shop.',
  )
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('list', { name: 'What was pressed' })).toContainText(
    'Forbidden certificates: retry {}',
  )
  await expect(page.getByRole('region', { name: 'No certificates' })).toContainText(
    'Nothing in shop matches “tls-old”.',
  )
  await expect(page.getByRole('region', { name: 'Nothing waiting' })).toHaveText(
    /No pods are waiting for a node\./,
  )
})

test('thousands of rows: only the ones in view are drawn, and every row is a key away', async ({
  page,
}) => {
  await kit(page)
  await page.getByRole('button', { name: 'With 2,500 rows' }).click()
  const pods = page.getByRole('grid', { name: 'Pods' })
  await expect(pods).toHaveAttribute('aria-rowcount', '2501')
  expect(await pods.getByRole('row').count()).toBeLessThan(80)
  // A column as wide as its text is as wide as its widest value of all the rows, not of the ones
  // drawn: the first row's cells are where the last row's are.
  const lefts = () =>
    pods
      .getByRole('row')
      .nth(1)
      .evaluate((row) =>
        [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().left)),
      )
  const atTop = await lefts()
  await pods.focus()
  await page.keyboard.press('End')
  await expect(pods.getByRole('row').filter({ hasText: 'storefront-2499' })).toBeVisible()
  expect(await pods.getByRole('row').count()).toBeLessThan(80)
  expect(await lefts()).toEqual(atTop)
  await page.keyboard.press('Home')
  await expect(pods.getByRole('row').filter({ hasText: 'storefront-0000' })).toBeVisible()
})

test('what a table is refused for, where its kinds can’t say it', async ({ page }) => {
  await kit(page)
  // For whoever wrote it: where, counted from 1, then what, then what it should be; in Lumovi's
  // words, quoting nothing of the table's own. A table that can be drawn has none.
  await expect(
    page.getByRole('list', { name: 'What a table is refused for' }).getByRole('listitem'),
  ).toHaveText([
    'Nothing: it can be drawn.',
    'Nothing: it can be drawn.',
    'Rows 1 and 2 have the same key.',
    'In row 1, inner rows 1 and 2 have the same key.',
    'Row 1 has 1 cell, and the table has 2 columns.',
    'Row 1, cell 1 is a number, and its column takes text.',
    'Row 1’s rest starts at column 3, and the table has 2 columns.',
    'Row 1’s rest doesn’t start at one of the table’s columns.',
    'Row 1, cell 1 isn’t a kind of cell.',
    'In row 2, inner row 2 has 1 cell, and the table has 2 columns.',
  ])
})
