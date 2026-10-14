/**
 * Notifications of new warnings, the desktop app's: off until a cluster's settings turn them on,
 * then what's new in the namespaces it watches, told by the system, a click away from where it
 * happened.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { holds } from '../holds.ts'
import { clusterOption, expect, openCluster, test } from './fixtures.ts'

/** A Warning event about `target`, as the API server would have it. */
function warning(target: KubeObject, name: string, reason: string, message: string): KubeObject {
  const at = new Date().toISOString()
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name, namespace: target.metadata.namespace, uid: name, creationTimestamp: at },
    involvedObject: {
      kind: target.kind,
      namespace: target.metadata.namespace,
      name: target.metadata.name,
      uid: target.metadata.uid,
      apiVersion: target.apiVersion,
    },
    reason,
    message,
    source: { component: 'tests' },
    firstTimestamp: at,
    lastTimestamp: at,
    count: 1,
    type: 'Warning',
  } as KubeObject
}

async function openSettings(page: Page, context: string) {
  await page.getByPlaceholder('Search clusters and labels…').fill(context)
  await expect(clusterOption(page, context)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+i')
  return page.getByRole('dialog')
}

test('new warnings, told while Lumovi runs: in the namespaces a cluster watches, several as one, a click away', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { app, page } = await launch({
    userDataDir,
    env: { LUMOVI_WARNINGS_EVERY_MS: '300' },
  })
  const notices = () =>
    app.evaluate(() =>
      (
        globalThis as unknown as { __notifications: { title: string; body: string }[] }
      ).__notifications.map((n) => `${n.title} | ${n.body}`),
    )

  // Off until it's turned on: then all namespaces, where the cluster opens in all; or these.
  const dialog = await openSettings(page, 'demo')
  const notify = dialog.getByRole('switch', { name: 'Notify me of new warnings' })
  await expect(notify).not.toBeChecked()
  await expect(dialog.getByRole('group', { name: 'Namespaces to watch' })).toHaveCount(0)
  await notify.click()
  const watch = dialog.getByRole('group', { name: 'Namespaces to watch' })
  await expect(watch.getByRole('radio', { name: 'All namespaces' })).toBeChecked()
  await watch.getByRole('radio', { name: 'These namespaces' }).check()
  await watch.getByRole('button', { name: 'Add' }).click()
  await watch.getByRole('searchbox', { name: 'Filter namespaces' }).fill('sh')
  await watch.getByRole('checkbox', { name: 'shop' }).check()
  await expect(watch.getByRole('button', { name: 'Stop watching shop' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  // What's there at the first look is only remembered: two looks at shop, and nothing told.
  const looks = () =>
    clusters.demo.requests.filter(
      (r) =>
        r.path === '/api/v1/namespaces/shop/events' &&
        (r.query.fieldSelector ?? '').includes('type=Warning'),
    ).length
  await expect.poll(looks).toBeGreaterThanOrEqual(2)
  expect(await notices()).toEqual([])
  // A look whose read fails is left out: what was there isn't new once it answers again.
  const answers = clusters.demo.fail('/api/v1/namespaces/shop/events', { status: 500 })
  let then = looks()
  await expect.poll(looks).toBeGreaterThanOrEqual(then + 2)
  answers()
  then = looks()
  await expect.poll(looks).toBeGreaterThanOrEqual(then + 2)
  expect(await notices()).toEqual([])

  // A new warning in shop: its reason and object, its message's first line, the cluster last.
  const storefront = clusters.demo.object('Deployment', 'shop', 'storefront')!
  clusters.demo.upsert(
    warning(
      storefront,
      'storefront.new-1',
      'ProgressDeadlineExceeded',
      'ReplicaSet has timed out progressing.\nMore below.',
    ),
  )
  await expect
    .poll(notices)
    .toEqual([
      'ProgressDeadlineExceeded: Deployment shop/storefront | ReplicaSet has timed out progressing.\ndemo',
    ])
  // In a namespace it doesn't watch: nothing.
  const redis = clusters.demo.object('StatefulSet', 'data', 'redis')
  if (redis)
    clusters.demo.upsert(warning(redis, 'redis.new-1', 'FailedCreate', 'create Pod failed'))
  // Several in shop at one look: one, with their reasons.
  const cart = clusters.demo.object('Deployment', 'shop', 'cart')!
  clusters.demo.upsert(warning(cart, 'cart.new-1', 'FailedScheduling', 'no nodes'))
  clusters.demo.upsert(warning(cart, 'cart.new-2', 'Unhealthy', 'probe failed'))
  await expect.poll(notices).toHaveLength(2)
  expect((await notices())[1]).toBe('2 new warnings in shop | FailedScheduling, Unhealthy\ndemo')
  // The same object and reason again soon: told once in 10 minutes.
  clusters.demo.upsert(
    warning(storefront, 'storefront.new-2', 'ProgressDeadlineExceeded', 'Again.'),
  )
  const now = looks()
  await expect.poll(looks).toBeGreaterThanOrEqual(now + 2)
  await holds(
    async () => (await notices()).length === 2,
    300,
    'an object and reason is told once in 10 minutes',
  )

  // What could carry what only the person may read is cut: a notification shows on a lock screen.
  const checkout = clusters.demo.object('Deployment', 'shop', 'checkout')!
  clusters.demo.upsert(
    warning(checkout, 'checkout.new-1', 'Unhealthy', 'Liveness probe failed: token=s3cr3t'),
  )
  await expect.poll(notices).toHaveLength(3)
  expect((await notices())[2]).toBe(
    'Unhealthy: Deployment shop/checkout | Liveness probe failed: (the rest left out by Lumovi)\ndemo',
  )

  // A click brings Lumovi to where it happened: the object.
  await app.evaluate(() =>
    (
      globalThis as unknown as { __notifications: { emit(e: string): void }[] }
    ).__notifications[0]!.emit('click'),
  )
  await expect(page.getByRole('complementary', { name: 'Deployment storefront' })).toBeVisible()
  // A group's, to the namespace's warnings.
  await app.evaluate(() =>
    (
      globalThis as unknown as { __notifications: { emit(e: string): void }[] }
    ).__notifications[1]!.emit('click'),
  )
  await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible()
  await expect.poll(() => new URL(page.url()).hash).toMatch(/health=warning/)
  await expect.poll(() => new URL(page.url()).hash).toMatch(/namespaces=shop/)
})

test('a cluster whose signing in fails is paused, said once, and its credential plugin not started again until the cluster answers in Lumovi', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const signedIn = join(tools, 'signed-in')
  const plugin = join(tools, 'credential.mjs')
  // A credential plugin whose sign-in has run out, until the person signs in again.
  writeFileSync(
    plugin,
    `import { appendFileSync, existsSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
if (!existsSync(${JSON.stringify(signedIn)})) {
  console.error('the sign-in has expired')
  process.exit(1)
}
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const kubeconfig = writeKubeconfig(tools, {
    clusters: [{ name: 'demo', server: url, caPem }],
    users: [
      { name: 'token', token: DEMO_TOKEN },
      { name: 'plugged', exec: { command: process.execPath, args: [plugin] } },
    ],
    contexts: [
      { name: 'demo', cluster: 'demo', user: 'token' },
      { name: 'signs-in', cluster: 'demo', user: 'plugged' },
    ],
  })
  const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').length - 1 : 0)
  const { app, page } = await launch({
    userDataDir: mkdtempSync(join(tmpdir(), 'lumovi-user-')),
    env: { KUBECONFIG: kubeconfig, LUMOVI_WARNINGS_EVERY_MS: '300' },
  })
  const notices = () =>
    app.evaluate(() =>
      (
        globalThis as unknown as { __notifications: { title: string; body: string }[] }
      ).__notifications.map((n) => `${n.title} | ${n.body}`),
    )
  const state = () => page.evaluate(() => window.lumovi!.app.warningNotices!('signs-in'))
  // Looks at demo's shop: the poller's clock. Looks at signs-in's data: its own, once it can.
  const looksAt = (namespace: string) => () =>
    clusters.demo.requests.filter(
      (r) =>
        r.path === `/api/v1/namespaces/${namespace}/events` &&
        (r.query.fieldSelector ?? '').includes('type=Warning'),
    ).length
  const demoLooks = looksAt('shop')
  const pluggedLooks = looksAt('data')

  // On demo's pages, where nothing of the start screen's reads signs-in.
  await openCluster(page, 'demo')
  await page.evaluate(async () => {
    await window.lumovi!.app.setCluster!('demo', { notify: true, watch: ['shop'] })
    await window.lumovi!.app.setCluster!('signs-in', { notify: true, watch: ['data'] })
  })
  // (The page reads its settings again.)
  await page.reload()
  const paused =
    'Notifications paused | Signing in failed. Open the cluster to sign in again, and notifications go on.\nsigns-in'
  await expect.poll(notices).toEqual([paused])
  expect(await state()).toMatchObject({
    signsInWith: expect.stringMatching(/^node/),
    pausedAt: expect.any(Number),
  })
  // Not started again by the looks after, nor said again.
  const started = runs()
  expect(started).toBeGreaterThanOrEqual(1)
  const then = demoLooks()
  await expect.poll(demoLooks).toBeGreaterThanOrEqual(then + 5)
  expect(runs()).toBe(started)
  expect(pluggedLooks()).toBe(0)
  expect(await notices()).toEqual([paused])

  // Its settings say so, and that a look signs in.
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('dialog').getByRole('option', { name: 'All clusters' }).click()
  await page.getByPlaceholder('Search clusters and labels…').fill('signs-in')
  await expect(clusterOption(page, 'signs-in')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+i')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/Signing in \(node[^)]*\) runs as it checks/)
  await expect(dialog).toContainText(
    /Paused at .+: signing in failed\. Open the cluster to sign in again, and notifications go on\./,
  )
  await page.keyboard.press('Escape')

  // Signed in again, and the cluster opened: it answers, and the looks go on.
  writeFileSync(signedIn, '')
  await page.getByPlaceholder('Search clusters and labels…').fill('signs-in')
  await openCluster(page, 'signs-in')
  await expect.poll(pluggedLooks).toBeGreaterThanOrEqual(2)
  expect(await state()).not.toHaveProperty('pausedAt')
  expect(await notices()).toEqual([paused])
})

test('a cluster whose credential plugin waits for a sign-in holds up its own looks alone: started once, and the other clusters looked at', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const plugin = join(tools, 'credential.mjs')
  // A credential plugin waiting for a sign-in in a browser that nobody finishes.
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
setTimeout(() => process.exit(1), 60_000)
`,
  )
  const kubeconfig = writeKubeconfig(tools, {
    clusters: [{ name: 'demo', server: url, caPem }],
    users: [
      { name: 'token', token: DEMO_TOKEN },
      { name: 'plugged', exec: { command: process.execPath, args: [plugin] } },
    ],
    contexts: [
      { name: 'demo', cluster: 'demo', user: 'token' },
      { name: 'waits', cluster: 'demo', user: 'plugged' },
    ],
  })
  const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').length - 1 : 0)
  const { page } = await launch({
    userDataDir: mkdtempSync(join(tmpdir(), 'lumovi-user-')),
    env: { KUBECONFIG: kubeconfig, LUMOVI_WARNINGS_EVERY_MS: '300' },
  })
  const demoLooks = () =>
    clusters.demo.requests.filter(
      (r) =>
        r.path === '/api/v1/namespaces/shop/events' &&
        (r.query.fieldSelector ?? '').includes('type=Warning'),
    ).length

  // On demo's pages, where nothing of the start screen's reads waits.
  await openCluster(page, 'demo')
  await page.evaluate(async () => {
    await window.lumovi!.app.setCluster!('waits', { notify: true, watch: ['data'] })
    await window.lumovi!.app.setCluster!('demo', { notify: true, watch: ['shop'] })
  })
  // (Its plugin started at the first look, which demo's second follows.)
  await expect.poll(demoLooks).toBeGreaterThanOrEqual(2)
  const started = runs()
  expect(started).toBeGreaterThanOrEqual(1)
  const then = demoLooks()
  await expect.poll(demoLooks).toBeGreaterThanOrEqual(then + 5)
  expect(runs()).toBe(started)
})
