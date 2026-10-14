/**
 * A page's change, made after its object moved: judged again, on the object as it is then. Its
 * tool rewrote what the change doesn't touch (its status), and it's made, with the version the
 * object has now; something it does changed, and nothing is made: Lumovi's dialog says so, and
 * shows the change again as it stands.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { DEMO_TOKEN, expect, freePort, signIn, test } from './fixtures.ts'

const FILE = `apiVersion: lumovi.dev/v1beta1
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

/** Its code: a header whose Grow proposes the widget's size be 7; what became of it, in its name. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const BUTTONS = [{ key: 'grow', name: 'Grow', changes: true }]
  let widget
  let n = 0
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([['make', 1, 'Header', { name: 'ready', buttons: BUTTONS, onPress: 'press' }], ['put', 0, 1]])
    }
    if (said.read === 1 && said.objects) widget = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(CUSTOM.widget)})
    if (said.proposed) commit([['change', 1, { name: 'outcome ' + said.proposed + ' ' + said.outcome, buttons: BUTTONS, onPress: 'press' }]])
    if (said.call === 'press') post(JSON.stringify({ propose: ++n, press: said.press, change: { action: 'patch', target: widget.token, patch: { spec: { size: 7 } } }, verb: 'Grow' }))
  })
})
`

const body = (page: Page) => page.locator('[data-plugin-body]')
const dialog = (page: Page) => page.locator('[data-plugin-proposal="tinker"]')

test('a change made after its tool rewrote its object is made, with the version it has now; one whose effect changed is shown again, and not made', async ({
  serve,
  page,
  clusters,
}) => {
  test.slow()
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'tinker.yaml'), FILE)
  writeFileSync(join(included, 'tinker.js'), CODE)
  const port = await freePort()
  const server = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/overview`, DEMO_TOKEN)
  const widget = () =>
    clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget) as KubeObject & {
      spec: { size?: number }
      status?: Record<string, unknown>
    }
  const rewrite = (to: (object: ReturnType<typeof widget>) => KubeObject) =>
    clusters.demo.upsert(to(structuredClone(widget())))
  const shown = dialog(page)
  const grow = body(page).getByRole('button', { name: 'Grow', exact: true })
  const made = () =>
    clusters.demo.requests.filter(
      (r) =>
        r.method === 'PATCH' &&
        r.path.endsWith(`/widgets/${CUSTOM.widget}`) &&
        !r.search?.includes('dryRun'),
    )

  // Its tool rewrites its status while the dialog is open: made all the same.
  await grow.click()
  await expect(shown).toContainText('The cluster accepts it')
  const seen = widget().metadata.resourceVersion
  rewrite((object) => ({
    ...object,
    status: { ...object.status, polishedAt: new Date().toISOString() },
  }))
  expect(widget().metadata.resourceVersion).not.toBe(seen)
  await shown.getByRole('button', { name: 'Grow' }).click()
  await expect(body(page).locator('h2').first()).toContainText('outcome 1 applied')
  await expect(shown).toHaveCount(0)
  expect(widget().spec.size).toBe(7)
  expect(made()).toHaveLength(1)

  // Someone else sets what it sets, while it's open: nothing is made, and the dialog says so and
  // shows the change again as it stands.
  rewrite((object) => ({ ...object, spec: { ...object.spec, size: 3 } }))
  await grow.click()
  await expect(shown).toContainText('The cluster accepts it')
  rewrite((object) => ({ ...object, spec: { ...object.spec, size: 5 } }))
  await shown.getByRole('button', { name: 'Grow' }).click()
  await expect(shown).toContainText(
    'changed since this was shown. Here is the change again, as it stands now.',
  )
  expect(made()).toHaveLength(1)
  expect(widget().spec.size).toBe(5)
})
