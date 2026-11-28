/**
 * Finding in YAML (LMV-404): ⌘F (Ctrl+F) in every YAML view, read-only or edited, and in diffs.
 * Its bar: the count, a step each way, match case and a regular expression, Escape; its matches
 * marked so they read in both themes. What it finds is what's shown: a Secret's hidden values
 * never, and a diff's folded lines as they'd be shown, unfolded by a step to one.
 */
import type { Locator, Page } from '@playwright/test'
import { encodeRelease, releaseRecord } from '../mock-cluster/fixtures/helm.ts'
import { open } from './action-helpers.ts'
import { DEMO, expect, openCluster, panel, row, test } from './fixtures.ts'

const bar = (where: Locator, label: string) =>
  where.getByRole('search', { name: `Find in ${label}` })
const field = (where: Locator, label: string) =>
  bar(where, label).getByRole('textbox', { name: `Find in ${label}` })

/** The text of the current match, as the page marks it. */
const current = (page: Page) =>
  page.evaluate(() => [...(CSS.highlights.get('lumovi-find-current') ?? [])][0]?.toString())

/** How many matches the page marks. */
const marked = (page: Page) => page.evaluate(() => CSS.highlights.get('lumovi-find')?.size ?? 0)

/**
 * How a text's colour stands out of what's under it, as WCAG measures it: the layers under it
 * (any CSS colours, the lowest first) and its own, put together as the page paints them.
 */
function contrast(page: Page, layers: string[], text: string): Promise<number> {
  return page.evaluate(
    ([layers, text]) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const paint = canvas.getContext('2d')!
      const pixel = (fills: string[]) => {
        paint.clearRect(0, 0, 1, 1)
        for (const fill of fills) {
          paint.fillStyle = fill
          paint.fillRect(0, 0, 1, 1)
        }
        return [...paint.getImageData(0, 0, 1, 1).data]
      }
      const luminance = ([r, g, b]: number[]) => {
        const linear = (v: number) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
      }
      const [light, dark] = [luminance(pixel(layers)), luminance(pixel([...layers, text]))].sort(
        (a, b) => b - a,
      )
      return (light! + 0.05) / (dark! + 0.05)
    },
    [layers, text] as const,
  )
}

/** The colours under a YAML view's text, the lowest first: the page's, then its own. */
const under = (where: Locator) =>
  where.evaluate((element) => {
    const layers: string[] = []
    for (let at: Element | null = element; at; at = at.parentElement) {
      layers.unshift(getComputedStyle(at).backgroundColor)
    }
    return layers
  })

