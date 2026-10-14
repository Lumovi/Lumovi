/**
 * The kit's Table, on the page the tests' build has for the kit's parts: the cases that break a
 * table first, as design drew them.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, openCluster, test } from './fixtures.ts'
import { holds } from '../holds.ts'
import { placed } from '../placed.ts'

async function kit(page: Page) {
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/kit'
  })
  await expect(page.getByRole('grid', { name: 'Certificates' })).toBeVisible()
}

/**
 * The pointer on something, as a hand moves it: twice. (One move is all Playwright makes, and
 * Radix opens no tooltip on the move that ends the pointer's way from another.)
 */
async function point(at: Locator) {
  await at.hover({ position: { x: 6, y: 6 } })
  await at.hover({ position: { x: 10, y: 8 } })
}

/**
 * The pointer away from every tooltip, and none left: along the window's top, since a move that
 * could be on its way to the tooltip keeps it open, as Radix sees it.
 */
async function away(page: Page) {
  for (const x of [0, 60, 120]) await page.mouse.move(x, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
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
  // (At this width, in a card beside another, Age gives way beside the name's floor: what it says
  // is read after each row.)
  await expect(pools.getByRole('columnheader')).toHaveText(['Name', 'Nodes', 'CPU', 'Status'])
  const general = pools.getByRole('row').filter({ hasText: 'general' })
  await expect(general).toHaveAccessibleDescription(/Age\s*41d/)
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
            .slice(0, 4)
            .map((cell) => Math.round(cell.getBoundingClientRect().left)),
        ),
    )
  expect(new Set(lefts.map((row) => row.join(','))).size).toBe(1)

  // The longest name loses its middle and keeps its end; whole for a screen reader, and in its
  // row's tooltip (below), never in a title of the browser's.
  const long = 'worker-eu-west-1a-m6i-2xlarge-on-demand-7f3a9c2d-b1e4-1c9aa7'
  const nodes = page.getByRole('grid', { name: 'Nodes' })
  const longest = nodes.getByRole('row').filter({ hasText: long }).getByRole('gridcell').first()
  await expect(longest.locator('[aria-hidden].absolute')).toHaveText(/^worker-eu-\S+…1c9aa7$/)
  await expect(longest.locator('[title]')).toHaveCount(0)
  // A row's last cell may take the rest of the row.
  await expect(nodes.getByRole('row').filter({ hasText: 'worker-2' })).toContainText(
    'Ready · 4 cores',
  )
  // A note runs under the whole row, two lines at most.
  const note = page
    .getByRole('grid', { name: 'Waiting for a node' })
    .getByText(/^0\/9 nodes are available: 3 Insufficient memory/)
  // (Measured on the block that holds it to two lines: the text inside lays out all of its own.)
  const lines = await note.evaluate((el) => {
    const block = el.closest<HTMLElement>('[class*="line-clamp"]')!
    return block.getBoundingClientRect().height / parseFloat(getComputedStyle(block).lineHeight)
  })
  expect(Math.round(lines)).toBe(2)
  // A row with a cell more than there are columns is drawn by its columns: the rest isn't shown.
  const waiting = page.getByRole('grid', { name: 'Waiting for a node' })
  await expect(waiting.getByRole('row').filter({ hasText: 'reports-nightly-28931' })).toContainText(
    '0/9 nodes are available: 9 Insufficient cpu.',
  )
  await expect(page.getByText('one cell too many')).toHaveCount(0)
  // A screen reader is told of the rows it can reach: a group's heading isn't counted as one.
  await expect(page.getByRole('treegrid', { name: 'Resources' })).toHaveAttribute(
    'aria-rowcount',
    '9',
  )
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
  const resources = page.getByRole('treegrid', { name: 'Resources' })
  const section = page.getByRole('region', { name: 'Resources table' })
  // How many show, of how many: counted in rows at the top level. Each group shows five at most
  // (Workloads its three, Network five of its twenty), and has its own "Show all".
  await expect(section).toContainText('8 of 23')
  await expect(resources.getByRole('heading', { name: /^Workloads/ })).toContainText('3')
  await expect(resources.getByRole('heading', { name: /^Network/ })).toContainText('20')
  await expect(resources.getByRole('row')).toHaveCount(9)
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
  // A group showing all it has has no "Show all"; Network's opens its rest in place, under it.
  await expect(section.getByRole('button', { name: /^Show all/ })).toHaveText(['Show all 20'])
  await section.getByRole('button', { name: 'Show all 20' }).click()
  await expect(section).not.toContainText('8 of 23')
  await expect(section).toContainText('23')
  await expect(resources.getByRole('row').filter({ hasText: 'route-18' })).toBeVisible()
  await expect(section.getByRole('button', { name: /^Show all/ })).toHaveCount(0)
})

