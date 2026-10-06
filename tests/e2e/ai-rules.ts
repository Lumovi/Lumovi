/**
 * The AI assistants page's Permissions tab, used as a person does: rules
 * added by typing where they apply and choosing what they say. The desktop
 * app's tests and a server's share them.
 */
import type { Locator, Page } from '@playwright/test'
import type { AiRule } from '../../src/shared/ai-permissions.ts'
import { expect } from '@playwright/test'

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Adds what a rule applies to: a name chosen from what's suggested, a pattern or label as typed. */
export async function addMatcher(editor: Locator, field: string | RegExp, text: string) {
  const input = editor.getByLabel(field, { exact: true })
  await input.fill(text)
  if (/[*=]/.test(text)) {
    await input.press('Enter')
    return
  }
  await editor
    .getByRole('group', { name: /^Suggestions for/ })
    .getByRole('button')
    .filter({ hasText: new RegExp(`^Name${escape(text)}(leaves out )?(\\d|none)`) })
    .click()
}

export interface RuleGiven {
  name: string
  clusters?: string[]
  namespaces?: string[]
  /** What it says, as the page's choices are labelled: { Changes: 'Never' }. */
  set: Record<string, string>
}

/** The person's own rules, as the page shows them (some may not be kept yet). */
const shownRules = (page: Page) =>
  page
    .getByRole('article')
    .filter({ hasNot: page.getByText('Set by your administrator') })
    .evaluateAll((articles) => articles.map((article) => article.getAttribute('aria-label')!))

/** Adds a rule, as a person does, and waits until it's kept. */
export async function addRule(page: Page, rule: RuleGiven): Promise<void> {
  const before = await shownRules(page)
  await page.getByRole('button', { name: 'Add rule' }).click()
  const editor = page.getByRole('article').last()
  await editor.getByLabel('Name', { exact: true }).fill(rule.name)
  for (const text of rule.clusters ?? []) await addMatcher(editor, /^(Clusters|Contexts)$/, text)
  for (const text of rule.namespaces ?? []) await addMatcher(editor, 'Namespaces', text)
  for (const [setting, choice] of Object.entries(rule.set)) {
    await editor
      .getByRole('group', { name: setting, exact: true })
      .getByRole('button', { name: choice, exact: true })
      .click()
  }
  await editor.getByRole('button', { name: 'Done' }).click()
  await expect
    .poll(async () => (await rulesNow(page)).map((r) => r.name))
    .toEqual([...before, rule.name])
}

/** The person's own rules, as they're kept now. */
export async function rulesNow(page: Page): Promise<AiRule[]> {
  return (await page.evaluate(() => window.lumovi!.aiPermissions!.get())).mine.rules
}

/** Opens the AI assistants page's Permissions tab. */
export async function openPermissions(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  await page.getByRole('link', { name: 'Permissions' }).click()
  await expect(page.getByRole('heading', { name: 'Defaults' })).toBeVisible()
}
