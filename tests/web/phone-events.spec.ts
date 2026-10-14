/** The Events page on a phone: its list, with no timeline, whatever the address asks. */
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('on a phone, events are a list: no Timeline to choose, and an address that asks for one opens the list', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(
    page,
    `${served.url}cluster/demo/events?namespaces=shop&as=timeline`,
    DEMO_TOKEN,
  )
  await expect(page.getByText(/^\d+ items$/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Timeline' })).toHaveCount(0)
  await expect(page.getByRole('grid', { name: /^Events on a timeline/ })).toHaveCount(0)
})
