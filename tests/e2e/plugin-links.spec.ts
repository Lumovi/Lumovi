/**
 * A plugin's page linking to Lumovi's own places for an object it was handed (`spec.links`): a
 * pod's Logs and Shell tabs, its Port forward dialog. Lumovi opens each as it does, with its own
 * icon and words for where it goes; the person does there what they do. A shell a link opened
 * waits for the person's Start, and the history says which plugin's page brought them.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  links: [logs, shell, port-forward]
`

/**
 * Toys' code: it reads shop's pods, and for the first of storefront's draws a header whose
 * buttons link to its shell (in either container) and a forward of its port, and a table whose
 * row links to its envoy's logs.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read !== 1 || !said.objects) return
    const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
    if (!pod) return
    commit([
      ['make', 1, 'Stack', {}],
      ['put', 0, 1],
      ['make', 2, 'Header', { name: 'Storefront', buttons: [
        { key: 'app', name: 'Shell into app', goes: { object: pod.token, at: 'shell', container: 'app' } },
        { key: 'envoy', name: 'Shell into envoy', goes: { object: pod.token, at: 'shell', container: 'envoy' } },
        { key: 'forward', name: 'Forward 8080', goes: { object: pod.token, at: 'port-forward', port: 8080 } },
      ] }],
      ['put', 1, 2],
      ['make', 3, 'Table', { title: 'Pods', columns: [{ name: 'Namespace', kind: 'text' }], headings: false, rows: [
        { key: 'one', lead: { name: pod.object.metadata.name }, cells: [{ kind: 'text', text: 'shop' }], goes: { object: pod.token, at: 'logs', container: 'envoy' } },
        { key: 'two', lead: { name: pod.object.metadata.name }, cells: [{ kind: 'text', text: 'nope' }], goes: { object: pod.token, at: 'shell', container: 'nope' } },
      ] }],
      ['put', 1, 3],
    ])
  })
})
`

function included(file = TOYS) {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file)
  writeFileSync(join(folder, 'toys.js'), CODE)
  return folder
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')
const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

async function opened(page: Page) {
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page).getByRole('button', { name: 'Shell into app' })).toBeVisible({
    timeout: 20_000,
  })
}

test('a link never starts a shell', async ({ launch, clusters }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await opened(page)
  // Lumovi's words for where it goes, and its icon: never the plugin's.
  const link = body(page).getByRole('button', { name: 'Shell into app' })
  await expect(link).toHaveAccessibleDescription(`Opens Pod shop/${POD} at its Shell tab`)
  await link.click()
  const detail = panel(page, 'Pod', POD)
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  const start = detail.locator('[data-shell-start]')
  await expect(start).toContainText(`A shell in ${POD}`)
  await expect(start).toContainText(
    'Toys’ page opened this tab. A shell starts only when you press Start: as you, within your access.',
  )
  await expect(detail.locator('[data-shell-via]')).toHaveText('Opened from Toys’ page')
  // Waiting, nothing is asked of the cluster, and nothing is in the history.
  await expect(start.getByRole('button', { name: 'Start shell' })).toBeVisible()
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
  expect(await events(page, { actions: ['shell.open'] })).toEqual([])
})

/**
 * Watches for Start: the moment it's drawn, pressed at once (a press meant for the link, under
 * the pointer), and when it comes alive. Read by `startWatched`.
 */
