import type { Locator } from '@playwright/test'
import {
  panel,
  clipboardText,
  CONTEXTS,
  DEMO,
  goTo,
  LARGE,
  openCluster,
  row,
  rows,
  test,
  expect,
} from './fixtures.ts'

const number = (n: number) => n.toLocaleString('en-US')

test.describe('large lists', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page, CONTEXTS.large)
    await goTo(page, 'Pods')
  })

  test('are paginated and virtualized', async ({ page }) => {
    await expect(page.getByText(`${number(LARGE.podCount)} items`)).toBeVisible()
    const pagination = page.getByRole('navigation', { name: 'Pagination' })
    await expect(pagination).toContainText(`1–100 of ${number(LARGE.podCount)}`)
    await expect(pagination).toContainText('Page 1 of 25')
    expect(await rows(page, 'Pods').count()).toBeLessThan(60)

    // Sorting works from the keyboard too.
    const name = page.getByRole('columnheader', { name: 'Name' })
    await name.getByRole('button').focus()
    await page.keyboard.press('Enter')
    await expect(name).toHaveAttribute('aria-sort', 'ascending')
    await pagination.getByRole('button', { name: 'Next page' }).click()
    await expect(pagination).toContainText('101–200')
    await expect(row(page, 'Pods', LARGE.podName(100))).toBeVisible()
    await pagination.getByRole('button', { name: 'Last page' }).click()
    await expect(pagination).toContainText('Page 25 of 25')
    const grid = page.getByRole('grid', { name: 'Pods' })
    await grid.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    await expect(row(page, 'Pods', LARGE.podName(LARGE.podCount - 1))).toBeVisible()
    await pagination.getByRole('button', { name: 'Previous page' }).click()
    await expect(pagination).toContainText('Page 24 of 25')
    await pagination.getByRole('button', { name: 'First page' }).click()
    await expect(pagination).toContainText('Page 1 of 25')

    await pagination.getByLabel('Rows per page').selectOption('500')
    await expect(pagination).toContainText('Page 1 of 5')
    // The keyboard pages too: → / ← while the list has focus.
    await grid.focus()
    await page.keyboard.press('ArrowRight')
    await expect(pagination).toContainText('Page 2 of 5')
    await page.keyboard.press('ArrowLeft')
    await expect(pagination).toContainText('Page 1 of 5')

    // The page and its size live in the URL, so reloading keeps them.
    await pagination.getByRole('button', { name: 'Next page' }).click()
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 2 of 5')
  })

  test('the pods of a node are paginated too', async ({ page }) => {
    await goTo(page, 'Nodes')
    await row(page, 'Nodes', LARGE.node).click()
    const node = panel(page, 'Node', LARGE.node)
    await node.getByRole('tab', { name: 'Pods' }).click()
    const pagination = node.getByRole('navigation', { name: 'Pagination' })
    await expect(pagination).toContainText(`1–50 of ${number(LARGE.podCount)}`)
    await pagination.getByRole('button', { name: 'Next page' }).click()
    await expect(pagination).toContainText('51–100')
  })
})

test('lists are capped, with a way to narrow them', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_MAX_LIST_ITEMS: '1000' } })
  await openCluster(page, CONTEXTS.large)
  await goTo(page, 'Pods')
  const note = page.getByRole('note')
  await expect(note).toContainText(`Showing the first 1,000 of ${number(LARGE.podCount)} pods`)
  await note.getByRole('button', { name: 'Filter by label' }).click()
  const labels = page.getByLabel('Label selector')
  await expect(labels).toBeFocused()

  // Filtered lists don't report their total, so the note can only say "first N".
  await labels.fill('app.kubernetes.io/name=load')
  await labels.press('Enter')
  await expect(note).toContainText('Showing the first 1,000 pods.')
  await labels.fill('app.kubernetes.io/name=nothing')
  await labels.press('Enter')
  await expect(
    page.getByText('Nothing matches the label selector “app.kubernetes.io/name=nothing”.'),
  ).toBeVisible()
  // Leaving the field without Enter keeps the selector that is applied.
  await labels.fill('draft')
  await labels.blur()
  await expect(labels).toHaveValue('app.kubernetes.io/name=nothing')
})

test('expired continue tokens restart the list once', async ({ page, clusters }) => {
  await openCluster(page, CONTEXTS.large)
  // Only the Pods view's list (the context's namespace): other lists loading meanwhile,
  // like all pods for the overview, keep their tokens.
  const pods = { kind: 'Pod', namespace: LARGE.namespace }
  clusters.large.expireContinueTokens(1, pods)
  await goTo(page, 'Pods')
  await expect(page.getByText(`${number(LARGE.podCount)} items`)).toBeVisible()

  clusters.large.expireContinueTokens(2, pods)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Couldn’t refresh' })).toContainText(
    'continue parameter is too old',
  )
})

