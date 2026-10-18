/**
 * The YAML editor knows the cluster's schemas: what's wrong is underlined before the dry run
 * (errors the cluster would refuse, warnings of what it would drop), counted under the editor
 * and listed; a field's description is under the pointer; and an object's fields are offered as
 * they're typed. For built-in kinds and for CRDs, by the cluster's own OpenAPI only.
 */
import type { Locator, Page } from '@playwright/test'
import { dialog, yamlSide } from './action-helpers.ts'
import { expect, openCluster, test } from './fixtures.ts'
import { holds } from '../holds.ts'

const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const errors = (page: Page) => dialog(page).locator('.cm-lintRange-error')
const warnings = (page: Page) => dialog(page).locator('.cm-lintRange-warning')
const count = (page: Page) => dialog(page).locator('.cm-schema-count')
const card = (page: Page) => page.locator('.cm-tooltip .cm-schema-card')

/**
 * Hovers `target` until a card shows, as a person's pointer would. CodeMirror shows a hover's card
 * 500 ms after the pointer last moved, for what it moved over: where that's drawn again in
 * between (a check's marks landing, under load), none comes until the pointer moves again. So it
 * moves again, as the pointer of someone waiting for a card does.
 */
async function hoverCard(page: Page, target: Locator, position?: { x: number; y: number }) {
  await expect(async () => {
    await target.hover(position && { position })
    await expect(card(page)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

/**
 * Takes the completion list's choice with `key`. A list takes a key only once it's stood 75 ms
 * (CodeMirror's interactionDelay), so a key typed fast never takes what's just appeared: it's
 * given that floor, as a person's key would be.
 */
async function take(page: Page, key: 'Tab' | 'Enter') {
  // eslint-disable-next-line no-restricted-syntax -- the list's own floor (75 ms) has to pass: no sign of it.
  await page.waitForTimeout(100)
  await page.keyboard.press(key)
}

/**
 * A page where the check's worker can't start, fails to load, or never answers: the page's own
 * `Worker` put in its place, before the editor makes its own.
 */
type Checking = 'none' | 'failing' | 'silent'

/** A fake worker's times, in the page's own clock. */
interface Kept {
  madeAt: number
  askedAt?: number
  terminatedAt?: number
}

/** Opens Create's YAML side with `yaml` in it, the caret at its end. */
async function create(page: Page, yaml: string, worker?: Checking) {
  await openCluster(page)
  if (worker) {
    await page.evaluate((worker) => {
      ;(window as unknown as { Worker: unknown }).Worker =
        worker === 'none'
          ? class {
              constructor() {
                throw new Error('No workers here.')
              }
            }
          : class extends EventTarget {
              // (Each one's own times, kept on the page: when it was made, first asked a check,
              // and let go of. What giving one up does.)
              kept: Kept = { madeAt: performance.now() }
              constructor() {
                super()
                const all = window as unknown as { workers?: Kept[] }
                ;(all.workers ??= []).push(this.kept)
              }
              postMessage() {
                this.kept.askedAt ??= performance.now()
                if (worker === 'failing') setTimeout(() => this.dispatchEvent(new Event('error')))
              }
              terminate() {
                this.kept.terminatedAt = performance.now()
              }
            }
    }, worker)
  }
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
  await hoverCard(page, errors(page).first(), { x: 2, y: 8 })
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
  await expect(offered.getByRole('option', { name: /^color/ })).toContainText('already set')
  // More than its rows show: how many, and how to see them.
  await expect(page.locator('.cm-schema-foot-list')).toHaveText('8 of 15 · ↑↓ for more')
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
  await hoverCard(page, dialog(page).locator('.cm-line', { hasText: 'size:' }).getByText('size'))
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
  await hoverCard(
    page,
    dialog(page).locator('.cm-line', { hasText: 'aliases:' }).getByText('aliases'),
  )
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

/** All of the editor's text replaced with `yaml`, the caret at its end. */
async function write(page: Page, yaml: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(yaml)
}

/** The problems' rows, the list opened from the count. */
async function listed(page: Page) {
  await count(page).click()
  return dialog(page).getByRole('listbox', { name: 'Problems' }).getByRole('option')
}

/** A widget's every kind of field with what doesn't go there; then a kind's own spec and status. */
const KINDS = `apiVersion: example.com/v1
kind: Widget
metadata:
  name: [w]
  namespace: true
  naem: x
  ownerReferences:
    - apiVersion: v1
      kind: Widget
      name: w
      uuid: x
spec:
  size: 2.5
  ratio: high
  port: {a: 1}
  shape: blob
  tier: 5
  edition: deluxe
  color: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq
  settings: {verbose: 1}
  tags: [1, {a: b}]
  parts: 3
  enabled: "yes"
---
apiVersion: example.com/v1
kind: Widget
metadata:
  name: &n w
  namespace: *n
spec: 5
---
apiVersion: example.com/v1
kind: Widget
metadata:
  name: w2
spec:
  size: 1
  port: [80]
  color:
  ? [x]
  : 1
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gadgets.example.org
spec:
  groop: example.org
status:
  storedVersion: [v1]
---
apiVersion: example.com/v1
kind: Widget
metadata:
  name: w3
spec:
  size: 1
  port: http
`

test('each kind of value a schema can ask for, and what was given instead, in Lumovi’s words', async ({
  page,
}) => {
  await create(page, KINDS)
  // (Nothing is said of what's left out, an alias, a key that isn't text, a list with no
  // schema for its items, a field a kind leaves open, or a number or a name where either goes.)
  await expect(count(page)).toHaveText('15 errors · 4 warnings')
  await expect(await listed(page)).toHaveText([
    '4:9 Text goes here, not a list. metadata.name',
    '5:14 Text goes here, not true or false. metadata.namespace',
    '6:3 An object’s metadata has no field “naem”. Did you mean name? metadata.naem',
    '8:7 This needs uid. metadata.ownerReferences[0]',
    '11:7 An owner reference has no field “uuid”. Did you mean uid? metadata.ownerReferences[0].uuid',
    '13:9 A whole number goes here, not 2.5. spec.size',
    '14:10 A number goes here, not text. spec.ratio',
    '15:9 A number or text goes here, not an object. spec.port',
    '16:10 This is one of the values the schema lists, not “blob”. spec.shape',
    '17:9 This is one of 1, 2 and 3, not 5. spec.tier',
    '18:12 This is one of standard, not “deluxe”. spec.edition',
    '19:10 This is one of red, green and blue, not “abcdefghijklmnopqrstuvwxyzabcdefghijklm…”. spec.color',
    '20:23 True or false goes here, not a number. spec.settings.verbose',
    '22:10 A list goes here, not a number. spec.parts',
    '23:12 True or false goes here, not text. spec.enabled',
    '30:7 An object goes here, not a number. spec',
    '38:9 A number or text goes here, not a list. spec.port',
    '48:3 A custom resource definition’s spec has no field “groop”. Did you mean group? spec.groop',
    /^50:3 .+’s status has no field “storedVersion”\. Did you mean storedVersions\? status\.storedVersion$/,
  ])
})

test('a line indented past its own, and a key set twice: each said once, where it is', async ({
  page,
}) => {
  await create(page, 'apiVersion: v1\nkind: Endpoints\nmetadata:\n  name: a\n    namespace: b\n')
  await expect(await listed(page)).toHaveText([
    '5:1 This line is indented more than the lines it belongs with.',
  ])
  await page.keyboard.press('Escape')
  await write(page, 'apiVersion: v1\nkind: Endpoints\nmetadata:\n  name: a\n  name: b\n')
  await expect(count(page)).toHaveText('1 error')
  await page.keyboard.press('F8')
  await expect(card(page)).toContainText('Error: name is set twice in this object.')
  // An object with nothing in it has nothing wrong with it.
  await page.keyboard.press('Escape')
  await write(page, '{}\n')
  await expect(count(page)).toBeHidden()
  await expect(errors(page)).toHaveCount(0)
})

test('a field’s card: its default, a description that scrolls; none on a value, a key the schema hasn’t, or a kind it doesn’t describe', async ({
  page,
}) => {
  await create(
    page,
    'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n  naem: x\nspec:\n  size: 1\n  enabled: false\n  notes: hi\n  parts:\n    - name: bolt\n---\napiVersion: v1\nkind: Endpoints\nmetadata:\n  name: e\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n',
  )
  // (Once the schemas are in: a card is made of them as the pointer stops.)
  await expect(count(page)).toHaveText('1 warning')
  const line = (text: RegExp) => dialog(page).locator('.cm-line', { hasText: text })
  /**
   * Hovers `word` on the line, once the card of what was hovered before has gone: until its card
   * shows, or (`none`) once, for a word that has none.
   */
  const hover = async (text: RegExp, word: string, none = false) => {
    await page.mouse.move(0, 0)
    await expect(card(page)).toHaveCount(0)
    const target = line(text).first().getByText(word).first()
    await (none ? target.hover() : hoverCard(page, target))
  }
  await hover(/^ {2}enabled: false$/, 'enabled')
  await expect(card(page)).toContainText('spec.enabled')
  await expect(card(page).locator('.cm-schema-type')).toHaveText(/^booleandefault\s*true$/)
  await hover(/^ {2}notes: hi$/, 'notes')
  await expect(card(page)).toContainText('Scroll for the rest')
  // Nothing in metadata is required; an item's field is any item's.
  await hover(/^ {2}name: w$/, 'name')
  await expect(card(page)).toContainText('metadata.name')
  await expect(card(page)).not.toContainText('required')
  await hover(/^ {4}- name: bolt$/, 'name')
  await expect(card(page)).toContainText('spec.parts[].name')
  // An object's default isn't said: only a value's.
  await page.mouse.move(0, 0)
  await expect(card(page)).toHaveCount(0)
  await hoverCard(
    page,
    line(/^metadata:$/)
      .nth(1)
      .getByText('metadata'),
  )
  await expect(card(page)).toContainText('Standard object')
  await expect(card(page)).not.toContainText('default')
  // No field's card on a value, on a key the schema hasn't (its warning's card instead), or in a
  // kind the cluster publishes no schema for.
  const fieldCard = page.locator('.cm-tooltip .cm-schema-field')
  for (const [text, word] of [
    [/^ {4}- name: bolt$/, 'bolt'],
    [/^ {2}naem: x$/, 'naem'],
    [/^ {2}name: web$/, 'name'],
  ] as const) {
    await hover(text, word, true)
    await holds(async () => (await fieldCard.count()) === 0, 800, `no field’s card on ${word}`)
  }
  // ⌥F1 on a key the schema hasn't: nothing; on one it has, its card, which Esc closes (not the
  // dialog).
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+F1')
  await holds(async () => (await card(page).count()) === 0, 300, 'no card')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+F1')
  await expect(card(page)).toContainText('esc to close')
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
})

test('after a key, its values; at a key, the object’s fields: a deprecated one after the rest, and one set is gone to', async ({
  page,
}) => {
  const head =
    'apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\nspec:\n  size: 1\n  color: red\n'
  const list = page.locator('.cm-tooltip-autocomplete')
  const options = list.getByRole('option')
  const offer = async (yaml: string) => {
    await write(page, yaml)
    await page.keyboard.press('Control+Space')
  }
  const none = async (yaml: string) => {
    await offer(yaml)
    await holds(async () => (await list.count()) === 0, 300, 'nothing is offered')
  }
  // (Once its schema is in: a key it hasn't is said.)
  await create(page, `${head}  naem: x\n`)
  await expect(count(page)).toHaveText('1 warning')
  // True or false, the schema's default said; then values found by what's typed, as shown.
  await offer(`${head}  enabled: `)
  await expect(options).toHaveText([/^true.*default$/, /^false$/])
  await expect(page.locator('.cm-schema-foot-list')).toHaveText('↵ or tab to take · esc to close')
  await page.keyboard.press('Escape')
  await offer(`${head}  shape: he`)
  await expect(options).toHaveText(['heart', 'he U+202E x'])
  await page.keyboard.press('Escape')
  await offer(`${head}  tier: 2`)
  await expect(options).toHaveText(['2'])
  await page.keyboard.press('Escape')
  // Nothing to choose from: a number, a key the schema hasn't, a map's own keys.
  await none(`${head}  ratio: `)
  await none(`${head}  frobs: `)
  await none('apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  labels:\n    ')
  // An object with nothing required: its fields as they come.
  await offer('apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  ')
  await expect(options).toHaveText([/^labels/, /^name/, /^namespace/, /^ownerReferences/])
  await page.keyboard.press('Escape')
  // Deprecated after the others not set, those set last; taking one set goes to it.
  await offer(`${head}  colo`)
  await expect(options).toHaveText([/^legacyColor.*deprecated$/, /^color.*already set/])
  // (As a person's key would be: once the list has stood long enough to take one.)
  // eslint-disable-next-line no-restricted-syntax -- the list's own floor (75 ms) has to pass: no sign of it.
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowDown')
  await take(page, 'Enter')
  await page.keyboard.insertText('#')
  await expect(editor(page)).toContainText('#color: red')
})

test('the problems list: up and down, a key it has no use for let be; a long run of what can’t be seen, said as how many', async ({
  page,
}) => {
  await create(
    page,
    `apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\nspec:\n  size: x\n  color: "pu${'ㅤ'.repeat(10)}rple"\n`,
  )
  const rows = await listed(page)
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toHaveText('6:9 A whole number goes here, not text. spec.size')
  await expect(
    rows.nth(1).getByRole('img', { name: 'and 7 more invisible characters' }),
  ).toHaveCount(1)
  const list = dialog(page).getByRole('listbox', { name: 'Problems' })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('x')
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  await expect(list).toBeFocused()
})

for (const [worker, how] of [
  ['none', 'no worker can start'],
  ['failing', 'its worker fails to load'],
] as const) {
  test(`where ${how}, the page checks it itself`, async ({ page }) => {
    await create(page, ENDPOINTS, worker)
    await expect(errors(page)).toHaveCount(2)
    await expect(count(page)).toHaveText('2 errors · 1 warning')
  })
}

test('with no worker, YAML too long to check on the page says so; shorter again, it’s checked', async ({
  page,
}) => {
  const labels = Array.from({ length: 2000 }, (_, i) => `    l${i}: v`).join('\n')
  await create(
    page,
    `apiVersion: v1\nkind: Endpoints\nmetadata:\n  name: 5\n  labels:\n${labels}\n`,
    'none',
  )
  const unchecked = dialog(page).locator('.cm-schema-unchecked')
  await expect(unchecked).toHaveText(
    'This YAML is too long to check as you type here. The cluster still checks it before anything changes.',
  )
  await expect(errors(page)).toHaveCount(0)
  await write(page, ENDPOINTS)
  await expect(unchecked).toHaveCount(0)
  await expect(errors(page)).toHaveCount(2)
})

test('a check its worker doesn’t answer in time is given up, with no marks, and the worker replaced', async ({
  page,
}) => {
  await create(page, ENDPOINTS, 'silent')
  const kept = () => page.evaluate(() => (window as unknown as { workers?: Kept[] }).workers ?? [])
  // One asked a check and silent for five seconds, let go of (not one let go of with an editor,
  // which goes at once), and another made in its place.
  const givenUp = (all: Kept[]) =>
    all.find(
      (each) =>
        each.askedAt !== undefined &&
        each.terminatedAt !== undefined &&
        each.terminatedAt - each.askedAt >= 4_500,
    )
  await expect.poll(async () => givenUp(await kept()) !== undefined, { timeout: 15_000 }).toBe(true)
  const all = await kept()
  const gone = givenUp(all)!
  expect(all.some((each) => each.madeAt >= gone.terminatedAt!)).toBe(true)
  await expect(errors(page)).toHaveCount(0)
  await expect(count(page)).toBeHidden()
})
