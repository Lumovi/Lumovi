/**
 * A view's action's own question and button, and its busy states, as a file says them: only an
 * action that asks first has a question and a button of its own, each one line and short, and a
 * busy word is short too. And what a person is told of an action: the status fields it writes on
 * the object itself, and its question and button as the file writes them.
 */
import { expect, test } from '@playwright/test'
import { asks } from '../../src/shared/plugin-asks.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'

/** A plugin of one view, of widgets, with these actions (each a YAML line or more). */
const file = (...actions: string[]) =>
  [
    'apiVersion: lumovi.dev/v1beta1',
    'kind: Plugin',
    'metadata: { name: probe }',
    'spec:',
    '  version: 1.0.0',
    '  needs: { lumovi: 1.0.0 }',
    '  groups: [example.com]',
    '  views:',
    '    - name: widgets',
    '      kinds: [{ group: example.com, kind: Widget }]',
    '      actions:',
    ...actions.map((action) => `        - ${action}`),
  ].join('\n')
const read = (...actions: string[]) =>
  parsePlugin(file(...actions), 'probe.yaml', { lumovisOwn: [] })
const said = (...actions: string[]) =>
  read(...actions).problems.map((line) => line.replace(/^probe\.yaml: spec\.views\[0\]\./, ''))

test('an action that asks first can ask its own question and name its own button: one line each, and short', () => {
  expect(
    said(
      `{ name: Stop, confirm: It stops., confirmTitle: 'Stop {{ .metadata.name }}?', confirmButton: Stop it, patch: { spec: { a: 1 } } }`,
      `{ name: Size, inputs: [{ name: n, label: N }], confirmTitle: Size it?, patch: { spec: { n: '{{ input.n }}' } } }`,
    ),
  ).toEqual([])
  // Where it doesn't ask, there's no question: the file's refused, and says why.
  expect(
    said(`{ name: Poke, runs: at-once, confirmTitle: Poke it?, patch: { spec: { a: 1 } } }`),
  ).toEqual([
    'actions[0]: confirmTitle: only an action that asks first (with confirm or inputs) has one',
  ])
  expect(
    said(`{ name: Poke, runs: at-once, confirmButton: Poke, patch: { spec: { a: 1 } } }`),
  ).toEqual([
    'actions[0]: confirmButton: only an action that asks first (with confirm or inputs) has one',
  ])
  expect(
    said(`{ name: Stop, confirm: Sure., confirmTitle: "Stop\\nit?", patch: { spec: { a: 1 } } }`),
  ).toEqual(['actions[0]: confirmTitle: should be one line'])
  const title = `${'a'.repeat(80)}?`
  expect(
    said(`{ name: Stop, confirm: Sure., confirmTitle: ${title}, patch: { spec: { a: 1 } } }`),
  ).toEqual(['actions[0]: confirmTitle: is longer than 80 characters'])
  expect(
    said(
      `{ name: Stop, confirm: Sure., confirmButton: ${'b'.repeat(25)}, patch: { spec: { a: 1 } } }`,
    ),
  ).toEqual(['actions[0]: confirmButton: is longer than 24 characters'])
  // Up to its limit, it's taken.
  expect(
    said(
      `{ name: Stop, confirm: Sure., confirmTitle: ${'a'.repeat(79)}?, confirmButton: ${'b'.repeat(24)}, patch: { spec: { a: 1 } } }`,
    ),
  ).toEqual([])
})

test('an action can say it’s busy, the first of its states that holds: each with a short word, and where it says, since when', () => {
  const busy = (states: string) =>
    said(
      `{ name: Polish, runs: at-once, when: { path: .spec.polishing, exists: false }, busy: ${states}, patch: { spec: { polishing: true } } }`,
    )
  expect(
    busy(
      `[{ when: { path: .status.started, exists: true }, word: Polishing, since: .status.started }, { when: { path: .spec.polishing, exists: true }, word: Polishing }]`,
    ),
  ).toEqual([])
  expect(
    busy(`[{ when: { path: .spec.polishing, exists: true }, word: ${'w'.repeat(25)} }]`),
  ).toEqual(['actions[0]: busy[0].word: is longer than 24 characters'])
  // A state needs both what holds and its word.
  expect(busy(`[{ word: Polishing }]`)).not.toEqual([])
  expect(busy(`[{ when: { path: .spec.polishing, exists: true } }]`)).not.toEqual([])
  expect(busy(`[]`)).not.toEqual([])
})

