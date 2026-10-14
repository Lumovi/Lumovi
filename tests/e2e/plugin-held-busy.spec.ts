/**
 * A header's button whose change was applied is busy at once, held by Lumovi in its own word,
 * and never shows the button it was in between: until the plugin draws again after it was
 * handed the changed object anew (Lumovi reads it again at once), or ten seconds at most.
 * Cancelled, nothing is held.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const FILE = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: polisher }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Polisher
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  changes: [{ group: example.com, kind: Widget, actions: [patch] }]
`

/**
 * Its code: it reads the widgets twice over (a second read that draws too, as a page's other
 * reads do) and draws a header whose Polish is busy while the widget says it's polishing. Nudge
 * changes what it doesn't draw, and after it the page draws nothing more.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let widget
  let quiet = false
  let n = 0
  const header = () => ({
    name: 'polisher',
    buttons: [
      { key: 'nudge', name: 'Nudge', changes: true, asks: true },
      widget && widget.object.spec && widget.object.spec.polishing
        ? { key: 'polish', name: 'Polish', changes: true, asks: true, busy: { word: 'Polishing' } }
        : { key: 'polish', name: 'Polish', changes: true, asks: true },
    ],
    onPress: 'press',
  })
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      post(JSON.stringify({ read: 2, what: 'list', kind: 'example.com/Widget', namespace: 'default' }))
      commit([['make', 1, 'Header', header()], ['put', 0, 1]])
    }
    if (said.objects && !quiet) {
      if (said.read === 1) widget = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(CUSTOM.widget)})
      commit([['change', 1, header()]])
    }
    if (said.call === 'press') {
      const { button } = said.carries
      if (button === 'nudge') quiet = true
      const patch = button === 'polish' ? { spec: { polishing: true } } : { metadata: { annotations: { 'example.com/nudged': 'yes' } } }
      post(JSON.stringify({ propose: ++n, press: said.press, change: { action: 'patch', target: widget.token, patch }, verb: button === 'polish' ? 'Polish' : 'Nudge' }))
    }
  })
})
`

async function opened(page: Page) {
  await openCluster(page)
  await page.evaluate((to) => {
    window.location.hash = to
  }, `#/cluster/${CONTEXTS.demo}/plugins/polisher/overview`)
  const header = page.locator('[data-plugin-body]').getByRole('group', { name: 'polisher' })
  await expect(header.getByRole('button', { name: 'Polish…' })).toBeVisible()
  return header
}

/**
 * Every name the header's buttons have, each frame, from when Lumovi's dialog has closed on: what
 * a person could have seen once the change was applied.
 */
async function watch(page: Page) {
  await page.evaluate(() => {
    const seen = new Set<string>()
    ;(window as unknown as { __seen: Set<string> }).__seen = seen
    const look = () => {
      if (!document.querySelector('[data-plugin-proposal]')) {
        for (const button of document.querySelectorAll(
          '[data-plugin-body] [role="group"] button',
        )) {
          seen.add(button.getAttribute('aria-label') ?? button.textContent ?? '')
        }
      }
      requestAnimationFrame(look)
    }
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    })
    look()
  })
}
const seen = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen])

test('a button whose change was applied is busy at once, and stays so until the plugin draws it busy itself; cancelled, nothing is held', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'polisher.yaml'), FILE)
  writeFileSync(join(folder, 'polisher.js'), CODE)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  const header = await opened(page)
  const dialog = page.locator('[data-plugin-proposal="polisher"]')

  // Cancelled: nothing was sent, and nothing is busy.
  await header.getByRole('button', { name: 'Polish…' }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Polish…' })).toBeVisible()
  await expect(header.locator('[data-busy]')).toHaveCount(0)

  // Applied: busy at once, in Lumovi's word, then the plugin's; never the button in between,
  // though the page draws for its other read meanwhile.
  await header.getByRole('button', { name: 'Polish…' }).click()
  await expect(dialog.getByRole('button', { name: 'Polish' })).toBeEnabled()
  await watch(page)
  await dialog.getByRole('button', { name: 'Polish' }).click()
  await expect(header.getByRole('button', { name: 'Polish, busy: polishing' })).toBeVisible()
  const names = await seen(page)
  expect(names).not.toContain('Polish…')
  expect(names.filter((name) => name.startsWith('Polish, busy'))).toEqual(
    expect.arrayContaining(['Polish, busy: polishing']),
  )
})

test('held, and the plugin draws nothing more: Lumovi lets it go after ten seconds', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'polisher.yaml'), FILE)
  writeFileSync(join(folder, 'polisher.js'), CODE)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  const header = await opened(page)
  const dialog = page.locator('[data-plugin-proposal="polisher"]')
  const fold = header.getByRole('button', { name: 'Nudge…' })
  await fold.click()
  await expect(dialog.getByRole('button', { name: 'Nudge' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Nudge' }).click()
  const started = Date.now()
  // Busy at once, in Lumovi's word and with no time; its tooltip says so.
  const held = header.getByRole('button', { name: 'Nudge, busy: sent' })
  await expect(held).toBeVisible()
  await expect(held).toHaveText('Sent')
  await held.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Sent. Nudge can be pressed again when it’s done.',
  )
  // Still held once the changed widget was read again: the plugin hasn't drawn since.
  await expect.poll(() => Date.now() - started, { timeout: 8_000 }).toBeGreaterThanOrEqual(5_000)
  await expect(held).toBeVisible()
  // Let go at ten seconds: the plugin's own button again.
  await expect(header.getByRole('button', { name: 'Nudge…' })).toBeVisible({ timeout: 15_000 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
})
