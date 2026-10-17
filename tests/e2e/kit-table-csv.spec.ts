/**
 * A plugin's table saved as CSV, as Lumovi's own lists are: Lumovi writes the file from what it
 * drew, so a field the plugin's file withholds can't be in it, and a cell a spreadsheet would read
 * as a formula is taken as text. In a card, its Download CSV is at the card heading's end; on its
 * own, its heading's; as its page's list, the square at the list bar's end.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { REPORT, scanned, SECRET } from '../mock-cluster/fixtures/trivy.ts'
import { toasts } from './action-helpers.ts'
import { expect, openCluster, test } from './fixtures.ts'

/**
 * A stand-in for trivy-operator, as one of Lumovi's own: its view of its reports withholds what
 * matched, and a page whose code draws them.
 */
const TRIVY = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: trivy-operator }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  label: Trivy
  kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
  pages: [{ id: overview, title: Overview }]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      withholds:
        - { path: report.secrets.match, why: The line around a secret Trivy found. }
`

/**
 * Its code: the reports it read in shop, as a table of what it was handed: each report's first
 * finding's match (withheld: it never comes), a cell of its own that a spreadsheet would read as
 * a formula, a number, a status since a moment, and a meter; one row holds a row. `layout` says
 * where the table stands: in a card beside a second table, or alone, as its page's list.
 */
const code = (layout: 'card' | 'list') => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const hostile = ${String(layout === 'list')}
  const columns = hostile ? [
    { name: '=HYPERLINK("http://example.com")', kind: 'text' },
    { name: '\\t+cmd', kind: 'text' },
    { name: '@SUM(1)', kind: 'number' },
    { name: 'State', kind: 'status' },
    { name: 'Used', kind: 'meter' },
  ] : [
    { name: 'Match', kind: 'text' },
    { name: 'Formula', kind: 'text' },
    { name: 'Secrets', kind: 'number' },
    { name: 'State', kind: 'status' },
    { name: 'Used', kind: 'meter' },
  ]
  const table = (title, rows) => ({
    title: hostile ? '../\\u202Eevil' + 'x'.repeat(240) : title,
    columns, headings: true, rows,
    ...(hostile ? { leadHeading: '-lead' } : {}),
  })
  const rowsOf = (objects) => objects.map((o, i) => ({
    key: o.object.metadata.name,
    lead: { name: o.object.metadata.name, beside: o.object.metadata.namespace, level: 'critical' },
    group: 'Exposed',
    cells: [
      { kind: 'text', text: String(o.object.report.secrets[0].match ?? 'not handed') },
      { kind: 'text', text: hostile ? '\\t=cmd' : '=HYPERLINK("http://example.com","x")' },
      { kind: 'number', value: o.object.report.secrets.length },
      { kind: 'status', level: 'critical', word: 'Exposed', since: '2026-10-01T12:00:00Z' },
      { kind: 'meter', label: 'Used', used: 3, of: 4, text: '3 of 4' },
    ],
    rows: [{ key: 'inner', lead: { name: '@SUM(1,2)' }, cells: [
      { kind: 'text', text: '-1+1' }, { kind: 'text', text: '+cmd' }, { kind: 'none' },
      { kind: 'none' }, { kind: 'none' },
    ] }],
  }))
  ${
    layout === 'card'
      ? `commit([['make', 1, 'Stack', {}], ['put', 0, 1],
    ['make', 2, 'Card', { title: 'Secrets found', note: 'from Trivy' }], ['put', 1, 2],
    ['make', 100, 'Table', table('Exposed secrets', [])], ['put', 2, 100],
    ['make', 101, 'Table', table('Second table', [])], ['put', 1, 101]])`
      : `commit([['make', 1, 'Stack', {}], ['put', 0, 1],
    ['make', 100, 'Table', table('Exposed secrets', [])], ['put', 1, 100]])`
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.read !== 1 || !said.objects) return
    const rows = rowsOf(said.objects)
    commit([['change', 100, table('Exposed secrets', rows)]${
      layout === 'card' ? `, ['change', 101, table('Second table', rows)]` : ''
    }])
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: 'aquasecurity.github.io/ExposedSecretReport', namespace: 'shop' }))
})`

/** The stand-ins' folder: trivy-operator's file and its code. */
function included(layout: 'card' | 'list'): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'trivy-operator.yaml'), TRIVY)
  writeFileSync(join(folder, 'trivy-operator.js'), code(layout))
  return folder
}

