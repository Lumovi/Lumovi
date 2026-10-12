/**
 * The YAML editor knows the cluster's schemas: what's wrong is underlined before the dry run
 * (errors the cluster would refuse, warnings of what it would drop), counted under the editor
 * and listed; a field's description is under the pointer; and an object's fields are offered as
 * they're typed. For built-in kinds and for CRDs, by the cluster's own OpenAPI only.
 */
import type { Page } from '@playwright/test'
import { dialog, yamlSide } from './action-helpers.ts'
import { expect, openCluster, test } from './fixtures.ts'

const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const errors = (page: Page) => dialog(page).locator('.cm-lintRange-error')
const warnings = (page: Page) => dialog(page).locator('.cm-lintRange-warning')
const count = (page: Page) => dialog(page).locator('.cm-schema-count')
const card = (page: Page) => page.locator('.cm-tooltip .cm-schema-card')

/**
 * Takes the completion list's choice with `key`. A list takes a key only once it's stood 75 ms
 * (CodeMirror's interactionDelay), so a key typed fast never takes what's just appeared: it's
 * given that floor, as a person's key would be.
 */
async function take(page: Page, key: 'Tab' | 'Enter') {
  await page.waitForTimeout(100)
  await page.keyboard.press(key)
}

/** Opens Create's YAML side with `yaml` in it, the caret at its end. */
async function create(page: Page, yaml: string) {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  await yamlSide(page)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(yaml)
}

const ENDPOINTS = `apiVersion: v1
kind: Endpoints
metadata:
  name: 5
  namespce: default
subsets: {}
`