test('a row’s rest says how long ago after its words, and a table from a cut read says so in Lumovi’s words', async ({
  page,
}) => {
  await kit(page)
  // The age is Lumovi's to say, from the plugin's time: after the words, in tabular figures.
  const launching = page.getByRole('grid', { name: 'Nodes' }).getByRole('row').filter({
    hasText: 'worker-3',
  })
  // (Joined by no-break spaces: any space matches.)
  await expect(launching).toContainText(/Launching\s·\s3m/)
  await expect(launching.getByText(/·\s3m/)).toHaveClass(/tabular-nums/)
  // A plugin's rest is one text in one direction box, a number kept with its unit inside it: one
  // written right to left reads as written.
  const rtl = page
    .getByRole('grid', { name: 'Nodes' })
    .getByRole('row')
    .filter({ hasText: 'worker-4' })
    .locator('[data-their-text]')
    .filter({ hasText: 'ליבות' })
  await expect(rtl).toHaveCount(1)
  await expect(rtl).toHaveAttribute('dir', 'auto')
  expect(await rtl.evaluate((el) => el.textContent)).toBe('מוכן · 4 ליבות')
  await expect(rtl.locator('.whitespace-nowrap')).toHaveText('4 ליבות')
  // A read cut at Lumovi's limit: its rows are drawn, and a line above them says what they're
  // from; with the cluster's count, that too. Never as a failure.
  const waiting = page.getByRole('region', { name: 'Waiting for a node table' })
  await expect(waiting).toContainText('These are from the first 5,000 Lumovi read. There are more.')
  await expect(waiting.getByRole('row').filter({ hasText: 'reports-nightly-28931' })).toBeVisible()
  await expect(waiting.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Not yet scheduled table' })).toContainText(
    'These are from the first 5,000 of 12,345 Lumovi read.',
  )
  // The numbers are the door's, by its token: one it didn't make says nothing.
  await expect(page.getByRole('region', { name: 'Not cut table' })).not.toContainText('Lumovi read')
})

test('a number, a meter and a text sort by what they hold, both ways, a cell with nothing last; a row that opens nothing is just a row', async ({
  page,
}) => {
  await kit(page)
  const spares = page.getByRole('grid', { name: 'Spare parts' })
  const press = async (name: string, then: string[]) => {
    await spares.getByRole('button', { name, exact: true }).click()
    await expect.poll(() => names(page, 'Spare parts')).toEqual(then)
  }
  await press('Count', ['nut', 'axle', 'bolt', 'gear'])
  await press('Count', ['bolt', 'axle', 'nut', 'gear'])
  await expect(spares.getByRole('columnheader', { name: 'Count' })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  // A meter by how full it is; one with no limit has nothing to compare, and is last.
  await press('Used', ['bolt', 'axle', 'nut', 'gear'])
  await press('Used', ['nut', 'axle', 'bolt', 'gear'])
  await press('Shelf', ['nut', 'bolt', 'axle', 'gear'])
  await press('Shelf', ['axle', 'bolt', 'nut', 'gear'])
  await press('Name', ['axle', 'bolt', 'gear', 'nut'])
  await press('Name', ['nut', 'gear', 'bolt', 'axle'])
  await expect(spares.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  // Past the last row the last stays; Enter on a row that opens nothing tells the plugin nothing.
  await spares.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'What was pressed' })).not.toContainText(
    'Spare parts',
  )
})

