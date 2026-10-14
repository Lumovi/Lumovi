/**
 * A list's columns as the person chooses them: shown, hidden, moved and sized, a column from a
 * label or an annotation, kept for that kind in that cluster; the list never scrolls sideways;
 * and its picked rows copied, and the whole of it saved as CSV.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { holds } from '../holds.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { demoCluster } from '../mock-cluster/fixtures/demo.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { toasts } from './action-helpers.ts'
import {
  clipboardText,
  CONTEXTS,
  DEMO,
  expect,
  hoverForTooltip,
  LARGE,
  openCluster,
  row,
  rows,
  test,
} from './fixtures.ts'

const go = (page: Page, to: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash
  }, to)
const grid = (page: Page) => page.getByRole('grid', { name: 'Pods' })
const header = (page: Page, name: string | RegExp) =>
  grid(page).getByRole('columnheader', { name, exact: typeof name === 'string' })
const button = (page: Page) => page.getByRole('button', { name: 'Columns', exact: true })
/** A text as a pattern that matches it and nothing else: a key's dots are dots. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const menu = (page: Page) => page.getByRole('dialog', { name: 'Columns' })
const box = (page: Page, name: string | RegExp) =>
  menu(page).getByRole('checkbox', {
    name: typeof name === 'string' ? new RegExp(`^${escaped(name)}`) : name,
  })
const field = (page: Page) => menu(page).getByPlaceholder('Label or annotation key')
const width = (page: Page, name: string) =>
  header(page, name).evaluate((cell) => Math.round(cell.getBoundingClientRect().width))

/**
 * The pointer off whatever it was over, onto the page's heading, and the tooltip it opened gone.
 * It moves twice there: a tooltip closes on a move after the pointer has left, not on the move
 * that leaves. (Not to the window's corner: its title bar takes the pointer from the page.)
 */
async function away(page: Page) {
  const heading = page.getByRole('heading', { level: 1 })
  await heading.hover({ position: { x: 2, y: 2 } })
  await heading.hover({ position: { x: 4, y: 4 } })
  await expect(page.getByRole('tooltip')).toHaveCount(0)
}

/**
 * A row's text with a mark, as it's drawn. Such a text is drawn twice: unseen, for measuring, and
 * seen but hidden from a screen reader (which reads it spelled): the seen one.
 */
const drawn = (row: Locator) => row.locator('[aria-hidden] > [data-their-text]')

/** Every mark of a text drawn inside the box that cuts it: none is cut away. */
async function marksShown(text: Locator) {
  await expect
    .poll(() =>
      text.evaluate((drawn) => {
        const box = drawn.closest('.overflow-hidden')!.getBoundingClientRect()
        const marks = [...drawn.querySelectorAll('[data-mark]')]
        return (
          marks.length > 0 &&
          marks.every((mark) => mark.getBoundingClientRect().right <= box.right + 0.5)
        )
      }),
    )
    .toBe(true)
}

/** Opens a kind's list from API resources. */
async function openKind(page: Page, group: string, label: string) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'API resources' })
    .click()
  await page
    .getByRole('rowgroup', { name: group, exact: true })
    .getByRole('button', { name: new RegExp(`^${escaped(label)}\\b`) })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
}

/** The list's headings, left to right. */
async function headings(page: Page) {
  const texts = await grid(page).getByRole('columnheader').allTextContents()
  return texts.filter(Boolean)
}

/** The menu's columns, top to bottom, by their names. */
async function choices(page: Page) {
  const texts = await menu(page).getByRole('list', { name: 'Columns' }).getByRole('checkbox').all()
  return Promise.all(
    texts.map((each) => each.evaluate((b) => b.querySelector('.flex-1')!.textContent)),
  )
}

/** kubectl's record of what was applied: an annotation no column is made of. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/** The shop's pods, as the cluster lists them. */
const SHOP_PODS = demoCluster().objects.filter(
  (o) => o.kind === 'Pod' && o.metadata.namespace === 'shop',
)

/** A pod in the shop, like the storefront's, carrying `annotations`. */
function shopPod(name: string, annotations: Record<string, string>): KubeObject {
  const template = demoCluster().objects.find(
    (o) => o.kind === 'Pod' && o.metadata.name === DEMO.pods.storefront[0],
  )!
  return {
    ...template,
    metadata: { ...template.metadata, name, annotations, uid: undefined },
  } as KubeObject
}

