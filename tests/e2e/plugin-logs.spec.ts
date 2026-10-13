/**
 * A pod's logs on a plugin's page, where its file says its pages show them (`spec.logs: shown`):
 * Lumovi reads them as the person and draws them in its own log view, and the plugin's code
 * never holds a line. The history says whose page they were shown on.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!
/** Five running pods of shop's: storefront's three and cart's two. */
const FIVE_PODS = [...DEMO.pods.storefront, ...DEMO.pods.cart]

const toys = (logs: boolean) => `apiVersion: lumovi.dev/v1beta1
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
${logs ? '  logs: shown\n' : ''}`

/** Toys' code: it reads shop's pods, and shows the envoy's logs of the first of storefront's. */
const CODE = `box.then(({ post, listen }) => {
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read !== 1 || !said.objects) return
    const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
    if (!pod) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Logs', { title: 'Its proxy', pod: pod.token, container: 'envoy' }],
      ['put', 0, 1],
    ] }))
  })
})
`

function included(logs = true) {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), toys(logs))
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

test('a pod’s logs on a plugin’s page are Lumovi’s to read and draw, and the history says whose page they were on', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // Lumovi's own log view, at the container the page named, following.
  const log = body(page).getByRole('log', { name: 'Logs for envoy' })
  await expect(log).toBeVisible({ timeout: 20_000 })
  clusters.demo.appendLogs('shop', POD, 'envoy', ['shown-on-a-page'])
  await expect(log).toContainText('shown-on-a-page')
  // Read as the person, for the plugin's page: the history names it, as Lumovi knows it.
  await expect
    .poll(async () => (await events(page, { actions: ['logs.read'] }))[0])
    .toMatchObject({
      outcome: 'success',
      summary: `Read the logs of Pod ${POD} (envoy), shown on the plugin Toys’ page`,
      details: { container: 'envoy', follow: true, plugin: 'toys', pluginVersion: '1.2.0' },
    })
})

test('a plugin whose file doesn’t say its pages show logs can’t show them', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(false) } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // The door knows no Logs part for it: the page is stopped, and nothing is read.
  await expect(body(page).getByTestId('plugin-ended')).toContainText(
    'It sent something a plugin can’t.',
    { timeout: 20_000 },
  )
  expect(await events(page, { actions: ['logs.read'] })).toEqual([])
})

