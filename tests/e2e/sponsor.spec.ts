/**
 * The sidebar's sponsor card, as Lumovi/main-sponsor's sponsor.json says: Lumovi's own, a
 * sponsor's, or nothing; and Lumovi's own whenever what it says can't be read or doesn't pass.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  ACME,
  picture,
  sponsorJson,
  startMockSponsor,
  type MockSponsor,
} from '../mock-sponsor/server.ts'
import {
  expect,
  mockOpenExternal,
  openCluster,
  test as base,
  type LaunchOptions,
  type Lumovi,
} from './fixtures.ts'

const test = base.extend<{
  sponsor: MockSponsor
  /** Lumovi, reading its sponsor card from the stand-in, every 250 ms. */
  launchSponsored: (options?: LaunchOptions) => Promise<Lumovi>
}>({
  // eslint-disable-next-line no-empty-pattern
  sponsor: async ({}, use) => {
    const sponsor = await startMockSponsor()
    await use(sponsor)
    await sponsor.close()
  },
  launchSponsored: async ({ launch, sponsor }, use) => {
    await use((options = {}) =>
      launch({
        ...options,
        env: {
          LUMOVI_SPONSOR_URL: sponsor.url,
          LUMOVI_SPONSOR_REFRESH_MS: '250',
          ...options.env,
        },
      }),
    )
  },
})

const BUILT_IN = 'https://github.com/sponsors/Lumovi'

const card = (page: Page) => page.getByRole('region', { name: 'Sponsor' })
const link = (page: Page) => card(page).getByRole('link')

/** The card's picture that shows, in the mode in use. */
const shownPicture = (page: Page) => card(page).locator('img:visible')

/** What a picture's data: URL holds. */
const dataOf = (src: string | null) => Buffer.from(src!.split(',')[1]!, 'base64')

/** The card leads to Lumovi's own GitHub Sponsors page, or where sponsor.json says. */
async function expectLumovis(page: Page, to = BUILT_IN) {
  await expect(link(page)).toHaveAccessibleName('Lumovi Help keep Lumovi free.')
  await expect(link(page)).toHaveAttribute('href', to)
}

test('Lumovi’s own card, leading where sponsor.json says, read with nothing but the request', async ({
  launchSponsored,
  sponsor,
}) => {
  sponsor.files.set(
    'sponsor.json',
    sponsorJson({ mode: 'lumovi', lumovi: { link: 'https://www.lumovi.example/sponsor' } }),
  )
  const { app, page } = await launchSponsored()
  const opened = await mockOpenExternal(app)
  await openCluster(page)
  await expectLumovis(page, 'https://www.lumovi.example/sponsor')
  // Its picture is Lumovi's own, built in.
  await expect(shownPicture(page)).toHaveAttribute('src', /^(?!data:)/)
  await expect(shownPicture(page)).toHaveAttribute('alt', 'Lumovi')
  // Where it leads, without www., shows as it's pointed at, and screen readers hear it.
  await expect(link(page)).toHaveAccessibleDescription('lumovi.example')
  // (It fades in as a whole: the domain and its arrow.)
  const domain = card(page).getByText('lumovi.example').locator('xpath=../..')
  await expect(domain).toHaveCSS('opacity', '0')
  await link(page).hover()
  await expect(domain).toHaveCSS('opacity', '1')
  // The browser opens it, not the app's window.
  await link(page).click()
  await expect.poll(opened).toEqual(['https://www.lumovi.example/sponsor'])
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')

  // Only sponsor.json was asked for (Lumovi's own card has no pictures to read), with nothing
  // that says who asks: no cookies, referrer or credentials.
  expect(new Set(sponsor.requests.map((r) => r.path))).toEqual(new Set(['/sponsor.json']))
  for (const { headers } of sponsor.requests) {
    expect(Object.keys(headers).sort()).toEqual(
      expect.arrayContaining(['accept', 'host', 'user-agent']),
    )
    for (const name of Object.keys(headers)) {
      expect([
        'accept',
        'accept-encoding',
        'accept-language',
        'connection',
        'host',
        'sec-fetch-mode',
        'user-agent',
      ]).toContain(name)
    }
    expect(headers['user-agent']).not.toMatch(/lumovi|electron/i)
  }
})