test('a list’s columns are shown, hidden and moved from the keyboard, and kept for that kind in that cluster', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  // The name's first, always shown, and the focus starts there.
  await expect(box(page, 'Name')).toBeFocused()
  await expect(box(page, 'Name')).toHaveAttribute('aria-disabled', 'true')
  expect(await choices(page)).toEqual([
    'Name',
    'Status',
    'Ready',
    'Restarts',
    'CPU',
    'Memory',
    'Node',
    'Age',
  ])
  await expect(menu(page).getByRole('button', { name: 'Reset' })).toBeDisabled()
  // The name can't be hidden.
  await page.keyboard.press('Space')
  await expect(box(page, 'Name')).toHaveAttribute('aria-checked', 'true')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
  await expect(box(page, 'Node')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(box(page, 'Node')).toHaveAttribute('aria-checked', 'false')
  await expect(header(page, 'Node')).toHaveCount(0)
  // ⌥↑ moves one a place, and it keeps the focus; nothing goes above the name.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
  await expect(box(page, 'Restarts')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(box(page, 'Restarts')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.press('Alt+ArrowUp')
  expect((await choices(page)).slice(0, 3)).toEqual(['Name', 'Restarts', 'Status'])
  expect((await headings(page)).slice(0, 3)).toEqual(['Name', 'Restarts', 'Status'])
  await expect(menu(page).getByRole('button', { name: 'Reset' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // Kept: on another page and back, and only for this kind in this cluster.
  await go(page, '#/cluster/demo/nodes')
  await expect(page.getByRole('grid', { name: 'Nodes' })).toBeVisible()
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  expect((await headings(page)).slice(0, 3)).toEqual(['Name', 'Restarts', 'Status'])
  await expect(header(page, 'Node')).toHaveCount(0)
  await go(page, `#/cluster/${CONTEXTS.large}/pods`)
  // (That cluster's own list, by how many it holds: a first row of Pods is on the page before
  // it is, the list just left, with its own columns.)
  await expect(page.getByText(`${LARGE.podCount.toLocaleString('en-US')} items`)).toBeVisible()
  await expect(rows(page, 'Pods').first()).toBeVisible()
  expect((await headings(page)).slice(0, 2)).toEqual(['Name', 'Status'])

  // Reset gives this list Lumovi's columns again.
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  await hoverForTooltip(
    menu(page).getByRole('button', { name: 'Reset' }),
    'Show Lumovi’s columns for Pods in this cluster again',
  )
  await menu(page).getByRole('button', { name: 'Reset' }).click()
  expect((await choices(page)).slice(0, 4)).toEqual(['Name', 'Status', 'Ready', 'Restarts'])
  await expect(box(page, 'Node')).toHaveAttribute('aria-checked', 'true')
})

test('a label or an annotation becomes a column, offered from what the listed objects carry', async ({
  page,
}) => {
  const component = 'app.kubernetes.io/component'
  const labelled = SHOP_PODS.filter((o) => o.metadata.labels?.[component]).length
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  // Room for those added: they come last, and the last that don't fit aren't drawn.
  for (const name of ['CPU', 'Memory', 'Node', 'Age']) await box(page, name).click()
  await field(page).fill('comp')
  const labels = menu(page).getByRole('group', { name: 'Labels' })
  await expect(labels.getByRole('option').first()).toContainText(component)
  await expect(labels.getByRole('option').first()).toContainText(
    `on ${labelled} of ${SHOP_PODS.length}`,
  )
  // The typed part, in bold.
  await expect(labels.getByRole('option').first().locator('b')).toHaveText('comp')
  // Enter adds it, and the field stays for another.
  await page.keyboard.press('Enter')
  await expect(field(page)).toHaveValue('')
  await expect(field(page)).toBeFocused()
  await expect(box(page, component)).toContainText('label')
  await expect(header(page, 'component')).toHaveCount(1)
  await expect(row(page, 'Pods', DEMO.pods.storefront[0]!)).toContainText('frontend')
  await expect(row(page, 'Pods', DEMO.pods.checkout[0]!)).toContainText('backend')

  // A key none of them has: offered both ways, and said so.
  await field(page).fill('team.example.com/owner')
  await expect(menu(page).getByRole('option')).toHaveText([
    'Add label “team.example.com/owner”',
    'Add annotation “team.example.com/owner”',
  ])
  await expect(menu(page)).toContainText(`None of the ${SHOP_PODS.length} pods has it yet.`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(box(page, 'team.example.com/owner')).toContainText('annotation')
  await expect(header(page, 'owner')).toHaveCount(1)

  // Two whose names would read the same show their whole keys.
  await field(page).fill(component)
  await expect(menu(page).getByRole('option')).toHaveText([
    `Add label “${component}”`,
    `Add annotation “${component}”`,
  ])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(header(page, component)).toHaveCount(2)
  await expect(header(page, 'component')).toHaveCount(0)
  // Each heading's tooltip says which it is (the menu closed, so it's the list's under the pointer).
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await hoverForTooltip(
    header(page, component).first().locator('[data-words]'),
    `Label ${component}`,
  )
  await away(page)
  await hoverForTooltip(
    header(page, component).last().locator('[data-words]'),
    `Annotation ${component}`,
  )
  await away(page)
  await button(page).click()

  // ⌫ on a row takes an added one away; so does its ×.
  await box(page, new RegExp(`^${escaped(component)}.*annotation`)).focus()
  await page.keyboard.press('Backspace')
  await expect(header(page, 'component')).toHaveCount(1)
  await menu(page)
    .getByRole('listitem')
    .filter({ hasText: 'team.example.com/owner' })
    .getByRole('button', { name: 'Remove this column' })
    .click()
  await expect(header(page, 'owner')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // It sorts as text.
  await header(page, 'component').getByRole('button').click()
  await expect(rows(page, 'Pods').first()).toContainText('backend')
  await expect(rows(page, 'Pods').last()).toContainText('frontend')
})

test('an added key is cut in its middle in the menu, keeping the end that tells keys apart', async ({
  page,
  clusters,
}) => {
  const prefix = 'deploy.platform.example.com/escalation-contact-for-'
  clusters.demo.upsert(
    shopPod('keyed-1', { [`${prefix}weekdays`]: 'ops', [`${prefix}weekends`]: 'on-call' }),
  )
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  for (const end of ['weekdays', 'weekends']) {
    // (A key the listed pods carry is offered, and chosen first.)
    await field(page).fill(`${prefix}${end}`)
    await expect(menu(page).getByRole('option').first()).toContainText(end)
    await page.keyboard.press('Enter')
    await expect(box(page, `${prefix}${end}`)).toBeVisible()
  }
  for (const end of ['weekdays', 'weekends']) {
    await expect(
      box(page, `${prefix}${end}`).locator('[aria-hidden]').filter({ hasText: '…' }).last(),
    ).toHaveText(new RegExp(`^deploy\\.\\S*…\\S*${end.slice(-4)}$`))
  }
})

test('the header’s own menu hides a column, or opens the menu', async ({ page }) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await header(page, 'Restarts').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide this column' }).click()
  await expect(header(page, 'Restarts')).toHaveCount(0)
  // The name's can't be hidden.
  await header(page, 'Name').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Hide this column' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await page.getByRole('menuitem', { name: 'Columns…' }).click()
  await expect(menu(page)).toBeVisible()
  await expect(box(page, 'Name')).toBeFocused()
  await expect(box(page, 'Restarts')).toHaveAttribute('aria-checked', 'false')
})

test('a column is sized by its heading’s edge or from the keyboard, never under its least', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  const own = await width(page, 'Restarts')
  const edge = header(page, 'Restarts').locator('.cursor-col-resize')
  const drag = async (by: number) => {
    const at = (await edge.boundingBox())!
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
    await page.mouse.down()
    await page.mouse.move(at.x + at.width / 2 + by / 2, at.y + at.height / 2)
    await page.mouse.move(at.x + at.width / 2 + by, at.y + at.height / 2)
    await page.mouse.up()
  }
  await drag(40)
  await expect.poll(() => width(page, 'Restarts')).toBe(own + 40)
  // A double-click gives it its own width back.
  await edge.dblclick()
  await expect.poll(() => width(page, 'Restarts')).toBe(own)
  // Never narrower than 64 px, nor than its heading's first word.
  await drag(-400)
  await expect.poll(() => width(page, 'Restarts')).toBeGreaterThanOrEqual(64)
  const least = await width(page, 'Restarts')
  expect(least).toBeLessThan(own)

  // ⌥→ and ⌥← by 16 px, ⌥0 back to its own, on a focused heading.
  await header(page, 'Restarts').getByRole('button').focus()
  await page.keyboard.press('Alt+Digit0')
  await expect.poll(() => width(page, 'Restarts')).toBe(own)
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => width(page, 'Restarts')).toBe(own + 16)
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => width(page, 'Restarts')).toBe(own - 16)
  // The name's least is 160 px.
  await header(page, 'Name').getByRole('button').focus()
  for (let i = 0; i < 30; i++) await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => width(page, 'Name')).toBe(160)
})

test('a list never scrolls sideways: the last columns that don’t fit aren’t drawn, and the button says how many', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  const before = await headings(page)
  // The name, widened, pushes the last ones out.
  await header(page, 'Name').getByRole('button').focus()
  for (let i = 0; i < 40; i++) await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(async () => (await headings(page)).length).toBeLessThan(before.length)
  await expect.poll(() => grid(page).evaluate((g) => g.scrollWidth <= g.clientWidth)).toBe(true)
  const drawn = await headings(page)
  const left = before.length - drawn.length
  // The ones left out are the last, in the person's order.
  expect(drawn).toEqual(before.slice(0, drawn.length))
  await expect(button(page)).toHaveText(String(left))
  await hoverForTooltip(
    button(page),
    `Columns: ${left} ${left === 1 ? 'doesn’t' : 'don’t'} fit at this width`,
  )
  await button(page).click()
  await expect(menu(page).getByText('doesn’t fit')).toHaveCount(left)
  for (const name of before.slice(drawn.length)) {
    await expect(box(page, name)).toContainText('doesn’t fit')
  }
})

test('picked rows are copied as the list shows them, each value whole, a formula’s start guarded', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(shopPod('formula-1', { note: '=HYPERLINK("https://example.com")' }))
  clusters.demo.upsert(shopPod('formula-2', { note: 'one\ntwo\tthree' }))
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await page.getByPlaceholder('Filter pods').fill('formula')
  await expect(rows(page, 'Pods')).toHaveCount(2)
  await button(page).click()
  for (const name of ['Ready', 'Restarts', 'CPU', 'Memory', 'Node', 'Age']) {
    await box(page, name).click()
  }
  await field(page).fill('note')
  await menu(page).getByRole('option', { name: /note/ }).first().click()
  await page.keyboard.press('Escape')
  for (const name of ['formula-1', 'formula-2']) {
    await row(page, 'Pods', name).getByRole('checkbox').click()
  }
  const bar = page.getByRole('toolbar', { name: 'Selected rows' })
  // Copy is the bar's first.
  await expect(bar.getByRole('button').first()).toHaveText('Copy')
  await bar.getByRole('button', { name: 'Copy' }).click()
  await expect(toasts(page)).toContainText('Copied 2 rows')
  const copied = (await clipboardText(page)).split('\n').map((line) => line.split('\t'))
  expect(copied.map((line) => [line[0], line[2]])).toEqual([
    ['Name', 'note'],
    ['formula-1', `'=HYPERLINK("https://example.com")`],
    ['formula-2', 'one two three'],
  ])
  expect(copied[0]![1]).toBe('Status')
  // ⌘C copies them too, from the list.
  await page.evaluate(() => ((window as { __clipboard?: string }).__clipboard = ''))
  await grid(page).focus()
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => clipboardText(page)).toContain('formula-2\t')
})

