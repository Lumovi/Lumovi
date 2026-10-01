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
  const { page } = await launch({ env: { KUBESTACKS_MAX_LIST_ITEMS: '1000' } })
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
  await choose('Copy kubectl describe')
  await expect.poll(clipboard).toBe(`kubectl describe pod ${DEMO.pods.debugShell} -n default`)
  await choose('Copy kubectl logs')
  await expect.poll(clipboard).toBe(`kubectl logs ${DEMO.pods.debugShell} -n default`)
  await choose('Open')
  await expect(panel(page, 'Pod', DEMO.pods.debugShell)).toBeVisible()

  await goTo(page, 'Nodes')
  await row(page, 'Nodes', DEMO.nodes.worker1).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy namespace/name' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Copy kubectl describe' }).click()
  await expect.poll(clipboard).toBe(`kubectl describe node ${DEMO.nodes.worker1}`)
})

test('narrow tables drop the least important columns', async ({ launch }) => {
  const { page } = await launch({ env: { KUBESTACKS_E2E_WINDOW: '1024x700' }, fullLayout: false })
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
