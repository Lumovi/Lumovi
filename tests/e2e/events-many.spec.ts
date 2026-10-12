/** An object with thousands of events: its Events tab draws the ones in view, and all are there to scroll to. */
import type { Locator } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const MANY = 3000

/** Events about a ConfigMap, a second apart, newest first by their number; every seventh a warning with a long message. */
function events(target: KubeObject): KubeObject[] {
  const now = Date.now()
  return Array.from({ length: MANY }, (_, i) => {
    const at = new Date(now - i * 1000).toISOString()
    const number = String(i).padStart(4, '0')
    return {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: {
        name: `many-${number}`,
        namespace: target.metadata.namespace,
        uid: `many-${number}`,
        creationTimestamp: at,
      },
      involvedObject: {
        kind: target.kind,
        namespace: target.metadata.namespace,
        name: target.metadata.name,
        uid: target.metadata.uid,
        apiVersion: target.apiVersion,
      },
      reason: i % 7 === 0 ? 'SyncFailed' : 'Synced',
      message:
        i % 7 === 0
          ? `event ${number}: the sync failed, and a message as long as this one takes more than one line in the panel, so events aren’t all of one height`
          : `event ${number}`,
      source: { component: 'tests' },
      firstTimestamp: at,
      lastTimestamp: at,
      count: 1,
      type: i % 7 === 0 ? 'Warning' : 'Normal',
    } as KubeObject
  })
}

/** Scrolls whatever the list scrolls in, to its end or its start. */
const scrollTo = (list: Locator, where: 'end' | 'start') =>
  list.evaluate((element, to) => {
    let scroller = element.parentElement!
    while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement!
    }
    scroller.scrollTop = to === 'end' ? scroller.scrollHeight : 0
  }, where)

test('thousands of events: the ones in view are drawn, and every one is there to scroll to', async ({
  page,
  clusters,
}) => {
  const target = clusters.demo.object('ConfigMap', 'shop', 'storefront-config')!
  const made = events(target)
  for (const event of made) clusters.demo.upsert(event)
  try {
    await openCluster(page)
    await goTo(page, 'ConfigMaps')
    await page.getByPlaceholder('Filter configmaps').fill('storefront-config')
    await row(page, 'ConfigMaps', 'storefront-config').first().getByRole('gridcell').nth(1).click()
    const detail = panel(page, 'ConfigMap', 'storefront-config')
    await detail.getByRole('tab', { name: 'Events' }).click()
    const list = detail.getByRole('list', { name: 'Events' })
    const drawn = list.getByRole('listitem')
    // Newest first, and only as many as the panel shows (and a few past its edges).
    await expect(drawn.first()).toContainText('event 0000')
    expect(await drawn.count()).toBeLessThan(80)
    // A screen reader is told where each is among them all.
    await expect(drawn.first()).toHaveAttribute('aria-setsize', String(MANY))
    await expect(drawn.first()).toHaveAttribute('aria-posinset', '1')
    // Each is as tall as its message: none lies over the next.
    const apart = () =>
      drawn.evaluateAll((items) => {
        const boxes = items
          .map((item) => item.getBoundingClientRect())
          .sort((a, b) => a.top - b.top)
        return boxes.every((box, i) => i === 0 || box.top >= boxes[i - 1]!.bottom - 0.5)
      })
    await expect.poll(apart).toBe(true)
    // The last of them is a scroll away, and still only the ones in view are drawn.
    await expect
      .poll(async () => {
        await scrollTo(list, 'end')
        return list.getByText(`event ${MANY - 1}`, { exact: true }).isVisible()
      })
      .toBe(true)
    expect(await drawn.count()).toBeLessThan(80)
    await expect(drawn.last()).toHaveAttribute('aria-posinset', String(MANY))
    await expect.poll(apart).toBe(true)
    await scrollTo(list, 'start')
    await expect(list.getByText(/^event 0000/)).toBeVisible()

    // The page's own find reaches only what's drawn, so the tab has a filter of its own past a
    // couple of hundred events: it finds one that isn't drawn, by its message.
    const filter = detail.getByPlaceholder('Filter events')
    await expect(list.getByText('event 2222', { exact: true })).toHaveCount(0)
    await filter.fill('event 2222')
    await expect(drawn).toHaveCount(1)
    await expect(drawn).toContainText('event 2222')
    await expect(detail).toContainText('1 of 3,000')
    // By its reason, in any case; and by what reported it. How many match is said beside it.
    await filter.fill('SYNCFAILED')
    await expect(detail).toContainText('429 of 3,000')
    await expect(drawn.first()).toContainText('event 0000')
    expect(await drawn.count()).toBeLessThan(80)
    await filter.fill('tests')
    await expect(detail).toContainText('3,000 of 3,000')
    // Nothing matches: said in the lists' own words.
    await filter.fill('no such event')
    await expect(detail).toContainText('No events match “no such event”.')
    await expect(list).toHaveCount(0)
    await detail.getByRole('button', { name: 'Clear filter' }).click()
    await expect(drawn.first()).toContainText('event 0000')
    await expect(detail.getByText(/ of 3,000$/)).toHaveCount(0)

    // Once it's there the filter stays for this visit, though the events age out to a handful:
    // a field that came and went would move the list under the pointer.
    for (const event of made.slice(50)) clusters.demo.remove('Event', 'shop', event.metadata.name)
    await page.getByRole('button', { name: /^Refresh/ }).click()
    await expect(drawn).toHaveCount(50)
    await expect(filter).toBeVisible()
    await filter.fill('event 0049')
    await expect(drawn).toHaveCount(1)
    await expect(detail).toContainText('1 of 50')
  } finally {
    for (const event of made) clusters.demo.remove('Event', 'shop', event.metadata.name)
  }
})
