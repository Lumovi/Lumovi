/**
 * The Events page's timeline (and an object's Events tab's): a row an object, or a reason, each
 * event a mark at its time, a repeated one a bar. Drawn from the demo cluster's checkout incident:
 * its Deployment scaled, its ReplicaSet made pods, two of them restarting again and again.
 */
import type { Page } from '@playwright/test'
import { placed } from '../placed.ts'
import { DEMO, expect, goTo, openCluster, test } from './fixtures.ts'

const grid = (page: Page) => page.getByRole('grid', { name: /^Events on a timeline/ })
const tooltip = (page: Page) => page.getByRole('tooltip')

/** The Events page, filtered to the checkout incident, as a timeline of the last hour. */
async function incident(page: Page) {
  await openCluster(page)
  await goTo(page, 'Events')
  await page.getByPlaceholder('Filter events').fill('checkout')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await page.getByRole('button', { name: '1h', exact: true }).click()
  await expect(grid(page)).toBeVisible()
}

test('a timeline of events: a row an object in the order it began, a repeated event a bar, what one is beside it, and what opens', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await incident(page)
  // In the address, so Back and a link come back to it; there are no columns to choose.
  expect(new URL(page.url()).hash).toContain('as=timeline')
  await expect(page.getByRole('button', { name: 'Columns' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // A row an object, the one whose first event came first on top. Each says its kind.
  await expect(grid(page).getByRole('rowheader')).toHaveText([
    /^Deployment\s*checkout/,
    /^Pod\s*checkout.*hqnnn/,
    /^Pod\s*checkout.*pwkd2/,
    /^ReplicaSet\s*che/,
    // (Its certificate's name has "checkout" in it too.)
    /^Certificate\s*checkout-tls/,
  ])
  // A repeated event is a bar from its first time to its last, with how often; two at once each
  // in a lane of its own, the Warning on top (the container backing off, as its image is pulled
  // again and again).
  const backOff = grid(page).getByRole('button', {
    name: /^BackOff on Pod checkout-\S+-hqnnn, 58 times, last .+ ago$/,
  })
  const pulled = grid(page).getByRole('button', {
    name: /^Pulled on Pod checkout-\S+-hqnnn, 14 times, last .+ ago$/,
  })
  await expect(backOff).toContainText('×58')
  await expect(backOff).toHaveAttribute('data-lane', '0')
  await expect(pulled).toHaveAttribute('data-lane', '1')
  // Once is a mark at its time.
  await expect(
    grid(page).getByRole('button', { name: /^ScalingReplicaSet on Deployment checkout, .+ ago$/ }),
  ).toBeVisible()

  // Pointed at: the charts' tooltip, with the reason, the kind, how often, the message whole and
  // when it first and last happened.
  await backOff.hover()
  await expect(tooltip(page)).toContainText('BackOff')
  // (The ring is the keyboard's: where the pointer is, the row, a hairline and this.)
  await expect(backOff).not.toHaveClass(/ring-2/)
  await expect(tooltip(page)).toContainText('Warning')
  await expect(tooltip(page)).toContainText('×58')
  await expect(tooltip(page)).toContainText('Back-off restarting failed container app in pod')
  await expect(tooltip(page)).toContainText(/First .+, Last /)
  // An event once says when: At.
  await grid(page)
    .getByRole('button', { name: /^ScalingReplicaSet on Deployment checkout/ })
    .hover()
  await expect(tooltip(page)).toContainText(/At \d/)

  // A mark opens its event; a row's name, its object.
  await backOff.click()
  await expect.poll(() => new URL(page.url()).hash).toMatch(/open=Event%2Fshop%2Fcheckout-/)
  await grid(page).getByRole('rowheader').nth(1).getByRole('button').click()
  await expect.poll(() => new URL(page.url()).hash).toMatch(/open=Pod%2Fshop%2Fcheckout-\S+-hqnnn/)
  // And List goes back to the list, which the address says too.
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(grid(page)).toHaveCount(0)
  expect(new URL(page.url()).hash).not.toContain('as=timeline')
})

test('the keys move through a timeline: rows up and down, events left and right, Enter opens one, Tab comes to the row’s name', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await incident(page)
  await grid(page).focus()
  // Down puts the keys on the first row's first event, and says it.
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('ScalingReplicaSet')
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('Scheduled')
  // Right steps through the row's events by when each began.
  await page.keyboard.press('ArrowRight')
  await expect(tooltip(page)).toContainText('Pulled')
  await page.keyboard.press('ArrowRight')
  await expect(tooltip(page)).toContainText('BackOff')
  await page.keyboard.press('ArrowLeft')
  await expect(tooltip(page)).toContainText('Pulled')
  await page.keyboard.press('End')
  await expect(tooltip(page)).toContainText('BackOff')
  // Up and down keep to the nearest time on the row they come to.
  await page.keyboard.press('ArrowUp')
  await expect(tooltip(page)).toContainText('ScalingReplicaSet')
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('Scheduled')
  // Escape lets go.
  await page.keyboard.press('Escape')
  await expect(tooltip(page)).toHaveCount(0)
  // One stop: Tab goes on to the name of the row the keys are on, and back again.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toContainText('hqnnn')
  await page.keyboard.press('Shift+Tab')
  await expect(grid(page)).toBeFocused()
  // Enter opens the event the keys are on.
  await page.keyboard.press('Enter')
  await expect
    .poll(() => new URL(page.url()).hash)
    .toMatch(/open=Event%2Fshop%2Fcheckout-\S+-hqnnn\./)
})

test('four reasons repeating at once: Warnings keep the lanes, most repeated first, and the rest are one pile that says how many, lists them, and is stepped through one by one', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await openCluster(page)
  await goTo(page, 'Events')
  await page.getByPlaceholder('Filter events').fill('recommendations')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await page.getByRole('button', { name: '1h', exact: true }).click()
  // The pod whose image can't be pulled: four reasons repeat over the same minutes.
  const pod = grid(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader').filter({ hasText: /Pod\s*recommendations/ }) })
  // On top, the Warning repeated most; then a Warning; the other two one pile, a Warning in it.
  await expect(
    pod.getByRole('button', { name: /^Failed on Pod \S+, 71 times, last .+ ago$/ }),
  ).toHaveAttribute('data-lane', '0')
  await expect(
    pod.getByRole('button', { name: /^Failed on Pod \S+, 9 times, last .+ ago$/ }),
  ).toHaveAttribute('data-lane', '1')
  const pile = pod.getByRole('button', {
    name: /^2 events that repeated over the same stretch: Failed on Pod \S+, 9 times, last .+ ago; BackOff on Pod \S+, 71 times, last .+ ago$/,
  })
  await expect(pile).toHaveAttribute('data-lane', '2')
  await expect(pile).toHaveText('+2')
  // Pointed at, a line for each it holds.
  await pile.hover()
  await expect(tooltip(page).getByRole('listitem')).toHaveText([
    /^Failed\s*Warning\s*×9/,
    /^BackOff\s*Normal\s*×71/,
  ])
  await expect(pile).not.toHaveClass(/ring-2/)
  // The keys step through it one by one, each said as itself, the pile ringed while they're in it.
  await page.mouse.move(0, 0)
  await grid(page).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('ScalingReplicaSet')
  // (Two that began and ended together come in their names' order: ErrImagePull's first.)
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('Error: ErrImagePull')
  await expect(pile).not.toHaveClass(/ring-2/)
  await page.keyboard.press('ArrowRight')
  await expect(tooltip(page)).toContainText('Failed to pull image')
  await expect(tooltip(page).getByRole('listitem')).toHaveCount(0)
  await expect(pile).toHaveClass(/ring-2/)
  await page.keyboard.press('ArrowRight')
  await expect(tooltip(page)).toContainText('Back-off pulling image')
  await expect(pile).toHaveClass(/ring-2/)
  await page.keyboard.press('ArrowRight')
  await expect(tooltip(page)).toContainText('Error: ImagePullBackOff')
  await expect(pile).not.toHaveClass(/ring-2/)
})

/**
 * Every count drawn on the timeline that's in the way of something: its box (in pixels from its
 * row's track) and what it's over, or its leaving the track (over the names, or past now).
 */
const countsInTheWay = (page: Page) =>
  grid(page).evaluate((grid) => {
    // (As the timeline leaves after now, for a count by the last mark.)
    const AFTER = 48
    const found: string[] = []
    for (const cell of grid.querySelectorAll('[role="gridcell"]')) {
      const track = cell.getBoundingClientRect()
      const marks = [...cell.querySelectorAll<HTMLElement>('button')]
      for (const count of cell.querySelectorAll<HTMLElement>('[data-count]')) {
        const own = count.closest('button')!
        const box = count.getBoundingClientRect()
        const said = `${count.textContent} of ${own.getAttribute('aria-label')}`
        if (box.left < track.left - 0.5 || box.right > track.right - AFTER + 0.5) {
          found.push(`${said}: off the track`)
        }
        for (const mark of marks) {
          if (mark === own) continue
          // Bars in another lane are above or below; marks are in the middle, so in every lane.
          const lane = mark.dataset.lane
          if (lane !== undefined && own.dataset.lane !== undefined && lane !== own.dataset.lane) {
            continue
          }
          // A single mark is its glyph; a bar, or close marks' pill, the whole of it.
          const glyph =
            mark.dataset.lane === undefined &&
            mark.querySelector(':scope > svg, :scope > span[aria-hidden]')
          const it = (glyph || mark).getBoundingClientRect()
          if (box.right > it.left + 0.5 && it.right > box.left + 0.5) {
            found.push(`${said}: over ${mark.getAttribute('aria-label')}`)
          }
        }
      }
    }
    return found
  })

test('a short bar’s count goes where it covers nothing: after it, before its first mark where a mark is after it, and never over the names or past now', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await openCluster(page)
  await goTo(page, 'Events')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await page.getByRole('button', { name: '1h', exact: true }).click()
  // The node-exporter pod on the node that went away: its probe failed 31 times in two minutes,
  // and a minute after, NodeNotReady once, just where the count would go after the bar.
  const pod = grid(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader').filter({ hasText: /Pod\s*node-exporter/ }) })
  const unhealthy = pod.getByRole('button', {
    name: /^Unhealthy on Pod node-exporter-\S+, 31 times, last .+ ago$/,
  })
  const notReady = pod.getByRole('button', {
    name: /^NodeNotReady on Pod node-exporter-\S+, .+ ago$/,
  })
  const count = unhealthy.locator('[data-count]')
  await expect(count).toHaveText('×31')
  // So it's before the bar's first mark, 4 px from it, clear of NodeNotReady's.
  await expect(count).toHaveAttribute('data-count', 'before')
  const [box, first, mark] = await Promise.all([
    placed(count),
    placed(unhealthy.locator('svg')),
    placed(notReady.locator('svg')),
  ])
  expect(first.x - (box.x + box.width)).toBeCloseTo(4, 0)
  expect(box.x + box.width <= mark.x || mark.x + mark.width <= box.x).toBe(true)
  // Nowhere in view is a count over another's mark or bar, or off the track: at the last hour,
  // where bars are wide, and across all the events there are, where most are short.
  expect(await countsInTheWay(page)).toEqual([])
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await countsInTheWay(page)).toEqual([])
})

