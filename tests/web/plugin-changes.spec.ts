/**
 * Changes through the door, on a server: a plugin's page proposes a change right after a press,
 * and Lumovi shows it in its own dialog, asks the cluster first, and makes it, as the person, only
 * once they confirm there. The page is told only what became of it; the history says which
 * plugin, version and digests proposed it. A proposal that follows no press, or names what its
 * file doesn't grant, opens nothing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { cutWords } from '../commands.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { audited, DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'

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
  changes:
    - group: example.com
      kind: Widget
      actions: [patch, create, delete]
      harm: [{ path: spec.wipe, is: true, says: Wipes every part it has., verb: wipe, unless: { path: spec.dryRun, is: true } }]
`

/**
 * Its code: it reads the widgets, and draws a header whose buttons propose changes to the first;
 * what became of each it says in the header's name, so the test sees what it was told.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let widget
  let n = 0
  const BUTTONS = [
    // (One that only reads: its press has no token, so what it proposes is refused.)
    { key: 'look', name: 'Look' },
    { key: 'resize', name: 'Resize', changes: true },
    { key: 'remove', name: 'Remove', changes: true },
    { key: 'stale', name: 'Stale', changes: true },
    { key: 'secret', name: 'Secret', changes: true },
    { key: 'copy', name: 'Copy', changes: true },
    { key: 'note', name: 'Note', changes: true },
  ]
  // (A change is the part's props whole: its buttons said again with its name.)
  const say = (name) => commit([['change', 1, { name, buttons: BUTTONS, onPress: 'press' }]])
  const propose = (press, change, extra = {}) =>
    post(JSON.stringify({ propose: ++n, press, change, ...extra }))
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([
        ['make', 1, 'Header', { name: 'ready', buttons: BUTTONS, onPress: 'press' }],
        ['put', 0, 1],
        // A row's buttons: one changes the widget, one only reads.
        ['make', 2, 'Table', {
          title: 'Widgets',
          headings: false,
          columns: [{ name: 'Do', kind: 'button' }],
          rows: [
            { key: 'shrink', lead: { name: 'shrink' }, cells: [{ kind: 'button', key: 'shrink', name: 'Shrink', changes: true, asks: true }] },
            { key: 'peek', lead: { name: 'peek' }, cells: [{ kind: 'button', key: 'peek', name: 'Peek' }] },
            { key: 'tune', lead: { name: 'tune' }, cells: [{ kind: 'button', key: 'tune', name: 'Tune', changes: true, asks: true }] },
          ],
          onPress: 'rowPress',
        }],
        ['put', 0, 2],
      ])
    }
    if (said.read === 1 && said.objects) {
      // (A list is kept up to date: proposed once, on its first answer.)
      const first = widget === undefined
      widget = said.objects[0] && said.objects[0].token
      // Proposed before any press: refused, and nothing is shown.
      if (first) propose('no-press', { action: 'patch', target: widget, patch: { spec: { size: 9 } } })
    }
    if (said.proposed) say('outcome ' + said.proposed + ' ' + said.outcome)
    if (said.call === 'rowPress' && said.carries.row === 'tune') {
      // A form past five fields, in sections: checks, a switch showing its limit, a pick of a list.
      propose(said.press, { action: 'patch', target: widget, patch: { spec: {
        wipe: { field: 'wipe' }, polish: { field: 'polish' }, retry: { limit: { field: 'limit' } }, parts: { field: 'parts' }, dryRun: { field: 'dryRun' },
      } } }, {
        verb: 'Tune',
        fields: [
          { kind: 'section', label: 'How' },
          { kind: 'check', key: 'wipe', label: 'Wipe' },
          { kind: 'check', key: 'polish', label: 'Polish' },
          { kind: 'switch', key: 'dryRun', label: 'Dry run', verb: 'Dry run' },
          { kind: 'section', label: 'If it fails' },
          { kind: 'switch', key: 'retry', label: 'Retry', shows: ['limit'] },
          { kind: 'number', key: 'limit', label: 'Limit', min: 1, max: 5, value: 2 },
          { kind: 'section', label: 'Parts' },
          { kind: 'picks', key: 'parts', label: 'Only these', options: [{ label: 'bolt', value: { name: 'bolt', count: 1 } }, { label: 'gear', value: { name: 'gear', count: 1 } }] },
        ],
        harm: [{ path: 'spec.wipe', detail: 'The bolt and the gear go.' }],
      })
    } else if (said.call === 'rowPress') {
      propose(said.press, { action: 'patch', target: widget, patch: { spec: { size: 1 } } }, { verb: 'Shrink' })
    }
    if (said.call === 'press') {
      const { button } = said.carries
      if (button === 'resize') {
        propose(said.press, { action: 'patch', target: widget, patch: { spec: { size: { field: 'size' }, color: { field: 'color' } } } }, {
          verb: 'Resize',
          fields: [
            { kind: 'number', key: 'size', label: 'Size', hint: 'In widget units.', min: 1, max: 10, value: 3 },
            { kind: 'choice', key: 'color', label: 'Colour', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }], value: 1 },
          ],
        })
      }
      if (button === 'remove') propose(said.press, { action: 'delete', target: widget })
      if (button === 'look') propose(said.press, { action: 'delete', target: widget })
      // A press spent already, by the proposal before it: refused.
      if (button === 'stale') {
        propose(said.press, { action: 'delete', target: widget })
        propose(said.press, { action: 'delete', target: widget })
      }
      // A new widget beside the first, named by the cluster from its generateName.
      if (button === 'copy') propose(said.press, { action: 'create', kind: 'example.com/Widget', in: widget, object: { spec: { size: 1 }, metadata: { generateName: 'copy-' } } })
      // Notes as long as a change may be: all of it in its command.
      if (button === 'note') {
        const annotations = {}
        for (let i = 0; i < 56; i++) annotations['example.com/note-' + i] = 'n'.repeat(230)
        propose(said.press, { action: 'patch', target: widget, patch: { metadata: { annotations } } })
      }
      // A kind its file doesn't say it changes: refused before any dialog.
      if (button === 'secret') propose(said.press, { action: 'create', kind: '/Secret', object: { metadata: { name: 'x' } } })
    }
  })
})
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with Tinker in it, as if it came with Lumovi (it knows its own address, for the box). */
async function served(serve: Serve, env: Record<string, string> = {}) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'tinker.yaml'), TINKER)
  writeFileSync(join(included, 'tinker.js'), CODE)
  const port = await freePort()
  return serve({
    port,
    env: {
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      ...env,
    },
  })
}