test('a sponsor’s card: its picture for each mode, its line, and its link in the browser', async ({
  launchSponsored,
  sponsor,
}) => {
  sponsor.serveAcme()
  const { app, page } = await launchSponsored({ theme: 'light' })
  const opened = await mockOpenExternal(app)
  await openCluster(page)
  await expect(link(page)).toHaveAccessibleName('Acme Rockets, anvils and other gear.')
  await expect(link(page)).toHaveAccessibleDescription('acme.example')
  // Lumovi's own copy of each picture, as it was read.
  const src = () => shownPicture(page).getAttribute('src')
  await expect.poll(async () => dataOf(await src())).toEqual(picture('example-light.png'))
  await page.evaluate(() => window.lumovi!.app.setTheme('dark'))
  await expect.poll(async () => dataOf(await src())).toEqual(picture('example-dark.png'))

  // With the keyboard too: the domain shows with its focus (back from the footer).
  await page.getByRole('button', { name: 'Theme' }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(link(page)).toBeFocused()
  await expect(card(page).getByText('acme.example').locator('xpath=../..')).toHaveCSS(
    'opacity',
    '1',
  )
  await page.keyboard.press('Enter')
  await expect.poll(opened).toEqual([ACME.link])
  // Each picture once, then asked only whether it changed (ETag).
  const asked = sponsor.requests.filter((r) => r.path === '/acme-light.png')
  expect(asked[0]!.headers['if-none-match']).toBeUndefined()
  await expect
    .poll(() => sponsor.requests.filter((r) => r.path === '/acme-light.png').length)
    .toBeGreaterThan(1)
  expect(
    sponsor.requests.filter((r) => r.path === '/acme-light.png')[1]!.headers['if-none-match'],
  ).toMatch(/^"/)
})

test('a change to sponsor.json shows while Lumovi runs: another card, or none', async ({
  launchSponsored,
  sponsor,
}) => {
  sponsor.files.set('sponsor.json', sponsorJson({ mode: 'lumovi' }))
  const { page } = await launchSponsored()
  await openCluster(page)
  await expectLumovis(page)

  sponsor.serveAcme()
  await expect(link(page)).toHaveAccessibleName('Acme Rockets, anvils and other gear.')

  // Nothing: the sidebar as it's always been, the nav down to the footer.
  sponsor.files.set('sponsor.json', sponsorJson({ mode: 'none' }))
  await expect(card(page)).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Resources' })
  await expect(nav).not.toHaveAttribute('style', /mask/)

  sponsor.files.set('sponsor.json', sponsorJson({ mode: 'lumovi' }))
  await expectLumovis(page)
})

test('whatever doesn’t pass shows Lumovi’s own card, never an error', async ({
  launchSponsored,
  sponsor,
}) => {
  const lumovi = { link: 'https://lumovi.example/own' }
  sponsor.serveAcme()
  const { page } = await launchSponsored({ theme: 'light' })
  await openCluster(page)
  const acme = () => expect(link(page)).toHaveAccessibleName(/^Acme/)
  await acme()

  const cases: [string, () => void, string][] = [
    ['invalid JSON', () => sponsor.files.set('sponsor.json', '{"version": 1, "mode": '), BUILT_IN],
    ['no file', () => sponsor.files.delete('sponsor.json'), BUILT_IN],
    [
      'a link that isn’t https',
      () => sponsor.serveAcme({ link: 'http://acme.example/' }),
      BUILT_IN,
    ],
    [
      'past its last day',
      () =>
        sponsor.files.set(
          'sponsor.json',
          sponsorJson({ mode: 'sponsor', lumovi, sponsor: { ...ACME, until: '2026-01-31' } }),
        ),
      lumovi.link,
    ],
    [
      'a picture of the wrong size',
      () => sponsor.files.set('acme-dark.png', picture('wrong-size.png')),
      lumovi.link,
    ],
    [
      'a picture that loops',
      () => sponsor.files.set('acme-light.png', picture('looping.gif')),
      lumovi.link,
    ],
    [
      'a picture that isn’t one',
      () =>
        sponsor.files.set(
          'acme-light.png',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        ),
      lumovi.link,
    ],
    ['a picture that isn’t there', () => sponsor.files.delete('acme-light.png'), lumovi.link],
    // Whole as far as Lumovi reads it, but the page can't draw it.
    [
      'a picture broken inside',
      () => sponsor.files.set('acme-dark.png', picture('broken.png')),
      lumovi.link,
    ],
  ]
  for (const [what, make, to] of cases) {
    await test.step(what, async () => {
      if (to === lumovi.link)
        sponsor.files.set('sponsor.json', sponsorJson({ mode: 'sponsor', lumovi, sponsor: ACME }))
      make()
      await expectLumovis(page, to)
      await expect(page.getByRole('alert')).toHaveCount(0)
      sponsor.serveAcme()
      await acme()
    })
  }

  // GitHub not answering keeps what was read last: the sponsor's card doesn't flicker away.
  sponsor.fail = 'drop'
  const asked = sponsor.requests.length
  await expect.poll(() => sponsor.requests.length).toBeGreaterThan(asked + 2)
  await acme()
})

test('pictures are taken by what they are: PNG, GIF or WebP, still or playing once, for 5 s at most', async ({
  launchSponsored,
  sponsor,
}) => {
  const lumovi = { link: 'https://lumovi.example/own' }
  sponsor.serveAcme()
  sponsor.files.set('sponsor.json', sponsorJson({ mode: 'sponsor', lumovi, sponsor: ACME }))
  const { page } = await launchSponsored({ theme: 'light' })
  await openCluster(page)
  const cases: [string, boolean][] = [
    ['still-lossy.webp', true],
    ['still-lossless.webp', true],
    ['animated.webp', true],
    ['animated.gif', true],
    ['looping.webp', false],
    ['long.webp', false],
    ['apng.png', false],
    ['wrong-size.png', false],
  ]
  for (const [name, taken] of cases) {
    await test.step(name, async () => {
      sponsor.files.set('acme-light.png', picture(name))
      if (taken) {
        await expect
          .poll(async () => dataOf(await shownPicture(page).getAttribute('src')))
          .toEqual(picture(name))
      } else {
        await expectLumovis(page, lumovi.link)
      }
      sponsor.files.set('acme-light.png', picture('example-light.png'))
      await expect(link(page)).toHaveAccessibleName(/^Acme/)
    })
  }
})

test('offline, Lumovi’s own card, at once; and the last card read, from the next start', async ({
  launchSponsored,
  sponsor,
  launch,
}) => {
  // Nothing answers: no wait, no error.
  sponsor.fail = 'drop'
  const offline = await launchSponsored()
  await openCluster(offline.page)
  await expectLumovis(offline.page)
  await offline.close()

  sponsor.fail = undefined
  sponsor.serveAcme()
  const first = await launchSponsored()
  await openCluster(first.page)
  await expect(link(first.page)).toHaveAccessibleName(/^Acme/)
  // Kept once it's read.
  await expect.poll(() => existsSync(join(first.userDataDir, 'sponsor', 'kept.json'))).toBe(true)
  await first.close()

  // Started again offline, and before it reads anything: the card it read last time.
  sponsor.fail = 'drop'
  const again = await launch({
    userDataDir: first.userDataDir,
    env: { LUMOVI_SPONSOR_URL: sponsor.url, LUMOVI_SPONSOR_REFRESH_MS: '600000' },
  })
  await openCluster(again.page)
  await expect(link(again.page)).toHaveAccessibleName(/^Acme/)
})

test('an animated picture plays once; for less motion, its first frame, still', async ({
  launchSponsored,
  sponsor,
}) => {
  sponsor.serveAcme({ image: { light: 'acme.webp', dark: 'acme.gif' } })
  sponsor.files.set('acme.webp', picture('animated.webp'))
  sponsor.files.set('acme.gif', picture('animated.gif'))
  const { page } = await launchSponsored({ theme: 'light' })
  await openCluster(page)
  await expect(link(page)).toHaveAccessibleName(/^Acme/)
  const shown = () => shownPicture(page).evaluate((img: HTMLImageElement) => img.currentSrc)
  // The tests ask for less motion: the first frame alone.
  const still = await shown()
  expect(still).toMatch(/^data:image\/webp;base64,/)
  expect(dataOf(still).length).toBeLessThan(picture('animated.webp').length)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(async () => dataOf(await shown())).toEqual(picture('animated.webp'))

  await page.evaluate(() => window.lumovi!.app.setTheme('dark'))
  await expect.poll(async () => dataOf(await shown())).toEqual(picture('animated.gif'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(shown).toMatch(/^data:image\/gif;base64,/)
  expect(dataOf(await shown()).length).toBeLessThan(picture('animated.gif').length)
})

test('the nav fades out over the card where it goes on; on short windows the card steps aside', async ({
  launchSponsored,
  sponsor,
}) => {
  sponsor.files.set('sponsor.json', sponsorJson({ mode: 'lumovi' }))
  const { app, page } = await launchSponsored({ fullLayout: false })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 760),
  )
  await openCluster(page)
  await expectLumovis(page)
  const nav = page.getByRole('navigation', { name: 'Resources' })
  /** Where the nav fades out: at its top, and at its bottom. */
  const fades = async () => {
    const style = (await nav.getAttribute('style')) ?? ''
    return [/gradient\(transparent/.test(style), /transparent\);?$/.test(style)]
  }
  // At the top, it goes on below.
  await expect.poll(fades).toEqual([false, true])
  await nav.evaluate((list) => list.scrollTo({ top: 60 }))
  await expect.poll(fades).toEqual([true, true])
  await nav.evaluate((list) => list.scrollTo({ top: list.scrollHeight }))
  await expect.poll(fades).toEqual([true, false])

  // Under 720 px tall, the nav keeps the room.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 700),
  )
  await expect(card(page)).toBeHidden()
})
