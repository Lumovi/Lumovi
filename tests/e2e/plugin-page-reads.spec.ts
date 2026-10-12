/**
 * A plugin's page reading through the door: what its code asks, what it's handed with a token
 * for each object, a list kept up to date, a refusal as a code and Lumovi's sentence; and an
 * ask that isn't one, or too many, stopping it. A test plugin on the tests' stage, as one of
 * Lumovi's own (only those carry code).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { READ_LIMITS, READ_REFUSED } from '../../src/shared/plugin-reads.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { expect, openCluster, test } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

/**
 * A test plugin's code: it asks `asks`, one after another, and shows each read's answers in a
 * Field of its own, named by the read: the objects' names and tokens, or how it ended.
 */
const reading = (...asks: object[]) => `box.then(({ post, listen }) => {
  const asks = ${JSON.stringify(asks)}
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 100
  const show = (read, value) => {
    let id = fields.get(read)
    const props = { name: 'read ' + read, value: value.slice(0, 4000) }
    if (id === undefined) {
      fields.set(read, (id = next++))
      commit([['make', id, 'Field', props], ['put', 1, id]])
    } else commit([['change', id, props]])
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.objects) show(said.read, '|' + said.objects.map((o) => o.object.metadata.name + '=' + o.token).sort().join('|') + '|')
    else if (said.ended) show(said.read, 'ended ' + said.ended + ': ' + said.said)
    else if (said.failing) show(said.read, 'failing ' + said.failing)
  })
  for (const ask of asks) post(JSON.stringify(ask))
})`

async function show(page: Page, code: string) {
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(
    (shown) =>
      (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show(
        shown,
      ),
    { plugin: 'toys', name: 'Toys', version: '1.2.0', context: 'demo', code },
  )
}

const field = (page: Page, read: number) =>
  page.locator('[data-part="Field"]').filter({ hasText: `read ${read}` })
const ended = (page: Page) => page.getByTestId('plugin-ended')

/** Each name a read shows, with its token. */
async function tokens(page: Page, read: number): Promise<Map<string, string>> {
  const text = (await field(page, read).textContent()) ?? ''
  return new Map(
    // (Each `|name=token|`: the Field's own words round it are no part of either.)
    [...text.matchAll(/\|([a-z0-9.-]+)=([A-Za-z0-9_-]+)(?=\|)/g)].map(([, name, token]) => [
      name!,
      token!,
    ]),
  )
}

function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  return folder
}

test('a plugin’s page reads its own kind through the door: each object with a token, kept up to date', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await show(
    page,
    reading(
      { read: 1, what: 'list', kind: 'example.com/Widget' },
      { read: 2, what: 'list', kind: '/Node' },
      { read: 3, what: 'events', of: 'made-up' },
    ),
  )
  await expect(field(page, 1)).toContainText(`|${CUSTOM.widget}=`)
  // Kubernetes' own, and what isn't read for a plugin yet: refused, said with Lumovi's words.
  await expect(field(page, 2)).toContainText(`ended not-granted: ${READ_REFUSED['not-granted']}`)
  await expect(field(page, 3)).toContainText(`ended not-yet: ${READ_REFUSED['not-yet']}`)
  const first = await tokens(page, 1)

  // One more Widget: in the list once it's read again, the others with the tokens they had.
  const widget = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!
  const another = structuredClone(widget) as KubeObject
  another.metadata = { ...another.metadata, name: 'green-widget', uid: 'green-widget-uid' }
  clusters.demo.upsert(another)
  await expect(field(page, 1)).toContainText('|green-widget=', { timeout: 15_000 })
  const second = await tokens(page, 1)
  for (const [name, token] of first) expect(second.get(name), name).toBe(token)
  expect(new Set(second.values()).size).toBe(second.size)
  // And gone, once it's gone.
  clusters.demo.remove('Widget.example.com', 'default', 'green-widget')
  await expect(field(page, 1)).not.toContainText('green-widget', { timeout: 15_000 })
  await expect(ended(page)).toHaveCount(0)
})

test('a read the plugin ends is read no more; a refresh reads its own lists again, and one too soon isn’t made', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  const widgets = () =>
    clusters.demo.requests.filter(
      ({ method, path }) => method === 'GET' && path.endsWith('/widgets'),
    ).length
  // It ends read 1 once it has it, refreshes (twice: the second too soon), then asks read 2.
  await show(
    page,
    `box.then(({ post, listen }) => {
      const commit = (steps) => post(JSON.stringify({ commit: steps }))
      commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
      let next = 10
      listen((text) => {
        const said = JSON.parse(text)
        const id = next++
        commit([['make', id, 'Field', { name: 'read ' + said.read, value: said.objects ? 'objects' : 'ended' }], ['put', 1, id]])
        if (said.read === 1) {
          post(JSON.stringify({ stop: 1 }))
          post(JSON.stringify({ refresh: true }))
          post(JSON.stringify({ refresh: true }))
          post(JSON.stringify({ read: 2, what: 'object', kind: 'example.com/Widget', namespace: 'default', name: '${CUSTOM.widget}' }))
        }
      })
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
    })`,
  )
  await expect(field(page, 2)).toContainText('objects')
  // Read 1's list once, and read 2's object: the refresh found no list of its own going.
  expect(widgets()).toBe(1)
  await expect(ended(page)).toHaveCount(0)
})

test('an ask that isn’t one, or more asks than a second takes, stops the plugin', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await show(page, reading({ read: 1, what: 'list', kind: 'example.com/Widget', label: 'x' }))
  await expect(ended(page)).toHaveAttribute('data-why', 'not-allowed')
  await expect(ended(page)).toContainText('It sent something a plugin can’t.')

  // (A refresh too soon isn't made, and doesn't stop it: but it's one of its second's asks.)
  const many = Array.from({ length: READ_LIMITS.asksASecond + 1 }, () => ({ refresh: true }))
  await show(page, reading(...many))
  await expect(ended(page)).toHaveAttribute('data-why', 'too-much')
})
