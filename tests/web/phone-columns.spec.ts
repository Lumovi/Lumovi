/**
 * A list's columns on a phone: the same choices in a sheet a finger works, made the card's facts;
 * and the list saved as CSV by the browser.
 */
import { readFileSync } from 'node:fs'
import { DEMO, DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('columns chosen on a phone: a sheet a finger works, and the cards say the choices as their facts', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/pods?namespaces=shop`, DEMO_TOKEN)
  const button = page.getByRole('button', { name: 'Columns', exact: true })
  await button.click()
  const sheet = page.getByRole('dialog', { name: 'Columns' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Reset' })).toBeDisabled()
  await expectFingerSized(page, 'the columns’ sheet, on a phone')
  await expectNoSidewaysScroll(page, 'the columns’ sheet, on a phone')
  // Ready hidden, and a label added: the cards' facts follow.
  await sheet.getByRole('checkbox', { name: /^Ready/ }).click()
  await sheet.getByPlaceholder('Label or annotation key').fill('component')
  await sheet.getByRole('option', { name: /^app\.kubernetes\.io\/component\b/ }).click()
  await expect(sheet.getByRole('button', { name: 'Reset' })).toBeEnabled()

  // Saved by the browser, named for the kind, the namespace and the day.
  const downloading = page.waitForEvent('download')
  await sheet.getByRole('button', { name: 'Download CSV' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^pods-shop-\d{4}-\d\d-\d\d\.csv$/)
  const text = readFileSync(await download.path(), 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  expect(text.slice(1).split('\r\n')[0]).toBe(
    'Name,Status,Restarts,CPU (cores),Memory (bytes),Node,Created,app.kubernetes.io/component',
  )
  // (Said as the sheet's first line while it's open; a browser's download has no file manager
  // to show it in.)
  await expect(sheet).toContainText('Saved pods-shop-')
  await expect(page.getByRole('button', { name: /^Show in/ })).toHaveCount(0)

  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
  const card = page.getByRole('list', { name: 'Pods' }).getByRole('listitem').first()
  await expect(card).toContainText(/frontend|backend/)
  await expect(card).toContainText(/\d+ restarts?/)
  await expect(card).not.toContainText(/\d+\/\d+ ready/)
  // Nothing's sized on a phone, so nothing doesn't fit: no count on the button.
  await expect(button).toHaveText('')
  await expectNoSidewaysScroll(page, 'a list with chosen columns, on a phone')
})

test('on a phone, a key not every pod has is a fact only where it is; events lead with their reason', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/pods?namespaces=shop`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Columns' })
  await sheet.getByPlaceholder('Label or annotation key').fill('prometheus.io/port')
  await sheet.getByRole('option', { name: /^prometheus\.io\/port\b/ }).click()
  await sheet.getByRole('button', { name: 'Close' }).click()
  const card = (name: string) =>
    page.getByRole('list', { name: 'Pods' }).getByRole('listitem').filter({ hasText: name })
  await expect(card(DEMO.pods.storefront[0]!)).toContainText('9901')
  await expect(card(DEMO.pods.checkout[0]!)).toBeVisible()
  await expect(card(DEMO.pods.checkout[0]!)).not.toContainText('9901')

  // An event's name is a hash: its card leads with its reason.
  await page.goto(`${served.url}cluster/demo/events?namespaces=shop`)
  const event = page.getByRole('list', { name: 'Events' }).getByRole('listitem').first()
  await expect(event).toContainText(/BackOff|Pulled|Scheduled|Started|Created|Killing/)
  await expect(event).not.toContainText(/\.[0-9a-f]{16}/)
})

test('on a phone, a custom resource is sorted by a column of its CRD’s, named as the cluster names it', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(
    page,
    `${served.url}cluster/demo/r/Certificate.cert-manager.io?namespaces=shop`,
    DEMO_TOKEN,
  )
  await expect(page.getByRole('list', { name: 'Certificates' }).getByRole('listitem')).toHaveCount(
    3,
  )
  await page.getByRole('button', { name: /^Sort/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Sort by' })
  await sheet.getByRole('option', { name: 'Secret' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sort: by Secret' })).toBeVisible()
})