test('a list with no groups has one “Show all”; thousands in groups are drawn as they’re scrolled to, each group its own', async ({
  page,
}) => {
  await kit(page)
  const claims = page.getByRole('region', { name: 'Node claims table' })
  await expect.poll(() => names(page, 'Node claims')).toEqual(['claim-a', 'claim-b'])
  await claims.getByRole('button', { name: 'Show all 4' }).click()
  await expect.poll(() => names(page, 'Node claims')).toHaveLength(4)
  await expect(claims.getByRole('button', { name: /^Show all/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'With 2,500 rows in groups' }).click()
  const teams = page.getByRole('region', { name: 'Pods by team table' })
  // Five teams of 500, each showing 150: drawn as they're scrolled to, not all at once.
  await expect(teams).toContainText('750 of 2,500')
  expect(await teams.getByRole('row').count()).toBeLessThan(200)
  await teams.getByRole('grid').evaluate((grid) => grid.scrollTo({ top: grid.scrollHeight }))
  await expect(teams.getByRole('button', { name: 'Show all 500' }).last()).toBeVisible()
  await teams.getByRole('button', { name: 'Show all 500' }).last().click()
  await expect(teams).toContainText('1,100 of 2,500')
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
  await page.getByRole('button', { name: 'With 2,500 rows', exact: true }).click()
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

test('a plugin’s texts are drawn in pieces: marks where they are, in a cut name and in a heading', async ({
  page,
}) => {
  await kit(page)
  const apps = page.getByRole('grid', { name: 'Applications' })
  const app = (name: string) => apps.getByRole('row').filter({ hasText: name })
  /** What a name draws: its letters, and each mark as its code point. */
  const drawn = (name: string) => app(name).locator('.font-medium [aria-hidden].absolute')
  // A letter that draws as nothing, and a mark that turns text round: each a mark where it was,
  // in a name and in a cell, and nothing after it turned.
  await expect(drawn('cart')).toHaveText('cartU+3164-api')
  await expect(drawn('invoice')).toHaveText('invoice-U+202Efdp.exe')
  await expect(
    app('invoice').getByRole('gridcell').getByRole('img', { name: 'invisible character U+202E' }),
  ).toHaveCount(1)
  await expect(app('invoice').getByRole('gridcell').last()).toContainText('ghcr.io/acme/')
  // A long name cut in its middle: the cut takes letters, and the marks of the part cut away
  // stand after the ellipsis. Whole in its row's tooltip, Lumovi's own, where a mark is drawn as
  // a mark: never in a title of the browser's, which could only spell it.
  await expect(drawn('platform-observability')).toHaveText(/^platform-\S*…U\+3164U\+180Eu-west$/)
  const cut = app('platform-observability').getByRole('gridcell').first()
  await expect(cut.locator('[title]')).toHaveCount(0)
  await point(cut)
  const whole = page.getByRole('tooltip')
  await expect(whole).toContainText('platform-observability-shared-infrastructure-')
  await expect(whole).toContainText('monitoring')
  await expect(whole.locator('[data-mark]')).toHaveText(['U+3164', 'U+180E'])
  await away(page)
  // A run of marks: three, then how many more.
  await expect(drawn('spam').locator('[data-mark]')).toHaveText([
    'U+3164',
    'U+3164',
    'U+3164',
    'and 117 more',
  ])
  // Right to left inside its own text, starting where every text of a row starts.
  const arabic = app('الدفع').locator('[data-their-text]').first()
  await expect(arabic).toHaveAttribute('dir', 'auto')
  await expect(arabic).toHaveCSS('text-align', 'left')
  // A heading is in capitals; its mark isn't.
  const stage = apps.getByRole('columnheader', { name: /^Sta.*U\+180E.*ge/ })
  await expect(stage).toBeVisible()
  await expect(stage.locator('[data-mark]')).toHaveCSS('text-transform', 'none')
  await expect(stage.locator('[data-their-text]')).toHaveCSS('text-transform', 'uppercase')
})

test('what a table is refused for, where its kinds can’t say it', async ({ page }) => {
  await kit(page)
  // For whoever wrote it: where, counted from 1, then what, then what it should be; in Lumovi's
  // words, quoting nothing of the table's own. A table that can be drawn has none. (A rest that
  // starts at no column, and a cell of a kind there isn't, are their kinds' to refuse, as the door
  // says it.)
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
    'Table.rows[0].rest.from: should be from 0 to 7',
    'Table.rows[0].cells[0].kind: should be one of text, number, age, status, meter, button, none',
    'In row 2, inner row 2 has 1 cell, and the table has 2 columns.',
  ])
})

test('a table of moments: its own lead heading, each revision in fixed-width type, and its whole hash shown by the pointer, the keyboard and a screen reader', async ({
  page,
}) => {
  await kit(page)
  const hashes = [
    '4f1c9aa8b7e6f5a4c3b2a1908f7e6d5c4b3a2910',
    '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291800',
    '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  ]
  const history = page.getByRole('grid', { name: 'History' })
  await expect(history.getByRole('columnheader')).toHaveText(['Synced', 'Revision', 'Source'])
  const rows = history.getByRole('row').filter({ hasText: 'h ago' })
  await expect(rows).toHaveCount(3)
  // Its first seven, in fixed-width type a step smaller; the whole never in the cell.
  const revision = rows.first().getByText('4f1c9aa', { exact: true })
  await expect(revision).toHaveCSS('font-size', '12px')
  expect(await revision.evaluate((words) => getComputedStyle(words).fontFamily)).toMatch(/mono/i)
  await expect(rows.first()).not.toContainText(hashes[0]!, { useInnerText: true })
  // A screen reader: each row's words, then the whole hash, as what describes it.
  for (const [i, hash] of hashes.entries()) {
    await expect(rows.nth(i)).toHaveAccessibleDescription(hash)
  }
  // Pointed at, the whole in Lumovi's tooltip, in the same type as its first seven; pointed away,
  // gone.
  await revision.hover()
  await expect(page.getByRole('tooltip')).toHaveText(hashes[0]!)
  expect(
    await page
      .getByRole('tooltip')
      .getByText(hashes[0]!)
      .evaluate((whole) => getComputedStyle(whole).fontFamily),
  ).toMatch(/mono/i)
  // (Twice: one move away is still on the way to the tooltip, as Radix sees it.)
  const title = page
    .getByRole('region', { name: 'History table' })
    .getByRole('heading')
    .getByText('History', { exact: true })
  await title.hover({ position: { x: 2, y: 2 } })
  await title.hover({ position: { x: 4, y: 4 } })
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // The keyboard on the table: its row's whole values show, and follow it up and down.
  await history.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('tooltip')).toHaveText(hashes[1]!)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('tooltip')).toHaveText(hashes[2]!)
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('tooltip')).toHaveText(hashes[1]!)
  // A pointer's press is no keyboard's: what its row showed goes.
  await rows.nth(1).getByRole('gridcell').last().click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})

