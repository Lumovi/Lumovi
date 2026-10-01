import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { dialog, menuAction, toasts, writes } from './action-helpers.ts'
import { expect, mockOpenExternal, openCluster, panel, row, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

/** Opens a custom kind's list from its API group on the API resources page. */
async function openKind(page: Page, group: string, label: string) {
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await page
    .getByRole('rowgroup', { name: group, exact: true })
    .getByRole('button', { name: new RegExp(`^${label}\\b`) })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
}

/** A view of widgets that reads fields every way a path can. */
const WIDGETS = String.raw`
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: my-widgets
spec:
  kinds:
    - { group: example.com, kind: Widget }
  icon: box
  columns:
    - { name: Size, path: '{.spec.size}', type: number }
    - { name: Color, path: '$.spec.color' }
    - { name: Parts, path: .spec.parts, type: count }
    - { name: Weight, path: .spec.weight, type: number, default: unknown }
  status:
    - when: { path: .spec.nothing }
      health: neutral
      label: Never
    - when: { path: .spec.color, equals: red }
      health: warning
      label: ''
    - when: { path: .spec.size, notEquals: 3 }
      health: critical
      label: Resized to {{ .spec.size }}
      detail: '{{ .spec.missing ?? .metadata.name }}'
    - when:
        all:
          - { path: .spec.size, exists: true }
          - any:
              - { path: .spec.color, in: [red, green] }
              - { path: .spec.color, matches: '^bl' }
      health: healthy
      label: '{{ .spec.color }} {{ .spec.size ?? "?" }}'
      detail: '{{ .spec.missing ?? "no detail" }}'
  details:
    - { name: Part names, path: '.spec.parts[*].name' }
    - { name: Last part, path: '.spec.parts[-1].name' }
    - { name: Spare parts, path: '.spec.parts[?(@.spare)].name' }
    - { name: Not two, path: '.spec.parts[?(@.count!=2)].name' }
    - { name: Four of, path: '.spec.parts[?(@.count==4)].name' }
    - { name: Flagged, path: '.spec.parts[?(@.spare==true)].name' }
    - { name: Nulls, path: '.spec.parts[?(@.missing==null)].name', default: none }
    - { name: App, path: .metadata.labels.app\.kubernetes\.io/name }
    - { name: Quoted, path: ".metadata.labels['app.kubernetes.io/name']" }
    - { name: Label count, path: '.metadata.labels[*]', type: count }
    - { name: First spare, path: '.spec.parts[0].spare', type: boolean }
    - { name: Second spare, path: '.spec.parts[1].spare', type: boolean }
    - { name: Made, path: .metadata.creationTimestamp, type: date }
    - { name: Names of a list, path: .spec.parts.name, default: none }
    - { name: Index of a number, path: '.spec.size[0]', default: none }
    - { name: Filter of a map, path: '.spec[?(@.size)]', default: none }
    - { name: Inside a number, path: .spec.size.inside, default: none }
    - { name: Every label, path: .metadata.labels.*, type: count }
    - { name: Alias bw, path: '.spec.aliases[?(@=="bw")]' }
    - { name: Aliases, path: '.spec.aliases[?(@)]', type: count }
    - { name: Gears, path: ".spec.parts[?(@['name']==\"gear\")].count" }
    - { name: Index of a map, path: '.spec[0]', default: none }
    - { name: Sixth part, path: '.spec.parts[5].name', default: none }
  links:
    - name: Namespace
      kind: Namespace
      objectName: '{{ .metadata.namespace }}'
    - name: Settings
      kind: ConfigMap
      objectName: '{{ .metadata.labels.tier }}-config'
      namespace: '{{ .spec.missing ?? .spec.alsoMissing }}'
    - name: Nothing
      kind: '{{ .spec.none }}'
      objectName: x
  actions:
    - name: Grow
      icon: rocket
      primary: true
      patch: { spec: { size: 10 } }
      undo: { spec: { size: 3 } }
      done: Grew {{ .metadata.name }}
    - name: Paint red
      danger: true
      when: { path: .spec.color, notEquals: red }
      type: json
      patch:
        - { op: replace, path: /spec/color, value: red }
      confirm: It turns {{ .metadata.name }} red.
    - name: Stamp
      when: { path: .spec.size, exists: true }
      patch:
        metadata:
          annotations: { example.com/stamped: '{{ now }}' }
`

/** Replaces KubeStacks' own view of certificates. */
const CERTIFICATES = `
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: plain-certificates
spec:
  kinds:
    - { group: cert-manager.io, kind: Certificate }
  columns:
    - { name: Common name, path: .spec.commonName, default: none }
---
# A kind in the core group: no group to name.
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: service-accounts
spec:
  kinds:
    - { kind: ServiceAccount }
  columns:
    - { name: Token, path: .automountServiceAccountToken, type: boolean, default: mounted }
`

/** Everything that can be wrong with a view, one problem at a time. */
const BROKEN = `
apiVersion: v1
kind: ConfigMap
---
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata: {}
---
spec: [unclosed
---
---
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata: { name: not-a-map }
spec: [1]
---
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata: { name: everything-wrong }
spec:
  kinds: []
  icon: sparkles
  colums: []
  columns:
    - { name: A, path: spec.a }
    - { name: B, path: '.spec..b' }
    - { name: C, path: '.spec[0]x' }
    - { name: D, path: '.spec[0' }
    - { name: E, path: '.spec[foo]' }
    - { name: F, path: '.spec[?(x==1)]' }
    - { name: G, path: '.spec[?(@.x==bare)]' }
    - { name: G2, path: '.spec[?(@.x==)]' }
    - { name: H, path: 5 }
    - { name: I, path: .spec.i, type: list }
    - { path: .spec.j }
  status:
    - { when: { path: .a, all: [] }, health: great, label: '{{ nope }}' }
    - { when: { path: .a, any: [{ path: .b }] }, health: healthy, label: x }
    - { health: healthy, label: '{{ .a b c }}' }
    - { health: healthy, label: '{{ .a ?? .b[ }}' }
    - { when: { path: .a, matches: '(' }, health: healthy, label: x }
    - { when: { path: .a, equals: { a: 1 } }, health: healthy, label: x }
    - { when: { path: .a, exists: 'yes' }, health: healthy, label: x }
    - { when: { path: .a, in: 3 }, health: healthy, label: x }
    - { when: null, health: healthy, label: x }
  details: notalist
  links:
    - { kind: Secret }
  actions:
    - { name: Do, patch: text }
    - { name: Do2, type: json, patch: { spec: {} } }
    - { name: Do3, patch: { a: 1 }, undo: [{ op: add }] }
`

test('your own views: they replace KubeStacks’, and what’s wrong with them is shown', async ({
  kubestacks,
  clusters,
}) => {
  const { page, userDataDir } = kubestacks
  const views = join(userDataDir, 'views')
  mkdirSync(join(views, 'a-folder.yaml'), { recursive: true })
  writeFileSync(join(views, 'widgets.yaml'), WIDGETS)
  writeFileSync(join(views, 'certificates.yml'), CERTIFICATES)
  writeFileSync(join(views, 'broken.yaml'), BROKEN)
  writeFileSync(join(views, 'huge.yaml'), `# ${'x'.repeat(300 * 1024)}\n`)
  writeFileSync(join(views, 'notes.txt'), 'not a view')
  await openCluster(page)

  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  const problems = page.getByRole('list', { name: 'View problems' })
  for (const problem of [
    'broken.yaml: should start with apiVersion: kubestacks.dev/v1alpha1 and kind: View',
    'broken.yaml (document 2): needs metadata.name',
    'broken.yaml (document 3): ',
    'broken.yaml (document 5): not-a-map: spec: should be a map of fields, not a list',
    'everything-wrong: spec.kinds: should not be empty',
    'spec.icon: should be one of activity, archive',
    'spec.colums: isn’t something a view has',
    'spec.columns[0].path: “spec.a” should start with a dot, like .spec.replicas',
    'spec.columns[1].path: “.spec..b” has an empty field name',
    'spec.columns[2].path: “.spec[0]x” has “x” where a . or [ should be',
    'spec.columns[3].path: “.spec[0” has a [ without its ]',
    'spec.columns[4].path: “.spec[foo]” has [foo], which isn’t an index, a key or a filter',
    'spec.columns[5].path: “.spec[?(x==1)]”: a filter compares a field of each item, like @.type',
    'spec.columns[6].path: “.spec[?(@.x==bare)]” compares with bare, which isn’t a value',
    'spec.columns[7].path: “.spec[?(@.x==)]” compares with nothing, which isn’t a value',
    'spec.columns[8].path: should be text, not a number',
    'spec.columns[9].type: should be one of string, number, date, boolean, count, not "list"',
    'spec.columns[10].name: is required',
    'spec.status[0].when.all: should not be empty',
    'spec.status[0].health: should be one of healthy, progressing, warning, critical, neutral',
    'spec.status[0].label: “nope” should start with a dot',
    'spec.status[1].when: needs exactly one of path, all or any',
    'spec.status[2].label: {{ .a b c }} should be a path, maybe with ?? "a fallback"',
    'spec.status[3].label: “.b[” has a [ without its ]',
    'spec.status[4].when.matches: Invalid regular expression',
    'spec.status[5].when.equals: should be a single value, not a object',
    'spec.status[6].when.exists: should be true or false, not a string',
    'spec.status[7].when.in: should be a list, not a number',
    'spec.status[8].when: should be a map of fields, not null',
    'spec.details: should be a list, not a string',
    'spec.links[0].name: is required',
    'spec.links[0].objectName: is required',
    'spec.actions[0].patch: should be a patch (an object or a list), not a string',
    'spec.actions[1]: patches are an object for type merge, and a list for type json',
    'spec.actions[2]: patches are an object for type merge, and a list for type json',
    'huge.yaml: It’s larger than 256 KB.',
  ]) {
    await expect(problems).toContainText(problem)
  }
  await expect(page.getByText(/views from KubeStacks, 3 of yours/)).toBeVisible()
  // (Where temporary folders are in the home folder, as on Windows, it's shown from ~.)
  await expect(page.getByText(/kubestacks-user-\w+[\\/]views/)).toBeVisible()
  const custom = page.getByRole('region', { name: 'Custom resources' })
  await expect(custom.getByRole('row').filter({ hasText: 'Widgets' })).toContainText('widgets.yaml')
  await expect(custom.getByRole('row').filter({ hasText: 'Certificates' })).toContainText(
    'certificates.yml',
  )
  await expect(
    page
      .getByRole('region', { name: 'Kubernetes' })
      .getByRole('row')
      .filter({ hasText: 'ServiceAccounts' }),
  ).toContainText('certificates.yml')

  // A view of one's own replaces KubeStacks'.
  await openKind(page, 'cert-manager.io', 'Certificates')
  await expect(page.getByRole('columnheader', { name: 'Common name' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Hosts' })).toHaveCount(0)

  // Columns and status from the widget view.
  clusters.demo.upsert({
    apiVersion: 'example.com/v1',
    kind: 'Widget',
    metadata: { name: 'plain-widget', namespace: 'default' },
    spec: { size: 3 },
  })
  await openKind(page, 'example.com', 'Widgets')
  const widget = row(page, 'Widgets', CUSTOM.widget)
  await expect(widget).toContainText('blue 3')
  await expect(widget).toContainText('unknown')
  // Its rules say nothing about this one, and the usual conventions neither.
  await expect(row(page, 'Widgets', 'plain-widget')).toContainText('Unknown')
  await page.getByRole('columnheader', { name: 'Weight' }).click()
  await page.getByRole('columnheader', { name: 'Parts' }).click()
  await expect(page.getByRole('grid', { name: 'Widgets' }).getByRole('row').nth(1)).toContainText(
    'plain-widget',
  )

  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  const detail = panel(page, 'Widget', CUSTOM.widget)
  for (const [fact, value] of <[string, string][]>[
    ['Part names', 'bolt, gear'],
    ['Last part', 'gear'],
    ['Spare parts', 'gear'],
    ['Not two', 'bolt'],
    ['Four of', 'bolt'],
    ['Flagged', 'gear'],
    ['Nulls', 'none'],
    ['App', 'widgets'],
    ['Quoted', 'widgets'],
    ['Label count', '2'],
    ['First spare', 'No'],
    ['Second spare', 'Yes'],
    ['Made', '(19d ago)'],
    ['Names of a list', 'none'],
    ['Index of a number', 'none'],
    ['Filter of a map', 'none'],
    ['Inside a number', 'none'],
    ['Every label', '2'],
    ['Alias bw', 'bw'],
    ['Aliases', '2'],
    ['Gears', '2'],
    ['Index of a map', 'none'],
    ['Sixth part', 'none'],
  ]) {
    await expect(
      detail.getByRole('term').filter({ hasText: new RegExp(`^${fact}$`) }),
    ).toBeVisible()
    await expect(detail).toContainText(
      new RegExp(`${fact}.{0,30}${value.replace(/[()]/g, '\\$&')}`),
    )
  }
  await expect(detail.getByRole('button', { name: 'Namespace/default' })).toBeVisible()
  await expect(detail.getByRole('button', { name: 'ConfigMap/toys-config' })).toBeVisible()
  await expect(detail).not.toContainText('Nothing')

  // Its actions: at once with an undo, after asking, and with the time filled in.
  await detail.getByRole('button', { name: 'Grow' }).click()
  await expect(toasts(page)).toContainText('Grew blue-widget')
  await expect(detail.locator('header')).toContainText('Resized to 10')
  await toasts(page).getByRole('button', { name: 'Undo' }).first().click()
  await expect(detail.locator('header')).toContainText('blue 3')

  await menuAction(page, 'Widget', CUSTOM.widget, 'Stamp')
  await expect(toasts(page)).toContainText('Stamp: blue-widget')
  const path = `/apis/example.com/v1/namespaces/default/widgets/${CUSTOM.widget}`
  expect(
    writes(clusters.demo, 'PATCH', path).at(-1)!.body.metadata.annotations['example.com/stamped'],
  ).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

  await menuAction(page, 'Widget', CUSTOM.widget, 'Paint red…')
  await expect(dialog(page)).toContainText('It turns blue-widget red.')
  await expect(dialog(page)).toContainText('--type=json')
  await dialog(page).getByRole('button', { name: 'Paint red', exact: true }).click()
  await expect(toasts(page)).toContainText('Paint red: blue-widget')
  expect(writes(clusters.demo, 'PATCH', path).at(-1)).toMatchObject({
    type: 'application/json-patch+json',
    body: [{ op: 'replace', path: '/spec/color', value: 'red' }],
  })
  // A rule whose label is empty is called by its health.
  await expect(detail.locator('header')).toContainText('warning')
})

test('views live in ~/.kubestacks/views unless KUBESTACKS_VIEWS_DIR says otherwise', async ({
  launch,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'kubestacks-home-'))
  mkdirSync(join(home, '.kubestacks', 'views'), { recursive: true })
  writeFileSync(join(home, '.kubestacks', 'views', 'mine.yaml'), 'apiVersion: v1\nkind: Pod\n')
  const { app, page } = await launch({
    env: { KUBESTACKS_VIEWS_DIR: undefined, HOME: home, USERPROFILE: home },
  })
  const opened = await mockOpenExternal(app)
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  // Shown from the home folder, as ~.
  await expect(page.getByText(join('~', '.kubestacks', 'views'))).toBeVisible()
  // Only the user's view has something wrong with it, not KubeStacks' own.
  await expect(page.getByRole('alert')).toContainText('A view couldn’t be used')
  await expect(page.getByRole('list', { name: 'View problems' }).getByRole('listitem')).toHaveText([
    'mine.yaml: should start with apiVersion: kubestacks.dev/v1alpha1 and kind: View',
  ])
  await page.getByRole('button', { name: 'How to write a view' }).click()
  await expect.poll(opened).toEqual([expect.stringMatching(/\/docs\/views\.md$/)])
})
