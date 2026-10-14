/** The Alerts page on a phone: a card an alert, and one opened as a page of its own with Back. */
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('alerts on a phone: a card each, worst first, and one opened as a page', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/alerts`, DEMO_TOKEN)
  const list = page.getByRole('list', { name: 'Alerts' })
  await expect(list.getByRole('listitem').first()).toContainText('KubePersistentVolumeFillingUp')
  // Severity and state as facts, on one line each.
  const waiting = list.getByRole('listitem').filter({ hasText: 'KubeContainerWaiting' })
  await expect(waiting).toContainText(/Pending, fires in \d+m/)
  await expectNoSidewaysScroll(page, 'the Alerts page')
  // Opened: a page of its own, all of it, and Back.
  await waiting.click()
  const opened = page.getByRole('complementary', { name: /^Alert KubeContainerWaiting/ })
  await expect(opened).toContainText('Pod container waiting longer than 1 hour.')
  await expect(opened).toContainText('alertname=KubeContainerWaiting')
  await expectNoSidewaysScroll(page, 'an opened alert')
  await opened.getByRole('button', { name: 'Back' }).click()
  await expect(opened).toHaveCount(0)
  await expect(list).toBeVisible()
})
