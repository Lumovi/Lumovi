/**
 * The plugins Lumovi comes with, and its own views of Kubernetes' kinds, checked against the
 * CRDs of the operators they're for (tests/plugins/crds, fetched by `npm run crds`): every
 * kind they name is real, and every path, template, link, related list and
 * action reads or writes fields those kinds have. A field an operator
 * renamed, or one misremembered, would otherwise just show nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parse, type Step } from '@shared/jsonpath'
import { isBuiltinKind, isCustomGroup, apiGroupOf, kindFor } from '@shared/resources'
import {
  changeProblem,
  clashes,
  EXPRESSION,
  parsePlugin,
  PLACEHOLDER,
  type Condition,
  type Plugin,
  type View,
} from '../../src/shared/plugins.ts'
import { asks } from '../../src/shared/plugin-asks.ts'
import { mayCarryCode, settle, type PluginFile } from '../../src/shared/plugin-loading.ts'
import type { Crd, Shape } from '../../scripts/crds.ts'

const PLUGINS = 'plugins'
/** Lumovi's own views, for Kubernetes' kinds that have no page: written as a plugin's are. */
const OWN = 'src/renderer/src/views'
const CRDS = 'tests/plugins/crds'

const sources = JSON.parse(readFileSync(join(CRDS, 'sources.json'), 'utf8')) as Record<
  string,
  { version: string }
>

/** Every CRD kept here, by the name Lumovi gives its kind, with where it came from. */
const crds = new Map<string, { crd: Crd; from: string }>()
for (const file of readdirSync(CRDS).filter((f) => f.endsWith('.json') && f !== 'sources.json')) {
  const name = basename(file, '.json')
  const { version, crds: list } = JSON.parse(readFileSync(join(CRDS, file), 'utf8')) as {
    version: string
    crds: Crd[]
  }
  for (const crd of list) {
    crds.set(kindFor(`${crd.group}/v1`, crd.kind), { crd, from: `${name} ${version}` })
  }
}

const views: View[] = []
const plugins: Plugin[] = []
const parseProblems: string[] = []
for (const folder of [OWN, PLUGINS]) {
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.yaml'))) {
    // Lumovi's own views of Kubernetes' kinds are no plugin, and what they show no plugin may.
    const parsed = parsePlugin(readFileSync(join(folder, file), 'utf8'), file, {
      ownViews: folder === OWN,
      lumovisOwn: views.flatMap((view) => view.kinds),
    })
    if (parsed.plugin) {
      views.push(...parsed.plugin.views)
      // (Lumovi's own views are no plugin: only their fields are checked.)
      if (folder === PLUGINS) plugins.push(parsed.plugin)
    }
    parseProblems.push(...parsed.problems)
  }
}
// A kind is one plugin's, though three of these share a group: a clash among Lumovi's own fails here.
for (const [plugin, problem] of clashes(plugins)) parseProblems.push(`${plugin.source}: ${problem}`)

// ——— Shapes ———

const ANY: Shape = { any: true }
const MAP: Shape = { additionalProperties: ANY }
/** ObjectMeta, which CRDs' schemas leave out. */
const METADATA: Shape = {
  properties: Object.fromEntries([
    ...[
      'name',
      'generateName',
      'namespace',
      'uid',
      'resourceVersion',
      'generation',
      'creationTimestamp',
      'deletionTimestamp',
    ].map((key) => [key, ANY]),
    ['labels', MAP],
    ['annotations', MAP],
    ['finalizers', { items: ANY }],
    [
      'ownerReferences',
      {
        items: {
          properties: Object.fromEntries(
            ['apiVersion', 'kind', 'name', 'uid', 'controller', 'blockOwnerDeletion'].map((k) => [
              k,
              ANY,
            ]),
          ),
        },
      },
    ],
  ]),
}

/** A served version's schema, with what every object has. */
function objectShape(schema: Shape): Shape {
  return {
    ...schema,
    properties: { ...schema.properties, apiVersion: ANY, kind: ANY, metadata: METADATA },
  }
}

/** Where `key` leads from `shape`, if anywhere. */
function field(shape: Shape, key: string): Shape | undefined {
  if (shape.any) return ANY
  return shape.properties?.[key] ?? shape.additionalProperties
}

/** Whether the steps of a path lead somewhere in `shape`. */
function resolves(shape: Shape, steps: Step[]): boolean {
  let at: Shape | undefined = shape
  for (const step of steps) {
    if (!at) return false
    if (at.any) return true
    if ('key' in step) {
      at = field(at, step.key)
    } else {
      // Every item of a list, or every value of a map.
      at = at.items ?? at.additionalProperties
      if (at && 'filter' in step && !resolves(at, step.filter.path)) return false
    }
  }
  return Boolean(at)
}

