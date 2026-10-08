/**
 * The clusters page (the desktop app's start screen): the kubeconfig files it reads, from its
 * footer, and changing them; a file that's gone or can't be read, while the others load; a
 * chosen one that's gone; and an organization's lock.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { clusterOption, DEMO, expect, test } from './fixtures.ts'

/** A kubeconfig in a folder of its own, with one context (`name`) for the demo cluster. */
function kubeconfigFor(name: string, server: string, caPem: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), `lumovi-${name}-`))
  return writeKubeconfig(dir, {
    currentContext: name,
    clusters: [{ name, server, caPem }],
    users: [{ name, token: DEMO_TOKEN }],
    contexts: [{ name, cluster: name, user: name }],
  })
}

/** Answers the next file picker with `filePaths` (or cancels it). */
const answer = (app: ElectronApplication, filePaths: string[] | null) =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: filePaths === null,
      filePaths: filePaths ?? [],
    })) as unknown as typeof dialog.showOpenDialog
  }, filePaths)

/** What's shown in Finder or Explorer, from now on (nothing is, really). */
const shown = async (app: ElectronApplication) => {
  await app.evaluate(({ shell }) => {
    const shown: string[] = []
    Object.assign(globalThis, { shown })
    shell.showItemInFolder = (path: string) => void shown.push(path)
  })
  return () => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)
}

const filesButton = (page: Page) => page.getByRole('button', { name: 'Kubeconfig files' })
const REVEAL = /^Show in (Finder|Explorer|folder)$/

/** The files popover, opened. */
async function openFiles(page: Page) {
  await filesButton(page).click()
  const popover = page.getByRole('dialog', { name: 'Kubeconfig files' })
  await expect(popover).toBeVisible()
  return popover
}

test('the files read are in the footer, each with where it’s from and its clusters, and can be chosen, added, removed and gone back from', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  const beta = kubeconfigFor('beta', clusters.demo.url, clusters.demo.caPem)
  const { page, app } = await launch()
  const revealed = await shown(app)
  await expect(filesButton(page)).toContainText(clusters.kubeconfigPath)

  let popover = await openFiles(page)
  await expect(popover).toContainText('Merged as kubectl does')
  await expect(popover).toContainText('From KUBECONFIG · 9 clusters')
  await expect(popover).toContainText('Lumovi reads these files and never writes to them.')
  // Nothing to go back from yet; KUBECONFIG's own isn't Lumovi's to remove.
  await expect(popover.getByRole('button', { name: /^Back to/ })).toHaveCount(0)
  await expect(popover.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await popover.getByRole('button', { name: REVEAL }).click()
  expect(await revealed()).toEqual([clusters.kubeconfigPath])

  // Chosen in place of KUBECONFIG's.
  await answer(app, [alpha])
  await popover.getByRole('button', { name: /^Choose a kubeconfig…/ }).click()
  await expect(popover).toBeHidden()
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(clusterOption(page, 'alpha')).toContainText(DEMO.gitVersion)
  await expect(filesButton(page)).toContainText(basename(alpha))

  // Another after it: both read, the footer counting the other.
  popover = await openFiles(page)
  await expect(popover).toContainText('Chosen in Lumovi · 1 cluster')
  await answer(app, [beta])
  await popover.getByRole('button', { name: 'Add another file…' }).click()
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(filesButton(page)).toContainText('+1')

  // Removed: no longer read (the file stays as it is).
  popover = await openFiles(page)
  await expect(popover).toContainText('Added in Lumovi · 1 cluster')
  await popover.getByRole('button', { name: 'Remove' }).nth(1).click()
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(filesButton(page)).not.toContainText('+1')
  // Still open, as it is now.
  await expect(popover).not.toContainText('Added in Lumovi')

  // Back to KUBECONFIG's.
  await popover.getByRole('button', { name: /^Back to KUBECONFIG and/ }).click()
  await expect(page.getByRole('option')).toHaveCount(9)
  await expect(filesButton(page)).toContainText(clusters.kubeconfigPath)
})

