/** Several namespaces on a phone: the chip says what's picked, and the sheet picks by finger. */
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('several namespaces picked on a phone: a box a finger’s size each, Done, and the chip says them', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  const chip = page.getByRole('button', { name: 'Namespace' })
  await chip.click()
  const sheet = page.getByRole('dialog', { name: 'Namespaces' })
  await expect(sheet).toBeVisible()
  // No Done until something's picked; a box adds, and the sheet stays.
  await expect(sheet.getByRole('button', { name: 'Done' })).toHaveCount(0)
  await sheet.getByRole('checkbox', { name: 'shop', exact: true }).click()
  await sheet.getByRole('checkbox', { name: 'data', exact: true }).click()
  await expect(sheet.getByRole('checkbox', { name: 'data', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expectFingerSized(page, 'the namespaces’ sheet, on a phone')
  await expectNoSidewaysScroll(page, 'the namespaces’ sheet, on a phone')
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(chip).toHaveText('data, shop')
  expect(new URL(page.url()).searchParams.get('namespaces')).toBe('data,shop')
  // A name picks it alone, and closes.
  await chip.click()
  await sheet.getByRole('option', { name: 'data', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  // (One name is middle-cut in the chip, as today.)
  await expect(chip).toContainText('data')
  await expect(chip).not.toContainText('shop')
  // And the close keeps what's picked.
  await chip.click()
  await sheet.getByRole('checkbox', { name: 'shop', exact: true }).click()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(chip).toHaveText('data, shop')
})
