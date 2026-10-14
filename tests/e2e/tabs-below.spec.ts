/**
 * An object kept open below, from the detail panel: a tab beside the terminals, on the tab the
 * panel showed, which stays while the pages above go elsewhere (its logs keep coming), and opens
 * in the panel again from its menu. Kept once a window: kept again, it's shown.
 */
import type { Page } from '@playwright/test'
import { DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const below = (page: Page) => page.getByRole('region', { name: 'Tabs below', exact: true })

test('a pod’s logs kept open below go on while the pages above go elsewhere, and open in the panel again', async ({
  page,
  clusters,
}) => {
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByRole('button', { name: 'Keep open below' }).click()

  // A tab after the terminals, on the panel's tab; shown, and the panel stays as it was.
  const tabs = below(page).getByRole('tablist', { name: 'Tabs below' })
  const tab = tabs.getByRole('tab', { name: `Pod ${pod}, Logs` })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Show below' })).toBeVisible()
  const kept = below(page).getByRole('tabpanel')
  const log = kept.getByRole('log')
  clusters.demo.appendLogs('shop', pod, 'app', ['kept below, line one'])
  await expect(log).toContainText('kept below, line one')

  // The pages above go elsewhere: it goes on.
  await goTo(page, 'Deployments')
  await expect(detail).toHaveCount(0)
  clusters.demo.appendLogs('shop', pod, 'app', ['kept below, after the page moved'])
  await expect(log).toContainText('kept below, after the page moved')

  // Kept again from the panel: it's shown, not kept twice.
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  await panel(page, 'Pod', pod).getByRole('button', { name: 'Show below' }).click()
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(panel(page, 'Pod', pod)).toHaveCount(0)

  // From its menu, in the panel again.
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in the panel' }).click()
  await expect(panel(page, 'Pod', pod)).toBeVisible()

  // Closed: gone, and the tabs below with it.
  await below(page)
    .getByRole('button', { name: `Close Pod ${pod}` })
    .click()
  await expect(tabs.getByRole('tab')).toHaveCount(0)
  await expect(below(page).getByRole('button', { name: 'Show the tabs below' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})

test('with focus below, ⌘W (Ctrl+Shift+W) closes the tab shown there, not the window', async ({
  page,
  lumovi,
}) => {
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  await panel(page, 'Pod', pod).getByRole('button', { name: 'Keep open below' }).click()
  const tabs = below(page).getByRole('tablist', { name: 'Tabs below' })
  const tab = tabs.getByRole('tab', { name: `Pod ${pod}` })
  await tab.focus()
  if (process.platform === 'darwin') {
    // (As the system's ⌘W comes: to the main process before the page, as a key, not a menu.)
    await lumovi.app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      for (const type of ['keyDown', 'char', 'keyUp'] as const) {
        contents.sendInputEvent({ type, keyCode: 'W', modifiers: ['meta'] })
      }
    })
  } else {
    await page.keyboard.press('Control+Shift+KeyW')
  }
  await expect(tabs.getByRole('tab')).toHaveCount(0)
  expect(
    await lumovi.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1)
})

test('the palette keeps the panel’s object open below, on the tab the panel shows', async ({
  page,
}) => {
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  await panel(page, 'Pod', pod).getByRole('tab', { name: 'Logs' }).click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /^Keep open below/ }).click()
  const tabs = below(page).getByRole('tablist', { name: 'Tabs below' })
  await expect(tabs.getByRole('tab', { name: `Pod ${pod}, Logs` })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // Kept: the palette says it's below, and shows it.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('option', { name: /^Show below/ })).toBeVisible()
})

test('a kept pod that’s deleted keeps its last lines, says when, and offers what ran it instead', async ({
  page,
  clusters,
}) => {
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  await panel(page, 'Pod', pod).getByRole('tab', { name: 'Logs' }).click()
  await panel(page, 'Pod', pod).getByRole('button', { name: 'Keep open below' }).click()
  const kept = below(page).getByRole('tabpanel')
  clusters.demo.appendLogs('shop', pod, 'app', ['the last line before it went'])
  await expect(kept.getByRole('log')).toContainText('the last line before it went')
  await page.keyboard.press('Escape')

  clusters.demo.remove('Pod', 'shop', pod)
  const tabs = below(page).getByRole('tablist', { name: 'Tabs below' })
  await expect(tabs.getByRole('tab', { name: `Pod ${pod}, Logs, deleted` })).toBeVisible({
    timeout: 20_000,
  })
  const notice = kept.getByRole('status').filter({ hasText: 'was deleted at' })
  await expect(notice).toContainText(new RegExp(`^Pod ${pod} was deleted at \\d\\d:\\d\\d\\.`))
  await expect(notice).toContainText('Its lines up to then stay here until you close this tab.')
  await expect(notice).toContainText(
    `It belonged to the Deployment ${DEMO.deployments.storefront}, which is still there.`,
  )
  // Its lines are still there, under the notice.
  await expect(kept.getByRole('log')).toContainText('the last line before it went')
  // What ran it, kept instead, on the same tab.
  await notice
    .getByRole('button', { name: `Keep ${DEMO.deployments.storefront} open instead` })
    .click()
  await expect(
    tabs.getByRole('tab', { name: `Deployment ${DEMO.deployments.storefront}, Logs` }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab')).toHaveCount(1)
})