test('what’s wrong is underlined before the dry run, counted, listed, and gone to', async ({
  page,
}) => {
  await create(page, ENDPOINTS)
  // Two the cluster would refuse, and one it would drop.
  await expect(errors(page)).toHaveCount(2)
  await expect(warnings(page)).toHaveCount(1)
  await expect(errors(page).first()).toHaveText('5')
  await expect(warnings(page)).toHaveText('namespce')
  await expect(count(page)).toHaveText('2 errors · 1 warning')
  await expect(dialog(page).locator('.cm-schema-foot')).toContainText(/F8 next · (⌥|Alt)F8 all/)

  // The count opens the list; Enter goes to a problem.
  await count(page).click()
  const list = dialog(page).getByRole('listbox', { name: 'Problems' })
  await expect(list).toBeFocused()
  await expect(list.getByRole('option')).toHaveText([
    '4:9 Text goes here, not a number. metadata.name',
    '5:3 An object’s metadata has no field “namespce”. Did you mean namespace? metadata.namespce',
    '6:10 A list goes here, not an object. subsets',
  ])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toBeFocused()
  // F8 there: that one's card; again, round to the first.
  await page.keyboard.press('F8')
  await expect(card(page)).toContainText('Error: a list goes here, not an object.')
  await page.keyboard.press('F8')
  await expect(card(page)).toContainText('Error: text goes here, not a number.')
  await expect(card(page)).toContainText('metadata.name · string')
  await expect(card(page)).toContainText('The cluster would refuse it.')
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await page.keyboard.press('F8')
  await expect(card(page)).toContainText(
    'Warning: an object’s metadata has no field “namespce”. Did you mean namespace?',
  )
  await expect(card(page)).toContainText('The cluster would drop it without saying so.')

  // Put right, they go; nothing ever stopped Create.
  await page.keyboard.press('Escape')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(
    'apiVersion: v1\nkind: Endpoints\nmetadata:\n  name: shop\nsubsets: []\n',
  )
  await expect(count(page)).toBeHidden()
  await expect(errors(page)).toHaveCount(0)
  await expect(dialog(page).getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  // YAML that doesn't parse, in Lumovi's words.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('apiVersion: v1\nkind: Endpoints\nsubsets:\n\t- x\n')
  await expect(errors(page)).toHaveCount(1)
  // (Near its start: a hover shows within one character's width of where a character starts or
  // ends, and a tab's middle, two characters wide, is just that far from both.)
  await errors(page)
    .first()
    .hover({ position: { x: 2, y: 8 } })
  await expect(card(page)).toContainText('Error: a tab can’t indent YAML: use spaces.')
})

test('a CRD’s fields: values, required ones, completion and descriptions from its schema', async ({
  page,
}) => {
  await create(
    page,
    'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\nspec:\n  color: purple\n  constructor: x\n  ',
  )
  // Its size is required; purple isn't one of its colours; and a name every object of the
  // language has is no field of a schema.
  await expect(errors(page)).toHaveCount(2)
  await expect(warnings(page)).toHaveText('constructor')
  await count(page).click()
  await expect(
    dialog(page).getByRole('listbox', { name: 'Problems' }).getByRole('option'),
  ).toHaveText([
    '5:1 This needs size. spec',
    '6:10 This is one of red, green and blue, not “purple”. spec.color',
    '7:3 A widget’s spec has no field “constructor”. spec.constructor',
  ])
  // Esc closes the list, and the editor has the focus again.
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+End')

  // ⌃Space (or ⌥Esc) offers the object's fields: required first, the set one quieter.
  await page.keyboard.press('Control+Space')
  const offered = page
    .getByRole('listbox')
    .filter({ has: page.getByRole('option', { name: /size/ }) })
  await expect(offered.getByRole('option').first()).toContainText('size')
  await expect(offered.getByRole('option').first()).toContainText('required')
  await expect(offered.getByRole('option', { name: /color/ })).toContainText('already set')
  await expect(page.locator('.cm-schema-foot-list')).toHaveText('↵ or tab to take · esc to close')
  // The selected one's description beside the list.
  await expect(page.locator('.cm-completionInfo')).toContainText(
    'How big the widget is, in widget units.',
  )
  await expect(page.locator('.cm-completionInfo')).toContainText('from the CRD widgets.example.com')
  // Tab takes it: "size: ", and after its colon nothing to choose from (a number).
  await take(page, 'Tab')
  await expect(editor(page)).toContainText('size:')
  await page.keyboard.insertText('3\n  par')
  await expect(page.getByRole('option', { name: /parts/ })).toBeVisible()
  await take(page, 'Enter')
  // A list: a new line, indented, with its first item's dash.
  await expect(editor(page)).toContainText('parts:')
  await page.keyboard.insertText('name: a\n      spare: ye')
  await expect(errors(page)).toHaveCount(2)

  // A field's description under the pointer.
  await dialog(page).locator('.cm-line', { hasText: 'size:' }).getByText('size').hover()
  await expect(card(page)).toContainText('spec.size')
  await expect(card(page)).toContainText('integer')
  await expect(card(page)).toContainText('required')
  await expect(card(page)).toContainText('How big the widget is, in widget units.')
  await expect(card(page)).toContainText('from the CRD widgets.example.com')
  // ⌥F1, the same for the field at the caret.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+F1')
  await expect(card(page)).toContainText('spec.color')
  await expect(card(page)).toContainText('one of')
  await expect(card(page)).toContainText('esc to close')
})

test('a schema’s words, and what a problem quotes, are the cluster’s text: what can’t be seen is a mark', async ({
  page,
}) => {
  await create(
    page,
    'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\nspec:\n  size: 1\n  aliases: []\n  color: "pu\u202Erple"\n',
  )
  const mark = { name: 'invisible character U+202E' }
  // (One problem: its underline is drawn in two, either side of the character's placeholder.)
  await expect(count(page)).toHaveText('1 error')
  // A description with one: a mark in its card.
  await dialog(page).locator('.cm-line', { hasText: 'aliases:' }).getByText('aliases').hover()
  await expect(card(page)).toContainText('Other names it goes by')
  await expect(card(page).getByRole('img', mark)).toHaveCount(1)
  // A value of the document's, quoted in its problem: a mark in the list's row.
  await count(page).click()
  const problems = dialog(page).getByRole('listbox', { name: 'Problems' })
  await expect(problems.getByRole('option')).toHaveText([
    '8:10 This is one of red, green and blue, not “puU+202Erple”. spec.color',
  ])
  await expect(problems.getByRole('img', mark)).toHaveCount(1)
  // A field whose name has one: offered spelled, and found by what's shown (its code point; a key
  // is typed of letters, digits and . - /, so not its "U+").
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('  202E')
  await page.keyboard.press('Control+Space')
  await expect(page.getByRole('option', { name: /badge U\+202E txt/ })).toBeVisible()
})

test('a kind whose cluster publishes no schema is said to be checked as YAML only', async ({
  page,
}) => {
  await create(
    page,
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: three\n',
  )
  await expect(
    dialog(page).getByText(
      'The cluster publishes no schema for Deployment, so only the YAML itself is checked.',
    ),
  ).toBeVisible()
  await expect(errors(page)).toHaveCount(0)
})

test('the check runs off the page, and is counted: a part only the worker runs', async ({
  page,
}) => {
  await create(page, ENDPOINTS)
  await expect(errors(page)).toHaveCount(2)
  // problemsIn runs only in the worker; the page reads places (completion, hover) with placeAt.
  const counted = await page.evaluate(() => {
    const files = (globalThis as { __coverage__?: Record<string, never> }).__coverage__ ?? {}
    const file = files['src/renderer/src/lib/yaml-schema.ts'] as
      { fnMap: Record<string, { name: string }>; f: Record<string, number> } | undefined
    const id = Object.entries(file?.fnMap ?? {}).find(([, fn]) => fn.name === 'problemsIn')?.[0]
    return id === undefined ? -1 : file!.f[id]
  })
  expect(counted).toBeGreaterThan(0)
})