test('beside a panel, what a column cuts is said whole in Lumovi’s tooltip, and only what’s cut: a heading, a text, and in the keyboard’s row', async ({
  launch,
  clusters,
}) => {
  // (A 1024 window, laid out at the tests' usual 1440 and zoomed: there the panel leaves the
  // table room to keep its Repository and path column, cut.)
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x900' } })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/argo-cd/overview'
  })
  const applications = page.getByRole('grid', { name: 'Applications' })
  await applications.getByRole('row').filter({ hasText: 'payments' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  const tip = (text: string) => page.getByRole('tooltip').filter({ hasText: text })
  // A heading its column cuts: whole in Lumovi's tooltip, and never a title beside it.
  await applications.getByRole('columnheader', { name: 'Repository and path' }).hover()
  await expect(tip('Repository and path')).toBeVisible()
  await expect(applications.getByRole('columnheader').locator('[title]')).toHaveCount(0)
  // (Pointed away twice: one move away is still on the way to the tooltip, as Radix sees it.)
  const away = async () => {
    await page.mouse.move(0, 0)
    await page.mouse.move(1, 1)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
  await away()
  // One that fits says nothing more.
  await applications.getByRole('columnheader', { name: 'Sync' }).hover()
  await expect(tip('Sync')).toHaveCount(0)
  // A text its column cuts: whole, in its own tooltip.
  await away()
  const batch = applications.getByRole('row').filter({ hasText: 'legacy-batch' })
  await batch.locator('[data-cuts]').first().hover()
  await expect(tip('apps/batch · github.com/example/deploy').first()).toBeVisible()
  // The keyboard's row (payments, opened above): cells can't be pointed at, so its tooltip says
  // the cut one whole too, beside the columns that gave way.
  await page.mouse.move(0, 0)
  await applications.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  const row = page.getByRole('tooltip').filter({ hasText: 'Target revision' })
  await expect(row).toContainText(
    /Repository and path\s*apps\/payments · github\.com\/example\/deploy/,
  )
  // Read after the row: what gave way, and not the cut cell again, which is read whole where it is.
  const payments = applications.getByRole('row').filter({ hasText: 'payments' }).first()
  await expect(payments).toHaveAccessibleDescription(/Target revision/)
  await expect(payments).not.toHaveAccessibleDescription(/Repository and path/)
  // Its value shortened as the page reads it again: no longer cut, no longer said.
  const app = structuredClone(
    clusters.demo.object('Application.argoproj.io', 'argocd', 'payments')!,
  )
  const spec = app.spec as { source: { repoURL: string; path: string } }
  spec.source.repoURL = 'https://g.io/d'
  spec.source.path = 'p'
  clusters.demo.upsert(app)
  await expect(page.getByRole('tooltip').filter({ hasText: 'Target revision' })).not.toContainText(
    'Repository and path',
  )
})

test('where it doesn’t all fit, a row has one tooltip, Lumovi’s own: where it goes, then what gave way; and a row with nothing to say has none', async ({
  page,
}) => {
  await kit(page)
  const fits = (name: string) => page.locator(`[data-fits="${name}"]`)
  const instances = fits('instances').getByRole('grid', { name: 'Instances' })
  await instances.scrollIntoViewIfNeeded()
  // Too narrow for its last two columns: they gave way whole.
  await expect(instances.getByRole('columnheader')).toHaveText(['Name', 'Role', 'Status', 'Node'])
  const row = instances.getByRole('row', { name: /orders-db-3/ })
  const tip = page.getByRole('tooltip')
  // Never the browser's: the row has no title, and nor has its name.
  await expect(row).not.toHaveAttribute('title')
  await expect(row.getByRole('gridcell').first().locator('[title]')).toHaveCount(0)
  // Under the pointer: where it goes first, in the words a header's link has, then what gave
  // way, a hairline between the two. Its lead isn't cut, so it isn't said again.
  await point(row.getByRole('gridcell').first())
  await expect(tip).toHaveText(
    /^Opens Pod shop\/orders-db-3 at its Logs tab\s*Restarts\s*2\s*Age\s*3d3h$/,
  )
  await expect(tip.locator('[data-row-tip] > [aria-hidden]')).toHaveCount(1)
  // Read after the row, in the same order.
  await expect(row).toHaveAccessibleDescription(
    /^Opens Pod shop\/orders-db-3 at its Logs tab\s+Restarts\s*2\s*Age\s*3d3h$/,
  )
  // A row whose name is cut too has all three: where it goes, its lead whole, what gave way,
  // with a hairline before each of the last two.
  await away(page)
  const long = 'orders-db-analytics-replica-eu-central-1a'
  const cut = instances.getByRole('row').filter({ hasText: long }).getByRole('gridcell').first()
  await expect(cut.locator('[aria-hidden].absolute')).toHaveText(/^orders-db-\S*…ral-1a$/)
  await point(cut)
  await expect(tip).toHaveText(
    new RegExp(
      `^Opens Pod shop/${long} at its Logs tab\\s*${long}\\s*Restarts\\s*0\\s*Age\\s*12d$`,
    ),
  )
  await expect(tip.locator('[data-row-tip] > [aria-hidden]')).toHaveCount(2)
  // On the keyboard's row too, and it follows the keyboard.
  await away(page)
  await instances.focus()
  await page.keyboard.press('ArrowDown')
  await expect(tip).toHaveText(
    /^Opens Pod shop\/orders-db-2 at its Logs tab\s*Restarts\s*0\s*Age\s*41d$/,
  )
  await page.keyboard.press('ArrowDown')
  await expect(tip).toContainText('Opens Pod shop/orders-db-3 at its Logs tab')
  // Pressed, it goes there: Lumovi's own to open, as the door made it.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('list', { name: 'What was pressed' })).toContainText(
    'Instances: go {"to":"reach","at":"logs","object":{"kind":"Pod","name":"orders-db-3","namespace":"shop"}}',
  )
  // A row that goes nowhere, with its lead whole and every column in view, has nothing to say:
  // no tooltip, however long the pointer stays.
  await page.keyboard.press('Tab')
  await away(page)
  const whole = fits('room').getByRole('gridcell').first()
  await point(whole)
  await holds(
    async () => (await tip.count()) === 0,
    900,
    'a row with nothing to say has no tooltip',
  )
})