const body = (page: Page) => page.locator('[data-plugin-body]')
/** What the plugin was told last: its header's name. */
// (Read as an element: while Lumovi's dialog is open, the page under it is hidden from roles.)
const said = (page: Page) => body(page).locator('h2').first()
const dialog = (page: Page) => page.locator('[data-plugin-proposal="tinker"]')

/** Presses one of the header's buttons: in its place, or in its More menu (past the last two). */
async function press(page: Page, name: string) {
  const button = body(page).getByRole('button', { name, exact: true })
  if (await button.isVisible()) return button.click()
  await body(page)
    .getByRole('button', { name: /^More for / })
    .click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function opened(page: Page, server: Served) {
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/overview`, DEMO_TOKEN)
  // (Proposed before any press, on its first read: refused.)
  await expect(said(page)).toContainText('outcome 1 refused', { timeout: 30_000 })
}

test('a change proposed after a press is shown in Lumovi’s dialog, asked of the cluster, and made only once confirmed', async ({
  serve,
  page,
  clusters,
}) => {
  test.slow()
  const server = await served(serve)
  await opened(page, server)
  await press(page, 'Resize')
  const shown = dialog(page)
  await expect(shown.getByRole('heading')).toHaveText(
    `Tinker asks to change the Widget default/${CUSTOM.widget}`,
  )
  await expect(shown).toContainText('From Tinker 1.0.0')
  await expect(shown.getByRole('region', { name: 'Options, in Tinker’s words' })).toContainText(
    'In widget units.',
  )
  // Asked of the cluster first: the change as it would be, and its command.
  await expect(shown).toContainText('The cluster accepts it, as the options stand.')
  await expect(shown).toContainText('kubectl patch widget.example.com/blue-widget --type merge')
  // The focus starts in the first field, never on the button; Enter there confirms nothing.
  await expect(shown.getByLabel('Size')).toBeFocused()
  await shown.getByLabel('Size').fill('11')
  await expect(shown).toContainText('A whole number from 1 to 10.')
  await expect(shown.getByRole('button', { name: 'Resize' })).toBeDisabled()
  await shown.getByLabel('Size').fill('5')
  await shown.getByLabel('Size').press('Enter')
  await shown.getByRole('radio', { name: 'Red' }).click()
  await expect(shown).toContainText('The cluster accepts it, as the options stand.')
  expect(
    clusters.demo.requests.filter((r) => r.method === 'PATCH' && !r.search?.includes('dryRun')),
  ).toEqual([])
  // Confirmed: made as shown, and the page told only that it was.
  await expect(shown.getByRole('button', { name: 'Resize' })).toBeEnabled()
  await shown.getByRole('button', { name: 'Resize' }).click()
  await expect(said(page)).toContainText('outcome 2 applied')
  await expect(shown).toHaveCount(0)
  const made = clusters.demo.requests.filter(
    (r) =>
      r.method === 'PATCH' &&
      r.path.endsWith(`/widgets/${CUSTOM.widget}`) &&
      !r.search?.includes('dryRun'),
  )
  expect(made).toHaveLength(1)
  // In the history: Lumovi's words, the plugin's name, version and digests, and which fields
  // the person changed (never their values).
  const [change] = audited(server, 'plugin.change')
  expect(change?.outcome).toBe('success')
  expect(change?.summary).toBe(
    `Changed the Widget default/${CUSTOM.widget}, as the plugin Tinker 1.0.0 proposed`,
  )
  expect(change?.details).toMatchObject({
    plugin: 'tinker',
    pluginVersion: '1.0.0',
    action: 'patch',
    fields: ['size', 'color'],
  })
  expect(String(change?.details?.pluginDigest)).toMatch(/^sha256:/)
  // A patch's command would carry what was typed: its fields' paths are kept instead.
  expect(change?.command).toBeUndefined()
  expect(change?.details?.paths).toEqual(['spec.size', 'spec.color'])
  expect(JSON.stringify(change?.details)).not.toContain('"5"')
})

test('a cancelled change is never made, and a deletion is Lumovi’s own “Delete”', async ({
  serve,
  page,
  clusters,
}) => {
  test.slow()
  const server = await served(serve)
  await opened(page, server)
  await press(page, 'Remove')
  const shown = dialog(page)
  await expect(shown.getByRole('heading')).toHaveText(
    `Tinker asks to delete the Widget default/${CUSTOM.widget}`,
  )
  await expect(shown).toContainText('What Lumovi will do')
  await expect(shown.getByRole('button', { name: 'Delete' })).toBeVisible()
  // (No options: what the cluster accepts is the change itself.)
  await expect(shown).toContainText('The cluster accepts it.')
  await expect(shown).not.toContainText('as the options stand')
  // (No fields: the focus starts on Cancel.)
  await expect(shown.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(said(page)).toContainText('outcome 2 cancelled')
  expect(
    clusters.demo.requests.filter((r) => r.method === 'DELETE' && !r.search?.includes('dryRun')),
  ).toEqual([])
  const [cancelled] = audited(server, 'plugin.change')
  expect(cancelled?.outcome).toBe('cancelled')
  expect(cancelled?.summary).toBe(
    `Didn’t delete the Widget default/${CUSTOM.widget} that the plugin Tinker 1.0.0 proposed: cancelled`,
  )
})

test('a proposal that follows a spent press, or names a kind its file doesn’t grant, opens nothing', async ({
  serve,
  page,
}) => {
  test.slow()
  const server = await served(serve)
  await opened(page, server)
  // The first of two on one press is shown; the second, on the same press, is refused.
  await press(page, 'Stale')
  await expect(said(page)).toContainText('outcome 3 refused')
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(said(page)).toContainText('outcome 2 cancelled')
  // One of Kubernetes' own kinds: refused at the door, nothing shown, nothing recorded.
  await press(page, 'Secret')
  await expect(said(page)).toContainText('outcome 4 refused')
  await expect(dialog(page)).toHaveCount(0)
  expect(audited(server, 'plugin.change').map((event) => event.outcome)).toEqual(['cancelled'])
  // What the backend is asked to send is held to the door's rule there too, whatever a page says.
  const asked = await page.evaluate(
    (name) =>
      (
        window as unknown as {
          lumovi: { kube: { pluginChange(request: object): Promise<unknown> } }
        }
      ).lumovi.kube.pluginChange({
        step: 'try',
        plugin: 'tinker',
        digest: '',
        codeDigest: '',
        context: 'demo',
        action: 'patch',
        target: { kind: 'Widget.example.com', name, namespace: 'default' },
        body: {
          metadata: { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: 'x', uid: 'u' }] },
        },
      }),
    CUSTOM.widget,
  )
  expect(asked).toMatchObject({ ok: false, refused: 'not-granted' })
  expect(audited(server, 'plugin.change')).toHaveLength(1)
})

test('on a server, a browser Lumovi hands no plugin’s code to proposes nothing', async ({
  serve,
  page,
}) => {
  // (The second wall off for this session: no code is handed, and no change of a plugin's is asked.)
  const server = await served(serve, { LUMOVI_SEC_FETCH_SITE: 'off' })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  const answer = await page.evaluate(
    (name) =>
      (
        window as unknown as {
          lumovi: { kube: { pluginChange(request: object): Promise<unknown> } }
        }
      ).lumovi.kube.pluginChange({
        step: 'check',
        plugin: 'tinker',
        digest: '',
        codeDigest: '',
        context: 'demo',
        action: 'patch',
        target: { kind: 'Widget.example.com', name, namespace: 'default' },
      }),
    CUSTOM.widget,
  )
  expect(answer).toEqual({ ok: false, refused: 'not-held' })
  expect(audited(server, 'plugin.change')).toEqual([])
})

test('a create shows the object Lumovi sends, its generateName as asked, and its command reads that very object', async ({
  serve,
  page,
}) => {
  test.slow()
  const server = await served(serve)
  await opened(page, server)
  await press(page, 'Copy')
  const shown = dialog(page)
  await expect(shown).toContainText('The cluster accepts it.')
  // In Kubernetes' order, with the generateName it asks for (not the name a dry run made up).
  const object = shown.getByLabel('The whole object Lumovi will create')
  await expect(object).toContainText('generateName: copy-')
  const text = await object.innerText()
  expect(text).not.toMatch(/(^|\s)name: /)
  expect(text.indexOf('apiVersion:')).toBeLessThan(text.indexOf('metadata:'))
  expect(text.indexOf('metadata:')).toBeLessThan(text.indexOf('spec:'))
  await expect(shown).toContainText("kubectl create -f - -n default --context demo <<'LUMOVI_EOF'")
  await expect(shown).not.toContainText('.yaml')
  // The command reads the object shown above: its first line and its end, the object said in a
  // line, not printed again.
  const command = shown.locator('[data-proposal-command]')
  await expect(command).toContainText(/the object above, \d+ lines/)
  await expect(command).toContainText(/LUMOVI_EOF$/)
  // However tall the object, what Lumovi will send's command, the verdict and the buttons stay
  // in view: the object scrolls in its box. (In a window too short for all of it, and tall
  // enough for the command's two lines: where it all fits, the object shows whole.)
  await page.setViewportSize({ width: 1280, height: 500 })
  for (const inView of [
    shown.getByRole('button', { name: 'Cancel' }),
    shown.getByRole('button', { name: 'Create' }),
    command,
    shown.getByText('The cluster accepts it.'),
  ]) {
    await expect(inView).toBeInViewport({ ratio: 1 })
  }
  await expect
    .poll(() =>
      shown
        .locator('[data-proposal-object]')
        .evaluate((box) => box.scrollHeight > box.clientHeight),
    )
    .toBe(true)
  // Confirmed: made, and the cluster names it.
  await expect(shown.getByRole('button', { name: 'Create' })).toBeEnabled()
  await shown.getByRole('button', { name: 'Create' }).click()
  await expect(said(page)).toContainText('applied')
  // The audit keeps no command for it (that would hold what was set): what it wrote, by path.
  const [made] = audited(server, 'plugin.change').filter(
    (entry) => entry.details?.action === 'create',
  )
  expect(made?.outcome).toBe('success')
  expect(made?.command).toBeUndefined()
  // (In the order the plugin wrote them, as a patch's are.)
  expect(made?.details?.paths).toEqual(['spec.size', 'metadata.generateName'])
})

test('a change as long as a plugin may send keeps its buttons in reach: its command scrolls in its box', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await opened(page, server)
  await press(page, 'Note')
  const shown = dialog(page)
  await expect(shown).toContainText('The cluster accepts it.')
  const command = shown.locator('[data-proposal-command]')
  await expect(command).toContainText('kubectl annotate')
  await expect(command).toContainText(`example.com/note-55=${'n'.repeat(230)}`)
  // (Broken only between its words, but for a word wider than its box.)
  expect(await cutWords(command)).toEqual([])
  await page.setViewportSize({ width: 1280, height: 600 })
  for (const inView of [
    shown.locator('[data-cancel]'),
    shown.locator('[data-confirm]'),
    shown.getByText('The cluster accepts it.'),
  ]) {
    await expect(inView).toBeInViewport({ ratio: 1 })
  }
  await expect.poll(() => command.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true)
  // Its last lines fade while there's more of it below; the keyboard scrolls it to its end, and
  // then nothing fades.
  const fade = () => command.evaluate((box) => getComputedStyle(box).maskImage)
  await expect.poll(fade).toContain('gradient')
  const region = shown.getByRole('region', { name: 'Equivalent command' })
  await region.focus()
  await page.keyboard.press('End')
  await expect
    .poll(() => command.evaluate((box) => box.scrollTop + box.clientHeight >= box.scrollHeight - 1))
    .toBe(true)
  await expect.poll(fade).toBe('none')
  await shown.locator('[data-cancel]').click()
  await expect(said(page)).toContainText('outcome 2 cancelled')
})

test('a press of a button that only reads proposes nothing: it has no token to spend', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await opened(page, server)
  await press(page, 'Look')
  await expect(said(page)).toContainText('outcome 2 refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a row’s button that changes something proposes a change, shown in Lumovi’s dialog; one that only reads proposes nothing', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await opened(page, server)
  // One that only reads: its press has no token, so what it proposes is refused.
  await body(page).getByRole('button', { name: 'Peek', exact: true }).click()
  await expect(said(page)).toContainText('outcome 2 refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // One that changes: Lumovi's own dialog, with the plugin's verb, and nothing made until it's
  // confirmed.
  await body(page).getByRole('button', { name: 'Shrink…', exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Shrink', exact: true })).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(said(page)).toContainText('outcome 3 cancelled')
})

test('a form past five fields stands in sections; a switch shows its field; a harm the file names is drawn in red and named on the button, but not on a dry run', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await opened(page, server)
  await body(page).getByRole('button', { name: 'Tune…', exact: true }).click()
  const shown = dialog(page)
  await expect(shown).toBeVisible()
  // In sections, under the plugin's headings.
  await expect(shown.getByRole('heading', { level: 4 })).toHaveText(['How', 'If it fails', 'Parts'])
  // A switch's field stands only while it's on.
  await expect(shown.getByText('Limit', { exact: true })).toHaveCount(0)
  await shown.getByRole('switch', { name: 'Retry' }).click()
  await expect(shown.getByText('Limit', { exact: true })).toBeVisible()
  // Nothing harms yet; the button is the plugin's word.
  await expect(shown.getByRole('region', { name: 'What it harms' })).toHaveCount(0)
  await expect(shown.getByRole('button', { name: 'Tune', exact: true })).toBeVisible()
  // Wipe on: its file's words in red, the page's detail as its own words, and the harm named on the
  // button, which is the danger one.
  await shown.getByRole('checkbox', { name: 'Wipe' }).check()
  const harms = shown.getByRole('region', { name: 'What it harms' })
  await expect(harms).toContainText('Wipes every part it has.')
  await expect(harms).toContainText('In Tinker’s words: The bolt and the gear go.')
  await expect(shown.getByRole('button', { name: 'Tune and wipe', exact: true })).toBeVisible()
  // A dry run, as the file says it, harms nothing: the button is the switch's word, nothing in red.
  await shown.getByRole('switch', { name: 'Dry run' }).click()
  await expect(shown.getByRole('region', { name: 'What it harms' })).toHaveCount(0)
  await expect(shown.getByRole('button', { name: 'Dry run', exact: true })).toBeVisible()
  await shown.getByRole('switch', { name: 'Dry run' }).click()
  await expect(shown.getByRole('button', { name: 'Tune and wipe', exact: true })).toBeVisible()
  // What's sent is what the fields say: picked parts as their values.
  await shown
    .getByRole('group', { name: 'Only these' })
    .getByRole('checkbox', { name: 'gear' })
    .check()
  await expect(shown).toContainText('The cluster accepts it, as the options stand.')
  await shown.getByRole('button', { name: 'Cancel' }).click()
  await expect(said(page)).toContainText('outcome 2 cancelled')
})

/** Which end of its track a switch's knob is drawn at: its start or its end. */
const knobAt = (control: Locator) =>
  control.evaluate((track) => {
    const box = track.getBoundingClientRect()
    const knob = track.firstElementChild!.getBoundingClientRect()
    return knob.left + knob.width / 2 < box.left + box.width / 2 ? 'start' : 'end'
  })

const trackOf = (control: Locator) =>
  control.evaluate((track) => getComputedStyle(track).backgroundColor)

test('a switch in Lumovi’s dialog is Lumovi’s own: off, its knob at the start; on, at the end, on the accent; in both themes', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await opened(page, server)
  await body(page).getByRole('button', { name: 'Tune…', exact: true }).click()
  const dry = dialog(page).getByRole('switch', { name: 'Dry run' })
  const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  let light = ''
  for (const theme of ['light', 'dark'] as const) {
    // (As the Theme menu sets it; dark once the page is drawn so, unlike light.)
    await page.evaluate((chosen) => {
      document.documentElement.dataset.theme = chosen
    }, theme)
    if (theme === 'light') light = await ground()
    else await expect.poll(ground).not.toBe(light)
    await expect(dry).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => knobAt(dry)).toBe('start')
    const off = await trackOf(dry)
    await dry.click()
    await expect(dry).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => knobAt(dry)).toBe('end')
    await expect.poll(() => trackOf(dry)).not.toBe(off)
    await dry.click()
    await expect.poll(() => knobAt(dry)).toBe('start')
  }
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(said(page)).toContainText('cancelled')
})