const watchStart = (page: Page) =>
  page.evaluate(() => {
    const seen: { drawn?: number; alive?: number } = {}
    ;(window as unknown as { startSeen: typeof seen }).startSeen = seen
    new MutationObserver(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-shell-start] button')
      if (!button) return
      if (seen.drawn === undefined) {
        seen.drawn = performance.now()
        button.click()
      }
      if (seen.alive === undefined && button.getAttribute('aria-disabled') !== 'true') {
        seen.alive = performance.now()
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
const startWatched = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { startSeen: { drawn?: number; alive?: number } }).startSeen,
  )

test('Start isn’t focused', async ({ launch, clusters }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await opened(page)
  await watchStart(page)
  await body(page).getByRole('button', { name: 'Shell into app' }).click()
  const detail = panel(page, 'Pod', POD)
  const start = detail.locator('[data-shell-start]')
  const button = start.getByRole('button', { name: 'Start shell' })
  // The focus starts on the container, never on Start; Enter there starts nothing.
  await expect(start.getByRole('combobox', { name: 'Container' })).toBeFocused()
  await page.keyboard.press('Enter')
  // A press the moment it's drawn did nothing; it comes alive only after the moment.
  await expect(button).not.toHaveAttribute('aria-disabled', 'true')
  const { drawn, alive } = await startWatched(page)
  expect(alive! - drawn!).toBeGreaterThanOrEqual(550)
  // Alive, Enter on Start still doesn't press it.
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(start).toBeVisible()
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
  // Pressed, it starts the shell, as the person.
  await button.click()
  await expect(start).toHaveCount(0)
  await expect(detail.locator('.xterm')).toBeVisible()
  await expect
    .poll(() => clusters.demo.requests.find((r) => r.path.endsWith(`/pods/${POD}/exec`))?.search)
    .toContain('container=app')
  // The history says which plugin's page brought the person there.
  await expect
    .poll(async () => (await events(page, { actions: ['shell.open'] }))[0])
    .toMatchObject({
      outcome: 'success',
      summary: `Opened a shell in Pod ${POD} (app), from the plugin Toys’ page`,
      details: { container: 'app', plugin: 'toys', pluginVersion: '1.2.0' },
    })
})

test('a second link while it waits only changes the container', async ({ launch, clusters }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await opened(page)
  await body(page).getByRole('button', { name: 'Shell into app' }).click()
  const detail = panel(page, 'Pod', POD)
  const start = detail.locator('[data-shell-start]')
  await expect(start.getByRole('combobox', { name: 'Container' })).toHaveValue('app')
  await body(page).getByRole('button', { name: 'Shell into envoy' }).click()
  await expect(start.getByRole('combobox', { name: 'Container' })).toHaveValue('envoy')
  await expect(start.locator('[data-shell-missing]')).toHaveCount(0)
  await expect(start.getByRole('button', { name: 'Start shell' })).toBeVisible()
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
})

test('a link naming a container the pod hasn’t opens the Shell tab as Lumovi would, on its first', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await opened(page)
  // (A row that links to its shell, naming a container its pod hasn't.)
  await body(page)
    .getByRole('row', { name: `${POD} nope` })
    .click()
  const start = panel(page, 'Pod', POD).locator('[data-shell-start]')
  await expect(start).toContainText(`A shell in ${POD}`)
  const container = start.getByRole('combobox', { name: 'Container' })
  await expect(container).toHaveValue('app')
  await expect(container.locator('option')).toHaveText(['app', 'envoy'])
  // Said, quietly, under what it would be.
  await expect(start.locator('[data-shell-missing]')).toHaveText(
    'Toys’ page asked for a container named nope, which this pod doesn’t have.',
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
})

test('a link opens a pod’s logs at the container it names, and its Port forward dialog at the port', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await opened(page)
  // A row that links to its logs says where, in Lumovi's words: read after it, and first in its
  // tooltip, Lumovi's own (never a title of the browser's). Pressed, it's there.
  const row = body(page).getByRole('row', { name: `${POD} shop` })
  await expect(row).toHaveAccessibleDescription(
    new RegExp(`^Opens Pod shop/${POD} at its Logs tab`),
  )
  await expect(row).not.toHaveAttribute('title')
  await row.hover({ position: { x: 6, y: 6 } })
  await row.hover({ position: { x: 10, y: 8 } })
  await expect(page.getByRole('tooltip')).toContainText(`Opens Pod shop/${POD} at its Logs tab`)
  await row.click()
  const detail = panel(page, 'Pod', POD)
  await expect(detail.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByRole('combobox', { name: 'Container' })).toHaveValue('envoy')
  await page.keyboard.press('Escape')
  // A forward: Lumovi's own dialog, its port filled in; nothing starts until it's pressed.
  await body(page).getByRole('button', { name: 'Forward 8080' }).click()
  const dialog = page.getByRole('dialog', { name: `Forward a port to ${POD}` })
  await expect(dialog).toContainText(`kubectl port-forward pod/${POD}`)
  await expect(dialog).toContainText(':8080')
  expect(await events(page, { actions: ['port-forward.open'] })).toEqual([])
})

test('the Plugins page says where its pages link to', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  await expect(page.locator('[data-plugin-links]')).toHaveText(
    'Its pages may open Lumovi’s Logs and Shell tabs for pods they show, and its Port forward dialog for pods and services. You start a shell or a forward there yourself.',
  )
})