test('a card stays with its row: a zoom lets it go, and rows coming in above don’t hand it to another', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  await incident(page)
  // Held by the keys on the second row's first event: its pod's Scheduled.
  await grid(page).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toContainText('Scheduled')
  await expect(tooltip(page)).toContainText('hqnnn')
  // An object whose events began before all of theirs comes in: a row above the rest.
  const at = new Date(Date.now() - 50 * 60_000).toISOString()
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Event',
    metadata: {
      name: 'checkout-early.1',
      namespace: 'shop',
      uid: 'checkout-early-1',
      creationTimestamp: at,
    },
    involvedObject: {
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'checkout-early',
      apiVersion: 'v1',
    },
    reason: 'Synced',
    message: 'checkout settings synced',
    source: { component: 'tests' },
    firstTimestamp: at,
    lastTimestamp: at,
    count: 1,
    type: 'Normal',
  } as never)
  await expect(grid(page).getByRole('rowheader').first()).toContainText('checkout-early')
  // The card is still its pod's, now a row further down.
  await expect(tooltip(page)).toContainText('hqnnn')
  await expect(tooltip(page)).toContainText('Scheduled')
  // An event of the pod's own from before it comes in: the card is still on the one it was on.
  const pod = DEMO.pods.checkout.find((name) => name.endsWith('hqnnn'))!
  const before = new Date(Date.now() - 49 * 60_000).toISOString()
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Event',
    metadata: {
      name: `${pod}.early`,
      namespace: 'shop',
      uid: `${pod}-early`,
      creationTimestamp: before,
    },
    involvedObject: { kind: 'Pod', namespace: 'shop', name: pod, apiVersion: 'v1' },
    reason: 'FailedScheduling',
    message: '0/3 nodes are available: 3 Insufficient cpu.',
    source: { component: 'default-scheduler' },
    firstTimestamp: before,
    lastTimestamp: before,
    count: 1,
    type: 'Warning',
  } as never)
  await expect(
    grid(page).getByRole('button', { name: /^FailedScheduling on Pod \S+-hqnnn/ }),
  ).toBeVisible()
  await expect(tooltip(page)).toContainText('Scheduled')
  await expect(tooltip(page)).not.toContainText('FailedScheduling')
  // Marks close together (every event there is, over months), pressed, zoom in: the card is let
  // go, not left naming what the row it was on shows now.
  await page.keyboard.press('Escape')
  await page.getByPlaceholder('Filter events').fill('')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  const together = grid(page)
    .getByRole('row')
    .filter({ hasText: 'hqnnn' })
    .getByRole('button', { name: /^\d+ events close together/ })
    .first()
  await together.hover()
  await expect(tooltip(page)).toContainText('hqnnn')
  await together.click()
  await expect(grid(page)).toHaveAccessibleName(/zoomed in/)
  await expect(tooltip(page)).toHaveCount(0)
  // And from Reset zoom and the range's buttons alike.
  await grid(page).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toBeVisible()
  await page.getByRole('button', { name: 'Reset zoom' }).first().click()
  await expect(tooltip(page)).toHaveCount(0)
  await grid(page).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tooltip(page)).toBeVisible()
  await page.getByRole('button', { name: '1h', exact: true }).click()
  await expect(tooltip(page)).toHaveCount(0)
})

