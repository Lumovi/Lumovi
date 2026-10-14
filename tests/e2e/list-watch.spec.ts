/**
 * Lists and objects watched while they're shown: a change in the cluster shows in about a
 * second, a list that's idle isn't read again every few seconds, and where a watch is refused
 * the list is polled as it always was.
 */
import type { KubeObject } from '../mock-cluster/types.ts'
import { holds } from '../holds.ts'
import { goTo, openCluster, row, test, expect } from './fixtures.ts'

/** A pod of the tests' own, in `default`. */
function pod(name: string, status: object): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'default', uid: `uid-${name}` },
    spec: { containers: [{ name: 'main', image: 'busybox:1.36', resources: {} }] },
    status,
  } as KubeObject
}

/** How a change must show: well within the time a poll would take. */
const AT_ONCE = { timeout: 2_500 }

test('a list watched: a change shows at once, and while it’s idle it isn’t read again every few seconds', async ({
  page,
  clusters,
}) => {
  const reads = () =>
    clusters.demo.requests.filter(
      (r) => r.path === '/api/v1/pods' && r.query.watch === undefined && r.query.limit !== '1',
    ).length
  await openCluster(page)
  await goTo(page, 'Pods')
  await expect.poll(() => clusters.demo.watches('pods')).toBe(1)
  // Read as it's shown, and once more as its watch holds, for what changed before it began.
  await expect.poll(reads).toBeGreaterThanOrEqual(2)

  // Idle: no read for longer than a poll's time.
  const idle = reads()
  await holds(() => reads() === idle, 7_000, 'an idle list watched isn’t read on a timer')

  // A pod added, then running: each at once. (Just it, in the list: a pod running sorts below.)
  await page.getByPlaceholder('Filter pods').fill('watched-1')
  clusters.demo.upsert(pod('watched-1', { phase: 'Pending' }))
  await expect(row(page, 'Pods', 'watched-1')).toContainText('Pending', AT_ONCE)
  clusters.demo.upsert(
    pod('watched-1', {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'main',
          ready: true,
          restartCount: 0,
          image: 'busybox:1.36',
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    }),
  )
  await expect(row(page, 'Pods', 'watched-1')).toContainText('Running', AT_ONCE)
  // And gone.
  clusters.demo.remove('Pod', 'default', 'watched-1')
  await expect(row(page, 'Pods', 'watched-1')).toHaveCount(0, AT_ONCE)

  // Another page: the list isn't watched once it's gone.
  await goTo(page, 'Services')
  await expect.poll(() => clusters.demo.watches('pods')).toBe(0)
})

test('an object opened is watched by its name: what it says changes at once', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(pod('watched-2', { phase: 'Pending' }))
  await openCluster(page)
  await goTo(page, 'Pods')
  await row(page, 'Pods', 'watched-2').click()
  const opened = page.getByRole('complementary', { name: 'Pod watched-2' })
  await expect(opened).toBeVisible()
  // The list's watch, and the object's.
  await expect.poll(() => clusters.demo.watches('pods')).toBe(2)
  clusters.demo.upsert(
    pod('watched-2', {
      phase: 'Failed',
      reason: 'Evicted',
      message: 'The node was low on resource: memory.',
    }),
  )
  await expect(opened).toContainText('Evicted', AT_ONCE)
})

test('a watch sent what never ends a line is ended, and its list polled as it was', async ({
  page,
  clusters,
}) => {
  const reads = () =>
    clusters.demo.requests.filter(
      (r) => r.path === '/api/v1/pods' && r.query.watch === undefined && r.query.limit !== '1',
    ).length
  await openCluster(page)
  await goTo(page, 'Pods')
  await expect.poll(() => clusters.demo.watches('pods')).toBe(1)
  clusters.demo.watchNoise(1_500_000)
  await expect.poll(() => clusters.demo.watches('pods')).toBe(0)
  const first = reads()
  await expect.poll(reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(first + 2)
})

test('a change while its list is being read has it read once more after: the read under way may be from before', async ({
  page,
  clusters,
}) => {
  const reads = () =>
    clusters.demo.requests.filter(
      (r) => r.path === '/api/v1/pods' && r.query.watch === undefined && r.query.limit !== '1',
    ).length
  await openCluster(page)
  await goTo(page, 'Pods')
  await expect.poll(() => clusters.demo.watches('pods')).toBe(1)
  await expect.poll(reads).toBeGreaterThanOrEqual(2)
  // (Settled: no read for a while.)
  const settled = reads()
  await holds(() => reads() === settled, 1_500, 'a watched list settles')
  const before = reads()
  // Its reads held (as a slow API server's are): a change has it read, and the read waits.
  let answer!: () => void
  const held = clusters.demo.fail(/^\/api\/v1\/pods\?limit=500$/, {
    until: new Promise<void>((resolve) => (answer = resolve)),
  })
  clusters.demo.upsert(pod('watched-4', { phase: 'Pending' }))
  await expect.poll(reads).toBe(before + 1)
  // Another change, while that read is under way; then the read is answered.
  clusters.demo.upsert(pod('watched-5', { phase: 'Pending' }))
  await holds(
    () => reads() === before + 1,
    1_500,
    'a read under way is waited for, not asked again',
  )
  held()
  answer()
  // Read once more after it, for what came while it was under way.
  await expect.poll(reads).toBe(before + 2)
})

test('a list watched whose read fails is read again every few seconds, until it’s back', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  await expect.poll(() => clusters.demo.watches('pods')).toBe(1)
  // Its reads fail, and its watch goes on: a change has it read, which fails.
  const clear = clusters.demo.fail(/^\/api\/v1\/pods\?limit=500$/, { status: 503 })
  clusters.demo.upsert(pod('watched-3', { phase: 'Pending' }))
  await expect(page.getByText(/Couldn’t refresh — showing the last data/)).toBeVisible(AT_ONCE)
  expect(clusters.demo.watches('pods')).toBe(1)
  // Back: read again on its own, well before a minute.
  clear()
  await expect(page.getByText(/Couldn’t refresh/)).toHaveCount(0, { timeout: 8_000 })
})

test('where watching is refused, a list is polled as it always was', async ({ page, clusters }) => {
  clusters.demo.deny({ verb: 'watch', resource: 'pods' })
  const reads = () =>
    clusters.demo.requests.filter(
      (r) => r.path === '/api/v1/pods' && r.query.watch === undefined && r.query.limit !== '1',
    ).length
  await openCluster(page)
  await goTo(page, 'Pods')
  await expect(page.getByRole('grid', { name: 'Pods' })).toBeVisible()
  const first = reads()
  await expect.poll(reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(first + 2)
  expect(clusters.demo.watches('pods')).toBe(0)
  clusters.demo.upsert(pod('polled-1', { phase: 'Pending' }))
  await expect(row(page, 'Pods', 'polled-1')).toContainText('Pending', { timeout: 8_000 })
})
