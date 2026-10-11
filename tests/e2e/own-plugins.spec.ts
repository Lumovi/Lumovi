import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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

/** A plugin of one view, of widgets, that reads fields every way a path can. */
const WIDGETS = String.raw`
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata:
  name: my-widgets
spec:
  views:
    - name: widgets
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

/** Its view of certificates is used before Lumovi's own. */
const CERTIFICATES = `
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata:
  name: plain
spec:
  views:
    - name: plain-certificates
      kinds:
        - { group: cert-manager.io, kind: Certificate }
      columns:
        - { name: Common name, path: .spec.commonName, default: none }
    # A kind in the core group: no group to name.
    - kinds:
        - { kind: Endpoints }
      columns:
        - { name: Address, path: '.subsets[0].addresses[0].ip', default: none }
`

/** Files that aren't a plugin, each for its own reason: none is used, and each reason is said. */
const NOT_PLUGINS: Record<string, string> = {
  'not-a-plugin.yaml': 'apiVersion: v1\nkind: ConfigMap\n',
  'nameless.yaml': 'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: {}\n',
  'specless.yaml': 'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: specless }\n',
  'unclosed.yaml': 'spec: [unclosed\n',
  'empty.yaml': '---\n',
  'not-a-map.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: not-a-map }\nspec: [1]\n',
  // A view by itself goes inside a plugin; and a file is one plugin.
  'a-view.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: View\nmetadata: { name: alone }\nspec: { kinds: [{ group: example.com, kind: Widget }] }\n',
  'two.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: one }\nspec: { views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n---\napiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: two }\nspec: { views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  // It reads as YAML, and only making its object finds that its alias names nothing set before it.
  'forward.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: *later }\nspec: { label: &later Later }\n',
  'nothing.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: nothing }\nspec: {}\n',
  'unlabelled.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: unlabelled }\nspec: { kinds: [{ group: example.com, kind: Gadget }] }\n',
  'placeless.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: placeless }\nspec: { label: No kinds, views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'pods-too.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: pods-too }\nspec:\n  label: Pods too\n  kinds: [{ kind: Pod }]\n',
  // One of Lumovi's by name, which it would have replaced.
  'my-flux.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: flux }\nspec: { label: My Flux }\n',
  'messy.yaml':
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: messy }\nspec:\n  label: Messy\n  category: workloads\n  colour: blue\n  kinds: []\n  views: notalist\n',
}

/** Everything that can be wrong with a plugin's views: all of it is said, and none of it is used. */
const BROKEN = `
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata: { name: everything-wrong }
spec:
  views:
    - kinds: []
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
    - kinds: [{ group: example.com, kind: Gadget }, { kind: '*' }]
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
`

test('plugins of your own: their views are used before Lumovi’s, and what’s wrong with one is shown', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(join(plugins, 'a-folder.yaml'), { recursive: true })
  writeFileSync(join(plugins, 'widgets.yaml'), WIDGETS)
  writeFileSync(join(plugins, 'certificates.yml'), CERTIFICATES)
  writeFileSync(join(plugins, 'broken.yaml'), BROKEN)
  for (const [name, text] of Object.entries(NOT_PLUGINS)) writeFileSync(join(plugins, name), text)
  writeFileSync(join(plugins, 'huge.yaml'), `# ${'x'.repeat(300 * 1024)}\n`)
  writeFileSync(join(plugins, 'notes.txt'), 'not a plugin')
  await openCluster(page)

  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  const problems = page.getByRole('list', { name: 'Plugin problems' })
  for (const problem of [
    // One file a reason: each is said with its file, and none of them is used.
    'not-a-plugin.yaml: should start with apiVersion: lumovi.dev/v1alpha1 and kind: Plugin',
    'nameless.yaml: needs metadata.name',
    'specless.yaml: needs spec',
    'unclosed.yaml: ',
    'not-a-map.yaml: spec: should be a map of fields, not a list',
    'a-view.yaml: a view goes inside a plugin: start with kind: Plugin and put this under its views.',
    'two.yaml: holds 2 documents, and a file is one plugin',
    // (Read like any other bad file: it doesn't stop the others being read.)
    'forward.yaml: Unresolved alias (the anchor must be set before the alias): later',
    'nothing.yaml: spec: needs views, or kinds for a place in the sidebar',
    'unlabelled.yaml: spec: needs a label for its place in the sidebar',
    'placeless.yaml: spec: a label, an icon or a category is for a place in the sidebar, and that needs kinds',
    'pods-too.yaml: spec: Pod has a page of its own, so it can’t be in a plugin',
    'messy.yaml: spec.category: should be one of cluster, network, config, storage, not "workloads"',
    'messy.yaml: spec.colour: isn’t something a plugin has',
    'messy.yaml: spec.kinds: should not be empty',
    'messy.yaml: spec.views: should be a list, not a string',
    'huge.yaml: It’s larger than 256 KB.',
    // Lumovi's of that name stays, and that's said: theirs isn't what they're looking at.
    'my-flux.yaml: spec: a label, an icon or a category is for a place in the sidebar, and that needs kinds',
    'my-flux.yaml: isn’t in use, so Lumovi’s Flux is shown instead',
    // Everything wrong in one plugin's views is said, each in its place.
    'broken.yaml: spec.views[0].kinds: should not be empty',
    'spec.views[0].icon: should be one of activity, archive',
    'spec.views[0].colums: isn’t something a view has',
    'spec.views[0].columns[0].path: “spec.a” should start with a dot, like .spec.replicas',
    'spec.views[0].columns[1].path: “.spec..b” has an empty field name',
    'spec.views[0].columns[2].path: “.spec[0]x” has “x” where a . or [ should be',
    'spec.views[0].columns[3].path: “.spec[0” has a [ without its ]',
    'spec.views[0].columns[4].path: “.spec[foo]” has [foo], which isn’t an index, a key or a filter',
    'spec.views[0].columns[5].path: “.spec[?(x==1)]”: a filter compares a field of each item, like @.type',
    'spec.views[0].columns[6].path: “.spec[?(@.x==bare)]” compares with bare, which isn’t a value',
    'spec.views[0].columns[7].path: “.spec[?(@.x==)]” compares with nothing, which isn’t a value',
    'spec.views[0].columns[8].path: should be text, not a number',
    'spec.views[0].columns[9].type: should be one of string, number, date, boolean, count, not "list"',
    'spec.views[0].columns[10].name: is required',
    'spec.views[0].status[0].when.all: should not be empty',
    'spec.views[0].status[0].health: should be one of healthy, progressing, warning, critical, neutral',
    'spec.views[0].status[0].label: “nope” should start with a dot',
    'spec.views[0].status[1].when: needs exactly one of path, all or any',
    'spec.views[0].status[2].label: {{ .a b c }} should be a path, maybe with ?? "a fallback"',
    'spec.views[0].status[3].label: “.b[” has a [ without its ]',
    'spec.views[0].status[4].when.matches: Invalid regular expression',
    'spec.views[0].status[5].when.equals: should be a single value, not an object',
    'spec.views[0].status[6].when.exists: should be true or false, not a string',
    'spec.views[0].status[7].when.in: should be a list, not a number',
    'spec.views[0].status[8].when: should be a map of fields, not null',
    'spec.views[0].details: should be a list, not a string',
    'spec.views[0].links[0].name: is required',
    'spec.views[0].links[0].objectName: is required',
    'spec.views[0].actions[0].patch: should be a patch (an object or a list), not a string',
    'spec.views[0].actions[1]: patches are an object for type merge, and a list for type json',
    'spec.views[0].actions[2]: patches are an object for type merge, and a list for type json',
    'broken.yaml: spec.views[1].kinds[1]: every kind (*) is of a group: name it',
    'broken.yaml: spec.views[1].related[0]: needs labels or a fieldSelector to find them',
    'spec.views[1].related[1].labels: should be a map of fields, not a list',
    'spec.views[1].related[2].labels.a: should be text, not a number',
    'spec.views[1].actions[0]: needs a patch, or an object to create (not both)',
    'spec.views[1].actions[1]: needs a patch, or an object to create (not both)',
    'spec.views[1].actions[2]: what it creates needs an apiVersion, a kind, and a metadata.name or generateName',
    'spec.views[1].actions[3]: what it creates needs an apiVersion',
    'spec.views[1].actions[4]: can’t undo creating something',
    'spec.views[1].actions[5]: {{ input.missing }} isn’t one of its inputs',
    'spec.views[1].actions[6].inputs: should not be empty',
    'spec.views[1].actions[7].inputs[0]: "two words" should be letters, digits and _, like replicas',
    'spec.views[1].actions[7].inputs[1]: a choice needs options, or a path to read them from',
    'spec.views[1].actions[7].inputs[2]: only a choice has options',
    'spec.views[1].actions[7].inputs[3]: a choice needs options, or a path to read them from',
  ]) {
    await expect(problems).toContainText(problem)
  }
  // (An empty file is nothing, and says nothing. Lumovi's own views of Kubernetes' kinds are
  // no plugin: its 32 are counted, and the two of these that could be used.)
  await expect(problems).not.toContainText('empty.yaml')
  await expect(page.getByText('32 plugins from Lumovi, 2 of yours.')).toBeVisible()
  // (Where temporary folders are in the home folder, as on Windows, it's shown from ~.)
  await expect(page.getByText(/lumovi-user-\w+[\\/]plugins/)).toBeVisible()
  const custom = page.getByRole('region', { name: 'Custom resources' })
  await expect(custom.getByRole('row').filter({ hasText: 'Widgets' })).toContainText('widgets.yaml')
  await expect(custom.getByRole('row').filter({ hasText: 'Certificates' })).toContainText(
    'certificates.yml',
  )
  await expect(
    page
      .getByRole('region', { name: 'Kubernetes' })
      .getByRole('row')
      .filter({ hasText: 'Endpoints' }),
  ).toContainText('certificates.yml')

  // A view in a plugin of one's own is used before Lumovi's.
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

