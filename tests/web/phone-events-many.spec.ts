/** Thousands of events on a phone, where the detail is a page and the page is what scrolls. */
import type { KubeObject } from '../mock-cluster/types.ts'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const MANY = 3000

test('thousands of events on a phone: the ones in view, scrolling with the page', async ({
  page,
  serve,
  clusters,
}) => {
  const target = clusters.demo.object('ConfigMap', 'shop', 'storefront-config')!
  const now = Date.now()
  const names = Array.from({ length: MANY }, (_, i) => `many-${String(i).padStart(4, '0')}`)
  for (const [i, name] of names.entries()) {
    const at = new Date(now - i * 1000).toISOString()
    clusters.demo.upsert({
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name, namespace: 'shop', uid: name, creationTimestamp: at },
      involvedObject: {
        kind: 'ConfigMap',
        namespace: 'shop',
        name: 'storefront-config',
        uid: target.metadata.uid,
        apiVersion: 'v1',
      },
      reason: 'Synced',
      message: `event ${name.slice(5)}`,
      source: { component: 'tests' },
      firstTimestamp: at,
      lastTimestamp: at,
      count: 1,
      type: 'Normal',
    } as KubeObject)
  }
  try {
    const served = await serve()
    await signInNarrow(
      page,
      `${served.url}cluster/demo/configmaps?open=ConfigMap/shop/storefront-config`,
      DEMO_TOKEN,
    )
    const detail = page.getByRole('complementary', { name: 'ConfigMap storefront-config' })
    await detail.getByRole('tab', { name: 'Events' }).click()
    const list = detail.getByRole('list', { name: 'Events' })
    const drawn = list.getByRole('listitem')
    await expect(drawn.first()).toContainText('event 0000')
    expect(await drawn.count()).toBeLessThan(80)
    // The page scrolls, and the list follows it to its last event.
    const toTheEnd = () =>
      list.evaluate((element) => {
        let scroller = element.parentElement!
        while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement!
        }
        scroller.scrollTop = scroller.scrollHeight
      })
    await expect
      .poll(async () => {
        await toTheEnd()
        return list.getByText(`event ${MANY - 1}`, { exact: true }).isVisible()
      })
      .toBe(true)
    expect(await drawn.count()).toBeLessThan(80)
    // What's above the list in the page grows while the tab is open (a notice, say): the list
    // is still drawn where it's looked at, not where it used to start.
    await list.evaluate((element) => {
      const above = document.createElement('div')
      above.style.height = '1500px'
      const block = element.closest('[role="tabpanel"]')!
      block.parentElement!.insertBefore(above, block)
    })
    await expect
      .poll(async () => {
        await toTheEnd()
        return list.getByText(`event ${MANY - 1}`, { exact: true }).isVisible()
      })
      .toBe(true)
    // The filter is a finger's size, and finds an event that isn't drawn.
    const filter = detail.getByPlaceholder('Filter events')
    await filter.fill('event 1234')
    await expect(drawn).toHaveCount(1)
    await expect(detail).toContainText('1 of 3,000')
    await expect
      .poll(async () => Math.round((await filter.locator('xpath=..').boundingBox())?.height ?? 0))
      .toBeGreaterThanOrEqual(44)
    await expectNoSidewaysScroll(page, 'thousands of events, on a phone')
  } finally {
    for (const name of names) clusters.demo.remove('Event', 'shop', name)
  }
})
