/**
 * A hostile plugin against the door on the desktop, where it takes more than the door alone: a
 * change on a cluster that's read-only in Lumovi is shown nowhere and made nowhere, even by a
 * page that skips Lumovi's question; and an ask of a tool's server about an object of a kind
 * that's in no namespace asks nothing of the cluster.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const TINKER = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: tinker }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Tinker
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  changes: [{ group: example.com, kind: Widget, actions: [patch] }]
`
/** Its code: a header whose one button proposes resizing the first widget; it says what came of it. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const BUTTONS = [{ key: 'resize', name: 'Resize', changes: true }]
  let widget
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([['make', 1, 'Header', { name: 'ready', buttons: BUTTONS, onPress: 'press' }], ['put', 0, 1]])
    }
    if (said.read === 1 && said.objects) widget = said.objects[0] && said.objects[0].token
    if (said.proposed) commit([['change', 1, { name: 'outcome ' + said.outcome, buttons: BUTTONS, onPress: 'press' }]])
    if (said.call === 'press') post(JSON.stringify({ propose: 1, press: said.press, change: { action: 'patch', target: widget, patch: { spec: { size: 9 } } } }))
  })
})
`
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function included() {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'tinker.yaml'), TINKER)
  writeFileSync(join(folder, 'tinker.js'), CODE)
  return folder
}
const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')

test('on a cluster read-only in Lumovi a plugin’s change is shown nowhere, and made nowhere, even asked straight', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await page.evaluate((context) => window.lumovi!.app.setReadOnly(context, true), CONTEXTS.demo)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/tinker/overview`)
  await expect(body(page).getByRole('button', { name: 'Resize' })).toBeVisible({ timeout: 20_000 })
  const before = clusters.demo.requests.length
  await body(page).getByRole('button', { name: 'Resize' }).click()
  // Lumovi's question refuses it: its words, no dialog, and the page told only "refused".
  await expect(
    page.getByText('This cluster is read-only in Lumovi: Tinker’s change isn’t made here.'),
  ).toBeVisible()
  await expect(body(page)).toContainText('outcome refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A page that skips the question and asks to make it straight is refused too.
  const made = await page.evaluate((asked) => window.lumovi!.kube.pluginChange(asked as never), {
    step: 'make',
    plugin: 'tinker',
    digest: sha(TINKER),
    codeDigest: sha(CODE),
    context: CONTEXTS.demo,
    action: 'patch',
    target: { kind: 'Widget.example.com', namespace: 'default', name: CUSTOM.widget },
    body: { spec: { size: 9 } },
    seen: {},
    fields: [],
  })
  expect(made).toMatchObject({ ok: false, refused: 'read-only' })
  // Nothing was written to the cluster.
  expect(
    clusters.demo.requests
      .slice(before)
      .filter((r) => r.method !== 'GET' && r.path.includes('widgets')),
  ).toEqual([])
})
