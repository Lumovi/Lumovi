/**
 * Changes through the door, as plain functions: what a page's proposal may say and what the door
 * refuses of it, the person's values put in only where the page marked them, each field's words
 * in Lumovi's, a press's token good once and for a moment, and what a plugin may propose at all.
 */
import { expect, test } from '@playwright/test'
import {
  CHANGE_LIMITS,
  changedFields,
  fieldAt,
  fieldWrong,
  filled,
  mayPropose,
  proposalProblem,
  startingValues,
  type Field,
  type Proposed,
} from '../../src/shared/plugin-changes.ts'
import { Tokens } from '../../src/shared/plugin-presses.ts'
import { takenFrom } from '../../src/backend/plugin-changes.ts'

/** A whole proposal: a patch of one field, the size, with what's said otherwise. */
const proposal = (also: Record<string, unknown> = {}, change: Record<string, unknown> = {}) => ({
  propose: 1,
  press: 'p1',
  verb: 'Resize',
  change: {
    action: 'patch',
    target: 'o1',
    patch: { spec: { size: { field: 'size' } } },
    ...change,
  },
  fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 10, value: 3 }],
  ...also,
})
const read = (said: unknown) => {
  const got = proposalProblem(said)
  if (typeof got === 'string') throw new Error(got)
  return got
}

test('a whole proposal is read as it was written: its press, its word, its change and its fields', () => {
  expect(read(proposal())).toEqual({
    id: 1,
    press: 'p1',
    verb: 'Resize',
    action: 'patch',
    target: 'o1',
    body: { spec: { size: { field: 'size' } } },
    fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 10, value: 3 }],
  })
  // A create names its own kind, and maybe an object whose namespace it's made in.
  expect(
    read({
      propose: 2,
      press: 'p1',
      change: {
        action: 'create',
        kind: 'postgresql.cnpg.io/Backup',
        in: 'o2',
        object: { metadata: { generateName: 'nightly-' }, spec: { cluster: { name: 'db' } } },
      },
    }),
  ).toMatchObject({ action: 'create', kind: 'postgresql.cnpg.io/Backup', in: 'o2' })
  // A scale's count, or the field it comes from.
  expect(
    read({ propose: 3, press: 'p1', change: { action: 'scale', target: 'o1', replicas: 2 } })
      .replicas,
  ).toBe(2)
  // A choice's options carry any JSON they put in.
  const choice = read(
    proposal(
      {
        fields: [
          {
            kind: 'choice',
            key: 'how',
            label: 'Strategy',
            options: [
              { label: 'Apply', value: { apply: {} } },
              { label: 'Hook', value: { hook: {} } },
            ],
          },
        ],
      },
      { patch: { syncStrategy: { field: 'how' } } },
    ),
  )
  expect((choice.fields[0] as Extract<Field, { kind: 'choice' }>).options[0]!.value).toEqual({
    apply: {},
  })
})