test('the Plugins page says a plugin shows logs, and that its code never sees them', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const read = page.getByRole('region', { name: 'May read' })
  await expect(
    read.getByText('It shows containers’ logs: Lumovi reads them, and its code never sees them.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    read.getByText('It reads no Secret’s value. It sends nothing anywhere but to this cluster.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(read).not.toContainText('Turned off by your organization’s policy')
})

/**
 * Toys' code for five: the logs of five of shop's running pods, each its own part, and a button
 * that takes the first of them away.
 */
const FIVE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let drawn = false
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.call === 'press') commit([['take', 1, 10]])
    // (A list is kept up to date: drawn once, on its first answer.)
    if (said.read !== 1 || !said.objects || drawn) return
    drawn = true
    const pods = said.objects.filter((o) => ${JSON.stringify(FIVE_PODS)}.includes(o.object.metadata.name))
    commit([
      ['make', 1, 'Stack', {}],
      ['put', 0, 1],
      ['make', 2, 'Header', { name: 'Shop', buttons: [{ key: 'close', name: 'Close the first' }], onPress: 'press' }],
      ['put', 1, 2],
      ...pods.flatMap((pod, i) => [
        ['make', 10 + i, 'Logs', { title: pod.object.metadata.name, pod: pod.token, container: 'app' }],
        ['put', 1, 10 + i],
      ]),
    ])
  })
})
`

test('a page shows four logs at once; the fifth waits, and starts when another closes', async ({
  launch,
}) => {
  const folder = included()
  writeFileSync(join(folder, 'toys.js'), FIVE)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  const logs = body(page).getByRole('log')
  const waiting = body(page).locator('[data-logs-waiting]')
  await expect(logs).toHaveCount(4, { timeout: 20_000 })
  await expect(waiting).toHaveText(
    'Not shown: a plugin’s page shows 4 logs at once. This one starts when another closes.',
  )
  // Only those streaming are read.
  const read = async () =>
    new Set((await events(page, { actions: ['logs.read'] })).map((e) => e.target?.name)).size
  await expect.poll(read).toBe(4)
  // One goes: the one that waited streams, in its place.
  // (The one waiting, by its card's name: the parts are in the order the page read its pods.)
  const fifth = (await body(page)
    .locator('section', { has: page.locator('[data-logs-waiting]') })
    .getAttribute('aria-label'))!
  await body(page).getByRole('button', { name: 'Close the first' }).click()
  await expect(waiting).toHaveCount(0)
  // (A part's log view is drawn once it's in view, as any is.)
  const its = body(page).getByRole('region', { name: fifth, exact: true })
  await its.scrollIntoViewIfNeeded()
  await expect(its.getByRole('log')).toBeVisible()
  await expect(logs).toHaveCount(4)
  await expect.poll(read).toBe(5)
})

test('where the organization’s policy lets no plugin show logs, a page’s Logs part says so, and none are read', async ({
  launch,
}) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginLogs: 'off' }))
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(), LUMOVI_POLICY: policy },
  })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page).getByRole('region', { name: 'Its proxy' })).toContainText(
    'Your organization’s policy doesn’t let plugins show or read containers’ logs.',
    { timeout: 20_000 },
  )
  await expect(body(page).getByRole('log')).toHaveCount(0)
  expect(await events(page, { actions: ['logs.read'] })).toEqual([])
  // The Plugins page says so, under its logs line.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  await expect(page.getByRole('region', { name: 'May read' })).toContainText(
    'It shows containers’ logs: Lumovi reads them, and its code never sees them.' +
      'Turned off by your organization’s policy (pluginLogs: off): Lumovi reads no logs for it.' +
      'It reads no Secret’s value. It sends nothing anywhere but to this cluster.',
  )
})

/** Toys, whose code reads logs: of the pods it reads. */
const READER = toys(false).replace('  pages:', '  logs: read\n  pages:')

/**
 * Its code: it reads shop's pods, asks for the last lines of the envoy of storefront's first,
 * and draws the newest it was handed; then asks for a container the pod hasn't, and for a token
 * that's no pod's, and draws what it was told.
 */
const READS = `box.then(({ post, listen }) => {
  const said = []
  let drawn = false
  const draw = () => {
    const header = { name: said.join(' | ') }
    post(JSON.stringify({ commit: drawn ? [['change', 1, header]] : [['make', 1, 'Header', header], ['put', 0, 1]] }))
    drawn = true
  }
  listen((text) => {
    const heard = JSON.parse(text)
    if (heard.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (heard.read === 1 && heard.objects && said.length === 0) {
      const pod = heard.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
      said.push('asked')
      post(JSON.stringify({ read: 2, what: 'logs', pod: pod.token, container: 'envoy', tail: 5 }))
      post(JSON.stringify({ read: 3, what: 'logs', pod: 'o_nobody', container: 'envoy' }))
    }
    if (heard.read === 2) {
      said.push(heard.lines ? 'newest: ' + heard.lines.at(-1).text + ' of ' + heard.lines.length + (heard.lines.at(-1).time ? ', timed' : '') : 'refused: ' + heard.ended)
      draw()
    }
    if (heard.read === 3) {
      said.push('other: ' + heard.ended)
      draw()
    }
  })
})
`

function reader() {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), READER)
  writeFileSync(join(folder, 'toys.js'), READS)
  return folder
}

test('a plugin whose file says its code reads logs is handed a pod’s last lines, once, and the history says so', async ({
  launch,
  clusters,
}) => {
  clusters.demo.appendLogs('shop', POD, 'envoy', ['read-by-its-code'])
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: reader() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // Its code drew what it was handed: the newest line, of as many as it asked for, each timed.
  // A token that's no pod's reads nothing.
  const header = body(page)
  await expect(header).toContainText('newest: read-by-its-code of 5, timed', { timeout: 20_000 })
  await expect(header).toContainText('other: not-found')
  await expect
    .poll(async () => (await events(page, { actions: ['logs.read'] }))[0])
    .toMatchObject({
      outcome: 'success',
      summary: `Read the logs of Pod ${POD} (envoy), for the plugin Toys’ code`,
      command: `kubectl logs ${POD} -c envoy --tail=5 -n shop --context ${CONTEXTS.demo}`,
      details: { container: 'envoy', previous: false, plugin: 'toys', pluginVersion: '1.2.0' },
    })
  // The Plugins page says so, first and in red: what logs print reaches its code.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const may = page.getByRole('region', { name: 'May read' })
  await expect(may.locator('[data-red-line="logs"]')).toHaveText(
    'Its code reads containers’ logs: what they print, which can hold tokens and personal data, reaches its code.' +
      'Of pods its page shows, one container at a time: at most its last 500 lines or hour, as you, within your access.',
  )
  await expect(may.locator('p').first()).toHaveText(/^Its code reads containers’ logs/)
  await expect(may.locator('p').first()).toHaveClass(/text-critical-text/)
  await expect(may).toContainText(
    'It reads no Secret’s value. It sends nothing anywhere but to this cluster.',
  )
  await expect(may).not.toContainText('It reads no logs.')
  await expect(may).not.toContainText('It shows containers’ logs')
})

test('where the organization’s policy lets no plugin show logs, its code reads none either', async ({
  launch,
}) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginLogs: 'off' }))
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: reader(), LUMOVI_POLICY: policy },
  })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page)).toContainText('refused: logs-off', { timeout: 20_000 })
  await expect
    .poll(async () => (await events(page, { actions: ['logs.read'] }))[0])
    .toMatchObject({ outcome: 'refused', details: { plugin: 'toys', refused: 'logs-off' } })
  // The Plugins page's red line goes quiet, and says why.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const line = page.getByRole('region', { name: 'May read' }).locator('[data-red-line="logs"]')
  await expect(line).toHaveText(
    'Its code reads containers’ logs: what they print, which can hold tokens and personal data, reaches its code.' +
      'Of pods its page shows, one container at a time: at most its last 500 lines or hour, as you, within your access.' +
      'Turned off by your organization’s policy (pluginLogs: off): Lumovi reads no logs for it.',
  )
  await expect(line.locator('p').first()).not.toHaveClass(/text-critical-text/)
})
