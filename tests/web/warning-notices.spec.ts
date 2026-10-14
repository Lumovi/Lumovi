/**
 * A server's notifications of new warnings: each person's own, in their browser, turned on from
 * the sidebar's cluster menu, told while a Lumovi tab is open, and a click away from where it
 * happened.
 */
import type { BrowserContext } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

/** The browser's notifications, recorded (window.__notices), with the permission given. */
async function fakeNotifications(context: BrowserContext, permission = 'default') {
  await context.addInitScript((permission) => {
    const notices: { title: string; body?: string }[] = []
    Object.assign(window, { __notices: notices })
    class Recorded {
      static permission = permission
      static async requestPermission() {
        Recorded.permission = 'granted'
        return 'granted'
      }
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        notices.push({ title, body: options?.body })
        Object.assign(window, { __lastNotice: this })
      }
    }
    Object.assign(window, { Notification: Recorded })
  }, permission)
}

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

test('a person’s own notifications of new warnings: asked of the browser, told while the tab is open, a click away', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await fakeNotifications(context)
  await page.clock.install()
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const notices = () =>
    page.evaluate(() =>
      (window as unknown as { __notices: { title: string; body?: string }[] }).__notices.map(
        (n) => `${n.title} | ${n.body}`,
      ),
    )

  // In the cluster's menu: off, and a way in.
  await page.getByRole('button', { name: 'Cluster' }).click()
  const row = page.getByRole('button', { name: /^Notify me of new warnings/ })
  await expect(row).toContainText('Off')
  await row.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('switch', { name: 'Notify me of new warnings' }).click()
  // The browser asks first.
  await expect(dialog).toContainText('Your browser will ask first.')
  await dialog.getByRole('button', { name: 'Allow notifications' }).click()
  await expect(dialog).toContainText('On in this browser.')
  await dialog.getByRole('button', { name: 'Send a test' }).click()
  await expect.poll(notices).toEqual(['A test from Lumovi | New warnings in demo come like this.'])
  const watch = dialog.getByRole('group', { name: 'Namespaces to watch' })
  await watch.getByRole('radio', { name: 'These namespaces' }).check()
  await watch.getByRole('button', { name: 'Add' }).click()
  await watch.getByRole('checkbox', { name: 'shop' }).check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Cluster' }).click()
  await expect(page.getByRole('button', { name: /^Notify me of new warnings/ })).toContainText(
    'On, in shop',
  )
  await page.keyboard.press('Escape')

  // The first look remembers; a look whose read fails is left out, so what was there isn't new
  // once it answers again; and a new warning in shop is told at the next.
  await page.clock.fastForward('00:31')
  const looks = () =>
    clusters.demo.requests.filter(
      (r) =>
        r.path === '/api/v1/namespaces/shop/events' &&
        (r.query.fieldSelector ?? '').includes('type=Warning'),
    ).length
  const answers = clusters.demo.fail('/api/v1/namespaces/shop/events', { status: 500 })
  let then = looks()
  await page.clock.fastForward('00:31')
  await expect.poll(looks).toBeGreaterThan(then)
  answers()
  then = looks()
  await page.clock.fastForward('00:31')
  await expect.poll(looks).toBeGreaterThan(then)
  expect(await notices()).toEqual(['A test from Lumovi | New warnings in demo come like this.'])
  const storefront = clusters.demo.object('Deployment', 'shop', 'storefront')!
  clusters.demo.upsert(
    warning(
      storefront,
      'storefront.new-1',
      'ProgressDeadlineExceeded',
      'ReplicaSet has timed out progressing.',
    ),
  )
  await page.clock.fastForward('00:31')
  await expect
    .poll(notices)
    .toContain(
      'ProgressDeadlineExceeded: Deployment shop/storefront | ReplicaSet has timed out progressing.\ndemo',
    )
  // A click: back to the tab, at the object.
  await page.evaluate(() =>
    (window as unknown as { __lastNotice: { onclick(): void } }).__lastNotice.onclick(),
  )
  await expect(page.getByRole('complementary', { name: 'Deployment storefront' })).toBeVisible()
})

test('one of a person’s tabs looks, and tells: the next once it’s closed', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await fakeNotifications(context, 'granted')
  await page.clock.install()
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const notices = (tab: typeof page) =>
    tab.evaluate(() =>
      (window as unknown as { __notices: { title: string }[] }).__notices.map((n) => n.title),
    )
  const looks = () =>
    clusters.demo.requests.filter(
      (r) =>
        r.path === '/api/v1/namespaces/shop/events' &&
        (r.query.fieldSelector ?? '').includes('type=Warning'),
    ).length
  await page.getByRole('button', { name: 'Cluster' }).click()
  await page.getByRole('button', { name: /^Notify me of new warnings/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('switch', { name: 'Notify me of new warnings' }).click()
  const watch = dialog.getByRole('group', { name: 'Namespaces to watch' })
  await watch.getByRole('radio', { name: 'These namespaces' }).check()
  await watch.getByRole('button', { name: 'Add' }).click()
  await watch.getByRole('checkbox', { name: 'shop' }).check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(looks).toBeGreaterThanOrEqual(1)

  // Another tab: it waits, the first still looking. (The clock is both tabs'.)
  const other = await context.newPage()
  await other.goto(`${served.url}cluster/demo`)
  await expect(other.getByRole('button', { name: 'Cluster' })).toBeVisible()
  const storefront = clusters.demo.object('Deployment', 'shop', 'storefront')!
  clusters.demo.upsert(warning(storefront, 'storefront.tabs-1', 'Unhealthy', 'probe failed'))
  const then = looks()
  await page.clock.fastForward('00:31')
  await expect.poll(() => notices(page)).toEqual(['Unhealthy: Deployment shop/storefront'])
  expect(looks()).toBe(then + 1)
  expect(await notices(other)).toEqual([])

  // The first closed: the other looks, from what's there then.
  await page.close()
  await expect.poll(looks).toBeGreaterThan(then + 1)
  const cart = clusters.demo.object('Deployment', 'shop', 'cart')!
  clusters.demo.upsert(warning(cart, 'cart.tabs-1', 'FailedScheduling', 'no nodes'))
  await other.clock.fastForward('00:31')
  await expect.poll(() => notices(other)).toEqual(['FailedScheduling: Deployment shop/cart'])
})
