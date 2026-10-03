import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { dialog, menuAction, toasts, writes } from './action-helpers.ts'
import { expect, mockOpenExternal, openCluster, panel, row, rows, test } from './fixtures.ts'

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
---
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata: { name: wrong-relations }
spec:
  kinds: [{ group: example.com, kind: Gadget }, { kind: '*' }]
  related:
    - { name: Everything, kind: Pod }
    - { name: Listed, kind: Pod, labels: [1] }
    - { name: Counted, kind: Pod, labels: { a: 5 } }
  actions:
    - { name: Neither }
    - name: Both
      patch: { a: 1 }
      create: { apiVersion: v1, kind: ConfigMap, metadata: { name: x } }
    - { name: Kindless, create: { apiVersion: v1, metadata: { name: x } } }
    - { name: Nameless, create: { apiVersion: v1, kind: ConfigMap } }
    - name: Undone
      create: { apiVersion: v1, kind: ConfigMap, metadata: { generateName: x- } }
      undo: { a: 1 }
    - { name: Unasked, patch: { a: '{{ input.missing }}' } }
    - { name: Unasking, inputs: [], patch: { a: 1 } }
    - name: Badly asked
      patch: { a: 1 }
      inputs:
        - { name: two words, label: X }
        - { name: c, label: C, type: choice }
        - { name: t, label: T, options: [a] }
        - { name: d, label: D, type: choice, options: [a], from: .x }
---
apiVersion: kubestacks.dev/v1alpha1
kind: AddOn
metadata: { name: pods-too }
spec:
  label: Pods too
  kinds: [{ kind: Pod }]