test('a person is told which status fields an action writes on the object itself, and its own question and button', () => {
  const { plugin } = read(
    `{ name: Terminate sync, when: { path: .status.phase, equals: Running }, confirm: It stops., confirmTitle: 'Terminate {{ .metadata.name }}’s sync?', patch: { status: { operationState: { phase: Terminating } } } }`,
    `{ name: Mark, confirm: Sure., type: json, patch: [{ op: replace, path: /status/marked, value: true }, { op: add, path: /spec/a, value: 1 }] }`,
    `{ name: Ready, confirm: Sure., subresource: status, patch: { status: { ready: true } } }`,
    `{ name: Label, runs: at-once, patch: { metadata: { labels: { a: b } } } }`,
  )
  const actions = asks(plugin!).actions
  expect(actions.map(({ name, writesStatus }) => [name, writesStatus])).toEqual([
    ['Terminate sync', ['status.operationState.phase']],
    ['Mark', ['status.marked']],
    // (Through the status subresource: said as that, not as a write of the object itself.)
    ['Ready', undefined],
    ['Label', undefined],
  ])
  expect(actions[0]).toMatchObject({
    confirmTitle: 'Terminate {{ .metadata.name }}’s sync?',
    runs: 'asks',
  })
  expect(actions[0]!.confirmButton).toBeUndefined()
  expect(actions[2]!.status).toBe(true)
})

test('an action that writes an object’s status on the object itself asks first, as a merge or a JSON patch; and no file sends a version of its own', () => {
  const line = 'actions[0]: writes the object’s status, so it has to ask first: give it confirm'
  expect(said(`{ name: Mark, runs: at-once, patch: { status: { marked: true } } }`)).toEqual([line])
  expect(
    said(
      `{ name: Mark, runs: at-once, type: json, patch: [{ op: replace, path: /status/marked, value: true }] }`,
    ),
  ).toEqual([line])
  // (Through the status subresource it's another permission, said as that: it may run at once.)
  expect(
    said(`{ name: Mark, runs: at-once, subresource: status, patch: { status: { marked: true } } }`),
  ).toEqual([])
  expect(said(`{ name: Mark, confirm: Sure., patch: { status: { marked: true } } }`)).toEqual([])
  // The version a change goes with is Lumovi's to say: a file that names one is refused.
  expect(
    said(
      `{ name: Pin, when: { path: .spec.a, exists: true }, confirm: Sure., patch: { metadata: { resourceVersion: '1' }, spec: { a: 2 } } }`,
    ),
  ).toEqual(['actions[0]: changes metadata.resourceVersion, which a plugin can’t change'])
  expect(
    said(
      `{ name: Pin, confirm: Sure., type: json, patch: [{ op: test, path: /metadata/resourceVersion, value: '1' }] }`,
    ),
  ).toEqual(['actions[0]: changes metadata.resourceVersion, which a plugin can’t change'])
})

test('an action can say what must still be as the person saw it when it’s sent: up to four paths, told to the person', () => {
  const same = (paths: string) =>
    said(
      `{ name: Stop, when: { path: .status.phase, equals: Running }, same: ${paths}, confirm: Sure., patch: { status: { phase: Stopping } } }`,
    )
  expect(same('[.status.startedAt]')).toEqual([])
  expect(same('[.a, .b, .c, .d]')).toEqual([])
  expect(same('[.a, .b, .c, .d, .e]')).not.toEqual([])
  expect(same('[]')).not.toEqual([])
  const { plugin } = read(
    `{ name: Stop, when: { path: .status.phase, equals: Running }, same: [.status.startedAt, .operation], confirm: Sure., patch: { status: { phase: Stopping } } }`,
  )
  expect(asks(plugin!).actions[0]!.same).toEqual(['.status.startedAt', '.operation'])
})