/** A match's colours, and the current one's, where `span` is drawn. */
const matchColours = (span: Locator) =>
  span.evaluate((element) => {
    const every = getComputedStyle(element, '::highlight(lumovi-find)')
    const now = getComputedStyle(element, '::highlight(lumovi-find-current)')
    return {
      every: { background: every.backgroundColor, color: every.color },
      current: { background: now.backgroundColor, color: now.color },
    }
  })

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('⌘F in an object’s YAML: the count, a step each way, match case, an expression, and Escape', async ({
  page,
}) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
  const find = detail.getByRole('button', { name: 'Find', exact: true })
  await expect(find).toHaveAttribute('aria-expanded', 'false')
  // From wherever the keyboard is: the tab it was opened from.
  await expect(detail.getByRole('tab', { name: 'YAML' })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(field(yaml, 'YAML')).toBeFocused()
  await expect(find).toHaveAttribute('aria-expanded', 'true')
  // Nothing typed, nothing said.
  await expect(bar(yaml, 'YAML')).not.toContainText(/match/)

  await page.keyboard.type('SHOP')
  // None is current until a step: then the first in sight, and on round.
  await expect(bar(yaml, 'YAML')).toContainText('3 matches')
  expect(await marked(page)).toBe(3)
  await page.keyboard.press('Enter')
  await expect(bar(yaml, 'YAML')).toContainText('1 of 3')
  expect(await current(page)).toBe('shop')
  await page.keyboard.press('Enter')
  await expect(bar(yaml, 'YAML')).toContainText('2 of 3')
  await page.keyboard.press('Shift+Enter')
  await expect(bar(yaml, 'YAML')).toContainText('1 of 3')
  await page.keyboard.press('Shift+Enter')
  await expect(bar(yaml, 'YAML')).toContainText('3 of 3')
  await yaml.getByRole('button', { name: 'Next match' }).click()
  await expect(bar(yaml, 'YAML')).toContainText('1 of 3')
  // Match case: none is "SHOP".
  await field(yaml, 'YAML').press('Alt+c')
  await expect(yaml.getByRole('button', { name: 'Match case' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(bar(yaml, 'YAML')).toContainText('No matches')
  await expect(yaml.getByRole('button', { name: 'Next match' })).toBeDisabled()
  expect(await marked(page)).toBe(0)
  await yaml.getByRole('button', { name: 'Match case' }).click()
  // An expression: one that isn't one says why, in the logs' words.
  await field(yaml, 'YAML').fill('s(h')
  await field(yaml, 'YAML').press('Alt+r')
  await expect(yaml.getByRole('alert')).toHaveText(
    'This isn’t a regular expression: a ( isn’t closed.',
  )
  await expect(field(yaml, 'YAML')).toHaveAttribute('aria-invalid', 'true')
  await field(yaml, 'YAML').fill('s.op')
  await expect(bar(yaml, 'YAML')).toContainText('3 matches')
  await expect(yaml.getByRole('alert')).toHaveCount(0)
  // A key's text, and a mark's own label, are what's there to find: never a line's number.
  await field(yaml, 'YAML').fill('^\\d+$')
  await expect(bar(yaml, 'YAML')).toContainText('No matches')

  // Escape closes it, and only it: the keyboard back on the tab, the panel open.
  await page.keyboard.press('Escape')
  await expect(bar(yaml, 'YAML')).toHaveCount(0)
  await expect(detail.getByRole('tab', { name: 'YAML' })).toBeFocused()
  await expect(detail).toBeVisible()
  expect(await marked(page)).toBe(0)

  // Its toolbar's Find: pressed, it opens; pressed again, it closes, the keyboard on it; opened
  // by it, Escape gives it the keyboard back.
  await find.click()
  await expect(field(yaml, 'YAML')).toBeFocused()
  // (What was looked for is still there, selected.)
  await expect(field(yaml, 'YAML')).toHaveValue('^\\d+$')
  await find.click()
  await expect(bar(yaml, 'YAML')).toHaveCount(0)
  await expect(find).toBeFocused()
  await find.click()
  await page.keyboard.press('Escape')
  await expect(find).toBeFocused()
  // ⌘F with the bar open puts the keyboard in its field again.
  await find.click()
  await yaml.getByRole('button', { name: 'Match case' }).focus()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(field(yaml, 'YAML')).toBeFocused()
})

test('a match reads in both themes: its text in the text’s colour, the current one on the accent', async ({
  page,
}) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
  await page.keyboard.press('ControlOrMeta+f')
  // A key: drawn in the key's colour, and in the text's inside a match.
  await page.keyboard.type('namespace')
  await page.keyboard.press('Enter')
  const key = yaml.locator('[data-find-text] span', { hasText: /^namespace$/ })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((to) => window.lumovi!.app.setTheme(to), theme)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).colorScheme))
      .toContain(theme)
    const layers = await under(key)
    const { every, current } = await matchColours(key)
    // (A match's fill isn't the ground it's on, and the current one's isn't a match's.)
    expect(every.background).not.toBe(layers.at(-1))
    expect(current.background).not.toBe(every.background)
    expect(await contrast(page, [...layers, every.background], every.color)).toBeGreaterThan(4.5)
    expect(await contrast(page, [...layers, current.background], current.color)).toBeGreaterThan(
      4.5,
    )
  }
})

