/**
 * KubeStacks' own views and add-ons, checked against the CRDs of the
 * operators they're for (tests/views/crds, fetched by `npm run crds`): every
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
  EXPRESSION,
  parseViews,
  PLACEHOLDER,
  type AddOn,
  type Condition,
  type View,
} from '../../src/renderer/src/lib/views.ts'
import type { Crd, Shape } from '../../scripts/crds.ts'

const VIEWS = 'src/renderer/src/views'
const CRDS = 'tests/views/crds'

const sources = JSON.parse(readFileSync(join(CRDS, 'sources.json'), 'utf8')) as Record<
  string,
  { version: string }
>

/** Every CRD kept here, by the name KubeStacks gives its kind, with where it came from. */
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
const addOns: AddOn[] = []
const parseProblems: string[] = []
for (const file of readdirSync(VIEWS).filter((f) => f.endsWith('.yaml'))) {
  const parsed = parseViews(readFileSync(join(VIEWS, file), 'utf8'), file)
  views.push(...parsed.views)
  addOns.push(...parsed.addOns)
  parseProblems.push(...parsed.problems)
}

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

/** A kind KubeStacks can show: built in, one of Kubernetes' others, or a CRD kept here. */
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

test('KubeStacks’ views and add-ons are all valid', () => {
  expect(parseProblems).toEqual([])
})

test('every add-on is checked against its operator’s CRDs, and names their kinds', () => {
  const problems: string[] = []
  for (const addOn of addOns) {
    if (!(addOn.name in sources)) {
      problems.push(`${addOn.source}: add-on ${addOn.name} has no CRDs in ${CRDS}/sources.json`)
      continue
    }
    // (Every kind of a group, `*.group`, are made by the tool, and not known until they are.)
    for (const kind of addOn.kinds.filter((k) => !k.startsWith('*.'))) {
      if (!crds.get(kind)?.from.startsWith(`${addOn.name} `)) {
        problems.push(`${addOn.source}: add-on ${addOn.name} names ${kind}, which its CRDs don’t`)
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
