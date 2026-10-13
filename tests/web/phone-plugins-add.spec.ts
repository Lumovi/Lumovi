/** What a plugin that comes with Lumovi adds, on a phone: its pages, its tab, its command. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

/** A stand-in for one of Lumovi's own, with names as long as a file may give them. */
const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys of the platform team
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: overview, title: Overview }
    - { id: capacity, title: 'Capacity of every toy, week by week' }
  tabs:
    - { id: parts, title: Parts, kinds: [{ group: example.com, kind: Widget }] }
  commands:
    - { name: 'Open the toys’ capacity, week by week', page: capacity }
`

test('a plugin’s pages, its tab and its command on a phone: whose they are, said short', async ({
  page,
  serve,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  const served = await serve({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await signInNarrow(page, `${served.url}cluster/demo/plugins/toys`, DEMO_TOKEN)
  const body = page.locator('[data-plugin-body]')
  // Whose it is, in a line a phone has room for.
  await expect(body).toContainText('From the plugin Toys of the platform team 1.2.0.')
  await expect(body).not.toContainText('This page is', { useInnerText: true })
  // (Toys comes with no code of its own: its page says so, in its place, as on any screen.)
  await expect(body.getByTestId('plugin-ended')).toContainText(
    'Its code isn’t part of this Lumovi.',
  )
  const tabs = page.getByRole('navigation', { name: 'Toys of the platform team' })
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expectNoSidewaysScroll(page, 'a plugin’s page, on a phone')
  await expectFingerSized(page, 'a plugin’s page, on a phone')
  const capacity = tabs.getByRole('link', { name: 'Capacity of every toy, week by week' })
  await capacity.click()
  await expect(capacity).toHaveAttribute('aria-current', 'page')

  // Its entry, in the sidebar the menu opens, goes to its first page.
  await page.getByRole('button', { name: 'Menu' }).click()
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Toys of the platform team', exact: true })
    .click()
  await expect(body.getByTestId('plugin-ended')).toContainText(
    'Its code isn’t part of this Lumovi.',
  )

  // Its command, its whole name, with whose it is beside it.
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('week by week')
  const command = palette.getByRole('option', { name: /^Open the toys’ capacity, week by week/ })
  await expect(command).toContainText('Toys of the platform team')
  await expectNoSidewaysScroll(page, 'a plugin’s command, on a phone')
  await command.click()
  await expect(capacity).toHaveAttribute('aria-current', 'page')

  // Its tab, on an object of its kind.
  await page.goto(
    `${served.url}cluster/demo/r/Widget.example.com?open=${encodeURIComponent(`Widget.example.com/default/${CUSTOM.widget}`)}`,
  )
  const widget = page.getByRole('complementary', { name: `Widget ${CUSTOM.widget}` })
  await widget.getByRole('tab', { name: 'Parts' }).click()
  await expect(widget.locator('[data-plugin-body]')).toContainText(
    'From the plugin Toys of the platform team 1.2.0.',
  )
  await expectNoSidewaysScroll(page, 'a plugin’s tab, on a phone')
  await expectFingerSized(page, 'a plugin’s tab, on a phone')
})