test('a Secret’s hidden values are never found: only what’s shown is', async ({ page }) => {
  const name = DEMO.secrets.postgresCredentials
  await open(page, 'Secrets', name)
  const detail = panel(page, 'Secret', name)
  await detail.getByRole('tab', { name: 'YAML' }).click()
  const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
  await page.keyboard.press('ControlOrMeta+f')
  // What kubectl kept of it is in its annotation: hidden, so its text isn't there to find.
  await page.keyboard.type('"password":"')
  await expect(bar(yaml, 'YAML')).toContainText('No matches')
  // The masks are what's shown: those are found.
  await field(yaml, 'YAML').fill('••••••••')
  await expect(bar(yaml, 'YAML')).toContainText('4 matches')
  // Shown, it's found; hidden again, it isn't.
  await field(yaml, 'YAML').fill('"password":"')
  await detail.getByRole('button', { name: 'Reveal values' }).click()
  await expect(bar(yaml, 'YAML')).toContainText('1 match')
  await detail.getByRole('button', { name: 'Hide values' }).click()
  await expect(bar(yaml, 'YAML')).toContainText('No matches')
  // (Said yes or no: a failure prints no value.)
  const text = await page.evaluate(() => document.body.innerText)
  expect(text.includes(DEMO.postgresPassword)).toBe(false)
})

test('Edit YAML has the same bar: in the dark theme it reads, it replaces, and Escape gives the keyboard back', async ({
  page,
}) => {
  await page.evaluate(() => window.lumovi!.app.setTheme('dark'))
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = detail.getByRole('textbox', { name: 'YAML of storefront-config', exact: true })
  await expect(editor).toBeFocused()
  const label = 'YAML of storefront-config'
  await page.keyboard.press('ControlOrMeta+f')
  await expect(field(detail, label)).toBeFocused()
  // Its field reads on the dark theme (CodeMirror's own was white on white).
  const input = field(detail, label)
  const layers = await under(input)
  const color = await input.evaluate((element) => getComputedStyle(element).color)
  expect(await contrast(page, layers, color)).toBeGreaterThan(4.5)

  await page.keyboard.type('info')
  await expect(bar(detail, label)).toContainText('1 match')
  await page.keyboard.press('Enter')
  await expect(bar(detail, label)).toContainText('1 of 1')
  // An editor that can be changed: replace, and all.
  await detail.getByRole('textbox', { name: 'Replace with' }).fill('debug')
  await detail.getByRole('button', { name: 'Replace all' }).click()
  await expect(editor).toContainText('LOG_LEVEL: debug')
  await expect(bar(detail, label)).toContainText('No matches')
  // An expression, and match case, are the editor's as they were.
  await field(detail, label).fill('LOG_\\w+')
  await field(detail, label).press('Alt+r')
  await expect(bar(detail, label)).toContainText('1 match')
  await field(detail, label).fill('log_\\w+')
  await field(detail, label).press('Alt+c')
  await expect(bar(detail, label)).toContainText('No matches')
  // Escape: the search closes, the edit stays, the keyboard back in the text.
  await page.keyboard.press('Escape')
  await expect(bar(detail, label)).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(detail.getByRole('button', { name: 'Review changes' })).toBeEnabled()

  // Its toolbar's Find: opened by it, Escape gives it the keyboard back.
  const find = detail.getByRole('button', { name: 'Find', exact: true })
  await find.click()
  await expect(field(detail, label)).toBeFocused()
  await expect(find).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(find).toBeFocused()
  await expect(find).toHaveAttribute('aria-expanded', 'false')
})