---
apiVersion: kubestacks.dev/v1alpha1
kind: AddOn
metadata: { name: messy }
spec:
  label: Messy
  category: workloads
  colour: blue
  kinds: []
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
    'broken.yaml: should start with apiVersion: kubestacks.dev/v1alpha1 and kind: View or AddOn',
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
    'wrong-relations: spec.kinds[1]: every kind (*) is of a group: name it',
    'wrong-relations: spec.related[0]: needs labels or a fieldSelector to find them',
    'spec.related[1].labels: should be a map of fields, not a list',
    'spec.related[2].labels.a: should be text, not a number',
    'spec.actions[0]: needs a patch, or an object to create (not both)',
    'spec.actions[1]: needs a patch, or an object to create (not both)',
    'spec.actions[2]: what it creates needs an apiVersion, a kind, and a metadata.name or generateName',
    'spec.actions[3]: what it creates needs an apiVersion',
    'spec.actions[4]: can’t undo creating something',
    'spec.actions[5]: {{ input.missing }} isn’t one of its inputs',
    'spec.actions[6].inputs: should not be empty',
    'spec.actions[7].inputs[0]: "two words" should be letters, digits and _, like replicas',
    'spec.actions[7].inputs[1]: a choice needs options, or a path to read them from',
    'spec.actions[7].inputs[2]: only a choice has options',
    'spec.actions[7].inputs[3]: a choice needs options, or a path to read them from',
    'pods-too: spec: Pod has a page of its own, so it can’t be in an add-on',
    'messy: spec.category: should be one of cluster, network, config, storage, not "workloads"',
    'messy: spec.colour: isn’t something an add-on has',
    'messy: spec.kinds: should not be empty',
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
      new RegExp(`${fact}.{0,30}${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
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
    'mine.yaml: should start with apiVersion: kubestacks.dev/v1alpha1 and kind: View or AddOn',
  ])
  await page.getByRole('button', { name: 'How to write a view' }).click()
  await expect.poll(opened).toEqual(['https://docs.kubestacks.com/custom-resources/write-a-view'])
})

/** Widgets related to what they need, and actions that ask first or make something new. */
const WORKSHOP = String.raw`
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: widget-workshop
spec:
  kinds:
    - { group: example.com, kind: Widget }
  related:
    - name: Storefront
      kind: Pod
      labels: { app.kubernetes.io/name: '{{ .spec.app ?? "storefront" }}' }
      namespace: '{{ .spec.missing ?? "shop" }}'
    - name: On worker-1
      kind: Pod
      fieldSelector: spec.nodeName=worker-1
    - name: Settings
      kind: ConfigMap
      labels: { widget: '{{ .metadata.name }}' }
      namespace: '{{ .spec.missing }}'
    - name: Nodes
      kind: Node
      labels: { kubernetes.io/os: linux }
    - name: Things
      kind: Thing.example.com
      labels: { widget: '{{ .metadata.name }}' }
    - name: Owners
      kind: Secret
      labels: { owner: '{{ .spec.missing }}' }
    - name: Placed
      kind: Pod
      fieldSelector: 'spec.nodeName={{ .spec.missing }},status.phase=Running'
  actions:
    - name: Resize
      icon: gauge
      inputs:
        - { name: size, label: New size, type: number, default: '{{ .spec.size }}' }
        - { name: unit, label: Unit, type: choice, options: [cm, in] }
        - { name: part, label: Part, type: choice, from: '.spec.parts[*].name', default: gear }
        - { name: note, label: Note, default: '{{ .spec.missing }}' }
      # A number on its own is a number, but annotations are always text.
      patch:
        metadata:
          annotations: { example.com/resized-to: '{{ input.size }}' }
        spec:
          size: '{{ input.size }}'
          unit: '{{ input.unit }}'
          part: '{{ input.part }}'
          note: '{{ input.note }}'
          previous: null
      undo: { spec: { size: 3 } }
      done: Resized {{ .metadata.name }} to {{ input.size }} {{ input.unit }}
    - name: Count
      inputs: [{ name: n, label: How many, type: number }]
      confirm: Counts to {{ input.n ?? "nothing" }}.
      patch: { spec: { count: '{{ input.n }}' } }
    - name: Pick an alias
      inputs: [{ name: alias, label: Alias, type: choice, from: .spec.nothing }]
      patch: { spec: { alias: '{{ input.alias }}' } }
    - name: Clone
      icon: package
      create:
        apiVersion: example.com/v1
        kind: Widget
        metadata:
          generateName: '{{ .metadata.name }}-copy-'
          labels: { app.kubernetes.io/name: widgets, size: '{{ .spec.size }}' }
        # Values on their own are copied as they are; labels are always text.
        spec:
          size: '{{ .spec.size }}'
          color: '{{ .spec.color }}'
          aliases: '{{ .spec.aliases[*] }}'
          parts: '{{ .spec.parts }}'
          note: '{{ .spec.missing }}'
          shade: '{{ .spec.missing ?? "plain" }}'
          tint: '{{ .spec.missing ?? .spec.color }}'
          copied: '{{ now }}'
          tags: ['{{ .spec.missing }}', copy]
      done: Cloned {{ .metadata.name }}
    - name: Copy to shop
      create:
        apiVersion: example.com/v1
        kind: Widget
        metadata: { name: '{{ .metadata.name }}-in-shop', namespace: shop }
        spec: { size: 2 }
    - name: Give it a namespace
      create: { apiVersion: v1, kind: Namespace, metadata: { name: '{{ .metadata.name }}-ns' } }
    - name: Make a thing
      create: { apiVersion: example.com/v1, kind: Thing, metadata: { name: thing } }
---
# Cluster-wide issuers, related to pods in every namespace.
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: issuers-and-pods
spec:
  kinds:
    - { group: cert-manager.io, kind: ClusterIssuer }
  related:
    - name: Storefront pods
      kind: Pod
      labels: { app.kubernetes.io/name: storefront }
`

async function writeViews(userDataDir: string, files: Record<string, string>) {
  const views = join(userDataDir, 'views')
  mkdirSync(views, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(views, name), text)
}

test('related objects: a tab each, and pods with their logs and usage', async ({
  kubestacks,
  clusters,
}) => {
  const { page, userDataDir } = kubestacks
  await writeViews(userDataDir, { 'workshop.yaml': WORKSHOP })
  // More settings than a page shows.
  for (let i = 0; i < 55; i++) {
    clusters.demo.upsert({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: `setting-${i}`, namespace: 'default', labels: { widget: CUSTOM.widget } },
      data: { value: String(i) },
    })
  }
  await openCluster(page)
  await openKind(page, 'example.com', 'Widgets')
  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  const detail = panel(page, 'Widget', CUSTOM.widget)
  // A view's pods are its first related pods, named as it says, with their logs and usage.
  // Lists whose templates find nothing are left out.
  await expect(detail.getByRole('tab')).toHaveText([
    'Overview',
    'Storefront',
    'Logs',
    'Metrics',
    'On worker-1',
    'Settings',
    'Nodes',
    'Things',
    'Map',
    'Events',
    'YAML',
  ])
  await detail.getByRole('tab', { name: 'Storefront' }).click()
  await expect(detail.getByRole('grid', { name: 'Pods' })).toContainText('storefront-')
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await expect(detail.getByRole('log')).toBeVisible()
  await detail.getByRole('tab', { name: 'Metrics' }).click()
  await expect(detail.getByRole('region', { name: 'CPU per pod' })).toBeVisible()

  // Other related lists have their kind's columns: pods' and nodes' with their usage.
  await detail.getByRole('tab', { name: 'On worker-1' }).click()
  await expect(detail.getByRole('grid', { name: 'On worker-1' })).toContainText('Running')
  // A list that can't be read says why, and can be tried again.
  const nodesFault = clusters.demo.fail('/api/v1/nodes', { status: 500 })
  await detail.getByRole('tab', { name: 'Nodes' }).click()
  await expect(detail.getByRole('button', { name: 'Try again' })).toBeVisible()
  nodesFault()
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('grid', { name: 'Nodes' }).getByRole('meter')).not.toHaveCount(0)
  await detail.getByRole('tab', { name: 'Things' }).click()
  await expect(detail).toContainText('This cluster doesn’t serve Thing.')
  await detail.getByRole('tab', { name: 'Settings' }).click()
  const settings = detail.getByRole('grid', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(detail.getByRole('navigation', { name: 'Pagination' })).toContainText('1–50 of 55')
  await detail.getByRole('button', { name: 'Next page' }).click()
  await expect(detail.getByRole('navigation', { name: 'Pagination' })).toContainText('51–55 of 55')
  // Opening one opens it in the panel.
  await rows(page, 'Settings').first().getByRole('gridcell').first().click()
  await expect(page.getByRole('complementary', { name: /^ConfigMap setting-/ })).toBeVisible()
  await page.goBack()

  // A widget whose pods can't be listed for their usage, and then aren't running at all.
  clusters.demo.upsert({
    apiVersion: 'example.com/v1',
    kind: 'Widget',
    metadata: { name: 'idle-widget', namespace: 'default' },
    spec: { size: 1, app: 'nothing-here' },
  })
  const fault = clusters.demo.fail('/api/v1/namespaces/shop/pods', { status: 500 })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await row(page, 'Widgets', 'idle-widget').getByRole('gridcell').nth(1).click()
  const idle = panel(page, 'Widget', 'idle-widget')
  await idle.getByRole('tab', { name: 'Metrics' }).click()
  await expect(idle.getByRole('button', { name: 'Try again' })).toBeVisible()
  fault()
  await idle.getByRole('button', { name: 'Try again' }).click()
  await expect(idle).toContainText('so there’s no usage to chart')
  await idle.getByRole('tab', { name: 'Storefront' }).click()
  await expect(idle).toContainText('Nothing is running for this right now.')
  await idle.getByRole('tab', { name: 'Settings' }).click()
  await expect(idle).toContainText('No settings')
  await expect(idle).toContainText('No configmaps match widget=idle-widget right now.')

  // A cluster-wide object's pods are found in every namespace.
  await openKind(page, 'cert-manager.io', 'ClusterIssuers')
  await row(page, 'ClusterIssuers', CUSTOM.clusterIssuers.production)
    .getByRole('gridcell')
    .nth(1)
    .click()
  const issuer = panel(page, 'ClusterIssuer', CUSTOM.clusterIssuers.production)
  await issuer.getByRole('tab', { name: 'Storefront pods' }).click()
  await expect(issuer.getByRole('grid', { name: 'Pods' })).toContainText('shop')
})

test('view actions that ask for values, and ones that create objects', async ({
  kubestacks,
  clusters,
}) => {
  const { page, userDataDir } = kubestacks
  await writeViews(userDataDir, { 'workshop.yaml': WORKSHOP })
  await openCluster(page)
  await openKind(page, 'example.com', 'Widgets')
  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  const path = `/apis/example.com/v1/namespaces/default/widgets/${CUSTOM.widget}`

  // Values it asks for start as its defaults say: a number, choices, and text to fill in.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Resize…')
  const form = dialog(page)
  await expect(form.getByRole('textbox', { name: 'New size' })).toHaveValue('3')
  await expect(form.getByRole('radio', { name: 'cm' })).toBeChecked()
  await expect(form.getByRole('radio', { name: 'gear' })).toBeChecked()
  const resize = form.getByRole('button', { name: 'Resize', exact: true })
  await expect(resize).toBeDisabled()
  await form.getByLabel('Note').fill('bigger')
  await form.getByRole('textbox', { name: 'New size' }).fill('')
  await expect(resize).toBeDisabled()
  await form.getByRole('textbox', { name: 'New size' }).fill('3')
  await form.getByRole('button', { name: 'Increase new size' }).click()
  await form.getByRole('radio', { name: 'in' }).check()
  await form.getByRole('radio', { name: 'bolt' }).check()
  await expect(form).toContainText('"size":4')
  await resize.click()
  await expect(toasts(page)).toContainText('Resized blue-widget to 4 in')
  expect(writes(clusters.demo, 'PATCH', path).at(-1)!.body).toEqual({
    metadata: { annotations: { 'example.com/resized-to': '4' } },
    spec: { size: 4, unit: 'in', part: 'bolt', note: 'bigger', previous: null },
  })

  // Its text can fall back when a value is left out.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Count…')
  await expect(form).toContainText('Counts to 0.')
  await form.getByRole('textbox', { name: 'How many' }).fill('')
  await expect(form).toContainText('Counts to nothing.')
  await form.getByRole('textbox', { name: 'How many' }).fill('5')
  await form.getByRole('button', { name: 'Count', exact: true }).click()
  await expect(toasts(page)).toContainText('Count: blue-widget')

  // A choice of nothing can't be made.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Pick an alias…')
  await expect(form).toContainText('There’s nothing to choose from.')
  await expect(form.getByRole('button', { name: 'Pick an alias' })).toBeDisabled()
  await form.getByRole('button', { name: 'Cancel' }).click()

  // What it creates is shown first, named as the API server would, and opened afterwards.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Clone…')
  await expect(form).toContainText(/Creates Widget blue-widget-copy-\w{5}/)
  await expect(form.getByRole('code').last()).toContainText(
    /kubectl create -f blue-widget-copy-\w{5}\.yaml -n default/,
  )
  await expect(form.getByLabel('Widget to create')).toContainText('color: blue')
  await expect(form.getByLabel('Widget to create')).not.toContainText('note')
  await form.getByRole('button', { name: 'Clone', exact: true }).click()
  await expect(toasts(page)).toContainText('Cloned blue-widget')
  const created = writes(clusters.demo, 'POST', '/apis/example.com/v1/namespaces/default/widgets')
  const clone = created.at(-1)!.body
  expect(clone).toMatchObject({
    metadata: {
      name: expect.stringMatching(/^blue-widget-copy-\w{5}$/),
      namespace: 'default',
      // (Resized to 4 above.)
      labels: { 'app.kubernetes.io/name': 'widgets', size: '4' },
    },
  })
  expect(clone.spec).toEqual({
    size: 4,
    color: 'blue',
    aliases: ['bw', 'blu'],
    parts: [
      { name: 'bolt', count: 4, spare: false },
      { name: 'gear', count: 2, spare: true },
    ],
    shade: 'plain',
    tint: 'blue',
    copied: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    tags: ['copy'],
  })
  await toasts(page).getByRole('button', { name: 'Open' }).first().click()
  await expect(page.getByRole('complementary', { name: /^Widget blue-widget-copy-/ })).toBeVisible()
  await page.goBack()

  // Elsewhere when it says so, and nowhere for kinds without namespaces.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Copy to shop…')
  await form.getByRole('button', { name: 'Copy to shop', exact: true }).click()
  await expect(toasts(page)).toContainText('Copy to shop: blue-widget')
  expect(
    writes(clusters.demo, 'POST', '/apis/example.com/v1/namespaces/shop/widgets'),
  ).toHaveLength(1)
  await menuAction(page, 'Widget', CUSTOM.widget, 'Give it a namespace…')
  await form.getByRole('button', { name: 'Give it a namespace', exact: true }).click()
  await expect(toasts(page)).toContainText('Give it a namespace: blue-widget')
  expect(writes(clusters.demo, 'POST', '/api/v1/namespaces').at(-1)!.body).toMatchObject({
    metadata: { name: 'blue-widget-ns' },
  })

  // A kind the cluster doesn't serve can't be created: the dialog says why.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Make a thing…')
  await form.getByRole('button', { name: 'Make a thing', exact: true }).click()
  await expect(form.getByRole('alert')).toBeVisible()
})

test('add-ons of your own, and ones that replace KubeStacks’', async ({ kubestacks }) => {
  const { page, userDataDir } = kubestacks
  await writeViews(userDataDir, {
    'add-ons.yaml': `
apiVersion: kubestacks.dev/v1alpha1
kind: AddOn
metadata: { name: flux }
spec:
  label: GitOps
  icon: git-branch
  kinds:
    - { group: kustomize.toolkit.fluxcd.io, kind: Kustomization }
---
apiVersion: kubestacks.dev/v1alpha1
kind: AddOn
metadata: { name: toys }
spec:
  label: Toys
  category: config
  kinds:
    - { group: example.com, kind: Widget }
    - { group: example.com, kind: Database }
`,
    // A view for every kind of a group.
    'example.yaml': `
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata: { name: everything-example }
spec:
  kinds:
    - { group: example.com, kind: '*' }
  columns:
    - { name: Made of, path: .spec.engine }
`,
  })
  await openCluster(page)
  const nav = sidebar(page)
  await expect(nav.getByRole('link', { name: 'GitOps', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Flux', exact: true })).toHaveCount(0)
  // One that says where it goes sits there, with the custom resources' icon if it has none.
  const links = await nav.getByRole('link').allTextContents()
  expect(links.findIndex((text) => text.trim() === 'Toys')).toBe(
    // (Kubernetes' own kinds' links end with their shortcut.)
    links.findIndex((text) => text.trim().startsWith('Secrets')) + 1,
  )
  await nav.getByRole('link', { name: 'Toys', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Toys')
  await expect(page.getByRole('navigation', { name: 'Toys' })).toContainText('AllWidgets')
  await page
    .getByRole('navigation', { name: 'Toys' })
    .getByRole('link', { name: /^Databases/ })
    .click()
  await expect(
    page.getByRole('grid', { name: 'Databases' }).getByRole('columnheader', { name: 'Made of' }),
  ).toBeVisible()
  await nav.getByRole('link', { name: 'GitOps', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'GitOps' })).toContainText('AllKustomizations3')
  await expect(page.getByRole('navigation', { name: 'GitOps' })).not.toContainText('HelmReleases')
})