/** Answers the save dialog with `file`, keeping the name Lumovi offered it. */
async function saveAs(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string }
      ;(globalThis as { __offered?: string }).__offered = options.defaultPath
      return { canceled: false, filePath: file }
    }) as unknown as typeof dialog.showSaveDialog
  }, file)
}

/** The name Lumovi offered the save dialog, without its folder. */
const offered = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as { __offered?: string }).__offered ?? '').split(/[\\/]/).at(-1))

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

/** What a CSV saved by the press holds, without its byte order mark. */
async function saved(app: ElectronApplication, press: () => Promise<void>) {
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), 'saved.csv')
  await saveAs(app, file)
  await press()
  await expect.poll(() => readFileSync(file, 'utf8').length, { timeout: 10_000 }).toBeGreaterThan(0)
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

test('a table in a card saves itself from its heading: every line as a spreadsheet reads it, a formula as text, and nothing it was never handed', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const { app, page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included('card') },
  })
  await openCluster(page)
  await go(page, '#/cluster/demo/plugins/trivy-operator/overview')
  const card = page.getByRole('region', { name: 'Secrets found' })
  await expect(card.getByRole('treegrid', { name: 'Exposed secrets' })).toContainText(REPORT)
  // In the card's heading, after its note.
  const button = card.getByRole('button', { name: 'Download CSV' })
  await expect(button).toBeVisible()
  const csv = await saved(app, () => button.click())
  await expect(toasts(page)).toContainText(/^Saved .*\.csv/)
  const lines = csv.trimEnd().split('\r\n')
  expect(lines[0]).toBe(
    'Group,Part of,Name,Name (beside),Health,Match,Formula,Secrets,State,State (since),Used (used),Used (of)',
  )
  // Its row: what matched never came (the code says "not handed"); a formula is text.
  expect(lines[1]).toBe(
    `Exposed,,${REPORT},shop,Failing,not handed,"'=HYPERLINK(""http://example.com"",""x"")",2,Exposed,2026-10-01T12:00:00.000Z,3,4`,
  )
  // The row it holds, on its own line, saying which it's part of; each formula's start guarded.
  expect(lines[2]).toBe(`,${REPORT},"'@SUM(1,2)",,,'-1+1,'+cmd,,,,,`)
  expect(csv).not.toContain(SECRET)

  // A table on its own: its Download CSV at its heading's end.
  const second = page.getByRole('region', { name: 'Second table table' })
  await expect(second.getByRole('button', { name: 'Download CSV' })).toBeVisible()
  // Beside its heading, which is read as its title and count alone.
  await expect(second.getByRole('heading', { level: 3 })).toHaveAccessibleName('Second table 1')
})

test('a table that’s its page’s list saves itself from the square at its bar’s end, where Lumovi’s lists have Columns', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const { app, page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included('list') },
  })
  await openCluster(page)
  await go(page, '#/cluster/demo/plugins/trivy-operator/overview')
  const bar = page.getByRole('group', { name: 'Filters' })
  await expect(bar).toContainText('1 item')
  const square = bar.getByRole('button', { name: 'Download CSV' })
  await expect(square).toBeVisible()
  const csv = await saved(app, () => square.click())
  // The plugin's headings are its words too: each guarded as a cell is, a tab before one dropped.
  const [header, ...lines] = csv.trimEnd().split('\r\n')
  expect(header).toBe(
    `Group,Part of,'-lead,'-lead (beside),Health,"'=HYPERLINK(""http://example.com"")",'+cmd,'@SUM(1),State,State (since),Used (used),Used (of)`,
  )
  // No cell starts as a formula or with a tab: the tab before "=cmd" dropped, its "=" guarded.
  for (const line of lines) expect(line).not.toMatch(/(^|,)[=+@\t]/)
  expect(lines[0]).toContain(",'=cmd,")
  expect(csv).not.toContain(SECRET)
  // Named as Lumovi's lists name theirs: whose, what, where, and the day.
  // Its title holds "../", a right-to-left override and 250 characters: nothing of it reaches the
  // name but letters, digits and hyphens, cut short.
  const name = (await offered(app))!
  expect(name).toMatch(/^trivy-evil-?x+-demo-\d{4}-\d{2}-\d{2}\.csv$/)
  expect(name.length).toBeLessThanOrEqual(90)
  await expect(toasts(page)).toContainText('Saved saved.csv')
})