// ——— What a view reads and writes ———

/** The paths a template's placeholders read (not `now`, nor an action's inputs). */
function templatePaths(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].flatMap(([, expression]) => {
    const [, path, , fallback] = EXPRESSION.exec(expression!)!
    return [path!, fallback].filter((p): p is string => Boolean(p) && p!.startsWith('.'))
  })
}

function conditionPaths(condition: Condition | undefined): string[] {
  if (!condition) return []
  if ('all' in condition) return condition.all.flatMap(conditionPaths)
  if ('any' in condition) return condition.any.flatMap(conditionPaths)
  return [condition.path]
}

/** Every string in a patch or an object to create. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** The fields a merge patch (or an object to create) sets, as steps from the object's root. */
function fieldPaths(value: unknown, at: Step[] = []): Step[][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [at]
  const entries = Object.entries(value)
  return entries.length === 0
    ? [at]
    : entries.flatMap(([key, item]) => fieldPaths(item, [...at, { key }]))
}

/** A JSON patch operation's path, as steps. */
function pointer(path: string): Step[] {
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((part) => (/^(\d+|-)$/.test(part) ? { all: true as const } : { key: part }))
}

const described = (steps: Step[]) =>
  steps.map((step) => ('key' in step ? `.${step.key}` : '[]')).join('')

/** A kind Lumovi can show: built in, one of Kubernetes' others, or a CRD kept here. */
function known(kind: string): boolean {
  return isBuiltinKind(kind) || !isCustomGroup(apiGroupOf(kind)) || crds.has(kind)
}

/**
 * Checks paths against kinds' served versions: each must exist in at least
 * one of them. (A view for several kinds can show a field only some of them
 * have, and operators move fields between versions that clusters serve.)
 */
function checker(kinds: string[], problems: string[], where: string) {
  const found = kinds.flatMap((kind) => crds.get(kind) ?? [])
  const shapes = found.flatMap(({ crd }) =>
    crd.versions.filter((v) => v.served).map((v) => objectShape(v.schema)),
  )
  const names = `${found.map(({ crd }) => crd.kind).join(', ')} (${[...new Set(found.map((f) => f.from))].join(', ')})`
  const check = (steps: Step[], what: string) => {
    if (found.length && !shapes.some((shape) => resolves(shape, steps))) {
      problems.push(`${where}: ${what} isn’t in ${names}`)
    }
  }
  return {
    path: (path: string, what = path) => check(parse(path), what),
    template: (template: string) => {
      for (const path of templatePaths(template)) check(parse(path), path)
    },
    steps: check,
  }
}

function checkView(view: View, problems: string[]) {
  const where = `${view.source}: ${view.name}`
  const { path, template, steps } = checker(view.kinds, problems, where)
  for (const field of [...(view.columns ?? []), ...(view.details ?? [])]) path(field.path)
  for (const rule of view.status ?? []) {
    conditionPaths(rule.when).forEach((p) => path(p))
    template(rule.label)
    if (rule.detail) template(rule.detail)
  }
  for (const link of view.links ?? []) {
    ;[link.kind, link.objectName, link.namespace ?? ''].forEach(template)
    if (!link.kind.includes('{{') && !known(link.kind)) {
      problems.push(`${where}: links to ${link.kind}, which no CRD here defines`)
    }
  }
  for (const related of view.related ?? []) {
    ;[related.kind, related.fieldSelector ?? '', related.namespace ?? ''].forEach(template)
    Object.values(related.labels ?? {}).forEach(template)
    if (!related.kind.includes('{{') && !known(related.kind)) {
      problems.push(`${where}: relates ${related.kind}, which no CRD here defines`)
    }
  }
  for (const action of view.actions ?? []) {
    const at = `action ${action.name}`
    conditionPaths(action.when).forEach((p) => path(p, `${at}: ${p}`))
    for (const input of action.inputs ?? []) {
      if (input.from) path(input.from, `${at}: ${input.from}`)
      if (input.default) template(input.default)
    }
    ;[action.confirm ?? '', action.done ?? '', ...strings(action.patch), ...strings(action.undo)]
      .concat(strings(action.create))
      .forEach(template)
    for (const patch of [action.patch, action.undo]) {
      if (!patch) continue
      const fields = Array.isArray(patch)
        ? patch.map((op) => pointer(String(op.path)))
        : fieldPaths(patch)
      for (const field of fields) steps(field, `${at} sets ${described(field)}`)
    }
    if (action.create) {
      const created = kindFor(String(action.create.apiVersion), String(action.create.kind))
      if (!known(created)) {
        problems.push(`${where}: ${at} creates ${created}, which no CRD here defines`)
      }
      const check = checker([created], problems, `${where}: ${at}`)
      for (const field of fieldPaths(action.create)) {
        check.steps(field, `what it creates sets ${described(field)}`)
      }
    }
  }
}

