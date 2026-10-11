/**
 * Create, served: its form is there, as on the desktop.
 */
import { chromium, firefox, webkit } from '@playwright/test'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

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

test.describe('under a finger', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true })

  test('on a tablet each kind’s form is a finger’s size, and nothing goes sideways', async ({
    page,
    serve,
  }) => {
    const served = await serve()
    await signInNarrow(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
    await page.getByRole('button', { name: 'Create…', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const form = dialog.getByRole('group', { name: 'Form', exact: true })
    await expect(form).toBeVisible()
    // Each kind, with what it grows when asked: a variable, storage, a port, a label, a key.
    const more: Record<string, string[]> = {
      Deployment: ['Add a variable'],
      StatefulSet: ['Add storage'],
      Service: ['Add a label', 'Add a port'],
      ConfigMap: ['Add a key'],
      Secret: ['Add a key'],
    }
    for (const kind of [
      'Deployment',
      'StatefulSet',
      'DaemonSet',
      'Job',
      'CronJob',
      'Service',
      'ConfigMap',
      'Secret',
      'PersistentVolumeClaim',
    ]) {
      await dialog.getByRole('radio', { name: kind, exact: true }).click()
      await expect(dialog.getByRole('radio', { name: kind, exact: true })).toBeChecked()
      for (const add of more[kind] ?? []) await form.getByRole('button', { name: add }).click()
      await expectNoSidewaysScroll(page, `${kind}’s form on a tablet`)
      await expectFingerSized(page, `${kind}’s form on a tablet`)
    }
    // YAML's side too.
    await dialog.getByRole('radio', { name: 'YAML', exact: true }).click()
    await expect(dialog.getByRole('group', { name: 'Templates' })).toBeVisible()
    await expectNoSidewaysScroll(page, 'Create’s YAML on a tablet')
    await expectFingerSized(page, 'Create’s YAML on a tablet')
    await served.stop()
  })

  test('on a phone there’s no Create: nothing is written there', async ({ page, serve }) => {
    await page.setViewportSize(PHONE)
    const served = await serve()
    await signInNarrow(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
    await expect(page.getByRole('button', { name: 'Create…', exact: true })).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+n')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await served.stop()
  })
})

// A server's page is opened in whatever browser its person has: what's typed for a Secret's
// value while values are hidden is drawn as dots in each of them, and never as what it is.
for (const [name, browsers] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test(`a Secret’s value, typed while hidden, isn’t drawn as what it is: ${name}`, async ({
    serve,
  }) => {
    // Chromium is every run's. The other two are CI's Browsers job's, which says so
    // (LUMOVI_E2E_BROWSERS=all): there, one that isn't installed or doesn't start fails the
    // test. Elsewhere they run where they can, and are skipped where they can't.
    const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
    test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
    const served = await serve()
    const browser = await browsers.launch().catch((error: unknown) => {
      if (must) throw error
      return undefined
    })
    test.skip(!browser, `${name} doesn’t start on this computer`)
    if (!browser) return
    try {
      const page = await browser.newPage()
      await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
      await page.getByRole('button', { name: 'Create…', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('radio', { name: 'Secret', exact: true }).click()
      const form = dialog.getByRole('group', { name: 'Form', exact: true })
      await form.getByRole('button', { name: 'Add a key' }).click()
      await page.keyboard.type('API_KEY')
      const value = form.getByRole('textbox', { name: 'API_KEY’s value', exact: true })
      // (No caret, which blinks, and nothing fading in: only what's drawn of the value.)
      await page.addStyleTag({
        content: '* { caret-color: transparent !important; transition: none !important }',
      })
      const drawn = async (typed: string) => {
        await value.fill(typed)
        await expect(value).toHaveValue(typed)
        // Its inside, where the value is drawn: not its border, whose corners are drawn a
        // shade apart from one time to the next.
        const box = (await value.boundingBox())!
        return page.screenshot({
          animations: 'disabled',
          clip: { x: box.x + 8, y: box.y + 6, width: box.width - 16, height: box.height - 12 },
        })
      }
      // Two values of one length, as unlike as letters get, are drawn alike.
      await drawn('first')
      const wide = await drawn('WWWWWWWW')
      const narrow = await drawn('iiiiiiii')
      expect(wide.equals(narrow), 'hidden, both are drawn the same').toBe(true)
      // (Shown, they aren't: the comparison can tell text from dots.)
      await dialog.getByRole('button', { name: 'Show values' }).click()
      const shownNarrow = await drawn('iiiiiiii')
      const shownWide = await drawn('WWWWWWWW')
      expect(shownWide.equals(shownNarrow), 'shown, they differ').toBe(false)
    } finally {
      await browser.close()
    }
  })
}
