/**
 * Create, served: its form is there where the server says so, as on the desktop.
 */
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

test('Create has its form where the server says it has, and is its YAML alone where not', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Create…', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Form' })).toBeChecked()
  await expect(dialog.getByRole('group', { name: 'Form', exact: true })).toBeVisible()
  await expect(dialog).toContainText('On demo')
  await served.stop()

  // (Only LUMOVI_CREATE_FORM=1 says so, while the form's kinds are being built.)
  const without = await serve({ env: { LUMOVI_CREATE_FORM: undefined } })
  await page.context().clearCookies()
  await signIn(page, `${without.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Create…', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Create', exact: true })).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'How to create' })).toHaveCount(0)
  await expect(dialog.getByRole('group', { name: 'Templates' })).toBeVisible()
})