// ——— The checks ———

test('Lumovi’s plugins are all valid', () => {
  expect(parseProblems).toEqual([])
})

test('every plugin is checked against its operator’s CRDs, and names their kinds', () => {
  const problems: string[] = []
  for (const plugin of plugins) {
    if (!(plugin.name in sources)) {
      problems.push(`${plugin.source}: ${plugin.name} has no CRDs in ${CRDS}/sources.json`)
      continue
    }
    // (Every kind of a group, `*.group`, are made by the tool, and not known until they are.)
    for (const kind of (plugin.place?.kinds ?? []).filter((k) => !k.startsWith('*.'))) {
      if (!crds.get(kind)?.from.startsWith(`${plugin.name} `)) {
        problems.push(`${plugin.source}: ${plugin.name} names ${kind}, which its CRDs don’t`)
      }
    }
  }
  expect(problems).toEqual([])
})

test('every kind a view is for has a CRD here, unless it’s one of Kubernetes’ own', () => {
  const problems = views.flatMap((view) =>
    view.kinds
      .filter(
        (kind) => isCustomGroup(apiGroupOf(kind)) && !kind.startsWith('*.') && !crds.has(kind),
      )
      .map((kind) => `${view.source}: ${view.name} is for ${kind}, which no CRD here defines`),
  )
  expect(problems).toEqual([])
})

test('every field a view reads or writes is in its kinds’ schemas', () => {
  const problems: string[] = []
  for (const view of views) checkView(view, problems)
  expect(problems).toEqual([])
})

test('the CRDs kept here are the ones sources.json names', () => {
  const kept = readdirSync(CRDS)
    .filter((f) => f.endsWith('.json') && f !== 'sources.json')
    .map((f) => basename(f, '.json'))
  expect(kept.sort()).toEqual(Object.keys(sources).sort())
})

// The second wall. The file's check refuses every way that's known of writing a change to what
// isn't a plugin's; so nothing a file can say reaches this one, and it's shown what a file
// couldn't: a change already filled in, as it would be sent.
test('a change is held, as it’s sent, to what a plugin may change', () => {
  const patch = (body: unknown) => changeProblem({ action: 'patch', patch: body })
  expect(patch({ spec: { suspend: true }, metadata: { annotations: { a: 'b' } } })).toBeUndefined()
  expect(patch([{ op: 'replace', path: '/spec/size', value: 3 }])).toBeUndefined()
  expect(patch({ metadata: { finalizers: [] } })).toBe(
    'changes metadata.finalizers, which a plugin can’t change',
  )
  expect(patch({ metadata: { namespace: 'elsewhere' } })).toContain('metadata.namespace')
  // What one placeholder for a whole operation would have come to.
  expect(patch([{ op: 'remove', path: '/metadata/finalizers' }])).toContain('metadata.finalizers')
  expect(patch([{ op: 'move', from: '/metadata/ownerReferences/0', path: '/spec/x' }])).toContain(
    'metadata.ownerReferences',
  )
  expect(patch([{ op: 'replace', path: '/metadata', value: {} }])).toContain(
    'all of an object’s metadata',
  )
  expect(patch([{ op: 'replace', path: '', value: {} }])).toContain('the object whole')
  expect(patch(['{{ .spec.op }}'])).toContain('fills in an operation whole')
  expect(patch({ metadata: '{{ .spec.metadata }}' })).toContain('metadata whole')
  const create = (metadata: unknown) =>
    changeProblem({
      action: 'create',
      object: { apiVersion: 'example.com/v1', kind: 'Gadget', metadata },
    })
  // A new object has its name and may have its namespace: its owners aren't a plugin's to say.
  expect(create({ name: 'gadget-abcde', namespace: 'shop', labels: { a: 'b' } })).toBeUndefined()
  expect(create({ name: 'gadget-abcde', ownerReferences: [] })).toContain(
    'metadata.ownerReferences',
  )
  // And nothing but a patch or a new object is a plugin's action's.
  expect(changeProblem({ action: 'delete' })).toContain('isn’t a patch or a new object')
})