test('an annotation’s value is the cluster’s text: what can’t be seen is a mark, in its cell and its tooltip, never cut away', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(shopPod('marked-1', { note: 'go\u202Eexe' }))
  clusters.demo.upsert(shopPod('marked-2', { note: 'a'.repeat(300) }))
  clusters.demo.upsert(
    shopPod('marked-3', { note: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight' }),
  )
  clusters.demo.upsert(shopPod('marked-4', { note: `${'weekly report, '.repeat(6)}\u0007` }))
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await page.getByPlaceholder('Filter pods').fill('marked')
  await expect(rows(page, 'Pods')).toHaveCount(4)
  await button(page).click()
  await field(page).fill('note')
  await menu(page).getByRole('option', { name: /note/ }).first().click()
  await page.keyboard.press('Escape')
  const value = (name: string) => drawn(row(page, 'Pods', name))
  // (One without a mark is drawn once.)
  const plain = (name: string) => row(page, 'Pods', name).locator('[data-their-text]')
  const mark = { name: 'invisible character U+202E' }
  // In its cell, the character that would turn it round is a mark; and in its tooltip.
  await expect(value('marked-1').locator('[data-mark]')).toHaveText(['U+202E'])
  await expect(value('marked-1')).toHaveText('goU+202Eexe')
  await hoverForTooltip(value('marked-1'), 'go')
  await expect(page.getByRole('tooltip').getByRole('img', mark)).toHaveCount(1)
  await away(page)
  // Cut at its end, its mark isn't cut with it: it stands after the "…", in the cell.
  await expect(value('marked-4')).toContainText('…')
  await expect(value('marked-4').locator('[data-mark]')).toHaveText(['U+0007'])
  await marksShown(value('marked-4'))
  // A long one: its start, and an ellipsis; a tall one: six lines, the rest run on.
  await hoverForTooltip(plain('marked-2'), 'aaa')
  await expect(page.getByRole('tooltip')).toHaveText(`${'a'.repeat(280)}…`)
  await away(page)
  await hoverForTooltip(plain('marked-3'), 'one')
  expect(await page.getByRole('tooltip').evaluate((tip) => tip.textContent)).toBe(
    'one\ntwo\nthree\nfour\nfive\nsix seven eight',
  )
})

/** A plugin of one view, of widgets: a column of their first alias. */
const ALIASES = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: widget-aliases
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  views:
    - name: widgets
      kinds:
        - { group: example.com, kind: Widget }
      columns:
        - { name: Alias, path: '.spec.aliases[0]' }
`

test('a CRD’s printer columns, and a plugin view’s, are the cluster’s text: a mark in its value, never cut away', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const database = (name: string, engine: string) => {
    const object = structuredClone(clusters.demo.object('Database.example.com', 'data', 'sandbox')!)
    object.metadata = { ...object.metadata, name, uid: undefined }
    object.spec = { ...(object.spec as object), engine }
    clusters.demo.upsert(object)
  }
  database('marked-pg', 'pg\u202Eexe')
  database('marked-warehouse', `${'postgres for the analytics warehouse, '.repeat(3)}\u0007`)
  const widget = structuredClone(
    clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!,
  )
  widget.metadata = { ...widget.metadata, name: 'marked-widget', uid: undefined }
  widget.spec = { ...(widget.spec as object), aliases: ['bw\u202Eexe'] }
  clusters.demo.upsert(widget)
  mkdirSync(join(userDataDir, 'plugins'), { recursive: true })
  writeFileSync(join(userDataDir, 'plugins', 'widget-aliases.yaml'), ALIASES)
  await openCluster(page)

  // The server's columns (Databases have no view): the engine's value, a mark in it.
  await openKind(page, 'example.com', 'Databases')
  const db = row(page, 'Databases', 'marked-pg')
  await expect(drawn(db).locator('[data-mark]')).toHaveText(['U+202E'])
  await expect(drawn(db)).toHaveText('pgU+202Eexe')
  // Its title spelled: a title can't draw a mark.
  await expect(db.locator('[title="pg U+202E exe"]')).toHaveCount(1)
  const long = drawn(row(page, 'Databases', 'marked-warehouse'))
  await expect(long).toContainText('…')
  await expect(long.locator('[data-mark]')).toHaveText(['U+0007'])
  await marksShown(long)

  // A view's column: the alias it reads, a mark in it.
  await openKind(page, 'example.com', 'Widgets')
  const alias = row(page, 'Widgets', 'marked-widget')
  await expect(drawn(alias).locator('[data-mark]')).toHaveText(['U+202E'])
  await expect(drawn(alias)).toHaveText('bwU+202Eexe')
  await expect(alias.locator('[title="bw U+202E exe"]')).toHaveCount(1)
})

/** Answers the save dialog with `file`, or as cancelled; what it was offered, as it was asked. */
async function saveAs(app: ElectronApplication, file: string | undefined) {
  await app.evaluate(({ dialog }, file) => {
    const offered: string[] = []
    Object.assign(globalThis, { offered })
    dialog.showSaveDialog = (async (options: { defaultPath: string }) => {
      offered.push(options.defaultPath)
      return { canceled: file === undefined, filePath: file }
    }) as unknown as typeof dialog.showSaveDialog
  }, file)
  return () => app.evaluate(() => (globalThis as unknown as { offered: string[] }).offered)
}

/** What's shown in the file manager, from now on (nothing is, really). */
async function shown(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const shown: string[] = []
    Object.assign(globalThis, { shown })
    shell.showItemInFolder = (path: string) => void shown.push(path)
  })
  return () => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)
}

/** The day it is here, as a file's name has it. */
const today = () => {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-')
}

test('Download CSV saves every row the filters let through: whole values, times in UTC, a formula guarded', async ({
  lumovi,
  clusters,
}) => {
  const { page, app } = lumovi
  clusters.demo.upsert(shopPod('formula-1', { note: '=HYPERLINK("https://example.com")' }))
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), 'chosen.csv')
  const offered = await saveAs(app, file)
  const reveals = await shown(app)
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  await field(page).fill('note')
  await menu(page).getByRole('option', { name: /note/ }).first().click()
  await menu(page).getByRole('button', { name: 'Download CSV' }).click()
  await expect(toasts(page)).toContainText('Saved chosen.csv')
  expect(await offered()).toEqual([
    expect.stringMatching(new RegExp(`pods-shop-${today()}\\.csv$`)),
  ])

  const text = readFileSync(file, 'utf8')
  // A spreadsheet reads it as UTF-8: it starts with a byte order mark; its lines end in CRLF.
  expect(text.charCodeAt(0)).toBe(0xfeff)
  const lines = text.slice(1).split('\r\n')
  expect(lines.at(-1)).toBe('')
  expect(lines[0]).toBe('Name,Status,Ready,Restarts,CPU (cores),Memory (bytes),Node,Created,note')
  // Every pod in the shop, not only a page of them.
  expect(lines.length - 2).toBe(SHOP_PODS.length + 1)
  const formula = lines.find((line) => line.startsWith('formula-1,'))!
  expect(formula.endsWith(`,"'=HYPERLINK(""https://example.com"")"`)).toBe(true)
  const created = lines[1]!.split(',')[7]
  expect(created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

  // Shown where it was saved.
  await toasts(page)
    .getByRole('button', { name: /^Show in (Finder|Explorer|folder)$/ })
    .click()
  await expect.poll(reveals).toEqual([file])

  // Several namespaces picked: the file's named for the cluster. Cancelled: nothing's said.
  await saveAs(app, undefined)
  await go(page, '#/cluster/demo/pods?namespaces=data,shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  await menu(page).getByRole('button', { name: 'Download CSV' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { offered: string[] }).offered))
    .toEqual([expect.stringMatching(new RegExp(`pods-demo-${today()}\\.csv$`))])
  // (Nothing says this one was saved. The first's note may still be there, or have gone by now: a
  // count of them all would say more about how long that takes than about this.)
  await holds(
    async () =>
      (await toasts(page)
        .getByText(/^Saved (?!chosen\.csv)/)
        .count()) === 0,
    2_000,
    'a cancelled save says nothing',
  )
})

test('only a file Lumovi saved is shown in the file manager, by a token: the page never learns where it is', async ({
  lumovi,
}) => {
  const { page, app } = lumovi
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-saved-'))
  const file = join(folder, 'pods.csv')
  await saveAs(app, file)
  const reveals = await shown(app)
  await openCluster(page)
  const saved = await page.evaluate(() => window.lumovi!.app.saveFile('pods.csv', 'a,b\r\n'))
  // Its name, and a token that stands for where it went.
  expect(saved).toEqual({ ok: true, data: { name: 'pods.csv', token: expect.any(String) } })
  const { token } = (saved as { data: { token: string } }).data
  expect(token).not.toContain(basename(folder))
  const show = (token: unknown) =>
    page.evaluate((token) => window.lumovi!.app.showSaved!(token as string), token)
  expect(await show(token)).toBe(true)
  // A path is no token, not even the file's own; nor is anything else.
  writeFileSync(join(folder, 'other.csv'), 'x')
  for (const other of [
    file,
    join(folder, 'other.csv'),
    `${folder}/../${basename(folder)}/pods.csv`,
    '',
    42,
    undefined,
  ]) {
    expect(await show(other)).toBe(false)
  }
  // (Making a link takes rights a Windows account may not have.)
  if (process.platform !== 'win32') {
    // The file it saved, once a link is put in its place, isn't shown.
    rmSync(file)
    symlinkSync(join(folder, 'other.csv'), file)
    expect(await show(token)).toBe(false)
  }
  expect(await reveals()).toEqual([file])
})

test('a column the cluster says is a number writes a number as it is; text is text, guarded', async ({
  lumovi,
  clusters,
}) => {
  const { page, app } = lumovi
  const now = new Date().toISOString()
  clusters.demo.upsert({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'gadgets.example.com', creationTimestamp: now, uid: 'gadget-crd' },
    spec: {
      group: 'example.com',
      names: { kind: 'Gadget', listKind: 'GadgetList', plural: 'gadgets', singular: 'gadget' },
      scope: 'Namespaced',
      versions: [
        {
          name: 'v1',
          served: true,
          storage: true,
          additionalPrinterColumns: [
            { name: 'Count', type: 'integer', jsonPath: '.spec.count' },
            { name: 'Note', type: 'string', jsonPath: '.spec.note' },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
              },
            },
          },
        },
      ],
    },
    status: {
      acceptedNames: { kind: 'Gadget', plural: 'gadgets' },
      conditions: [{ type: 'Established', status: 'True', reason: 'InitialNamesAccepted' }],
      storedVersions: ['v1'],
    },
  } as KubeObject)
  for (const [name, count, note] of [
    ['counted', -3, '=1+1'],
    ['worded', '=1+1', 'plain'],
  ] as const) {
    clusters.demo.upsert({
      apiVersion: 'example.com/v1',
      kind: 'Gadget',
      metadata: { name, namespace: 'shop', creationTimestamp: now, uid: `gadget-${name}` },
      spec: { count, note },
    } as KubeObject)
  }
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), 'gadgets.csv')
  await saveAs(app, file)
  await openCluster(page)
  await go(page, '#/cluster/demo/r/Gadget.example.com?namespaces=shop')
  await expect(page.getByRole('grid', { name: 'Gadgets' }).getByText('worded')).toBeVisible()
  await button(page).click()
  await menu(page).getByRole('button', { name: 'Download CSV' }).click()
  await expect(toasts(page)).toContainText('Saved gadgets.csv')
  const lines = readFileSync(file, 'utf8').slice(1).split('\r\n')
  const header = lines[0]!.split(',')
  const cell = (name: string, column: string) =>
    lines.find((line) => line.startsWith(`${name},`))!.split(',')[header.indexOf(column)]
  // A number as it is, a negative one too; text as text, its formula's start guarded.
  expect(cell('counted', 'Count')).toBe('-3')
  expect(cell('counted', 'Note')).toBe("'=1+1")
  expect(cell('worded', 'Note')).toBe('plain')
  // What isn't a number in a number's column the cluster sends as nothing: empty, never NaN.
  expect(cell('worded', 'Count')).toBe('')
})

test('a column is dragged to its place in the menu: never above the name, and let go of, it isn’t clicked', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  const item = (name: string) =>
    menu(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('checkbox', { name: new RegExp(`^${escaped(name)}`) }) })
  const middle = async (name: string) => {
    // (Measured once the menu is where it's drawn: it opens out of view until it's placed, and a
    // slow machine would measure it there.)
    await expect(item(name)).toBeInViewport()
    const at = (await item(name).boundingBox())!
    return { x: at.x + at.width / 2, y: at.y + at.height / 2, top: at.y, bottom: at.y + at.height }
  }
  const drag = async (name: string, toY: number) => {
    const from = await middle(name)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // (A press that hardly moves is no drag yet.)
    await page.mouse.move(from.x, from.y - 2)
    await page.mouse.move(from.x, toY, { steps: 8 })
  }
  // Up the list, above Status: a line says where it lands.
  await drag('Node', (await middle('Status')).top + 2)
  await expect(menu(page).locator('li[aria-hidden].bg-accent')).toHaveCount(1)
  await page.mouse.up()
  expect((await choices(page)).slice(0, 3)).toEqual(['Name', 'Node', 'Status'])
  expect((await headings(page)).slice(0, 3)).toEqual(['Name', 'Node', 'Status'])
  // Let go of, it's still shown: the drag was no click.
  await expect(box(page, 'Node')).toHaveAttribute('aria-checked', 'true')
  // Past the last: it's last.
  await drag('Status', (await middle('Age')).bottom + 10)
  await expect(menu(page).locator('li[aria-hidden].bg-accent')).toHaveCount(1)
  await page.mouse.up()
  expect((await choices(page)).at(-1)).toBe('Status')
  // Above the name: it lands after it.
  await drag('Age', (await middle('Name')).top + 1)
  await page.mouse.up()
  expect((await choices(page)).slice(0, 2)).toEqual(['Name', 'Age'])
  // Dragged and let go of where it was: nothing moves.
  const before = await choices(page)
  await drag('Ready', (await middle('Ready')).y + 6)
  await page.mouse.up()
  expect(await choices(page)).toEqual(before)
})

test('a list without names keeps one column at least, and its first moves like the rest', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/events?namespaces=shop')
  const events = page.getByRole('grid', { name: 'Events' })
  await expect(events.getByRole('row').nth(1)).toBeVisible()
  await button(page).click()
  const all = await choices(page)
  expect(all[0]).toBe('Type')
  // Its first isn't held there: ⌥↓ moves it.
  await expect(box(page, 'Type')).toBeFocused()
  await page.keyboard.press('Alt+ArrowDown')
  expect((await choices(page)).slice(0, 2)).toEqual([all[1], 'Type'])
  // Hidden down to one, that one stays.
  const shown = async () =>
    (await events.getByRole('columnheader').allTextContents()).filter(Boolean)
  for (const name of all.filter((each) => each !== 'Reason')) await box(page, name).click()
  await expect.poll(shown).toEqual(['Reason'])
  await box(page, 'Reason').click()
  await expect(box(page, 'Reason')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(shown).toEqual(['Reason'])
  // One shown again.
  await box(page, 'Message').click()
  await expect(box(page, 'Message')).toHaveAttribute('aria-checked', 'true')
  await expect(events.getByRole('columnheader', { name: 'Message' })).toHaveCount(1)
})

test('the keys offered: the most common first, alike by name, never kubectl’s own; the keyboard moves through them', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(shopPod('applied-1', { [LAST_APPLIED]: '{}' }))
  clusters.demo.upsert(shopPod('scraped-1', { 'prometheus.io/scrape': 'true' }))
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  // Every pod has these three: by name.
  await field(page).fill('app.kubernetes.io/')
  await expect(menu(page).getByRole('group', { name: 'Labels' }).getByRole('option')).toHaveText([
    /^app\.kubernetes\.io\/component/,
    /^app\.kubernetes\.io\/name/,
    /^app\.kubernetes\.io\/part-of/,
  ])
  // Four have this one, three that: the most common first.
  await field(page).fill('prometheus')
  const offered = menu(page).getByRole('group', { name: 'Annotations' }).getByRole('option')
  await expect(offered).toHaveText([/^prometheus\.io\/scrape/, /^prometheus\.io\/port/])
  // ↑ from the first goes round to the last.
  await expect(offered.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(offered.last()).toHaveAttribute('aria-selected', 'true')
  // kubectl's own record of what was applied is no column anyone wants: not offered.
  await field(page).fill('kubectl')
  await expect(menu(page).getByRole('option')).toHaveText([
    'Add label “kubectl”',
    'Add annotation “kubectl”',
  ])
  // A key has no spaces: nothing's offered, and the keys do nothing.
  const before = await choices(page)
  await field(page).fill('two words')
  await expect(menu(page).getByRole('option')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  expect(await choices(page)).toEqual(before)
  // One added twice is one column.
  for (let i = 0; i < 2; i++) {
    await field(page).fill('team.example.com/owner')
    await menu(page)
      .getByRole('option', { name: 'Add annotation “team.example.com/owner”' })
      .click()
  }
  await expect(header(page, 'owner')).toHaveCount(1)
})

test('a key not every pod has: a dash where it isn’t, copied as one, and sorted first', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await button(page).click()
  await field(page).fill('prometheus.io/scrape')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(header(page, 'scrape')).toHaveCount(1)
  // Sorted by it: the pods without it first, then the storefront's.
  await header(page, 'scrape').getByRole('button').click()
  await expect(rows(page, 'Pods').first()).not.toContainText('storefront')
  await expect(rows(page, 'Pods').last()).toContainText('storefront')
  // One picked and copied: a dash where it has none.
  await row(page, 'Pods', DEMO.pods.checkout[0]!).getByRole('checkbox').click()
  await page
    .getByRole('toolbar', { name: 'Selected rows' })
    .getByRole('button', { name: 'Copy' })
    .click()
  await expect(toasts(page)).toContainText('Copied 1 row')
  // (The added column is the last.)
  const [, line] = (await clipboardText(page)).split('\n').map((each) => each.split('\t'))
  expect(line!.at(-1)).toBe('—')
})

test('a key none of the listed objects has is said for none listed, the one listed, and all of them', async ({
  page,
  clusters,
}) => {
  const web = structuredClone(clusters.demo.object('Deployment', 'shop', 'storefront')!)
  web.metadata = { ...web.metadata, name: 'legacy-web', namespace: 'legacy', uid: undefined }
  clusters.demo.upsert(web)
  await openCluster(page)
  const said = async (to: string, words: string) => {
    await go(page, to)
    await button(page).click()
    await field(page).fill('team.example.com/owner')
    await expect(menu(page)).toContainText(words)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
  }
  await said(
    '#/cluster/demo/pods?namespaces=argocd',
    'No pods are listed here yet, so the column will be empty until some are.',
  )
  await said(
    '#/cluster/demo/workloads?namespaces=legacy',
    'The one workload listed doesn’t have it yet.',
  )
  await said('#/cluster/demo/workloads?namespaces=shop', 'None of the 4 workloads has it yet.')
})

test('a heading’s edge pressed with another button sizes nothing; a release sorted by a column hidden since is sorted by name', async ({
  lumovi,
}) => {
  const { page, app } = lumovi
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=shop')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  const own = await width(page, 'Restarts')
  const edge = header(page, 'Restarts').locator('.cursor-col-resize')
  const at = (await edge.boundingBox())!
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(at.x + at.width / 2 + 40, at.y + at.height / 2)
  await page.mouse.up({ button: 'right' })
  await page.keyboard.press('Escape')
  expect(await width(page, 'Restarts')).toBe(own)

  // Helm's releases: sorted by the chart, which is then hidden, they're sorted by name.
  await go(page, '#/cluster/demo/helm')
  const releases = page.getByRole('grid', { name: 'Helm releases' })
  await releases.getByRole('button', { name: 'Chart' }).click()
  await expect(releases.getByRole('columnheader', { name: 'Chart' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await releases.getByRole('columnheader', { name: 'Chart' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide this column' }).click()
  await expect(releases.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  // Saved as CSV, named for the releases and the cluster.
  const offered = await saveAs(app, join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), 'r.csv'))
  await button(page).click()
  await menu(page).getByRole('button', { name: 'Download CSV' }).click()
  await expect(toasts(page)).toContainText('Saved r.csv')
  expect(await offered()).toEqual([
    expect.stringMatching(new RegExp(`releases-\\S+-${today()}\\.csv$`)),
  ])
})

/** A CSV line's fields: a quoted one may hold commas, and "" for a quote. */
function fieldsOf(line: string): string[] {
  const fields: string[] = []
  let at = 0
  while (at <= line.length) {
    if (line[at] === '"') {
      let text = ''
      let from = at + 1
      for (;;) {
        const quote = line.indexOf('"', from)
        text += line.slice(from, quote)
        if (line[quote + 1] !== '"') {
          at = quote + 2
          break
        }
        text += '"'
        from = quote + 2
      }
      fields.push(text)
    } else {
      const comma = line.indexOf(',', at)
      const end = comma === -1 ? line.length : comma
      fields.push(line.slice(at, end))
      at = end + 1
    }
  }
  return fields
}

/** A plugin of one view, of widgets: a column of when each is due. */
const DUE = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: widget-due
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  views:
    - name: widgets
      kinds:
        - { group: example.com, kind: Widget }
      columns:
        - { name: Due, path: '.spec.due', type: date }
`

test('Download CSV: a time in UTC, nothing where there’s none, a share of what a node can allocate', async ({
  lumovi,
  clusters,
}) => {
  const { page, app, userDataDir } = lumovi
  // A node with no metrics yet.
  const node = structuredClone(clusters.demo.object('Node', undefined, 'worker-3')!)
  node.metadata = { ...node.metadata, name: 'worker-9', uid: undefined }
  clusters.demo.upsert(node)
  // Widgets due at a time, at no time anyone wrote as one, and at none.
  for (const [name, due] of [
    ['due-at', '2026-10-01T10:00:00.000Z'],
    ['due-soon', 'soon'],
    ['due-never', undefined],
  ] as const) {
    const widget = structuredClone(
      clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!,
    )
    widget.metadata = { ...widget.metadata, name, uid: undefined }
    widget.spec = { ...(widget.spec as object), ...(due ? { due } : {}) }
    clusters.demo.upsert(widget)
  }
  mkdirSync(join(userDataDir, 'plugins'), { recursive: true })
  writeFileSync(join(userDataDir, 'plugins', 'widget-due.yaml'), DUE)
  await openCluster(page)
  /** The list's CSV, by its rows' names and its headings. */
  const csv = async (file: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), file)
    await saveAs(app, path)
    await button(page).click()
    await menu(page).getByRole('button', { name: 'Download CSV' }).click()
    await expect(toasts(page).getByText(`Saved ${file}`)).toHaveCount(1)
    await page.keyboard.press('Escape')
    const lines = readFileSync(path, 'utf8').slice(1).split('\r\n').map(fieldsOf)
    const heads = lines[0]!
    return (name: string, column: string) =>
      lines.find((line) => line[0] === name)![heads.indexOf(column)]
  }
  const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/

  // CronJobs: the next run in UTC, none for a suspended one; no last run for one never run.
  await go(page, '#/cluster/demo/cronjobs?namespaces=batch')
  await expect(rows(page, 'CronJobs').first()).toBeVisible()
  const cron = await csv('cronjobs.csv')
  expect(cron('nightly-report', 'Next run')).toMatch(UTC)
  expect(cron('nightly-report', 'Last run')).toMatch(UTC)
  expect(cron('cleanup', 'Next run')).toBe('')
  expect(cron('quarterly-audit', 'Last run')).toBe('')

  // Nodes: a share of what's allocatable, and none without metrics.
  await go(page, '#/cluster/demo/nodes')
  await expect(rows(page, 'Nodes').first()).toBeVisible()
  const nodes = await csv('nodes.csv')
  expect(nodes('worker-1', 'CPU (% of allocatable)')).toMatch(/^\d+\.\d$/)
  expect(nodes('worker-9', 'CPU (% of allocatable)')).toBe('')

  // A view's time: in UTC; one that isn't a time, as written; none, nothing.
  await go(page, '#/cluster/demo/r/Widget.example.com?namespaces=default')
  await expect(rows(page, 'Widgets').first()).toBeVisible()
  const widgets = await csv('widgets.csv')
  expect(widgets('due-at', 'Due')).toBe('2026-10-01T10:00:00Z')
  expect(widgets('due-soon', 'Due')).toBe('soon')
  expect(widgets('due-never', 'Due')).toBe('')
})
