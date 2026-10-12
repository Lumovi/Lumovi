import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { isCustomGroup } from '../../src/shared/resources.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { dialog, menuAction, toasts, writes } from './action-helpers.ts'
import { expect, mockOpenExternal, openCluster, panel, row, rows, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

/** The page of every plugin: what's in use, what isn't and why. */
async function allPlugins(page: Page) {
  await sidebar(page).getByRole('link', { name: 'All plugins' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plugins')
}

/** What that page says is wrong, as lines "file: problem", each file's under its own row. */
function problemLines(page: Page): Promise<string[]> {
  return page.getByRole('list', { name: /^Problems with / }).evaluateAll((lists) =>
    lists.flatMap((list) => {
      const file = list.getAttribute('aria-label')!.slice('Problems with '.length)
      return [...list.querySelectorAll('li')].map((line) => `${file}: ${line.textContent}`)
    }),
  )
}

/** That the page says `problem` (a line "file: problem", or a part of one). */
async function expectProblem(page: Page, problem: string) {
  await expect
    .poll(async () => (await problemLines(page)).join('\n'), { message: problem })
    .toContain(problem)
}

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
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: my-widgets
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
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
          runs: at-once
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
          runs: at-once
          when: { path: .spec.size, exists: true }
          patch:
            metadata:
              annotations: { example.com/stamped: '{{ now }}' }
`

/**
 * Named as one of Lumovi's plugins, it's in that plugin's place, all of it. And it shows a kind
 * of Kubernetes' own that Lumovi has no page for, which it says it does.
 */
const CERTIFICATES = `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: cert-manager
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [cert-manager.io]
  shows: [{ kind: Endpoints }]
  views:
    - name: plain-certificates
      kinds:
        - { group: cert-manager.io, kind: Certificate }
      columns:
        - { name: Common name, path: .spec.commonName, default: none }
    # A kind in the core group: no group to name, and nothing but showing it.
    - kinds:
        - { kind: Endpoints }
      columns:
        - { name: Address, path: '.subsets[0].addresses[0].ip', default: none }
`

/** Files that aren't a plugin, each for its own reason: none is used, and each reason is said. */
const NOT_PLUGINS: Record<string, string> = {
  'not-a-plugin.yaml': 'apiVersion: v1\nkind: ConfigMap\n',
  'nameless.yaml': 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: {}\n',
  'specless.yaml': 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: specless }\n',
  'unclosed.yaml': 'spec: [unclosed\n',
  'empty.yaml': '---\n',
  'not-a-map.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: not-a-map }\nspec: [1]\n',
  // A view by itself goes inside a plugin; and a file is one plugin.
  'a-view.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: View\nmetadata: { name: alone }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, kinds: [{ group: example.com, kind: Widget }] }\n',
  'two.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: one }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n---\napiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: two }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  // It reads as YAML, and only making its object finds that its alias names nothing set before it.
  'forward.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: *later }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, label: &later Later }\n',
  'nothing.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: nothing }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, groups: [example.com] }\n',
  'unlabelled.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: unlabelled }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, kinds: [{ group: example.com, kind: Gadget }] }\n',
  'placeless.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: placeless }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, label: No kinds, views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'pods-too.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: pods-too }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  label: Pods too\n  kinds: [{ kind: Pod }]\n',
  // One of Lumovi's by name, which it would have replaced.
  'my-flux.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: flux }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, label: My Flux }\n',
  'messy.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: messy }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  label: Messy\n  category: workloads\n  colour: blue\n  kinds: []\n  views: notalist\n',
}

/** Everything that can be wrong with a plugin's views: all of it is said, and none of it is used. */
/** The tools' groups a view's text names, with example.com: what a plugin of it declares. */
const groupsIn = (view: string) =>
  [
    ...new Set([
      'example.com',
      ...[...view.matchAll(/group: ([\w.-]+)/g)].map(([, group]) => group!).filter(isCustomGroup),
    ]),
  ].join(', ')

/**
 * A plugin of one view of `kind`, of example.com, with whatever else `spec` says; its groups
 * are the ones its views name, unless `spec` says something of groups itself.
 */
const plugin = (name: string, kind: string, spec = '', view = '') => `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: ${JSON.stringify(name)} }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
${spec.includes('groups') ? '' : `  groups: [${groupsIn(view)}]\n`}${spec}  views:
    - kinds: [{ group: example.com, kind: ${kind} }]
${view}`

/** What a plugin's file must say of itself, and may not say: one file a reason. */
const NOT_THE_FORMAT: Record<string, string> = {
  'shouting.yaml': plugin('My Flux', 'Gadget'),
  'trailing.yaml': plugin('flux-', 'Gadget'),
  // A key nobody knows is refused wherever a file has keys: beside its start, under its
  // metadata, and by the names every object answers to.
  'coded.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\ncode: x\nmetadata: { name: coded, origin: lumovi }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0, toString: x }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }], constructor: x }] }\n',
  // What a file says is quoted back cut short, and with nothing in it that can't be seen: a
  // name's end kept, and the file's own name as plain as what's in it.
  'long-winded.yaml': plugin(`Shouting-${'a'.repeat(60)}-to-the-end`, 'Gadget'),
  'back\u202Ewards.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: fine }\nspec: { version: "1.0\u202E", needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'lumovi.yaml': plugin('lumovi', 'Gadget'),
  'lumovi-tools.yaml': plugin('lumovi-tools', 'Gadget'),
  'kubernetes.yaml': plugin('kubernetes', 'Gadget'),
  'unversioned.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: unversioned }\nspec: { groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'two-numbers.yaml':
    "apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: two-numbers }\nspec: { version: '1.0', needs: { lumovi: '1.22' }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n",
  'zeros.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: zeros }\nspec: { version: 01.2.3, needs: { lumovi: 1.0.123456 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  // (YAML reads this version as the number 1: the line says what was written.)
  'a-number.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: a-number }\nspec: { version: 1.0, needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'needy.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: needy }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0, door: 1 }, groups: nope, shows: nope, views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  'too-new.yaml':
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: too-new }\nspec: { version: 1.0.0, needs: { lumovi: 99.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Gadget }] }] }\n',
  // Groups that are nobody's to declare, in a file that isn't held to its groups either.
  'grabby.yaml': plugin(
    'grabby',
    'Gadget',
    // (And add-ons' groups that sit under k8s.io, which are a plugin's to have as any other.)
    "  groups: [example.com, apps, '', lumovi.dev, plugins.lumovi.dev, kubernetes.io, node.kubernetes.io, k8s.io, gateway.networking.k8s.io, autoscaling.k8s.io, snapshot.storage.k8s.io, cluster.x-k8s.io]\n",
  ),
  'twice.yaml': plugin(
    'twice',
    'Gadget',
    '',
    '    - kinds: [{ group: example.com, kind: Other }, { group: example.com, kind: Gadget }]\n',
  ),
  // What's the cluster's to set, or an owner's: in a patch of either kind, its undo, and a new object.
  'guarded.yaml': plugin(
    'guarded',
    'Gadget',
    '',
    `      actions:
        - name: Unhook
          confirm: Sure?
          patch: { metadata: { finalizers: null } }
        - name: Adopt
          confirm: Sure?
          type: json
          patch: [{ op: add, path: /metadata/ownerReferences/0, value: {} }]
        - name: Move
          confirm: Sure?
          patch: { spec: { size: 1 } }
          undo: { metadata: { namespace: elsewhere } }
        - name: Spawn
          create:
            apiVersion: example.com/v1
            kind: Gadget
            metadata: { generateName: gadget-, ownerReferences: [] }
        - name: Rename
          confirm: Sure?
          type: json
          patch: [{ op: replace, path: /metadata/name, value: other }, { op: test }, null]
        - name: Approve
          confirm: Sure?
          subresource: approval
          patch: { status: {} }
        - name: Copy
          confirm: Sure?
          patch: { metadata: '{{ .spec.template.metadata }}' }
        - name: Clone
          create:
            apiVersion: example.com/v1
            kind: Gadget
            metadata: '{{ .spec.template.metadata }}'
        - name: Aim
          inputs: [{ name: what, label: What }]
          type: json
          patch: [{ op: remove, path: '/metadata/{{ input.what }}' }]
        - name: Carry
          confirm: Sure?
          type: json
          patch: [{ op: move, from: '/spec/{{ .spec.from }}', path: /spec/to }]
        - name: Wipe
          confirm: Sure?
          type: json
          patch: [{ op: replace, path: /metadata, value: {} }]
        - name: Swap
          confirm: Sure?
          type: json
          patch: [{ op: replace, path: '', value: {} }]
        - name: Label
          confirm: Sure?
          type: json
          patch: [{ op: add, path: /metadata/labels/tier, value: '{{ .spec.tier }}' }]
        - name: Whatever
          confirm: Sure?
          type: json
          patch: ['{{ .spec.op }}']
        - name: Back
          confirm: Sure?
          type: json
          patch: [{ op: add, path: /spec/a, value: 1 }]
          undo: [{ op: remove }]
        - name: Odd
          create: { apiVersion: example.com/v1, kind: Gadget, metadata: { name: { a: 1 } } }
`,
  ),
  'texts.yaml': plugin(
    'texts',
    'Gadget',
    '',
    `      columns:
        - { name: ${'n'.repeat(81)}, path: .spec.a }
        - { name: "back\\u202Ewards", path: .spec.b }
        - { name: "two\\nlines", path: .spec.c }
      status:
        - { health: healthy, label: "{{ .a }}${'l'.repeat(500)}", detail: "bell\\u0007" }
        - { health: healthy, label: fine, detail: ${'d'.repeat(501)} }
        - { health: healthy, label: "blank\u3164filler" }
        - { health: healthy, label: "a\u2028break" }
      related:
        - { name: Pods, kind: Pod, labels: { "ti\u200Ber": front } }
      actions:
        - name: Note
          confirm: Sure?
          patch: { metadata: { annotations: { name: ${'n'.repeat(200)}, note: "tag\\U000E0041ged" } } }
`,
  ),
  'hurried.yaml': plugin(
    'hurried',
    'Gadget',
    '',
    `      actions:
        - name: Ask
          runs: at-once
          confirm: Sure?
          patch: { spec: { size: 1 } }
        - name: Go
          patch: { spec: { size: 1 } }
        - name: Somehow
          runs: sometimes
          patch: { spec: { size: 1 } }
`,
  ),
}

/**
 * Kubernetes' own kinds: one that Lumovi has no page for can be shown, and only shown, by a
 * plugin that says it does; nothing else of Kubernetes' is a plugin's.
 */
const KUBERNETES: Record<string, string> = {
  // (It calls every one of them critical: said in its own list, and counted nowhere.)
  'limits.yaml': plugin(
    'limits',
    'LimitsUnused',
    '  shows: [{ kind: LimitRange }]\n',
    `    - kinds: [{ kind: LimitRange }]
      columns: [{ name: Limits, path: '.spec.limits[*].type' }]
      status: [{ health: critical, label: Too tight }]
`,
  ),
  'acts.yaml': plugin(
    'acts',
    'ActsUnused',
    '  shows: [{ kind: LimitRange }]\n',
    `    - kinds: [{ kind: LimitRange }]
      actions:
        - name: Loosen
          confirm: Sure?
          patch: { spec: { limits: [] } }
`,
  ),
  'unsaid.yaml': plugin('unsaid', 'UnsaidUnused', '', '    - kinds: [{ kind: LimitRange }]\n'),
  'paged.yaml': plugin(
    'paged',
    'PagedUnused',
    '',
    '    - kinds: [{ kind: Pod }, { group: apiextensions.k8s.io, kind: CustomResourceDefinition }]\n',
  ),
  'shows-wrong.yaml': plugin(
    'shows-wrong',
    'ShowsUnused',
    '  shows: [{ kind: Pod }, { group: example.com, kind: Widget }, { group: apiextensions.k8s.io, kind: CustomResourceDefinition }, { kind: LimitRange }]\n  label: Shows\n  kinds: [{ kind: LimitRange }]\n',
  ),
  // A replacement that can't be used itself: Lumovi's stays, and what would have lost to the
  // replacement is judged without it.
  'j-keda.yaml': plugin(
    'keda',
    'JKedaUnused',
    '',
    '    - kinds: [{ group: keda.sh, kind: ScaledObject }, { group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]\n',
  ),
  'k-scalers.yaml': plugin(
    'scalers',
    'JKedaUnused',
    '',
    '    - kinds: [{ group: keda.sh, kind: ScaledObject }]\n',
  ),
  // A kind's name is its own: with its group in it and none beside it, it would be taken for a
  // kind of Kubernetes' and walk out of the plugin's groups.
  'dotted.yaml': plugin(
    'dotted',
    'DottedUnused',
    "  shows: [{ kind: Certificate.cert-manager.io }, { kind: '*.coordination.k8s.io' }, { kind: pod }, { group: coordination.k8s.io, kind: '*' }]\n  label: Dotted\n  kinds: [{ kind: Deployment.apps }]\n",
    `    - kinds: [{ kind: Certificate.cert-manager.io }, { group: example.com, kind: '*.example.com' }]
      actions:
        - name: Make
          create: { apiVersion: v1, kind: Widget.example.com, metadata: { generateName: w- } }
`,
  ),
  // Nor does a group's name hide another: it's a group's name and nothing more.
  'slashed.yaml': plugin(
    'slashed',
    'SlashedUnused',
    "  groups: [example.com, apps/x, APPS, 'apps.']\n  shows: [{ group: batch/, kind: Job }]\n",
    `    - kinds: [{ group: apps/x, kind: Deployment }, { group: /, kind: Pod }]
      actions:
        - name: Make
          create: { apiVersion: apps/x/v1, kind: Deployment, metadata: { generateName: d- } }
        - name: Make another
          create: { apiVersion: Example.com/v1, kind: SlashedUnused, metadata: { generateName: s- } }
`,
  ),
  // What one of Lumovi's plugins shows is that plugin's, under any other name.
  'my-kustomizations.yaml': plugin(
    'my-kustomizations',
    'KustomUnused',
    '',
    '    - kinds: [{ group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]\n',
  ),
  'my-rules.yaml': plugin(
    'my-rules',
    'RulesUnused',
    '',
    '    - kinds: [{ group: constraints.gatekeeper.sh, kind: K8sRequiredLabels }]\n',
  ),
}

/** Plugins that are fine by themselves, and not beside each other: the first by file name is used. */
const BESIDE: Record<string, string> = {
  'a-twin.yaml': plugin('twin', 'Twin'),
  'b-twin.yaml': plugin('twin', 'Triplet'),
  'c-gadgets.yaml': plugin('gadgets', 'Gadget'),
  'd-gadgets.yaml': plugin('more-gadgets', 'Gadget'),
  // Every kind of a group is the whole group: nobody else's after, and not to be had after another.
  'e-moons.yaml': plugin(
    'moons',
    'Unused',
    '',
    "    - kinds: [{ group: moons.example.com, kind: '*' }]\n",
  ),
  'f-moon.yaml': plugin(
    'one-moon',
    'Unused2',
    '',
    '    - kinds: [{ group: moons.example.com, kind: Moon }]\n',
  ),
  'g-star.yaml': plugin(
    'one-star',
    'Unused3',
    '',
    '    - kinds: [{ group: stars.example.com, kind: Star }]\n',
  ),
  'h-stars.yaml': plugin(
    'stars',
    'Unused4',
    '',
    "    - kinds: [{ group: stars.example.com, kind: '*' }]\n",
  ),
}

const BROKEN = `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: everything-wrong }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
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
  for (const [name, text] of Object.entries({
    ...NOT_PLUGINS,
    ...NOT_THE_FORMAT,
    ...KUBERNETES,
    ...BESIDE,
  })) {
    writeFileSync(join(plugins, name), text)
  }
  writeFileSync(join(plugins, 'huge.yaml'), `# ${'x'.repeat(300 * 1024)}\n`)
  writeFileSync(join(plugins, 'notes.txt'), 'not a plugin')
  await openCluster(page)

  await allPlugins(page)
  for (const problem of [
    // One file a reason: each is said with its file, and none of them is used.
    'not-a-plugin.yaml: should start with apiVersion: lumovi.dev/v1beta1 and kind: Plugin',
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
    // What a plugin says of itself: its name, its version, what it needs.
    'shouting.yaml: metadata.name: "My Flux" should be lowercase letters, digits and hyphens, starting with a letter and ending with a letter or a digit, at most 63 characters',
    'trailing.yaml: metadata.name: "flux-" should be lowercase letters',
    'coded.yaml: code: isn’t something a plugin has',
    'coded.yaml: metadata.origin: isn’t something a plugin has',
    'coded.yaml: spec.needs.toString: isn’t something a plugin has',
    'coded.yaml: spec.views[0].constructor: isn’t something a view has',
    'long-winded.yaml: metadata.name: "Shouting-aaaaaaaaaaaaaaaaaaaaaaaa…he-end" should be lowercase letters',
    'backU+202Ewards.yaml: spec.version: "1.0U+202E" should be three numbers, like 1.0.0',
    'lumovi.yaml: metadata.name: "lumovi" is Lumovi’s own name, which a plugin can’t have',
    'lumovi-tools.yaml: metadata.name: "lumovi-tools" starts with Lumovi’s own name, which a plugin can’t have',
    'kubernetes.yaml: metadata.name: "kubernetes" is Kubernetes’ own name, which a plugin can’t have',
    'unversioned.yaml: spec.version: is required',
    'unversioned.yaml: spec.needs.lumovi: is required',
    'two-numbers.yaml: spec.version: "1.0" should be three numbers, like 1.0.0',
    'two-numbers.yaml: spec.needs.lumovi: "1.22" should be three numbers, like 1.22.0',
    'zeros.yaml: spec.version: "01.2.3" should be three numbers, like 1.0.0',
    'zeros.yaml: spec.needs.lumovi: "1.0.123456" should be three numbers, like 1.22.0',
    'a-number.yaml: spec.version: "1.0" should be three numbers, like 1.0.0',
    'needy.yaml: spec.needs.door: isn’t something a plugin has',
    'needy.yaml: spec.groups: should be a list, not a string',
    'too-new.yaml: needs Lumovi 99.0.0 or newer; this is ',
    // Groups nobody may declare.
    'grabby.yaml: spec.groups[1]: apps is Kubernetes’ own, so a plugin can’t have it',
    'grabby.yaml: spec.groups[2]: the core group is Kubernetes’ own, so a plugin can’t have it',
    'grabby.yaml: spec.groups[3]: lumovi.dev is Lumovi’s own, so a plugin can’t have it',
    'grabby.yaml: spec.groups[4]: lumovi.dev is Lumovi’s own, so a plugin can’t have it',
    // Kubernetes' own names, where its labels and annotations live; an add-on's group under
    // k8s.io (the four after them in the file) is refused for nothing.
    'grabby.yaml: spec.groups[5]: kubernetes.io is Kubernetes’ own, so a plugin can’t have it',
    'grabby.yaml: spec.groups[6]: node.kubernetes.io is Kubernetes’ own, so a plugin can’t have it',
    'grabby.yaml: spec.groups[7]: k8s.io is Kubernetes’ own, so a plugin can’t have it',
    'twice.yaml: spec.views[1].kinds[1]: Gadget.example.com is already shown by spec.views[0]',
    // What isn't a plugin's to change.
    'guarded.yaml: spec.views[0].actions[0]: changes metadata.finalizers, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[1]: changes metadata.ownerReferences, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[2]: changes metadata.namespace, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[3]: changes metadata.ownerReferences, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[4]: changes metadata.name, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[5].subresource: should be one of status, not "approval"',
    // Nor can any of it be filled in later, past what the file says: metadata is written out, and
    // so is where an operation changes; and none replaces metadata whole.
    'guarded.yaml: spec.views[0].actions[6]: fills in an object’s metadata whole, which a plugin can’t: write it out',
    'guarded.yaml: spec.views[0].actions[7]: what it creates needs an apiVersion, a kind, and a metadata.name or generateName',
    'guarded.yaml: spec.views[0].actions[8]: fills in where an operation changes, which a plugin can’t: write its path out',
    'guarded.yaml: spec.views[0].actions[9]: fills in where an operation changes, which a plugin can’t: write its path out',
    'guarded.yaml: spec.views[0].actions[10]: replaces all of an object’s metadata, which a plugin can’t change',
    'guarded.yaml: spec.views[0].actions[11]: replaces the object whole, which a plugin can’t',
    // (Nor is an operation itself: one placeholder would be whatever it found.)
    'guarded.yaml: spec.views[0].actions[13]: fills in an operation whole, which a plugin can’t: write it out',
    'guarded.yaml: spec.views[0].actions[14]: needs each operation’s path written out, as text',
    'guarded.yaml: spec.views[0].actions[15]: what it creates needs an apiVersion, a kind, and a metadata.name or generateName',
    // Texts are plain, and names short.
    'texts.yaml: spec.views[0].columns[0].name: is longer than 80 characters',
    'texts.yaml: spec.views[0].columns[1].name: holds a character that can’t be seen (U+202E)',
    'texts.yaml: spec.views[0].columns[2].name: holds a character that isn’t text (U+000A)',
    'texts.yaml: spec.views[0].status[0].label: is longer than 500 characters',
    'texts.yaml: spec.views[0].status[0].detail: holds a character that isn’t text (U+0007)',
    'texts.yaml: spec.views[0].status[1].detail: is longer than 500 characters',
    'texts.yaml: spec.views[0].status[2].label: holds a character that can’t be seen (U+3164)',
    'texts.yaml: spec.views[0].status[3].label: holds a character that can’t be seen (U+2028)',
    // A key is shown as its value is; and what's sent to the cluster is held to its characters,
    // not to a name's length.
    'texts.yaml: spec.views[0].related[0].labels.tiU+200Ber: holds a character that can’t be seen (U+200B)',
    'texts.yaml: spec.views[0].actions[0].patch.metadata.annotations.note: holds a character that can’t be seen (U+E0041)',
    // An action that asks nothing says so, and only such a one.
    'hurried.yaml: spec.views[0].actions[0]: asks first, so it can’t say runs: at-once',
    'hurried.yaml: spec.views[0].actions[1]: runs at once, so it has to say so: runs: at-once',
    'hurried.yaml: spec.views[0].actions[2].runs: should be one of at-once, not "sometimes"',
    // A name is one plugin's, and so is a kind: the first by file name is used.
    // Kubernetes' own kinds: shown only, by a plugin that says so, and never one with a page or
    // one Lumovi itself shows.
    'acts.yaml: spec.views[1].actions: a view of Kubernetes’ own kind only shows it, so it can’t have actions',
    'unsaid.yaml: spec.views[1].kinds[0]: LimitRange is Kubernetes’ own: to show it, name it under spec.shows',
    'paged.yaml: spec.views[1].kinds[0]: Pod has a page of its own, so it can’t be in a plugin',
    'paged.yaml: spec.views[1].kinds[1]: CustomResourceDefinition.apiextensions.k8s.io is shown by Lumovi itself, so it can’t be in a plugin',
    'shows-wrong.yaml: spec.shows[0]: Pod has a page of its own, so it can’t be in a plugin',
    'shows-wrong.yaml: spec.shows[1]: Widget.example.com isn’t Kubernetes’ own: a view names it once example.com is in spec.groups',
    'shows-wrong.yaml: spec.shows[2]: CustomResourceDefinition.apiextensions.k8s.io is shown by Lumovi itself, so it can’t be in a plugin',
    'shows-wrong.yaml: spec.shows[3]: LimitRange isn’t shown by any of its views',
    'shows-wrong.yaml: spec.kinds[0]: LimitRange is Kubernetes’ own, so it can’t be under a plugin’s place in the sidebar',
    'needy.yaml: spec.shows: should be a list, not a string',
    'slashed.yaml: spec.groups[1]: "apps/x" should be an API group’s name, like cert-manager.io',
    'slashed.yaml: spec.groups[2]: "APPS" should be an API group’s name',
    'slashed.yaml: spec.groups[3]: "apps." should be an API group’s name',
    'slashed.yaml: spec.shows[0]: "batch/" should be an API group’s name',
    'slashed.yaml: spec.views[1].kinds[0]: "apps/x" should be an API group’s name',
    'slashed.yaml: spec.views[1].kinds[1]: "/" should be an API group’s name',
    'slashed.yaml: spec.views[1].actions[0]: what it creates: "apps/x/v1" should be an API version, like cert-manager.io/v1',
    'slashed.yaml: spec.views[1].actions[1]: what it creates: "Example.com/v1" should be an API version',
    'dotted.yaml: spec.kinds[0]: "Deployment.apps" should be a kind’s own name, like Certificate: its group goes under group',
    'dotted.yaml: spec.shows[0]: "Certificate.cert-manager.io" should be a kind’s own name',
    'dotted.yaml: spec.shows[1]: "*.coordination.k8s.io" should be a kind’s own name',
    'dotted.yaml: spec.shows[2]: "pod" should be a kind’s own name',
    // (Nor every kind of a group of Kubernetes': each is written out.)
    'dotted.yaml: spec.shows[3]: "*" should be a kind’s own name',
    'dotted.yaml: spec.views[1].kinds[0]: "Certificate.cert-manager.io" should be a kind’s own name',
    'dotted.yaml: spec.views[1].kinds[1]: "*.example.com" should be a kind’s own name',
    'dotted.yaml: spec.views[1].actions[0]: what it creates: "Widget.example.com" should be a kind’s own name',
    // What one of Lumovi's plugins has can be had one way: under that plugin's name, all of it.
    'j-keda.yaml: Kustomization.kustomize.toolkit.fluxcd.io is flux’s kind. A plugin of yours named flux takes its place, all of it',
    'k-scalers.yaml: ScaledObject.keda.sh is keda’s kind. A plugin of yours named keda takes its place, all of it',
    'my-kustomizations.yaml: Kustomization.kustomize.toolkit.fluxcd.io is flux’s kind. A plugin of yours named flux takes its place, all of it',
    'my-rules.yaml: constraints.gatekeeper.sh is all gatekeeper’s. A plugin of yours named gatekeeper takes its place, all of it',
    'b-twin.yaml: twin is a-twin.yaml’s name too',
    'd-gadgets.yaml: Gadget.example.com is already gadgets’ kind',
    'f-moon.yaml: moons.example.com is all moons’, so another plugin can’t have it',
    'h-stars.yaml: stars.example.com is in one-star’s groups too, so this plugin can’t have every kind of it',
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
    await expectProblem(page, problem)
  }
  // What follows for a file is said in its row: that it isn't in use, and, where it has the
  // name of one of Lumovi's, that Lumovi's is shown instead.
  const fileRow = (file: string) =>
    page.getByRole('table', { name: 'Plugins' }).locator('tr[data-state]').filter({ hasText: file })
  await expect(fileRow('my-flux.yaml')).toContainText('Not in use. 2 problems to fix in the file.')
  await expect(fileRow('my-flux.yaml')).toContainText('Lumovi’s Flux is shown instead')
  await expect(fileRow('j-keda.yaml')).toContainText('Lumovi’s KEDA is shown instead')
  await expect(fileRow('b-twin.yaml')).toContainText('Not in use.')
  // A file's name is the file's to choose: on this page too it's shown with nothing in it that
  // can't be seen, in its row and in its path.
  await expect(fileRow('backU+202Ewards.yaml')).toContainText('Not in use.')
  await expect(fileRow('backU+202Ewards.yaml')).toContainText(/plugins[\\/]backU\+202Ewards\.yaml/)
  // (An empty file is nothing, and says nothing. Lumovi's own views of Kubernetes' kinds are
  // no plugin: its 32 are counted, and the seven of these that could be used.)
  await expectProblem(page, 'empty.yaml: holds nothing')
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByText('32 plugins from Lumovi, 7 of yours.')).toBeVisible()
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

  // A kind of Kubernetes' own, shown by the plugin that says it shows it: its columns and its
  // status in its own list, and no number of Lumovi's own moved by what it calls them.
  const kubernetes = page.getByRole('region', { name: 'Kubernetes' })
  await expect(kubernetes.getByRole('row').filter({ hasText: 'LimitRanges' })).toContainText(
    'limits.yaml',
  )
  await kubernetes.getByRole('button', { name: /^LimitRanges\b/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('LimitRanges')
  await expect(page.getByRole('columnheader', { name: 'Limits' })).toBeVisible()
  await expect(page.getByRole('grid', { name: 'LimitRanges' })).toContainText('Too tight')
  await sidebar(page).getByRole('link', { name: 'Overview' }).click()
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('3/4')
  await expect(page.getByRole('region', { name: 'Workloads healthy' })).toContainText('8/12')
  await expect(page.getByRole('list', { name: 'Needs attention' })).not.toContainText('Too tight')
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()

  // A plugin of one's own with the name of one of Lumovi's is in its place, all of it: said
  // with the count, shown as theirs, and nothing of Lumovi's plugin is used, for the kinds theirs
  // doesn't show either.
  await allPlugins(page)
  const table = page.getByRole('table', { name: 'Plugins' })
  await expect(table.locator('tr[data-state="in-place-of"]')).toContainText(
    'In use in place of Lumovi’s cert-manager',
  )
  await expect(table.locator('tr[data-state="in-place-of"]')).toContainText('certificates.yml')
  await expect(table.locator('tr[data-state="replaced"]')).toContainText(
    'Not in use: your certificates.yml is used in its place, all of it.',
  )
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(
    custom.getByRole('row').filter({ hasText: 'ClusterIssuers' }).getByRole('cell').nth(3),
  ).toHaveText('—')
  await expect(sidebar(page).getByRole('link', { name: 'cert-manager', exact: true })).toHaveCount(
    0,
  )
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
  // What's wrong with it is said on the page of every plugin, which the line leads to.
  await page.getByRole('alert').getByRole('button', { name: 'See Plugins' }).click()
  await expect
    .poll(() => problemLines(page))
    .toEqual(['mine.yaml: should start with apiVersion: lumovi.dev/v1beta1 and kind: Plugin'])
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByText('32 plugins from Lumovi. Yours go in')).toBeVisible()
  // A plugin of theirs named as one of Lumovi's, with something wrong with it (here, a spec
  // that's no map): Lumovi's stays in use, which is said after its problem and isn't counted
  // as one more.
  writeFileSync(
    join(home, '.lumovi', 'plugins', 'my-flux.yaml'),
    'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: flux }\nspec: [1]\n',
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
  await allPlugins(page)
  await expect
    .poll(() => problemLines(page))
    .toEqual([
      'mine.yaml: should start with apiVersion: lumovi.dev/v1beta1 and kind: Plugin',
      'my-flux.yaml: spec: should be a map of fields, not a list',
    ])
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
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
  await allPlugins(page)
  await expect
    .poll(() => problemLines(page))
    .toEqual(['odd.yaml: It couldn’t be read: source is not a string'])
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
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

  await allPlugins(page)
  await expect
    .poll(async () => (await problemLines(page)).join('\n'))
    .toBe('gone.yaml: It isn’t there: a link to a file that’s gone.')
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  const custom = page.getByRole('region', { name: 'Custom resources' })
  await expect(custom.getByRole('row').filter({ hasText: 'Widgets' })).toContainText('widgets.yaml')
})

/** Widgets related to what they need, and actions that ask first or make something new. */
const WORKSHOP = String.raw`
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: cert-manager
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com, cert-manager.io]
  views:
    - name: widget-workshop
      kinds:
        - { group: example.com, kind: Widget }
        # (Not served by the cluster: what making one says.)
        - { group: example.com, kind: Thing }
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
        - name: Give it an issuer
          create:
            apiVersion: cert-manager.io/v1
            kind: ClusterIssuer
            metadata: { name: '{{ .metadata.name }}-issuer' }
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
  await menuAction(page, 'Widget', CUSTOM.widget, 'Give it an issuer…')
  await form.getByRole('button', { name: 'Give it an issuer', exact: true }).click()
  await expect(toasts(page)).toContainText('Give it an issuer: blue-widget')
  expect(
    writes(clusters.demo, 'POST', '/apis/cert-manager.io/v1/clusterissuers').at(-1)!.body,
  ).toMatchObject({ metadata: { name: 'blue-widget-issuer' } })

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
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: flux }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [kustomize.toolkit.fluxcd.io]
  label: GitOps
  icon: git-branch
  kinds:
    - { group: kustomize.toolkit.fluxcd.io, kind: Kustomization }
`,
    // Another in the place of one of Lumovi's: with more than one, they're counted.
    'keda.yaml': `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: keda }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [keda.sh]
  views:
    - kinds: [{ group: keda.sh, kind: ScaledObject }]
`,
    // One with a place of its own, and a view for every kind of a group.
    'toys.yaml': `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
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
  await nav.getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByText('32 plugins from Lumovi, 3 of yours.')).toBeVisible()
  await allPlugins(page)
  await expect(page.getByText('In use in place of Lumovi’s', { exact: false })).toHaveCount(2)
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

test('Lumovi’s own plugins are held inside their groups, and a kind is one plugin’s', async ({
  launch,
}) => {
  // Lumovi's own are only ever the ones built in, so the tests' build takes a folder of
  // stand-ins for more of them: the only way to show the app a bad one.
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  const files: Record<string, string> = {
    // Whatever a file says, it can't put itself outside the fence.
    'unfenced.yaml': plugin('unfenced', 'Gadget', '  fenced: false\n  groups: [example.com]\n'),
    'groupless.yaml': plugin('groupless', 'Gadget').replace(/ {2}groups: .*\n/, ''),
    'outside.yaml': plugin(
      'outside',
      'Gadget',
      '  groups: [other.example.com]\n  label: Outside\n  kinds: [{ group: elsewhere.example.com, kind: Thing }]\n',
      '    - kinds: [{ group: coordination.k8s.io, kind: Lease }, { kind: Endpoints }]\n',
    ),
    // What it creates is one of its own kinds: being in a group it has isn't enough.
    'maker.yaml': plugin(
      'maker',
      'Gadget',
      '  groups: [example.com]\n',
      `      actions:
        - name: Make another
          create: { apiVersion: example.com/v1, kind: Gadget, metadata: { generateName: gadget- } }
        - name: Make a neighbour
          create: { apiVersion: example.com/v1, kind: Gizmo, metadata: { generateName: gizmo- } }
        - name: Run something
          create: { apiVersion: batch/v1, kind: Job, metadata: { generateName: job- } }
        - name: Make a pod
          create: { apiVersion: v1, kind: Pod, metadata: { generateName: pod- } }
`,
    ),
    // Every kind of a group is the group's kinds, each of them its own to create.
    'planets.yaml': plugin(
      'planets',
      'Planet',
      '  groups: [example.com, planets.example.com]\n',
      `      actions:
        - name: Add a moon
          create: { apiVersion: planets.example.com/v1, kind: Moon, metadata: { generateName: moon- } }
    - kinds: [{ group: planets.example.com, kind: '*' }]
`,
    ),
    // A kind one of Lumovi's has is that plugin's, whatever shares its group.
    'second-flux.yaml': plugin(
      'second-flux',
      'Unused',
      '  groups: [example.com, kustomize.toolkit.fluxcd.io]\n',
      '    - kinds: [{ group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]\n',
    ),
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(included, name), text)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included } })
  await openCluster(page)
  await allPlugins(page)
  for (const problem of [
    'unfenced.yaml: spec.fenced: isn’t something a plugin has',
    'groupless.yaml: spec.groups: is required: the API groups its kinds are in, like [example.com]',
    'outside.yaml: spec.kinds[0]: Thing.elsewhere.example.com isn’t in one of its groups: add elsewhere.example.com to spec.groups',
    'outside.yaml: spec.views[0].kinds[0]: Gadget.example.com isn’t in one of its groups: add example.com to spec.groups',
    'outside.yaml: spec.views[1].kinds[0]: Lease.coordination.k8s.io is Kubernetes’ own: to show it, name it under spec.shows',
    'outside.yaml: spec.views[1].kinds[1]: Endpoints is Kubernetes’ own: to show it, name it under spec.shows',
    'maker.yaml: spec.views[0].actions[1].create: makes a Gizmo.example.com, which isn’t one of this plugin’s kinds',
    'maker.yaml: spec.views[0].actions[2].create: makes a Job, which isn’t one of this plugin’s kinds',
    'maker.yaml: spec.views[0].actions[3].create: makes a Pod, which isn’t one of this plugin’s kinds',
    'second-flux.yaml: Kustomization.kustomize.toolkit.fluxcd.io is already flux’s kind',
  ]) {
    await expectProblem(page, problem)
  }
  expect((await problemLines(page)).join('\n')).not.toContain('planets.yaml')
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  // The one of them that's fine is one of Lumovi's.
  await expect(page.getByText('33 plugins from Lumovi.')).toBeVisible()
})