test('a file that can’t be read, or is gone, is said so, and the others still load', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  const beta = kubeconfigFor('beta', clusters.demo.url, clusters.demo.caPem)
  const gamma = kubeconfigFor('gamma', clusters.demo.url, clusters.demo.caPem)
  const broken = join(mkdtempSync(join(tmpdir(), 'lumovi-broken-')), 'config')
  writeFileSync(broken, 'clusters: [unterminated\n')
  const { page, app } = await launch({ env: { KUBECONFIG: [alpha, broken].join(delimiter) } })

  // Unreadable: the rest are read, under a notice.
  await expect(clusterOption(page, 'alpha')).toContainText(DEMO.gitVersion)
  const unreadable = page.getByRole('status').filter({ hasText: 'couldn’t be read' })
  await expect(unreadable).toContainText(basename(broken))
  await expect(unreadable).toContainText('so its clusters aren’t here')
  const popover = await openFiles(page)
  await expect(popover).toContainText('Couldn’t be read:')
  await page.keyboard.press('Escape')

  // Gone: one added, then deleted.
  await answer(app, [beta])
  await (await openFiles(page)).getByRole('button', { name: 'Add another file…' }).click()
  await expect(clusterOption(page, 'beta')).toBeVisible()
  rmSync(beta)
  await page.getByRole('button', { name: 'Reload' }).click()
  const gone = page.getByRole('status').filter({ hasText: 'is gone' })
  await expect(gone).toContainText(basename(beta))
  await expect(clusterOption(page, 'beta')).toHaveCount(0)
  // A warning while others load (critical only when nothing does).
  await expect(filesButton(page).locator('svg').first()).toHaveClass(/text-warn-text/)

  // Chosen again where it is now: in its place.
  await answer(app, [gamma])
  await gone.getByRole('button', { name: 'Choose it again…' }).click()
  await expect(clusterOption(page, 'gamma')).toContainText(DEMO.gitVersion)
  await expect(gone).toHaveCount(0)
})

test('a chosen kubeconfig that’s gone says so, and offers to choose another or go back', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ kubeconfigFiles: [alpha] }))
  rmSync(alpha)
  const { page } = await launch({ userDataDir })

  await expect(
    page.getByRole('heading', { name: 'The kubeconfig you chose is gone' }),
  ).toBeVisible()
  await expect(page.getByText('it’s been moved or deleted')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a kubeconfig…' })).toBeFocused()
  await page.getByRole('button', { name: /^Back to KUBECONFIG and/ }).click()
  await expect(page.getByRole('option')).toHaveCount(9)
})

test('an organization’s lock: Managed in place of changes, and the files shown as they are', async ({
  launch,
  clusters,
}) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))
  const { page } = await launch({ env: { LUMOVI_POLICY: policy } })

  await page.getByRole('button', { name: 'Managed' }).click()
  const managed = page.getByRole('dialog').filter({ hasText: 'Managed by your organization' })
  await expect(managed).toContainText(
    'Your organization’s policy keeps Lumovi to the kubeconfig in KUBECONFIG or ~/.kube/config, so it can’t add files or clusters.',
  )
  await expect(managed).toContainText(policy)
  await page.keyboard.press('Escape')

  const popover = await openFiles(page)
  await expect(popover).toContainText('Managed')
  await expect(popover).toContainText('From KUBECONFIG · 9 clusters')
  await expect(popover).toContainText('Your organization’s policy keeps Lumovi to these files.')
  for (const name of [/^Choose a kubeconfig…/, 'Add another file…', /^Back to/, 'Remove']) {
    await expect(popover.getByRole('button', { name })).toHaveCount(0)
  }
  void clusters
})

test('an organization’s lock with no clusters says who to ask', async ({ launch }) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))
  const { page } = await launch({
    env: { LUMOVI_POLICY: policy, KUBECONFIG: join(tmpdir(), 'lumovi-does-not-exist', 'config') },
  })
  await expect(page.getByRole('heading', { name: 'No clusters yet' })).toBeVisible()
  await expect(
    page.getByText(
      'Your organization’s policy keeps Lumovi to KUBECONFIG and ~/.kube/config, and neither has a cluster. Ask whoever looks after this computer.',
    ),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a kubeconfig…' })).toHaveCount(0)
  // Its own Reload, not the footer's, has the focus.
  await expect(page.getByRole('button', { name: 'Reload' }).first()).toBeFocused()
})