test('what the door refuses of a proposal, in its own words, quoting nothing the plugin wrote', () => {
  const refused = (said: unknown) => proposalProblem(said)
  expect(refused('propose')).toBe('propose: should be named values')
  expect(refused(proposal({ propose: 0 }))).toMatch(/^propose: should be a whole number/)
  expect(refused(proposal({ press: 'not a token!' }))).toMatch(/^propose\.press:/)
  expect(refused(proposal({}, { action: 'restart' }))).toMatch(
    /^propose\.change\.action: should be one of patch, create, delete, scale/,
  )
  // The button: one line, short, never the way out, and never for a deletion.
  expect(refused(proposal({ verb: 'Cancel' }))).toMatch(/would read as the way out/)
  expect(refused(proposal({ verb: '  don’t ' }))).toMatch(/would read as the way out/)
  expect(refused(proposal({ verb: 'a'.repeat(CHANGE_LIMITS.verb + 1) }))).toMatch(/longer than 24/)
  expect(refused(proposal({ verb: 'Two\nlines' }))).toMatch(/one line/)
  expect(refused(proposal({ verb: 'Delete it' }, { action: 'delete', patch: undefined }))).toBe(
    'propose.verb: a deletion’s button is Lumovi’s own',
  )
  // Fields: at most five, each key once, each going somewhere, each place a field's.
  const five = Array.from({ length: 6 }, (_, i) => ({ kind: 'switch', key: `k${i}`, label: 'L' }))
  expect(refused(proposal({ fields: five }))).toMatch(/longer than 5/)
  expect(
    refused(
      proposal({
        fields: [
          { kind: 'switch', key: 'a', label: 'A' },
          { kind: 'switch', key: 'a', label: 'B' },
        ],
      }),
    ),
  ).toBe('propose.fields: each key once')
  expect(refused(proposal({}, { patch: { spec: { size: 4 } } }))).toBe(
    'propose.fields: size goes nowhere in the change',
  )
  expect(refused(proposal({}, { patch: { spec: { size: { field: 'other' } } } }))).toMatch(
    /names no field other/,
  )
  expect(
    refused(proposal({ fields: [{ kind: 'number', key: 'size', label: 'Size', min: 5, max: 1 }] })),
  ).toMatch(/its min is above its max/)
  expect(
    refused(
      proposal({
        fields: [{ kind: 'text', key: 'size', label: 'x'.repeat(CHANGE_LIMITS.label + 1) }],
      }),
    ),
  ).toMatch(/longer than 40/)
  expect(
    refused(
      proposal({
        fields: [
          { kind: 'choice', key: 'size', label: 'One', options: [{ label: 'only', value: 1 }] },
        ],
      }),
    ),
  ).toMatch(/two at least/)
  expect(
    refused(
      proposal({
        fields: [
          {
            kind: 'choice',
            key: 'size',
            label: 'C',
            options: [{ label: 'a' }, { label: 'b', value: 2 }],
          },
        ],
      }),
    ),
  ).toMatch(/options\[0\]\.value: is required/)
  // Never who owns an object or who managed its fields; never deeper than 20, nor a key longer than 253.
  expect(
    refused(proposal({ fields: [] }, { patch: { metadata: { ownerReferences: [] } } })),
  ).toMatch(/isn’t a plugin’s to write/)
  let deep: unknown = 1
  for (let i = 0; i < 25; i++) deep = { a: deep }
  expect(refused(proposal({ fields: [] }, { patch: deep }))).toMatch(/nested deeper than 20/)
  expect(refused(proposal({ fields: [] }, { patch: { ['k'.repeat(254)]: 1 } }))).toMatch(
    /key longer than 253/,
  )
  // A create: a kind of its own as group/Kind, a name or a generateName, and no namespace of its own.
  const create = (object: unknown, kind = 'example.com/Widget') =>
    refused({ propose: 1, press: 'p1', change: { action: 'create', kind, object } })
  expect(create({ metadata: { name: 'w' } }, '/Secret')).toMatch(/should be a kind of its own/)
  expect(create({ metadata: {} })).toMatch(/a name or a generateName/)
  expect(create({ metadata: { name: 'w', namespace: 'kube-system' } })).toMatch(
    /is Lumovi’s to say/,
  )
})

test('the person’s values go in only where the page marked them, each a value of its kind', () => {
  const proposed = read(
    proposal(
      {
        fields: [
          { kind: 'text', key: 'note', label: 'Note' },
          { kind: 'switch', key: 'prune', label: 'Prune' },
        ],
      },
      { patch: { spec: { note: { field: 'note' }, prune: { field: 'prune' } } } },
    ),
  )
  const values = startingValues(proposed.fields)
  expect(values).toEqual({ note: '', prune: false })
  // A text that holds what JSON quotes, a brace and a line's end stays one string, never more.
  const typed = 'a "b" } c\nd'
  expect(filled(proposed, { ...values, note: typed })).toEqual({
    body: { spec: { note: typed, prune: false } },
  })
  // Nothing while a value is wrong; and nothing past what a proposal may send.
  const sized = read(proposal())
  expect(filled(sized, { size: 11 })).toBe('fields')
  const big = read(
    proposal(
      { fields: [{ kind: 'text', key: 'size', label: 'Big', most: 256 }] },
      { patch: { spec: { size: { field: 'size' }, pad: 'x'.repeat(CHANGE_LIMITS.bytes) } } },
    ),
  )
  expect(filled(big, { size: 'y' })).toBe('too-big')
  // The fields the person changed: what the history keeps, never the values.
  expect(changedFields(proposed.fields, { note: 'hi', prune: false })).toEqual(['note'])
})