test('the words beside a name take the room it leaves: whole where both fit, cut first where they don’t, and the name only once they’re at their least; a cut line under it is whole in the tooltip too', async ({
  page,
}) => {
  await kit(page)
  const fits = (name: string) => page.locator(`[data-fits="${name}"]`)
  await fits('room').scrollIntoViewIfNeeded()
  /** How a lead stands: its name whole or cut in its middle, the words beside whole or cut. */
  const lead = (name: string) =>
    fits(name).evaluate((box) => {
      const whole = box.querySelector('[data-whole]')!
      const beside = box.querySelector<HTMLElement>('[data-beside]')!
      return {
        name: box.querySelector('[data-whole] ~ [aria-hidden]')!.textContent,
        nameCut:
          whole.getBoundingClientRect().width >
          whole.parentElement!.getBoundingClientRect().width + 0.5,
        besideCut: beside.scrollWidth > beside.clientWidth,
        // In characters of its own type: how much of it is left to read.
        besideCh: beside.clientWidth / Number.parseFloat(getComputedStyle(beside).fontSize),
        share: beside.clientWidth / beside.parentElement!.clientWidth,
      }
    })
  const tip = page.getByRole('tooltip')
  const BESIDE = 'storefront · ServiceMonitor · shop · Prometheus k8s'
  // Room for both: the words beside are whole, though they're well over 40% of the lead (no
  // share of it is kept back from them).
  const room = await lead('room')
  expect(room).toMatchObject({ name: '10.0.3.7:8080', nameCut: false, besideCut: false })
  expect(room.share).toBeGreaterThan(0.4)
  // Less room: they're cut at their end, and the name hasn't given a pixel.
  const less = await lead('less')
  expect(less).toMatchObject({ name: '10.0.3.7:8080', nameCut: false, besideCut: true })
  // What's cut is whole in the row's tooltip: the name, then the words beside it.
  await point(fits('less').getByRole('gridcell').first())
  await expect(tip).toHaveText(`10.0.3.7:8080 ${BESIDE}`)
  await away(page)
  // Not enough for the name either: the words are at their least, about five characters, and
  // then the name loses its middle and keeps its end.
  const least = await lead('least')
  expect(least).toMatchObject({ nameCut: true, besideCut: true })
  expect(least.name).toMatch(/^storefront-metrics-\S*…c:8080$/)
  expect(least.besideCh).toBeGreaterThan(2)
  expect(least.besideCh).toBeLessThan(4)
  await point(fits('least').getByRole('gridcell').first())
  await expect(tip).toHaveText(
    `storefront-metrics-exporter-7d9f6c5b8-x2kqp.shop.svc:8080 ${BESIDE}`,
  )
  // In the tooltip's own ink, the words beside quieter; and no title of the browser's on either.
  await expect(tip.getByText(BESIDE).locator('xpath=..')).toHaveCSS('opacity', '0.68')
  await expect(fits('least').getByRole('gridcell').first().locator('[title]')).toHaveCount(0)
  // The line under a name is the lead's too: cut at its end, it's whole in the row's tooltip, on
  // a line of its own under the name, as quiet as the words beside.
  await away(page)
  const UNDER = 'Get "http://10.0.3.7:8080/metrics": context deadline exceeded'
  const under = fits('under').locator('[data-under]')
  expect(await under.evaluate((line) => line.scrollWidth > line.clientWidth)).toBe(true)
  await point(fits('under').getByRole('gridcell').first())
  await expect(tip).toHaveText(`10.0.3.7:8080${UNDER}`)
  const line = tip.getByText(UNDER).locator('xpath=..')
  await expect(line).toHaveCSS('opacity', '0.68')
  await expect(line).toHaveCSS('display', 'block')
})