test('the list is driven by the keyboard', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Deployments')
  await page.keyboard.press('/')
  const filter = page.getByPlaceholder('Filter deployments')
  await expect(filter).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const grid = page.getByRole('grid', { name: 'Deployments' })
  await expect(grid).toBeFocused()

  const active = () =>
    grid.evaluate(
      (element) =>
        document.getElementById(element.getAttribute('aria-activedescendant')!)!.textContent,
    )
  await expect.poll(active).toContain('recommendations')
  await page.keyboard.press('j')
  await expect.poll(active).toContain('checkout')
  await page.keyboard.press('k')
  await expect.poll(active).toContain('recommendations')
  await page.keyboard.press('End')
  await expect.poll(active).toContain('storefront')
  await page.keyboard.press('Home')
  await page.keyboard.press('PageDown')
  await page.keyboard.press('PageUp')
  await page.keyboard.press('ArrowDown')
  // Other keys and modified keys are left alone.
  await page.keyboard.press('x')
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('Enter')
  await expect(panel(page, 'Deployment', DEMO.deployments.checkout)).toBeVisible()

  // With the panel open, moving through the list opens each row.
  await page.keyboard.press('ArrowDown')
  await expect(panel(page, 'Deployment', DEMO.deployments.cart)).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await expect(panel(page, 'Deployment', DEMO.deployments.checkout)).toBeVisible()

  // Escape in the filter leaves the field but keeps the panel open.
  await filter.focus()
  await page.keyboard.press('Escape')
  await expect(filter).not.toBeFocused()
  await expect(panel(page, 'Deployment', DEMO.deployments.checkout)).toBeVisible()
})