test('plugins live in ~/.lumovi/plugins unless LUMOVI_PLUGINS_DIR says otherwise', async ({
  launch,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'lumovi-home-'))
  mkdirSync(join(home, '.lumovi', 'plugins'), { recursive: true })
  writeFileSync(join(home, '.lumovi', 'plugins', 'mine.yaml'), 'apiVersion: v1\nkind: Pod\n')
  const { app, page } = await launch({
    env: { LUMOVI_PLUGINS_DIR: undefined, HOME: home, USERPROFILE: home },
  })
  const opened = await mockOpenExternal(app)
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  // Shown from the home folder, as ~.
  await expect(page.getByText(join('~', '.lumovi', 'plugins'))).toBeVisible()
  // Only the user's file has something wrong with it, not Lumovi's own. And what's counted is
  // Lumovi's 32: not the file that couldn't be used, nor Lumovi's own views of Kubernetes' kinds,
  // which are no plugin.
  await expect(page.getByRole('alert')).toContainText('A plugin couldn’t be used')
  await expect(
    page.getByRole('list', { name: 'Plugin problems' }).getByRole('listitem'),
  ).toHaveText(['mine.yaml: should start with apiVersion: lumovi.dev/v1alpha1 and kind: Plugin'])
  await expect(page.getByText('32 plugins from Lumovi. Yours go in')).toBeVisible()
  // A plugin of theirs named as one of Lumovi's, with something wrong with it (here, a spec
  // that's no map): Lumovi's stays in use, which is said after its problem and isn't counted
  // as one more.
  writeFileSync(
    join(home, '.lumovi', 'plugins', 'my-flux.yaml'),
    'apiVersion: lumovi.dev/v1alpha1\nkind: Plugin\nmetadata: { name: flux }\nspec: [1]\n',
  )
  // And one with a name longer than its column: cut in its middle, since its end is what tells
  // two files apart, and whole on hover.
  const long = 'the-widgets-of-the-platform-team-as-we-like-to-see-them.yaml'
  writeFileSync(join(home, '.lumovi', 'plugins', long), WIDGETS)
  await page.reload()
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByTitle(long).locator('[aria-hidden]')).toHaveText(
    /^the-widgets-of-\S+…m\.yaml$/,
  )
  await expect(page.getByRole('alert')).toContainText('2 problems with plugins')
  await expect(
    page.getByRole('list', { name: 'Plugin problems' }).getByRole('listitem'),
  ).toHaveText([
    'mine.yaml: should start with apiVersion: lumovi.dev/v1alpha1 and kind: Plugin',
    'my-flux.yaml: spec: should be a map of fields, not a list',
    'my-flux.yaml: isn’t in use, so Lumovi’s Flux is shown instead',
  ])
  await page.getByRole('button', { name: 'How to write a plugin' }).click()
  await expect.poll(opened).toEqual(['https://docs.lumovi.dev/custom-resources/write-a-plugin'])

  // Whatever a file turns out to hold, it's that file's problem and never the others': here one
  // comes as no text at all, which reading it as YAML can't take, and the next is still used.
  await app.evaluate(({ ipcMain }, widgets) => {
    ipcMain.removeHandler('app:plugins')
    ipcMain.handle('app:plugins', () => ({
      directory: '/somewhere',
      files: [
        { name: 'odd.yaml', text: 5 },
        { name: 'widgets.yaml', text: widgets },
      ],
    }))
  }, WIDGETS)
  await page.reload()
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(
    page.getByRole('list', { name: 'Plugin problems' }).getByRole('listitem'),
  ).toHaveText(['odd.yaml: It couldn’t be read: source is not a string'])
  await expect(page.getByText('32 plugins from Lumovi, 1 of yours.')).toBeVisible()
})

