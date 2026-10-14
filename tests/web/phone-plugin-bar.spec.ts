/**
 * On a phone, Lumovi's top bar is Lumovi's: its title is the page's own, which Lumovi wrote from
 * the plugin's file, on every page of a plugin's. Nothing a plugin's code sends is drawn there,
 * a picked row's name least of all: that is the first line of the plugin's own page, under
 * Lumovi's strip that says whose page it is.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { placed } from '../placed.ts'
import { DEMO_TOKEN, expect, freePort, test } from './fixtures.ts'
import { expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

/** What every text of the plugin's carries here, so that none of it can be anywhere unseen. */
const MARK = 'x-toys-wrote-this'
/** A row named as Lumovi might name a page of its own, with a character that turns text round. */
const NAME = `Lumovi: your session ended. Sign in again ${MARK} ‮niaga`
const UNDER = `under ${MARK}`

/** Its code: a split of two rows, each with a page of one card. Every text carries the mark. */
const CODE = `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Split', { list: { title: 'Things ${MARK}', rows: [
        { key: 'a', lead: { name: ${JSON.stringify(NAME)}, beside: 'beside ${MARK}', under: ${JSON.stringify(UNDER)} }, status: { level: 'critical', word: 'word ${MARK}' } },
        { key: 'b', lead: { name: 'second ${MARK}' } },
      ] } }],
      ['make', 2, 'Stack', {}],
      ['make', 3, 'Header', { name: ${JSON.stringify(NAME)}, status: { level: 'critical', word: 'status ${MARK}' } }],
      ['make', 4, 'Card', { title: 'Its page ${MARK}' }],
      ['put', 2, 3], ['put', 2, 4], ['put', 1, 2], ['put', 0, 1],
    ] }))
  })
})
`

test('a plugin’s text never reaches Lumovi’s top bar on a phone: a picked row’s name is the first line of the plugin’s page, and the bar keeps the page’s own title', async ({
  serve,
  page,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), CODE)
  const port = await freePort()
  const server = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  await signInNarrow(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
  // (Lumovi's top bar: the one header with the page's title in it.)
  const bar = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) })
  const body = page.locator('[data-plugin-body="toys"]')
  const row = body.getByRole('button').filter({ hasText: 'your session ended' })
  await expect(row).toBeVisible({ timeout: 30_000 })
  // The list is the page: the bar has Menu, and the page's title, the plugin's label from its
  // file. (All of the bar, whatever it's made of: its text, and every name and title in it.)
  const barSays = () =>
    bar.evaluate((element) =>
      [
        element.textContent,
        ...[...element.querySelectorAll('*')].flatMap((each) => [
          each.getAttribute('aria-label'),
          each.getAttribute('title'),
          each.getAttribute('alt'),
        ]),
      ]
        .filter(Boolean)
        .join(' | '),
    )
  await expect(bar.getByRole('heading', { level: 1 })).toHaveAccessibleName('Toys')
  expect(await barSays()).not.toContain(MARK)
  // Tapped: a page of its own. The bar has Back to the list in Menu's place, Lumovi's words,
  // and the same title; nothing the plugin wrote is in it.
  await row.tap()
  await expect(bar.getByRole('button', { name: 'Back to the list', exact: true })).toBeFocused()
  await expect(bar.getByRole('button', { name: 'Menu' })).toHaveCount(0)
  await expect(bar.getByRole('heading', { level: 1 })).toHaveAccessibleName('Toys')
  const says = await barSays()
  for (const never of [MARK, 'session', 'Sign in', 'niaga', 'U+202E']) {
    expect(says, never).not.toContain(never)
  }
  // Nor does the page's own name change for it (the tab's, which a person reads too).
  expect(await page.title()).not.toContain(MARK)
  // The name is in the plugin's page, under Lumovi's strip that says whose page it is: whole,
  // as a plugin's text is drawn (what can't be seen as a mark), one heading below the bar's.
  const strip = page.getByTestId('plugin-whose')
  await expect(strip).toContainText('From the plugin Toys 1.2.0')
  const name = body.getByRole('heading', { level: 2 }).first()
  await expect(name).toContainText(`Lumovi: your session ended. Sign in again ${MARK}`)
  await expect(name.getByRole('img', { name: 'invisible character U+202E' })).toHaveCount(1)
  const [stripBox, nameBox, barBox] = [await placed(strip), await placed(name), await placed(bar)]
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(stripBox.y + 1)
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(nameBox.y + 1)
  // Its header under it doesn't say the name again.
  await expect(body.getByRole('heading').filter({ hasText: 'your session ended' })).toHaveCount(1)
  await expectNoSidewaysScroll(page, 'a plugin’s picked row, on a phone')
  // Back returns to the list, with Menu again, the keyboard on the row that was opened, and
  // the bar as it was.
  await bar.getByRole('button', { name: 'Back to the list', exact: true }).tap()
  await expect(bar.getByRole('button', { name: 'Menu' })).toBeVisible()
  await expect(row).toBeFocused()
  expect(await barSays()).not.toContain(MARK)
})