test('a link sorted by a column that doesn’t sort, or isn’t there, lists as usual', async ({
  page,
}) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  const status = page.getByRole('grid', { name: 'Pods' }).getByRole('columnheader', {
    name: 'Status',
  })
  await expect(status).toHaveAttribute('aria-sort', 'ascending')
  const usual = await rows(page, 'Pods').allInnerTexts()
  // Pods' Ready column shows "1/2", which doesn't sort.
  for (const sort of ['ready', 'nothing']) {
    await page.evaluate((sort) => {
      window.location.hash = `${window.location.hash.split('?')[0]}?sort=${sort}&desc=1`
    }, sort)
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`))
    await expect(status).toHaveAttribute('aria-sort', 'ascending')
    expect(await rows(page, 'Pods').allInnerTexts()).toEqual(usual)
  }
  // Its header sorts it the other way, as if the link hadn't asked.
  await status.getByRole('button').click()
  await expect(status).toHaveAttribute('aria-sort', 'descending')
})

test('headers and the label selector show whole at the default window, beside the panel too', async ({
  page,
}) => {
  await openCluster(page)
  /** The headers a list cuts short, sorted by each in turn (its arrow takes room too). */
  const cut = async (label: string, sortBy: string[]) => {
    const grid = page.getByRole('grid', { name: label })
    const shortened = () =>
      grid.getByRole('columnheader').evaluateAll((headers) =>
        headers.flatMap((header) => {
          const text = header.querySelector<HTMLElement>('.truncate')
          return text && text.scrollWidth > text.clientWidth ? [text.textContent] : []
        }),
      )
    const found = new Set(await shortened())
    for (const header of sortBy) {
      await grid.getByRole('columnheader', { name: header }).getByRole('button').click()
      await expect(grid.getByRole('columnheader', { name: header })).toHaveAttribute('aria-sort')
      for (const text of await shortened()) found.add(text)
    }
    return [...found]
  }
  await goTo(page, 'Events')
  expect(await cut('Events', ['Count', 'Last seen'])).toEqual([])
  // Its placeholder, in the field's own type, fits the field.
  const fits = await page.getByLabel('Label selector').evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input, '::placeholder')
    const context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    return context.measureText(input.placeholder).width <= input.clientWidth
  })
  expect(fits).toBe(true)
  await goTo(page, 'Volume Claims')
  expect(await cut('Volume Claims', [])).toEqual([])
  await goTo(page, 'Pods')
  expect(await cut('Pods', ['Restarts'])).toEqual([])
  // Beside the panel, columns that don't fit step aside (whole), and none is cut or pushed off.
  await row(page, 'Pods', DEMO.pods.debugShell).getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'Pod', DEMO.pods.debugShell)).toBeVisible()
  expect(await cut('Pods', [])).toEqual([])
  const grid = page.getByRole('grid', { name: 'Pods' })
  // (Once the panel has made its room.)
  await expect.poll(() => grid.evaluate((g) => g.scrollWidth <= g.clientWidth)).toBe(true)
})

test('rows have a context menu', async ({ page }) => {
  const clipboard = () => clipboardText(page)
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(DEMO.pods.debugShell)
  const target = row(page, 'Pods', DEMO.pods.debugShell)

  const choose = async (item: string) => {
    await target.click({ button: 'right' })
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }
  await choose('Copy name')
  await expect.poll(clipboard).toBe(DEMO.pods.debugShell)
  await choose('Copy namespace/name')
  await expect.poll(clipboard).toBe(`default/${DEMO.pods.debugShell}`)
  // For this cluster, wherever it's pasted (as the dialogs' commands are).
  await choose('Copy kubectl describe')
  await expect
    .poll(clipboard)
    .toBe(`kubectl describe pod/${DEMO.pods.debugShell} -n default --context ${CONTEXTS.demo}`)
  await choose('Copy kubectl logs')
  await expect
    .poll(clipboard)
    .toBe(`kubectl logs ${DEMO.pods.debugShell} -n default --context ${CONTEXTS.demo}`)
  await choose('Open')
  await expect(panel(page, 'Pod', DEMO.pods.debugShell)).toBeVisible()

  await goTo(page, 'Nodes')
  await row(page, 'Nodes', DEMO.nodes.worker1).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy namespace/name' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Copy kubectl describe' }).click()
  await expect
    .poll(clipboard)
    .toBe(`kubectl describe node/${DEMO.nodes.worker1} --context ${CONTEXTS.demo}`)
})

test('narrow tables drop the least important columns', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x700' }, fullLayout: false })
  await openCluster(page)
  await goTo(page, 'Pods')
  const headers = page.getByRole('grid', { name: 'Pods' }).getByRole('columnheader')
  await expect(headers).not.toContainText(['Node'])
  await row(page, 'Pods', DEMO.pods.debugShell).click()
  // The first column holds the row checkboxes.
  await expect(headers).toHaveText(['', 'Name', 'Status'])
})

test('a failed refresh keeps the list and says so', async ({ page, clusters }) => {
  await openCluster(page)
  await goTo(page, 'Services')
  await expect(row(page, 'Services', DEMO.services.storefront)).toBeVisible()
  const clear = clusters.demo.fail('/api/v1/services', { status: 503, body: 'overloaded' })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const notice = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
  await expect(notice).toBeVisible()
  await expect(row(page, 'Services', DEMO.services.storefront)).toBeVisible()
  clear()
  await notice.getByRole('button', { name: 'Retry' }).click()
  await expect(notice).toHaveCount(0)
})

test('filters live in the URL and survive Back', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByRole('button', { name: /^Failing/ }).click()
  await page.getByPlaceholder('Filter pods').fill('checkout')
  await expect(rows(page, 'Pods')).toHaveCount(2)
  await goTo(page, 'Services')
  await page.keyboard.press('Meta+[')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect(page.getByPlaceholder('Filter pods')).toHaveValue('checkout')
  await expect(rows(page, 'Pods')).toHaveCount(2)
  // A page number past the end falls back to the last page.
  await page.evaluate(() => {
    window.location.hash = window.location.hash.replace('?', '?page=9&')
  })
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 1 of 1')
})

test.describe('a list’s bar keeps to one row as it narrows', () => {
  /**
   * Where each of these sits down the page: the same for all on one row. (No number for what
   * isn't drawn at that instant: a bar that has just changed its shape draws again.)
   */
  const tops = (locators: Locator[]) =>
    Promise.all(
      locators.map(async (locator) => {
        const box = await locator.boundingBox()
        return box ? Math.round(box.y + box.height / 2) : NaN
      }),
    )
  /** Whether these are on one row; asked until they are, since a measure is of one instant. */
  const oneRow = async (locators: Locator[]) => {
    const all = await tops(locators)
    return all.every((top) => top === all[0])
  }

  test('beside an open object the fields shrink, at the default window', async ({ page }) => {
    await openCluster(page)
    await goTo(page, 'Services')
    const bar = page.getByRole('group', { name: 'Filters' })
    const labels = bar.getByRole('textbox', { name: 'Label selector' })
    const filter = bar.getByPlaceholder('Filter services')
    await expect(labels).toHaveAttribute('placeholder', 'Label selector, e.g. app=web')
    await row(page, 'Services', DEMO.services.storefront).getByRole('gridcell').nth(1).click()
    await expect(panel(page, 'Service', DEMO.services.storefront)).toBeVisible()
    // Both fields are still fields, on the count's row.
    await expect.poll(() => oneRow([bar.getByText(/^\d+ items$/), labels, filter])).toBe(true)
    await expect(bar.getByText('/', { exact: true })).toBeVisible()
  })

  test('at the smallest window the label selector is a button, and chips go under', async ({
    launch,
  }) => {
    const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x700' }, fullLayout: false })
    await openCluster(page)
    await goTo(page, 'Services')
    const bar = page.getByRole('group', { name: 'Filters' })
    await expect(bar.getByRole('textbox', { name: 'Label selector' })).toBeVisible()
    await row(page, 'Services', DEMO.services.storefront).getByRole('gridcell').nth(1).click()
    await expect(panel(page, 'Service', DEMO.services.storefront)).toBeVisible()

    const button = bar.getByRole('button', { name: 'Label selector', exact: true })
    const filter = bar.getByPlaceholder('Filter', { exact: true })
    await expect(button).toBeVisible()
    await expect(bar.getByRole('textbox', { name: 'Label selector' })).toHaveCount(0)
    await expect(bar.getByText('/', { exact: true })).toHaveCount(0)
    await expect.poll(() => oneRow([bar.getByText(/^\d+ items$/), button, filter])).toBe(true)
    // The key still finds the filter, without its hint.
    await page.keyboard.press('/')
    await expect(filter).toBeFocused()
    await page.keyboard.press('Escape')

    // The field opens under the button, typed in at once; it stays inside the window.
    await button.click()
    const popover = page.getByRole('dialog', { name: 'Label selector' })
    const field = popover.getByRole('textbox', { name: 'Label selector' })
    await expect(field).toBeFocused()
    // (From the button's own edge rightwards: never over the sidebar. Asked until it's so: the
    // field has the focus as soon as the popover is there, a moment before it's put by its
    // button, and it grows into its place.)
    const edges = async () => {
      const [at, box] = [await button.boundingBox(), await popover.boundingBox()]
      return at && box
        ? { left: box.x - at.x, right: box.x + box.width }
        : { left: NaN, right: NaN }
    }
    await expect.poll(async () => (await edges()).left).toBeGreaterThanOrEqual(-1)
    await expect.poll(async () => (await edges()).right).toBeLessThanOrEqual(1024)
    // Escape closes it without applying, and the button has the focus again.
    await field.fill('app=nothing')
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(button).toBeFocused()
    await expect(page).not.toHaveURL(/labels=/)
    // Nor does a click outside it apply what was typed.
    await button.click()
    await expect(field).toHaveValue('')
    await field.fill('app=nothing')
    await bar.getByText(/^\d+ items$/).click()
    await expect(popover).toHaveCount(0)
    await expect(page).not.toHaveURL(/labels=/)
    // Enter applies it, and the button says what's applied.
    await button.click()
    await field.fill('app=storefront')
    await page.keyboard.press('Enter')
    await expect(popover).toHaveCount(0)
    const applied = bar.getByRole('button', { name: 'Label selector: app=storefront' })
    await expect(applied).toBeFocused()
    await expect(page).toHaveURL(/labels=app(=|%3D)storefront/)
    await expect(
      page.getByText('Nothing matches the label selector “app=storefront”.'),
    ).toBeVisible()
    // Opened again it holds what's applied, selected; Tab leaves it be, and nothing with Enter
    // clears it.
    await applied.click()
    await expect(field).toHaveValue('app=storefront')
    expect(
      await field.evaluate(
        (input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!,
      ),
    ).toBe('app=storefront'.length)
    await page.keyboard.type('app=other')
    await page.keyboard.press('Tab')
    await expect(popover).toHaveCount(0)
    await expect(applied).toBeVisible()
    await applied.click()
    await field.fill('')
    await page.keyboard.press('Enter')
    await expect(button).toBeVisible()
    await expect(page).not.toHaveURL(/labels=/)

    // A list with chips keeps them whole: under the first row here, wrapping there.
    await page.keyboard.press('Escape')
    await goTo(page, 'Pods')
    await row(page, 'Pods', DEMO.pods.debugShell).getByRole('gridcell').nth(1).click()
    await expect(panel(page, 'Pod', DEMO.pods.debugShell)).toBeVisible()
    const chips = bar.locator('button[aria-pressed]')
    await expect(chips.first()).toBeVisible()
    await expect
      .poll(async () => {
        const [first, chip] = await tops([bar.getByText(/^\d+ items$/), chips.first()])
        return chip! - first!
      })
      .toBeGreaterThan(20)
    expect(await chips.evaluateAll((all) => all.every((c) => c.scrollWidth <= c.clientWidth))).toBe(
      true,
    )
    expect(await bar.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true)
  })
})
