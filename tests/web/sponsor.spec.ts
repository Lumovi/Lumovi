/**
 * The sidebar's sponsor card on a server, and on a fleet's hub: the server reads
 * Lumovi/main-sponsor and serves the card from its own origin, so the browser reaches nothing
 * else (and the page's CSP stays as it is).
 */
import type { Page } from '@playwright/test'
import { ACME, picture, sponsorJson, startMockSponsor } from '../mock-sponsor/server.ts'
import { expect, test } from './fixtures.ts'
import { as, card as clusterCard, fleetEnv } from './fleet.ts'
import { FLEET } from '../mock-cluster/fleet.ts'

const card = (page: Page) => page.getByRole('region', { name: 'Sponsor' })
const link = (page: Page) => card(page).getByRole('link')

test('the server reads the card, and serves it from its own origin', async ({
  page,
  context,
  serve,
}) => {
  const sponsor = await startMockSponsor()
  sponsor.serveAcme()
  try {
    const served = await serve({
      env: {
        LUMOVI_AUTH: 'proxy',
        LUMOVI_SPONSOR_URL: sponsor.url,
        LUMOVI_SPONSOR_REFRESH_MS: '250',
      },
    })
    const elsewhere: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (!url.startsWith('data:') && !url.startsWith(served.url)) elsewhere.push(url)
    })
    await as(context, 'leo@example.com')
    await page.goto(served.url)
    await expect(link(page)).toHaveAccessibleName('Acme Rockets, anvils and other gear.')
    await expect(link(page)).toHaveAccessibleDescription('acme.example')
    // In a tab of its own, that can't reach back into the page, and tells the sponsor nothing.
    await expect(link(page)).toHaveAttribute('href', ACME.link)
    await expect(link(page)).toHaveAttribute('target', '_blank')
    await expect(link(page)).toHaveAttribute('rel', 'noopener noreferrer')
    const src = await card(page).locator('img:visible').getAttribute('src')
    expect(Buffer.from(src!.split(',')[1]!, 'base64')).toEqual(picture('example-light.png'))

    // A change shows on the open page.
    sponsor.files.set('sponsor.json', sponsorJson({ mode: 'lumovi' }))
    await expect(link(page)).toHaveAccessibleName('Lumovi Help keep Lumovi free.')
    await expect(link(page)).toHaveAttribute('href', 'https://github.com/sponsors/Lumovi')
    sponsor.files.set('sponsor.json', sponsorJson({ mode: 'none' }))
    await expect(card(page)).toHaveCount(0)

    // Nothing hot-linked: the page asked only its own server.
    expect(elsewhere).toEqual([])
    // And the server asked for nothing but the files.
    expect(new Set(sponsor.requests.map((r) => r.path))).toEqual(
      new Set(['/sponsor.json', '/acme-light.png', '/acme-dark.png']),
    )
    for (const { headers } of sponsor.requests) {
      expect(headers.cookie).toBeUndefined()
      expect(headers.referer).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
      expect(headers['x-forwarded-user']).toBeUndefined()
    }
    // Quietly: nothing in its log about it.
    expect(served.log()).not.toMatch(/sponsor/i)
  } finally {
    await sponsor.close()
  }
})

test('a server with no way out shows Lumovi’s own card, with no wait and nothing logged', async ({
  page,
  context,
  serve,
}) => {
  // (The tests' servers all read from a closed port.)
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await as(context, 'leo@example.com')
  await page.goto(served.url)
  await expect(link(page)).toHaveAccessibleName('Lumovi Help keep Lumovi free.')
  await expect(link(page)).toHaveAttribute('href', 'https://github.com/sponsors/Lumovi')
  expect(served.log()).not.toMatch(/sponsor|ECONNREFUSED/i)
})

test('a fleet’s hub shows the card with each cluster', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const sponsor = await startMockSponsor()
  sponsor.serveAcme()
  try {
    const served = await serve({
      env: { ...fleetEnv(clusters), LUMOVI_SPONSOR_URL: sponsor.url },
    })
    await as(context, 'alice@example.com')
    await page.goto(served.url)
    await clusterCard(page, FLEET.prodEu).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
    await expect(link(page)).toHaveAccessibleName('Acme Rockets, anvils and other gear.')
  } finally {
    await sponsor.close()
  }
})