// The fence, from the outside: however a file spells a kind and its group, either the file is
// refused, or every kind it comes to (as Lumovi resolves it: the id its views and changes are
// found by) is a tool's kind in one of the groups the file declares, or one it says it shows.
test('no spelling of a kind gets a plugin outside its groups', () => {
  const GROUPS = [
    '',
    '/',
    '.',
    ' ',
    'apps',
    'apps/x',
    'apps/',
    '/apps',
    'APPS',
    'apps ',
    'apps.',
    'batch/',
    'rbac.authorization.k8s.io/x',
    'cert-manager.io/x',
    'cert-manager.io/v1',
    'example.com/v1',
    'example.com/',
    'Example.com',
    'example..com',
    'example.com.',
    '-example.com',
    'coordination.k8s.io',
    'v1',
    'core',
    'example.com',
  ]
  const KINDS = [
    'Deployment',
    'Pod',
    'Job',
    'Role',
    'Secret',
    'Lease',
    'Widget',
    'widget',
    'Deployment.apps',
    'Certificate.cert-manager.io',
    '*.cert-manager.io',
    '*.coordination.k8s.io',
    'Widget.example.com',
    'Wid get',
    'Widget/v1',
    ' Widget',
    '*',
    '',
  ]
  const groupOf = (id: string) => (id.includes('.') ? id.slice(id.indexOf('.') + 1) : '')
  let accepted = 0
  for (const declared of [['example.com'], ['example.com', 'apps/x'], ['apps/x']]) {
    for (const group of GROUPS) {
      for (const kind of KINDS) {
        for (const where of ['view', 'place', 'shows', 'create'] as const) {
          const named = `{ group: ${JSON.stringify(group)}, kind: ${JSON.stringify(kind)} }`
          const text = [
            'apiVersion: lumovi.dev/v1beta1',
            'kind: Plugin',
            'metadata: { name: probe }',
            'spec:',
            '  version: 1.0.0',
            '  needs: { lumovi: 1.0.0 }',
            `  groups: ${JSON.stringify(declared)}`,
            ...(where === 'shows' ? [`  shows: [${named}]`] : []),
            ...(where === 'place' ? ['  label: Probe', `  kinds: [${named}]`] : []),
            '  views:',
            `    - kinds: [${where === 'view' || where === 'shows' ? named : '{ group: example.com, kind: Widget }'}]`,
            ...(where === 'create'
              ? [
                  '      actions:',
                  '        - name: Make',
                  `          create: { apiVersion: ${JSON.stringify(group ? `${group}/v1` : 'v1')}, kind: ${JSON.stringify(kind)}, metadata: { generateName: x- } }`,
                ]
              : where === 'view'
                ? [
                    '      actions:',
                    '        - { name: Poke, confirm: Sure?, patch: { spec: { a: 1 } } }',
                  ]
                : []),
          ].join('\n')
          const { plugin } = parsePlugin(text, 'probe.yaml', { lumovisOwn: [] })
          if (!plugin) continue
          accepted++
          const said = `${where}: group ${JSON.stringify(group)}, kind ${JSON.stringify(kind)}`
          for (const id of [
            ...(plugin.place?.kinds ?? []),
            ...plugin.views.flatMap((v) => v.kinds),
          ]) {
            // One of Kubernetes' own is there only as a kind the plugin says it shows, with no
            // page of its own; anything else is in a group the file declares.
            if (isCustomGroup(groupOf(id))) expect(plugin.groups, said).toContain(groupOf(id))
            else {
              expect(plugin.shows, said).toContain(id)
              expect(isBuiltinKind(id), said).toBe(false)
            }
          }
          // And a group it declares is a tool's, written as a group is.
          for (const declaredGroup of plugin.groups) {
            expect(declaredGroup, said).toMatch(/^[a-z0-9.-]+$/)
            expect(isCustomGroup(declaredGroup), said).toBe(true)
          }
        }
      }
    }
  }
  // (The honest spellings among them are accepted, so the loop isn't passing by refusing all.)
  expect(accepted).toBeGreaterThan(5)
})

// ——— Which copy of a plugin is in use ———