test('a timeline zooms into what’s dragged across, and says when a stretch, or a filter, has nothing', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await incident(page)
  // The track of the first row: its times run from an hour ago to now, and 48 px after it.
  const track = await placed(grid(page).getByRole('gridcell').first())
  const plot = track.width - 48
  const y = track.y + track.height / 2
  // Dragged across the minutes before anything happened: nothing in that stretch.
  await page.mouse.move(track.x + 4, y)
  await page.mouse.down()
  await page.mouse.move(track.x + plot * 0.1, y, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByText('No events in this stretch.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset zoom' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Reset zoom' }).first().click()
  await expect(grid(page)).toBeVisible()
  await expect(page.getByRole('button', { name: '1h', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // Across the incident: zoomed in, with the window in a chip that resets it.
  const again = await placed(grid(page).getByRole('gridcell').first())
  await page.mouse.move(again.x + plot * 0.2, y)
  await page.mouse.down()
  await page.mouse.move(again.x + plot * 0.5, y, { steps: 4 })
  await page.mouse.up()
  await expect(grid(page)).toHaveAccessibleName(/zoomed in/)
  await expect(page.getByRole('button', { name: '1h', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  // The page's filters are the timeline's: the Warning chip, and the filter.
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.getByRole('button', { name: /^Warning/ }).click()
  await expect(grid(page).getByRole('rowheader')).toHaveText([/hqnnn/, /pwkd2/])
  await page.getByPlaceholder('Filter events').fill('no such event anywhere')
  await expect(page.getByText('No events match.')).toBeVisible()
})

test('all the events there are, however old: an axis of months', async ({ lumovi }) => {
  const { page } = lumovi
  await openCluster(page)
  await goTo(page, 'Events')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // (The demo cluster keeps an event from 88 days ago: the axis still has its times.)
  const axis = grid(page).getByRole('columnheader').nth(1)
  await expect.poll(async () => (await axis.innerText()).split(/\s+/).length).toBeGreaterThan(3)
  await expect(axis).toContainText('now')
  await expect(page.getByRole('note').filter({ hasText: 'Kubernetes keeps events' })).toHaveText(
    'Kubernetes keeps events for about an hour, unless its API server is set otherwise: older ones are gone, here as in kubectl.',
  )
})

test('an object’s Events tab draws a row a reason, and opens the way it was left', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await incident(page)
  await grid(page).getByRole('rowheader').nth(1).getByRole('button').click()
  const panel = page.getByRole('complementary')
  await panel.getByRole('tab', { name: 'Events' }).click()
  await panel.getByRole('button', { name: 'Timeline', exact: true }).click()
  const tab = panel.getByRole('grid', { name: /^Events on a timeline/ })
  await expect(tab.getByRole('rowheader')).toHaveText([/^Scheduled/, /^Pulled/, /^BackOff/])
  await expect(tab.getByRole('columnheader').first()).toHaveText('Reason')
  // Another object's tab opens as a timeline too: it's kept with the person.
  await grid(page).getByRole('rowheader').nth(2).getByRole('button').click()
  await panel.getByRole('tab', { name: 'Events' }).click()
  await expect(panel.getByRole('grid', { name: /^Events on a timeline/ })).toBeVisible()
  await panel.getByRole('button', { name: 'List', exact: true }).click()
  await expect(panel.getByRole('list', { name: 'Events' })).toBeVisible()
})

test('a panel opened from a timeline too narrow to keep beside it opens over it, and the timeline stays as it was', async ({
  launch,
}) => {
  // (The narrowest window Lumovi has: a panel beside the page would leave it too little.)
  const { page } = await launch({ fullLayout: false, env: { LUMOVI_E2E_WINDOW: '1024x768' } })
  await incident(page)
  await page.getByRole('button', { name: '15m', exact: true }).click()
  await grid(page).getByRole('rowheader').nth(1).getByRole('button').click()
  await expect(page.locator('aside[data-over]')).toBeVisible()
  // What was clicked is still there under it: the timeline, as it was.
  await expect(grid(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Close (Esc)' }).click()
  await expect(page.locator('aside[data-over]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '15m', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

/** The switch between Events' list and its timeline, and its Timeline button. */
const switchOf = (page: Page) => page.getByRole('group', { name: 'Show events as' })

test('alone at 1024, the Events toolbar puts its chips under, and List and Timeline stay whole in the window', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  await openCluster(page)
  await goTo(page, 'Events')
  const shown = await placed(switchOf(page))
  const width = await page.evaluate(() => document.documentElement.clientWidth)
  expect(shown.x + shown.width).toBeLessThanOrEqual(width)
  // The filter keeps room to type in.
  expect((await placed(page.getByPlaceholder(/^Filter/))).width).toBeGreaterThanOrEqual(80)
  await switchOf(page).getByRole('button', { name: 'Timeline' }).click()
  await expect(grid(page)).toBeVisible()
})

test('beside a panel at 1440, the Events toolbar keeps List and Timeline whole beside it, and its filter room to type in', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await openCluster(page)
  await goTo(page, 'Events')
  await page.getByRole('grid').getByRole('row').nth(1).getByRole('gridcell').nth(1).click()
  const panel = await placed(page.getByRole('complementary', { name: /^Event / }))
  const shown = await placed(switchOf(page))
  expect(shown.x + shown.width).toBeLessThanOrEqual(panel.x)
  expect((await placed(page.getByPlaceholder(/^Filter/))).width).toBeGreaterThanOrEqual(80)
  await switchOf(page).getByRole('button', { name: 'Timeline' }).click()
  await expect(grid(page)).toBeVisible()
})