/** A cluster's settings dialog, opened with ⌘I on the selected one (found by its context). */
async function openSettings(page: Page, context: string, name = context) {
  await page.getByPlaceholder('Search clusters and labels…').fill(context)
  await expect(clusterOption(page, name)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+i')
  return page.getByRole('dialog')
}

test('a cluster’s settings: its name, color, group, labels and namespace, production by hand, hidden; kept, and shown where it is', async ({
  launch,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const first = await launch({ userDataDir })
  let { page } = first
  await expect(clusterOption(page, 'demo')).toContainText(DEMO.gitVersion)

  const dialog = await openSettings(page, 'demo')
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused()
  await dialog.getByLabel('Name', { exact: true }).fill('Payments EU')
  await dialog.getByRole('radio', { name: 'Orange' }).click()
  await dialog.getByLabel('Group').fill('Payments')
  const labels = dialog.getByLabel('Labels')
  await labels.fill('env=production')
  await labels.press('Enter')
  await labels.fill('region=eu-west-1')
  await labels.press('Enter')
  // Not a label: said so, and not kept.
  await labels.fill('not a label')
  await labels.press('Enter')
  await expect(labels).toHaveAttribute('aria-invalid', 'true')
  await labels.fill('')
  await dialog.getByLabel('Namespace').fill('team-a')
  // demo doesn't look like production: set by hand.
  await expect(dialog.getByRole('switch', { name: 'Production' })).not.toBeChecked()
  await dialog.getByRole('switch', { name: 'Production' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await page.getByPlaceholder('Search clusters and labels…').fill('')

  const row = clusterOption(page, 'Payments EU')
  await expect(row).toContainText('Production')
  // Its context under its name, and its group.
  await expect(row).toContainText('demo')
  await expect(page.getByRole('group', { name: /^Payments/ })).toContainText('Payments EU')
  await expect(page.getByRole('group', { name: /^Other clusters/ })).toBeVisible()
  // Found by a label, which shows.
  await page.getByPlaceholder('Search clusters and labels…').fill('env=production')
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(row).toContainText('env=production')
  // Its group counts what was found.
  await expect(page.getByRole('group', { name: /^Payments/ })).toHaveAccessibleName(/1$/)
  await page.getByPlaceholder('Search clusters and labels…').fill('')

  // Grouped by a label's values instead, then by nothing.
  await page.getByRole('button', { name: 'Group by' }).click()
  await page.getByRole('menuitem', { name: 'region' }).click()
  await expect(page.getByRole('group', { name: /^region=eu-west-1/ })).toContainText('Payments EU')
  await expect(page.getByRole('group', { name: /^No region label/ })).toBeVisible()
  await page.getByRole('button', { name: 'Grouped by region' }).click()
  await page.getByRole('menuitem', { name: 'Nothing' }).click()
  await expect(page.getByRole('group', { name: /^Clusters/ })).toBeVisible()

  // Hidden, from its actions: counted in the footer, and shown from there.
  await page.getByPlaceholder('Search clusters and labels…').fill('sandbox')
  await page.getByPlaceholder('Search clusters and labels…').fill('')
  await clusterOption(page, 'sandbox').getByRole('button', { name: 'Actions for sandbox' }).click()
  await page.getByRole('menuitem', { name: 'Hide' }).click()
  await expect(clusterOption(page, 'sandbox')).toHaveCount(0)
  await page.getByRole('button', { name: '1 hidden' }).click()
  await expect(clusterOption(page, 'sandbox')).toHaveClass(/opacity-55/)
  await expect(page.getByRole('button', { name: 'Showing 1 hidden' })).toBeVisible()
  await first.app.close()

  // Kept across a restart, and its name where the cluster shows.
  page = (await launch({ userDataDir })).page
  await expect(clusterOption(page, 'Payments EU')).toContainText('Production')
  await clusterOption(page, 'Payments EU').click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('Payments EU')
  await expect(page).toHaveTitle(/· Payments EU — Lumovi$/)
  // Opened in its namespace.
  await expect(page.getByRole('button', { name: /namespace/i }).first()).toContainText('team-a')
})

test('a cluster is added from a pasted kubeconfig, checked, named, and used with kubectl; then its connection edited, and removed', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })
  await expect(clusterOption(page, 'demo')).toBeVisible()
  const text = readFileSync(kubeconfigFor('pasted', clusters.demo.url, clusters.demo.caPem), 'utf8')

  await page.keyboard.press('ControlOrMeta+n')
  let dialog = page.getByRole('dialog', { name: 'Add a cluster' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Check it' })).toBeDisabled()
  await dialog.locator('.cm-content').click()
  await page.keyboard.insertText(text)
  await dialog.getByRole('button', { name: 'Check it' }).click()

  await expect(page.getByRole('dialog', { name: 'pasted is ready' })).toBeVisible()
  // Its title follows its name as it's typed.
  dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('It reads as a kubeconfig')
  await expect(dialog).toContainText(`pasted · user pasted`)
  await expect(dialog).toContainText(DEMO.gitVersion)
  await expect(dialog).toContainText('Signed in as pasted · can list namespaces')
  await expect(dialog).toContainText(/export KUBECONFIG=|\$env:KUBECONFIG = /)
  await dialog.getByLabel('Name', { exact: true }).fill('Pasted cluster')
  await dialog.getByRole('radio', { name: 'Teal' }).click()
  await dialog.getByRole('button', { name: 'Close' }).last().click()

  // In the list, selected, in Lumovi's own folder.
  const row = clusterOption(page, 'Pasted cluster')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(row).toContainText(DEMO.gitVersion)
  const files = await openFiles(page)
  await expect(files).toContainText('Clusters added in Lumovi · 1 cluster')
  await page.keyboard.press('Escape')

  // Its settings: where it comes from, and its connection edited (its token kept from the page).
  const settings = await openSettings(page, 'pasted', 'Pasted cluster')
  await expect(settings).toContainText('Added in Lumovi')
  await expect(settings).toContainText('a token')
  await settings.getByRole('button', { name: 'Edit connection…' }).click()
  dialog = page.getByRole('dialog', { name: 'Edit connection' })
  await expect(dialog.locator('.cm-content')).toContainText('(kept by Lumovi)')
  await expect(dialog.locator('.cm-content')).not.toContainText(DEMO_TOKEN)
  await dialog.getByRole('button', { name: 'Check it' }).click()
  await expect(page.getByRole('dialog', { name: 'Pasted cluster is saved' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Removed from Lumovi, asked first: ⌘⌫ on it (the last: ↑ from the first).
  await page.getByPlaceholder('Search clusters and labels…').fill('')
  await page.keyboard.press('ArrowUp')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+Backspace')
  await expect(
    page.getByRole('dialog', { name: 'Remove Pasted cluster from Lumovi?' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  // Or from its actions.
  await row.getByRole('button', { name: 'Actions for Pasted cluster' }).click()
  await page.getByRole('menuitem', { name: 'Remove from Lumovi' }).click()
  dialog = page.getByRole('dialog', { name: 'Remove Pasted cluster from Lumovi?' })
  await expect(dialog).toContainText('Your own kubeconfig files aren’t touched.')
  // Alone in its file: nothing else is removed with it.
  await expect(dialog).not.toContainText('and with it')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0)
})

test('adding a cluster: a name already read, a credential program allowed, a server that doesn’t answer', async ({
  launch,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(dir, 'ran')
  const plugin = join(dir, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const plugged = readFileSync(
    writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-plugged-')), {
      currentContext: 'demo',
      clusters: [{ name: 'c', server: clusters.demo.url, caPem: clusters.demo.caPem }],
      users: [{ name: 'u', exec: { command: process.execPath, args: [plugin] } }],
      // Named as the fixture's: added under another name.
      contexts: [{ name: 'demo', cluster: 'c', user: 'u' }],
    }),
    'utf8',
  )
  const { page, app } = await launch()
  await expect(clusterOption(page, 'demo')).toBeVisible()
  // The menu's New (⌘N, which the menu takes before the page) adds a cluster here.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('create')!.click())
  await expect(page.getByRole('dialog', { name: 'Add a cluster' })).toBeVisible()
  await page.keyboard.press('Escape')
  const paste = async (text: string) => {
    await page.getByRole('button', { name: 'Add cluster' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a cluster' })
    await dialog.locator('.cm-content').click()
    await page.keyboard.insertText(text)
    await dialog.getByRole('button', { name: 'Check it' }).click()
    return dialog
  }

  let dialog = await paste(plugged)
  await expect(dialog).toContainText('demo is already read, so it’s added as')
  await expect(dialog.getByLabel('Add demo as')).toHaveValue('demo-2')
  await expect(dialog).toContainText('Signing in runs a program on this computer')
  await expect(dialog).toContainText(plugin)
  await expect(dialog).toContainText('Waiting for you')
  expect(existsSync(ran)).toBe(false)
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(page.getByRole('dialog', { name: 'demo-2 is ready' })).toBeVisible()
  expect(existsSync(ran)).toBe(true)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await expect(clusterOption(page, 'demo-2')).toContainText(DEMO.gitVersion)

  // A server that doesn't answer: why, and added anyway.
  const offline = readFileSync(kubeconfigFor('vpn-only', clusters.offlineUrl, undefined), 'utf8')
  dialog = await paste(offline)
  await expect(dialog).toContainText('The server didn’t answer')
  await expect(dialog).toContainText('like a VPN')
  await dialog.getByRole('button', { name: 'Add it anyway' }).click()
  await expect(page.getByRole('dialog', { name: 'vpn-only is ready' })).toBeVisible()
})

test('the list: found by a name or label just given, Enter on its buttons, its keys after a menu, and every cluster hidden', async ({
  launch,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })
  await expect(clusterOption(page, 'sandbox')).toBeVisible()
  const search = page.getByPlaceholder('Search clusters and labels…')

  // Named and labelled, with no group: found by both at once.
  const dialog = await openSettings(page, 'sandbox')
  await dialog.getByLabel('Name', { exact: true }).fill('Staging')
  await dialog.getByLabel('Labels').fill('env=stage')
  await dialog.getByLabel('Labels').press('Enter')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  for (const words of ['Staging', 'env=stage']) {
    await search.fill(words)
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(clusterOption(page, 'Staging')).toBeVisible()
  }
  await search.fill('')

  // Grouped by a label: the button says so.
  await page.getByRole('button', { name: 'Group by' }).click()
  await page.getByRole('menuitem', { name: 'env' }).click()
  await expect(page.getByRole('button', { name: 'Grouped by env' })).toBeVisible()
  await expect(page.getByRole('group', { name: /^env=stage/ })).toBeVisible()

  // Enter on a button in the list's bar presses it: not opens the selected cluster.
  await page.getByRole('button', { name: 'Add cluster' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Add a cluster' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toHaveCount(0)

  // A cluster's actions closed: back in the search, where the keys are.
  await search.click()
  await page.keyboard.press('.')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(search).toBeFocused()

  // Every cluster hidden: said so, and where to show them.
  const all = await page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts)
  await page.evaluate(
    async (names) => {
      for (const name of names) await window.lumovi!.app.setCluster!(name, { hidden: true })
    },
    all.map((context) => context.name),
  )
  await page.reload()
  await expect(page.getByText('Every cluster is hidden. Show them from the footer.')).toBeVisible()
})

test('a cluster’s settings: production back to Lumovi’s guess, and read-only kept by LUMOVI_READ_ONLY says so', async ({
  launch,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ clusters: { demo: { production: true } } }),
  )
  const { page } = await launch({ userDataDir, env: { LUMOVI_READ_ONLY: '1' } })
  await expect(clusterOption(page, 'demo')).toContainText('Production')
  const dialog = await openSettings(page, 'demo')
  await expect(dialog).toContainText('Set by LUMOVI_READ_ONLY.')
  await expect(dialog.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Use Lumovi’s guess' }).click()
  // demo doesn't look like production.
  await expect(dialog.getByRole('switch', { name: 'Production' })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(clusterOption(page, 'demo')).not.toContainText('Production')
  expect(
    await page.evaluate(async () => (await window.lumovi!.app.settings()).clusters?.demo),
  ).toBeUndefined()

  // The keys, in the shortcuts.
  await page.getByPlaceholder('Search clusters and labels…').fill('')
  await page.getByRole('button', { name: 'Kubeconfig files' }).focus()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog')).toContainText('Clusters page')
  await expect(page.getByRole('dialog')).toContainText('Remove one added in Lumovi')
})

test('a kubeconfig that can’t be opened is left out, said so, and the others load', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  // A folder named as a kubeconfig.
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-folder-'))
  const { page } = await launch({ env: { KUBECONFIG: [alpha, folder].join(delimiter) } })
  await expect(clusterOption(page, 'alpha')).toContainText(DEMO.gitVersion)
  await expect(page.getByRole('status').filter({ hasText: 'couldn’t be read' })).toContainText(
    basename(folder),
  )
})