/** A file holding a plugin of `name` that shows `kinds` (each "Kind.group"). */
function file(fileName: string, name: string, kinds: string[], extra = ''): PluginFile {
  const named = kinds.map((id) => {
    const [kind, ...group] = id.split('.')
    return `{ group: ${group.join('.')}, kind: ${JSON.stringify(kind)} }`
  })
  const groups = [...new Set(kinds.map((id) => id.slice(id.indexOf('.') + 1)))]
  return {
    name: fileName,
    text: [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      `metadata: { name: ${name} }`,
      'spec:',
      '  version: 1.0.0',
      '  needs: { lumovi: 1.0.0 }',
      `  groups: [${groups.join(', ')}]`,
      extra,
      `  views: [{ kinds: [${named.join(', ')}] }]`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

test('which copy of a plugin is in use: Lumovi’s, one in its place by its name, the first of two', () => {
  const flux = plugins.find((plugin) => plugin.name === 'flux')!
  const keda = plugins.find((plugin) => plugin.name === 'keda')!
  const states = (files: PluginFile[]) =>
    Object.fromEntries(
      settle(plugins, files, 'yours').files.map((entry) => [
        entry.file,
        [entry.state, entry.lumovis?.name, ...entry.problems].filter(Boolean).join(' | '),
      ]),
    )
  // Each line: the files of a folder, and what becomes of each.
  expect(states([file('mine.yaml', 'mine', ['Widget.example.com'])])).toEqual({
    'mine.yaml': 'in-use',
  })
  // Named as one of Lumovi's, it's in its place; under another name, Lumovi's kind is Lumovi's.
  expect(
    states([
      file('a.yaml', 'flux', ['Kustomization.kustomize.toolkit.fluxcd.io']),
      file('b.yaml', 'other', ['ScaledObject.keda.sh']),
    ]),
  ).toEqual({
    'a.yaml': 'in-place-of | flux',
    'b.yaml':
      'not-in-use | b.yaml: ScaledObject.keda.sh is keda’s kind. A plugin of yours named keda takes its place, all of it',
  })
  // Of two with one name, and of two that show one kind, the first by file name.
  expect(
    states([
      file('b.yaml', 'twin', ['Gadget.example.com']),
      file('a.yaml', 'twin', ['Widget.example.com']),
      file('d.yaml', 'second', ['Widget.example.com']),
    ]),
  ).toEqual({
    'a.yaml': 'in-use',
    'b.yaml': 'not-in-use | b.yaml: twin is a.yaml’s name too',
    'd.yaml': 'not-in-use | d.yaml: Widget.example.com is already twin’s kind',
  })
  // One in Lumovi's place that can't be used itself leaves Lumovi's there, for the others too.
  expect(
    states([
      file('a.yaml', 'keda', ['ScaledObject.keda.sh', 'Kustomization.kustomize.toolkit.fluxcd.io']),
      file('b.yaml', 'scalers', ['ScaledObject.keda.sh']),
    ]),
  ).toEqual({
    'a.yaml':
      'not-in-use | keda | a.yaml: Kustomization.kustomize.toolkit.fluxcd.io is flux’s kind. A plugin of yours named flux takes its place, all of it',
    'b.yaml':
      'not-in-use | b.yaml: ScaledObject.keda.sh is keda’s kind. A plugin of yours named keda takes its place, all of it',
  })
  // A file with the name of one of Lumovi's is judged before the others, whatever its file's
  // name: the place is its own, and what another file takes of that plugin's is what's refused.
  expect(
    states([
      file('aaa.yaml', 'aaa', ['Kustomization.kustomize.toolkit.fluxcd.io']),
      file('flux.yaml', 'flux', ['Kustomization.kustomize.toolkit.fluxcd.io']),
    ]),
  ).toEqual({
    'aaa.yaml':
      'not-in-use | aaa.yaml: Kustomization.kustomize.toolkit.fluxcd.io is already flux’s kind',
    'flux.yaml': 'in-place-of | flux',
  })
  // Two with Lumovi's names, one showing a kind of the other's plugin that the other doesn't
  // show itself: both are in use, whichever file's name comes first, since nobody else has it.
  for (const [first, second] of [
    ['a.yaml', 'b.yaml'],
    ['b.yaml', 'a.yaml'],
  ] as const) {
    expect(
      states([
        file(first, 'keda', ['ScaledObject.keda.sh', 'Kustomization.kustomize.toolkit.fluxcd.io']),
        file(second, 'flux', ['A.example.com']),
      ]),
    ).toEqual({ [first]: 'in-place-of | keda', [second]: 'in-place-of | flux' })
  }
  // And one that's out is out against what's in use at the end: here the first falls to one of
  // Lumovi's, which frees the kind the second lost to it.
  expect(
    states([
      file('a.yaml', 'keda', ['ScaledObject.keda.sh', 'Certificate.cert-manager.io']),
      file('b.yaml', 'flux', ['ScaledObject.keda.sh']),
    ]),
  ).toEqual({
    'a.yaml':
      'not-in-use | keda | a.yaml: Certificate.cert-manager.io is cert-manager’s kind. A plugin of yours named cert-manager takes its place, all of it',
    'b.yaml':
      'not-in-use | flux | b.yaml: ScaledObject.keda.sh is keda’s kind. A plugin of yours named keda takes its place, all of it',
  })
  // Of two files with one name the second is out, whatever becomes of the first: here the first
  // isn't used either, and the name is still its own.
  expect(
    states([
      file('a.yaml', 'twin', ['ScaledObject.keda.sh']),
      file('b.yaml', 'twin', ['Widget.example.com']),
    ]),
  ).toEqual({
    'a.yaml':
      'not-in-use | a.yaml: ScaledObject.keda.sh is keda’s kind. A plugin of yours named keda takes its place, all of it',
    'b.yaml': 'not-in-use | b.yaml: twin is a.yaml’s name too',
  })
  // A file that can't be read, or isn't a plugin, is its own problem; one named as Lumovi's
  // says which of Lumovi's is shown instead.
  expect(
    states([
      { name: 'gone.yaml', text: '', error: 'It couldn’t be read: ENOENT' },
      { name: 'odd.yaml', text: 5 as unknown as string },
      {
        name: 'flux.yaml',
        text: 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: flux }\nspec: [1]\n',
      },
    ]),
  ).toEqual({
    'flux.yaml': 'not-in-use | flux | flux.yaml: spec: should be a map of fields, not a list',
    'gone.yaml': 'not-in-use | gone.yaml: It couldn’t be read: ENOENT',
    'odd.yaml': 'not-in-use | odd.yaml: It couldn’t be read: source is not a string',
  })
  // (And not of a file with that name when another file is in that plugin's place.)
  expect(
    states([
      file('a.yaml', 'flux', ['Kustomization.kustomize.toolkit.fluxcd.io']),
      {
        name: 'b.yaml',
        text: 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: flux }\nspec: [1]\n',
      },
    ]),
  ).toEqual({
    'a.yaml': 'in-place-of | flux',
    'b.yaml': 'not-in-use | b.yaml: spec: should be a map of fields, not a list',
  })
  // What's in use of Lumovi's is all of them but the ones a file is in the place of.
  const settled = settle(
    plugins,
    [file('a.yaml', 'flux', ['Kustomization.kustomize.toolkit.fluxcd.io'])],
    'server',
  )
  expect(settled.lumovis).toHaveLength(plugins.length - 1)
  expect(settled.lumovis).not.toContain(flux)
  expect(settled.lumovis).toContain(keda)
  expect(settled.files.map(({ state, plugin }) => [state, plugin!.name])).toEqual([
    ['in-place-of', 'flux'],
  ])
  expect(settled.files[0]!.origin).toBe('server')
})

test('every file comes back once, in one state, whatever order the files are handed in', () => {
  const files = [
    file('a.yaml', 'twin', ['Widget.example.com']),
    file('b.yaml', 'twin', ['Gadget.example.com']),
    file('c.yaml', 'flux', ['Kustomization.kustomize.toolkit.fluxcd.io', 'ScaledObject.keda.sh']),
    file('d.yaml', 'keda', ['ScaledObject.keda.sh']),
    file('e.yaml', 'more', ['Widget.example.com', 'Thing.example.com']),
    file('f.yaml', 'things', ['Thing.example.com']),
    { name: 'g.yaml', text: 'spec: [unclosed' },
    { name: 'h.yaml', text: '' },
  ]
  const told = (handed: PluginFile[]) =>
    settle(plugins, handed, 'yours').files.map(({ file, state, problems }) => ({
      file,
      state,
      problems,
    }))
  const first = told(files)
  expect(first.map((entry) => entry.file)).toEqual(files.map(({ name }) => name))
  // Rotated and reversed: the same answer, in the files' own order.
  for (let turn = 1; turn < files.length; turn++) {
    const turned = [...files.slice(turn), ...files.slice(0, turn)]
    expect(told(turned)).toEqual(first)
    expect(told(turned.reverse())).toEqual(first)
  }
})

test('only what came inside Lumovi may carry code: a folder’s file is data, whatever it says', () => {
  expect(mayCarryCode('lumovi')).toBe(true)
  for (const origin of ['yours', 'server', 'installed'] as const)
    expect(mayCarryCode(origin)).toBe(false)
  // There's no field for code in a plugin's file, so a file that names some is refused like
  // any file with something unknown in it: nothing of it is used.
  for (const extra of ['  code: ./index.js', '  src: [a.ts]', '  entry: { page: main.js }']) {
    const [entry] = settle(
      plugins,
      [file('coded.yaml', 'coded', ['Widget.example.com'], extra)],
      'yours',
    ).files
    expect(entry!.state).toBe('not-in-use')
    expect(entry!.problems.join(' ')).toContain('isn’t something a plugin has')
  }
})

test('a key nobody knows is refused wherever a file has keys, the names every object answers to among them', () => {
  const NAMES = [
    'code',
    'origin',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ]
  const base = (at: string, key: string) => {
    const extra = (where: string, indent: string) => (at === where ? `${indent}${key}: x\n` : '')
    return (
      `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\n${extra('top', '')}` +
      `metadata:\n  name: probe\n${extra('metadata', '  ')}` +
      `spec:\n  version: 1.0.0\n${extra('spec', '  ')}` +
      `  needs:\n    lumovi: 1.0.0\n${extra('needs', '    ')}` +
      `  groups: [example.com]\n  label: Probe\n  kinds:\n    - group: example.com\n      kind: Widget\n${extra('place kind', '      ')}` +
      `  views:\n    - kinds: [{ group: example.com, kind: Widget }]\n${extra('view', '      ')}` +
      `      columns:\n        - name: A\n          path: .a\n${extra('column', '          ')}` +
      `      status:\n        - health: healthy\n          label: Fine\n          when:\n            path: .a\n${extra('condition', '            ')}` +
      `      actions:\n        - name: Poke\n          confirm: Sure?\n          patch: { spec: { a: 1 } }\n${extra('action', '          ')}` +
      `          inputs:\n            - name: n\n              label: N\n${extra('input', '              ')}`
    )
  }
  // (As it stands, with nothing added, it's a plugin.)
  expect(parsePlugin(base('nowhere', 'x'), 'probe.yaml').problems).toEqual([])
  for (const at of [
    'top',
    'metadata',
    'spec',
    'needs',
    'place kind',
    'view',
    'column',
    'condition',
    'action',
    'input',
  ]) {
    for (const key of NAMES) {
      const { plugin, problems } = parsePlugin(base(at, key), 'probe.yaml')
      expect(plugin, `${key} at ${at}`).toBeUndefined()
      expect(problems.join(' | '), `${key} at ${at}`).toContain(`${key}: isn’t something`)
    }
  }
})

test('whatever a folder holds: what’s in use doesn’t clash, and what isn’t would still lose to it', () => {
  // A few thousand folders, the same ones every run: files with Lumovi's names and their own,
  // showing kinds of Lumovi's plugins and of nobody's, in every mix of a few.
  const NAMES = ['flux', 'keda', 'cert-manager', 'mine', 'theirs', 'ours']
  const KINDS = [
    'Kustomization.kustomize.toolkit.fluxcd.io',
    'ScaledObject.keda.sh',
    'Certificate.cert-manager.io',
    'A.example.com',
    'B.example.com',
  ]
  let seed = 7
  const next = (below: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % below
  }
  for (let folder = 0; folder < 3000; folder++) {
    const files = Array.from({ length: 1 + next(5) }, (_, i) => {
      const kinds = KINDS.filter(() => next(3) === 0)
      return file(
        `${'zyxwv'[next(5)]}${i}.yaml`,
        NAMES[next(NAMES.length)]!,
        kinds.length ? kinds : [KINDS[3 + next(2)]!],
      )
    })
    const settled = settle(plugins, files, 'yours')
    const inUse = settled.files.filter((entry) => entry.state !== 'not-in-use')
    const said = JSON.stringify(
      settled.files.map((entry) => [entry.file, entry.plugin?.name, entry.state]),
    )
    // Nothing in use clashes with anything in use, or with what's left of Lumovi's.
    expect(
      clashes(
        inUse.map((entry) => entry.plugin!),
        settled.lumovis,
      ).size,
      said,
    ).toBe(0)
    // One in Lumovi's place: Lumovi's of that name isn't in use beside it.
    for (const entry of inUse) {
      expect(
        settled.lumovis.some(({ name }) => name === entry.plugin!.name),
        said,
      ).toBe(false)
    }
    // And each that lost by what it shows would lose again to what's in use at the end (with
    // Lumovi's of its own name out of the way, as it would be if it stood).
    const names = new Map<string, string>()
    for (const entry of settled.files) {
      if (!entry.plugin) continue
      const twin = names.has(entry.plugin.name)
      if (!twin) names.set(entry.plugin.name, entry.file)
      if (entry.state !== 'not-in-use' || twin) continue
      const again = clashes(
        [...inUse.map((other) => other.plugin!), entry.plugin],
        settled.lumovis.filter(({ name }) => name !== entry.plugin!.name),
      )
      expect(again.has(entry.plugin), `${entry.file} in ${said}`).toBe(true)
    }
  }
})

// ——— What a plugin asks for ———

test('what a plugin asks for is read from its file: its kinds, what it reads, each action and what it sends', () => {
  const flux = asks(plugins.find((plugin) => plugin.name === 'flux')!)
  expect(flux.kinds).toHaveLength(7)
  expect(flux.kinds).toContain('Kustomization.kustomize.toolkit.fluxcd.io')
  expect(flux.groups).toEqual([
    'kustomize.toolkit.fluxcd.io',
    'helm.toolkit.fluxcd.io',
    'source.toolkit.fluxcd.io',
  ])
  expect(flux.creates).toEqual([])
  // The same action on each of its views is one action, on all their kinds.
  expect(flux.actions.map(({ name }) => name)).toEqual(['Reconcile', 'Suspend', 'Resume'])
  expect(flux.actions.every(({ kinds }) => kinds.length === 7)).toBe(true)
  expect(flux.shows).toEqual([])
  // Every one of its actions says which it is, and what it sends as it's written: what's filled
  // in later is said as what it is, and what a merge patch removes as removed.
  const reconcile = flux.actions.find(({ name }) => name === 'Reconcile')!
  expect(reconcile.runs).toBe('at-once')
  expect(reconcile.patch).toBe(
    'metadata:\n  annotations:\n    reconcile.fluxcd.io/requestedAt: (now)',
  )
  const resume = flux.actions.find(({ name }) => name === 'Resume')!
  expect(resume.patch).toContain('suspend: (removed)')
  // What takes an action back is sent too, later, and is shown with it; and a patch of an
  // object's status says that it is one.
  const suspend = flux.actions.find(({ name }) => name === 'Suspend')!
  expect(suspend.patch).toBe('spec:\n  suspend: true')
  expect(suspend.undo).toBe('spec:\n  suspend: (removed)')
  const rollouts = asks(plugins.find((plugin) => plugin.name === 'argo-rollouts')!)
  expect(rollouts.actions.filter(({ status }) => status).map(({ name }) => name)).toEqual([
    'Promote',
    'Abort',
  ])
  expect(flux.actions.every(({ status }) => status === undefined)).toBe(true)
  // One that asks, creates, and takes a choice.
  const tekton = asks(plugins.find((plugin) => plugin.name === 'tekton')!)
  expect(tekton.creates).toEqual(['PipelineRun.tekton.dev'])
  const run = tekton.actions.find(({ creates }) => creates !== undefined)!
  expect(run.runs).toBe('asks')
  expect(run.creates).toContain('kind: PipelineRun')
  expect(run.creates).toContain('(from the object)')
  // What it lists beside an object, and links to: the kinds its file names.
  const cnpg = asks(plugins.find((plugin) => plugin.name === 'cloudnative-pg')!)
  expect(cnpg.related.kinds).toContain('Pod')
  const certs = asks(plugins.find((plugin) => plugin.name === 'cert-manager')!)
  expect(certs.links.kinds).toContain('Secret')
  expect(certs.links.templated).toBe(true)
  // A null takes a field away in a merge patch, and is a null anywhere else.
  const [made] = parsePlugin(
    [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      'metadata: { name: nulls }',
      'spec:',
      '  version: 1.0.0',
      '  needs: { lumovi: 1.0.0 }',
      '  groups: [example.com]',
      '  views:',
      '    - kinds: [{ group: example.com, kind: Widget }]',
      '      actions:',
      '        - name: Harmless',
      '          runs: at-once',
      '          patch: { metadata: { labels: { seen: yes, when: "(now)", then: "{{ now }}", mix: "(removed) {{ .spec.x }}", near: "( Now )" } } }',
      '          undo: { spec: { replicas: 0, image: other, note: null } }',
      '        - name: Set',
      '          confirm: Sure?',
      '          type: json',
      '          patch: [{ op: add, path: /spec/note, value: null }]',
      '        - name: Make',
      '          create: { apiVersion: example.com/v1, kind: Widget, metadata: { generateName: w- }, spec: { note: null } }',
    ].join('\n'),
    'nulls.yaml',
  ).plugin!.views.map((view) => view)
  const nulls = asks({
    ...plugins[0]!,
    views: [made!],
    place: undefined,
    groups: ['example.com'],
    shows: [],
  })
  // A text of the file's own that reads as what Lumovi says of something filled in is quoted:
  // only the real one stands bare.
  expect(nulls.actions[0]!.patch).toContain('when: "(now)"')
  expect(nulls.actions[0]!.patch).toContain('then: (now)')
  expect(nulls.actions[0]!.patch).toContain('mix: "(removed) (from the object)"')
  // (Any parenthesis of the file's own, so a near miss can't pass for one either.)
  expect(nulls.actions[0]!.patch).toContain('near: "( Now )"')
  expect(nulls.actions[0]!.undo).toBe('spec:\n  replicas: 0\n  image: other\n  note: (removed)')
  expect(nulls.actions[1]!.patch).toContain('value: null')
  expect(nulls.actions[1]!.json).toBe(true)
  expect(nulls.actions[0]!.json).toBeUndefined()
  expect(nulls.actions[2]!.creates).toContain('note: null')
  // And for every one of Lumovi's: an action is one or the other, and sends something.
  for (const plugin of plugins) {
    for (const action of asks(plugin).actions) {
      expect(['at-once', 'asks'], `${plugin.name}: ${action.name}`).toContain(action.runs)
      expect(action.patch ?? action.creates, `${plugin.name}: ${action.name}`).toBeTruthy()
      expect(`${action.patch}${action.creates}`, `${plugin.name}: ${action.name}`).not.toContain(
        '{{',
      )
    }
  }
})
