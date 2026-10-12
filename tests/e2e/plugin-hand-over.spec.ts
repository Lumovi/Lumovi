/**
 * The hand-over on the desktop: a plugin's page is given its code by Lumovi alone, and says why
 * where it isn't; one whose plugin changes under it ends, said so, and opens again with the new.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openCluster, test } from './fixtures.ts'

/** A stand-in for one of Lumovi's own, with a page, claiming Widgets of `group`. */
const plugin = (
  name: string,
  label: string,
  group = 'example.com',
) => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: ${name} }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [${group}]
  label: ${label}
  kinds: [{ group: ${group}, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`
/** Code that reads every Widget, and shows how many it was handed. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Field', { name: 'widgets', value: '…' }], ['put', 0, 1]])
  listen((text) => {
    const said = JSON.parse(text)
    if (said.objects) commit([['change', 1, { name: 'widgets', value: String(said.objects.length) }]])
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
})`

async function show(page: Page, name: string, label: string) {
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(
    (shown) =>
      (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show(
        shown,
      ),
    { plugin: name, name: label, version: '1.2.0', context: 'demo' },
  )
}
const ended = (page: Page) => page.getByTestId('plugin-ended')
const widgets = (page: Page) => page.locator('[data-part="Field"]').filter({ hasText: 'widgets' })

test('a plugin’s page is handed its code by Lumovi, or says why it couldn’t start', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), plugin('toys', 'Toys'))
  writeFileSync(join(folder, 'toys.js'), CODE)
  // Toys has code; Plain hasn't.
  writeFileSync(join(folder, 'plain.yaml'), plugin('plain', 'Plain', 'plain.example.com'))
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)

  await show(page, 'toys', 'Toys')
  await expect(widgets(page)).not.toContainText('…')
  await expect(ended(page)).toHaveCount(0)

  // No code in this Lumovi: it never started, and opening it again can't help.
  await show(page, 'plain', 'Plain')
  await expect(ended(page)).toHaveAttribute('data-why', 'not-handed')
  await expect(ended(page).getByRole('heading')).toHaveText('Plain’s page couldn’t start.')
  await expect(ended(page)).toContainText('Its code isn’t part of this Lumovi.')
  await expect(ended(page)).toContainText('The rest of Lumovi is as it was.')
  await expect(ended(page).getByRole('button', { name: 'Open it again' })).toHaveCount(0)

  // Not a plugin in use.
  await show(page, 'nobody', 'Nobody')
  await expect(ended(page).getByRole('heading')).toHaveText('Nobody isn’t in use any more.')
})

test('a page whose plugin changes under it ends, says so, and opens again with what it is now', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), plugin('toys', 'Toys'))
  writeFileSync(join(folder, 'toys.js'), CODE)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await show(page, 'toys', 'Toys')
  await expect(widgets(page)).not.toContainText('…')
  // Its code changes: the next time the list is read again, the read is refused, and the page ends.
  writeFileSync(join(folder, 'toys.js'), `${CODE}\n// a new version`)
  await expect(ended(page)).toHaveAttribute('data-why', 'changed', { timeout: 15_000 })
  await expect(ended(page).getByRole('heading')).toHaveText(
    'Toys changed since its page was opened.',
  )
  // Opened again: the code as it is now, handed over, and reading.
  await ended(page).getByRole('button', { name: 'Open it again' }).click()
  await expect(widgets(page)).not.toContainText('…')
  await expect(ended(page)).toHaveCount(0)
})
