/** Every plugin, on a phone: the page a server's administrator and its people see there. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('every plugin on a phone, as a server has them: cards, and a plugin as a page of its own', async ({
  page,
  serve,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-plugins-'))
  const long = 'the-widgets-of-the-platform-team-as-we-like-to-see-them-on-a-phone.yaml'
  writeFileSync(
    join(folder, long),
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: widgets }\nspec: { version: 2.1.0, needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Widget }] }] }\n',
  )
  writeFileSync(join(folder, 'broken.yaml'), 'apiVersion: v1\nkind: Pod\n')
  const served = await serve({ env: { LUMOVI_PLUGINS_DIR: folder } })
  await signInNarrow(page, `${served.url}cluster/demo/plugins`, DEMO_TOKEN)
  // A server's are its administrator's, and counted so: its files, the one that holds no plugin too.
  await expect(page.getByText('32 from Lumovi, 2 from this server')).toBeVisible()
  const which = page.getByRole('group', { name: 'Which plugins' })
  await expect(which.getByRole('button', { name: /^This server’s 2$/ })).toBeVisible()
  // Cards, one fact a line; a file's name whole, however long.
  // (Its own items: a file's problems are a list inside its card.)
  const cards = page.getByRole('list', { name: 'Plugins' }).locator('> li')
  const widgets = cards.filter({ hasText: 'widgets' }).filter({ hasText: '2.1.0' })
  await expect(widgets).toContainText('On this cluster')
  await expect(widgets).toContainText('This server’s')
  await expect(widgets).toContainText(long)
  const broken = cards.filter({ hasText: 'broken.yaml' }).first()
  await expect(broken).toContainText('Not in use. 1 problem to fix in the file.')
  await expect(page.getByRole('list', { name: 'Problems with broken.yaml' })).toHaveText(
    'should start with apiVersion: lumovi.dev/v1beta1 and kind: Plugin',
  )
  await expectNoSidewaysScroll(page, 'the plugins, on a phone')
  await expectFingerSized(page, 'the plugins, on a phone')
  // Narrowed to what isn't in use: the one file.
  await which.getByRole('button', { name: /^Not in use 1$/ }).click()
  await expect(cards).toHaveCount(1)
  await which.getByRole('button', { name: /^All/ }).click()

  // A card opens the plugin as a page of its own, with a way back.
  await cards.filter({ hasText: /^Flux/ }).getByRole('button').click()
  // (What a plugin is, said once, is the first thing on its own page.)
  await expect(page.getByText('this server’s are files its administrator put there.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'May change and create' })).toContainText(
    'Only the kinds it shows:',
  )
  await expect(
    page.getByRole('region', { name: 'Its actions, and what each sends' }),
  ).toContainText('runs at once')
  await expectNoSidewaysScroll(page, 'a plugin, on a phone')
  await expectFingerSized(page, 'a plugin, on a phone')
  await page.getByRole('button', { name: 'All plugins' }).click()
  await expect(cards.first()).toBeVisible()
  await expect(page.getByText('This server’s are in', { exact: false })).toBeVisible()
})
