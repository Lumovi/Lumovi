/**
 * Create, served: its form is there, as on the desktop.
 */
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

test('Create has its form, served', async ({ page, serve }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Create…', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Form' })).toBeChecked()
  await expect(dialog.getByRole('group', { name: 'Form', exact: true })).toBeVisible()
  await expect(dialog).toContainText('On demo')
  // YAML's side is the dialog as it was, with the switch.
  await dialog.getByRole('radio', { name: 'YAML' }).click()
  await expect(dialog.getByRole('group', { name: 'Templates' })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'YAML' })).toBeChecked()
  await served.stop()
})
