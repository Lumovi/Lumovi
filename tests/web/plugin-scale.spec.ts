/**
 * A plugin's page at a large cluster's size, on a team's server, in a browser: 2,500 pods through
 * the door, read and drawn by a plugin's code and kept up to date as they change, within every
 * one of the door's limits, with the page answering.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO_TOKEN, expect, freePort, signIn, test } from './fixtures.ts'

const PODS = 2500
const NAMESPACE = 'scale'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name, status.phase, spec.nodeName] }]
  pages: [{ id: overview, title: Overview }]
`

/** Its code: the namespace's pods, how many run, and every one in a table, again at each answer. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let drawn = false
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: ${JSON.stringify(NAMESPACE)} }))
    if (said.read !== 1 || !said.objects) return
    const pods = said.objects
    const running = pods.filter((pod) => pod.object.status && pod.object.status.phase === 'Running').length
    const tiles = { tiles: [
      { key: 'pods', icon: 'box', label: 'Pods', value: { kind: 'figure', text: String(pods.length) } },
      { key: 'running', icon: 'activity', label: 'Running', value: { kind: 'figure', text: String(running) }, detail: running + ' running' },
    ] }
    const table = {
      title: 'Pods',
      headings: true,
      columns: [{ name: 'Phase', kind: 'text' }, { name: 'Node', kind: 'text' }],
      rows: pods.map((pod) => ({
        key: pod.token,
        lead: { name: pod.object.metadata.name },
        cells: [
          { kind: 'text', text: (pod.object.status && pod.object.status.phase) || 'Unknown' },
          { kind: 'text', text: (pod.object.spec && pod.object.spec.nodeName) || 'none' },
        ],
      })),
    }
    if (drawn) return commit([['change', 2, tiles], ['change', 4, table]])
    drawn = true
    commit([
      ['make', 1, 'Stack', {}], ['put', 0, 1],
      ['make', 2, 'Tiles', tiles], ['put', 1, 2],
      ['make', 3, 'Card', { title: 'Pods' }], ['put', 1, 3],
      ['make', 4, 'Table', table], ['put', 3, 4],
    ])
  })
})
`

const pod = (i: number, phase = 'Running') => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: `scale-${String(i).padStart(4, '0')}`,
    namespace: NAMESPACE,
    uid: `scale-${i}`,
    creationTimestamp: new Date().toISOString(),
    labels: { app: 'scale' },
  },
  spec: { nodeName: `node-${i % 20}`, containers: [{ name: 'app', image: 'busybox' }] },
  status: { phase },
})

const body = (page: Page) => page.locator('[data-plugin-body]')

/** Lumovi's page's own frames until `until` holds: how long its thread was held at a time. */
const framesUntil = (page: Page, text: string) =>
  page.evaluate(
    (text) =>
      new Promise<{ frames: number; worst: number; over100: number; median: number }>((done) => {
        const gaps: number[] = []
        let last = performance.now()
        const tile = () => document.querySelector('[data-plugin-body] [aria-label="Running"]')
        const tick = (now: number) => {
          gaps.push(now - last)
          last = now
          if (tile()?.textContent?.includes(text)) {
            const sorted = [...gaps].sort((a, b) => a - b)
            done({
              frames: gaps.length,
              worst: Math.round(sorted.at(-1)!),
              over100: gaps.filter((gap) => gap > 100).length,
              median: Math.round(sorted[Math.floor(sorted.length / 2)]!),
            })
          } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    text,
  )

test('2,500 pods through the door on a server’s page: read, drawn and kept up to date within its limits', async ({
  page,
  serve,
  clusters,
}) => {
  test.setTimeout(240_000)
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NAMESPACE, creationTimestamp: new Date().toISOString() },
    status: { phase: 'Active' },
  })
  for (let i = 0; i < PODS; i++) clusters.demo.upsert(pod(i))
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  writeFileSync(join(folder, 'toys.js'), CODE)
  const port = await freePort()
  const server = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder },
  })
  const started = Date.now()
  await signIn(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
  const tile = body(page).getByRole('region', { name: 'Running' })
  await expect(tile).toContainText(`${PODS} running`, { timeout: 60_000 })
  const firstDrawn = Date.now() - started
  await expect(body(page).getByRole('grid', { name: 'Pods' })).toBeVisible()
  const measuring = framesUntil(page, `${PODS - 50} running`)
  for (let i = 0; i < 50; i++) clusters.demo.upsert(pod(i * 50, 'Failed'))
  const frames = await measuring
  console.log(
    `2,500 pods on a server: first drawn ${firstDrawn} ms after signing in; frames ${JSON.stringify(frames)}`,
  )
  await expect(body(page).getByTestId('plugin-ended')).toHaveCount(0)
  await expect(tile).toContainText(`${PODS - 50} running`)
  expect(frames.frames).toBeGreaterThan(10)
  expect(frames.worst).toBeLessThan(1000)
})