test('plugins a ConfigMap mounts, as links into a folder of its own', async ({ lumovi }) => {
  test.skip(process.platform === 'win32', 'Making links on Windows takes a privilege')
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  // As Kubernetes mounts a ConfigMap: each file is a link into ..data, a link to the latest copy.
  const copy = '..2026_10_04_12_00_00.000000001'
  mkdirSync(join(plugins, copy), { recursive: true })
  writeFileSync(join(plugins, copy, 'widgets.yaml'), WIDGETS)
  symlinkSync(copy, join(plugins, '..data'))
  symlinkSync(join('..data', 'widgets.yaml'), join(plugins, 'widgets.yaml'))
  // A link to nothing is a problem of its own; the others still load.
  symlinkSync('nowhere.yaml', join(plugins, 'gone.yaml'))
  await openCluster(page)

  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(
    page.getByRole('list', { name: 'Plugin problems' }).getByRole('listitem'),
  ).toHaveText([/^gone\.yaml: It couldn’t be read: ENOENT/])
  const custom = page.getByRole('region', { name: 'Custom resources' })
  await expect(custom.getByRole('row').filter({ hasText: 'Widgets' })).toContainText('widgets.yaml')
})

/** Widgets related to what they need, and actions that ask first or make something new. */
const WORKSHOP = String.raw`
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata:
  name: workshop
spec:
  views:
    - name: widget-workshop
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
    # Cluster-wide issuers, related to pods in every namespace.
    - name: issuers-and-pods
      kinds:
        - { group: cert-manager.io, kind: ClusterIssuer }
      related:
        - name: Storefront pods
          kind: Pod
          labels: { app.kubernetes.io/name: storefront }
`

async function writePlugins(userDataDir: string, files: Record<string, string>) {
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(plugins, name), text)
}

test('related objects: a tab each, and pods with their logs and usage', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  await writePlugins(userDataDir, { 'workshop.yaml': WORKSHOP })
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
    'Audit',
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
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  await writePlugins(userDataDir, { 'workshop.yaml': WORKSHOP })
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

test('plugins of your own, and ones that replace Lumovi’s', async ({ lumovi }) => {
  const { page, userDataDir } = lumovi
  await writePlugins(userDataDir, {
    // One named as Lumovi's is: its place in the sidebar is used in place of Lumovi's.
    'flux.yaml': `
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata: { name: flux }
spec:
  label: GitOps
  icon: git-branch
  kinds:
    - { group: kustomize.toolkit.fluxcd.io, kind: Kustomization }
`,
    // One with a place of its own, and a view for every kind of a group.
    'toys.yaml': `
apiVersion: lumovi.dev/v1alpha1
kind: Plugin
metadata: { name: toys }
spec:
  label: Toys
  category: config
  kinds:
    - { group: example.com, kind: Widget }
    - { group: example.com, kind: Database }
  views:
    - kinds:
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