test('beside a panel at 1024, a row of tiles too narrow for two stands one across, each line on one line', async ({
  launch,
}) => {
  // (Laid out at 1024 itself, not zoomed out to the tests' usual width.)
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x900' }, fullLayout: false })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/argo-cd/overview'
  })
  const applications = page.getByRole('grid', { name: 'Applications' })
  await applications.getByRole('row').filter({ hasText: 'payments' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  const tiles = ['Healthy', 'Out of sync', 'Last sync failed'].map((name) =>
    page.getByRole('region', { name, exact: true }),
  )
  // One across: each at the row's left edge, one under another, with its label whole.
  await expect
    .poll(async () => new Set(await Promise.all(tiles.map(async (t) => (await placed(t)).x))).size)
    .toBe(1)
  const label = tiles[1]!.getByText('Out of sync', { exact: true })
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // A short line holds on one line (16 px), never broken inside a word.
  const line = tiles[1]!.getByText('of 3 applications', { exact: true })
  expect((await placed(line)).height).toBeLessThanOrEqual(20)
})

test('beside a panel at 1440, a row of tiles keeps its words at the top, and a line in parts wraps between them', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1440x900' } })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/argo-cd/overview'
  })
  const applications = page.getByRole('grid', { name: 'Applications' })
  await applications.getByRole('row').filter({ hasText: 'payments' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  const tiles = ['Healthy', 'Out of sync', 'Last sync failed'].map((name) =>
    page.getByRole('region', { name, exact: true }),
  )
  // One height, and in each its label and its figure at the same height: the spare under the line.
  const tops = await Promise.all(
    tiles.map((tile) =>
      tile.evaluate((el) => {
        const top = (selector: string) =>
          Math.round(el.querySelector(selector)!.getBoundingClientRect().top)
        return [Math.round(el.getBoundingClientRect().height), top('span'), top('.text-\\[28px\\]')]
      }),
    ),
  )
  expect(new Set(tops.map((at) => at.join())).size).toBe(1)
  // Healthy's line, two parts: each whole on a line of its own, broken only between them.
  const parts = await tiles[0]!
    .locator('[data-part]')
    .evaluateAll((els) =>
      els.map((el) => [
        el.textContent,
        Math.round(el.getBoundingClientRect().top),
        el.getClientRects().length,
      ]),
    )
  expect(parts.map(([text]) => text)).toEqual(['1 degraded', '1 progressing'])
  expect(parts[1]![1]).toBeGreaterThan(parts[0]![1] as number)
})
