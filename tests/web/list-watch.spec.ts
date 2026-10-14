/**
 * A server's lists, watched as whoever is signed in: a change shows at once. Secrets, whose
 * showing a server's access decides, are polled as they were.
 */
import type { KubeObject } from '../mock-cluster/types.ts'
import { expect, test } from './fixtures.ts'

test('a list is watched as whoever is signed in, and a change shows at once; Secrets are polled as they were', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await context.setExtraHTTPHeaders({
    'X-Forwarded-User': 'frank@example.com',
    'X-Forwarded-Groups': 'sre',
  })
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect.poll(() => clusters.demo.watches('pods')).toBe(1)
  const watch = clusters.demo.requests.find(
    (r) => r.path === '/api/v1/pods' && r.query.watch === '1',
  )!
  expect(watch.headers['impersonate-user']).toBe('frank@example.com')

  await page.getByPlaceholder('Filter pods').fill('watched-web')
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'watched-web', namespace: 'default', uid: 'uid-watched-web' },
    spec: { containers: [{ name: 'main', image: 'busybox:1.36', resources: {} }] },
    status: { phase: 'Pending' },
  } as KubeObject)
  await expect(
    page.getByRole('grid', { name: 'Pods' }).getByRole('row').filter({ hasText: 'watched-web' }),
  ).toContainText('Pending', { timeout: 2_500 })

  await page.goto(`${served.url}cluster/demo/secrets`)
  await expect(page.getByRole('grid', { name: 'Secrets' })).toBeVisible()
  const secrets = () =>
    clusters.demo.requests.filter((r) => r.path === '/api/v1/secrets' && !r.query.watch).length
  const first = secrets()
  await expect.poll(secrets, { timeout: 15_000 }).toBeGreaterThanOrEqual(first + 2)
  expect(clusters.demo.watches('secrets')).toBe(0)
})

test('a person’s watches are counted on all their pages together: past the most, a list is polled', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_WATCHES_PER_PERSON: '1' } })
  await context.setExtraHTTPHeaders({
    'X-Forwarded-User': 'frank@example.com',
    'X-Forwarded-Groups': 'sre',
  })
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect.poll(() => clusters.demo.watches()).toBe(1)

  // Another of Frank's pages: its list isn't watched, and is read every few seconds.
  const other = await context.newPage()
  await other.goto(`${served.url}cluster/demo/services`)
  await expect(other.getByRole('grid', { name: 'Services' })).toBeVisible()
  const reads = () =>
    clusters.demo.requests.filter(
      (r) => r.path === '/api/v1/services' && r.query.watch === undefined && r.query.limit !== '1',
    ).length
  const first = reads()
  await expect.poll(reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(first + 2)
  expect(clusters.demo.watches('services')).toBe(0)
  expect(clusters.demo.watches()).toBe(1)
})