test('in a diff, a folded line’s match counts, and a step to it unfolds its lines alone', async ({
  page,
}) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = detail.getByRole('textbox', { name: 'YAML of storefront-config', exact: true })
  const text = await editor.innerText()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  // A change near the top and one at the end: unchanged lines folded between them.
  await page.keyboard.insertText(
    text.replace('LOG_LEVEL: info', 'LOG_LEVEL: debug').replace('pageSize: 24', 'pageSize: 48'),
  )
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail).toContainText('The cluster accepts this change')
  const changes = detail.locator('pre[aria-label="Changes"]')
  const folds = changes.locator('[data-change="gap"]')
  const before = await folds.count()
  expect(before).toBeGreaterThan(1)
  await expect(changes).not.toContainText('readTimeout')

  await detail.getByRole('button', { name: 'Find', exact: true }).click()
  await page.keyboard.type('timeout')
  await expect(bar(detail, 'Changes')).toContainText('1 match')
  // (Folded, it's counted, and not marked: nothing of it is on the page. Its fold says so.)
  expect(await marked(page)).toBe(0)
  await expect(folds.filter({ hasText: /unchanged lines · 1 match$/ })).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(bar(detail, 'Changes')).toContainText('1 of 1')
  await expect(changes).toContainText('readTimeout: 5s')
  await expect(folds).toHaveCount(before - 1)
  await expect.poll(() => current(page)).toBe('Timeout')
  // Matches in what's shown and what's folded count in order.
  await field(detail, 'Changes').fill('a')
  await expect(bar(detail, 'Changes')).toContainText(/^\D*\d+ matches/)
})

test('⌘F in a dialog finds in the dialog’s YAML, not behind it, and Escape closes the search, not the dialog', async ({
  page,
}) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await page.keyboard.press('ControlOrMeta+n')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Form' })).toBeChecked()
  // From a field of the form beside the YAML.
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('web')
  await page.keyboard.press('ControlOrMeta+f')
  const search = dialog.getByRole('search')
  await expect(search.getByRole('textbox').first()).toBeFocused()
  await expect(detail.getByRole('search')).toHaveCount(0)
  await page.keyboard.type('web')
  await expect(search).toContainText(/\d+ matches/)
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused()
})

test('a release’s Manifest with a Secret has Find, and its masked values are never found', async ({
  page,
  clusters,
}) => {
  const manifest = `---
# Source: vault-app/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: vault-app-db
data:
  password: ${Buffer.from('made-up').toString('base64')}
`
  const spec = {
    name: 'vault-app',
    namespace: 'default',
    chart: { name: 'vault-app' },
    revisions: [
      {
        revision: 1,
        status: 'deployed',
        ago: 60_000,
        chartVersion: '0.1.0',
        description: 'Install complete',
        values: {},
        manifest,
      },
    ],
  }
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'sh.helm.release.v1.vault-app.v1',
      namespace: 'default',
      labels: { name: 'vault-app', owner: 'helm', status: 'deployed', version: '1' },
    },
    type: 'helm.sh/release.v1',
    data: {
      release: Buffer.from(
        encodeRelease(releaseRecord(spec, spec.revisions[0]!, Date.now())),
      ).toString('base64'),
    },
  })
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await row(page, 'Helm releases', 'vault-app').first().getByRole('gridcell').nth(1).click()
  const release = page.getByRole('complementary', { name: 'Helm release vault-app' })
  await release.getByRole('tab', { name: 'Manifest' }).click()
  await release.getByRole('button', { name: 'Find', exact: true }).click()
  // A value, as only a shown one could be (the pattern, never a value, is what's typed).
  await field(release, 'Manifest').fill('password: [A-Za-z0-9+/=]{4}')
  await field(release, 'Manifest').press('Alt+r')
  await expect(bar(release, 'Manifest')).toContainText('No matches')
  await release.getByRole('button', { name: 'Reveal values' }).click()
  await expect(bar(release, 'Manifest')).toContainText('1 match')
  await release.getByRole('button', { name: 'Hide values' }).click()
  await expect(bar(release, 'Manifest')).toContainText('No matches')
})