test('each field says what’s wrong with it in Lumovi’s words, by its kind', () => {
  const text: Field = { kind: 'text', key: 't', label: 'T', required: true, most: 5 }
  expect(fieldWrong(text, '  ')).toBe('Fill this in.')
  expect(fieldWrong(text, 'abcdef')).toBe('At most 5 characters.')
  expect(fieldWrong(text, 'abc')).toBeUndefined()
  const number: Field = { kind: 'number', key: 'n', label: 'N', min: 1, max: 10 }
  for (const wrong of [undefined, 0, 11, 2.5])
    expect(fieldWrong(number, wrong)).toBe('A whole number from 1 to 10.')
  expect(fieldWrong(number, 10)).toBeUndefined()
  const choice: Field = {
    kind: 'choice',
    key: 'c',
    label: 'C',
    options: [
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ],
  }
  expect(fieldWrong(choice, undefined)).toBe('Choose one.')
  expect(fieldWrong(choice, 1)).toBeUndefined()
  expect(fieldWrong({ kind: 'switch', key: 's', label: 'S' }, true)).toBeUndefined()
})

test('the cluster’s words are said under the field whose place they name', () => {
  const proposed: Proposed = read(
    proposal({}, { patch: { operation: { sync: { revision: { field: 'size' } } } } }),
  )
  expect(fieldAt(proposed, 'operation.sync.revision')).toBe('size')
  expect(fieldAt(proposed, '.operation.sync.revision')).toBe('size')
  expect(fieldAt(proposed, 'spec.other')).toBeUndefined()
  const scaled = read({
    propose: 1,
    press: 'p',
    change: { action: 'scale', target: 'o', replicas: { field: 'n' } },
    fields: [{ kind: 'number', key: 'n', label: 'N', min: 0, max: 5 }],
  })
  expect(fieldAt(scaled, 'spec.replicas')).toBe('n')
})

test('a press’s token is good once, for a moment, and only the latest press’s', () => {
  let made = 0
  const tokens = new Tokens({ objects: 0 }, () => `t${++made}`)
  const first = tokens.pressed(1_000)
  const second = tokens.pressed(2_000)
  // The next press lets go of the one before.
  expect(tokens.spendPress(first, 2_100)).toBe(false)
  expect(tokens.spendPress(second, 2_100)).toBe(true)
  expect(tokens.spendPress(second, 2_200)).toBe(false)
  // Past its moment, or let go (the page hidden), or with the page gone: nothing.
  const late = tokens.pressed(10_000)
  expect(tokens.spendPress(late, 10_000 + CHANGE_LIMITS.pressMs + 1)).toBe(false)
  const hidden = tokens.pressed(20_000)
  tokens.letPressGo()
  expect(tokens.spendPress(hidden, 20_001)).toBe(false)
  const closed = tokens.pressed(30_000)
  tokens.close()
  expect(tokens.spendPress(closed, 30_001)).toBe(false)
})

test('a plugin proposes only what its file says, and never to one of Kubernetes’ own kinds', () => {
  const changes = [
    { kind: 'argoproj.io/Application', actions: ['patch', 'delete'] as const },
  ] as const
  expect(mayPropose('argoproj.io/Application', 'patch', changes)).toBe(true)
  expect(mayPropose('argoproj.io/Application', 'create', changes)).toBe(false)
  expect(mayPropose('argoproj.io/AppProject', 'patch', changes)).toBe(false)
  for (const kind of [
    '/Secret',
    'apps/Deployment',
    'rbac.authorization.k8s.io/Role',
    'batch/Job',
  ]) {
    expect(mayPropose(kind, 'patch', [{ kind, actions: ['patch'] }]), kind).toBe(false)
  }
  // (A group of a project of Kubernetes' that isn't its own API is a plugin's to claim.)
  expect(
    mayPropose('cluster.x-k8s.io/Cluster', 'patch', [
      { kind: 'cluster.x-k8s.io/Cluster', actions: ['patch'] },
    ]),
  ).toBe(true)
})

test('whose fields a patch would take, read from the cluster’s own words', () => {
  expect(
    takenFrom(
      'Apply failed with 2 conflicts: conflict with "argocd-application-controller" using argoproj.io/v1alpha1: .operation\nconflict with "helm" using argoproj.io/v1alpha1: .spec.source.targetRevision',
    ),
  ).toEqual([
    { manager: 'argocd-application-controller', field: 'operation' },
    { manager: 'helm', field: 'spec.source.targetRevision' },
  ])
  expect(takenFrom('something else')).toEqual([])
})
