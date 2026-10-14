/**
 * A view's action's newer words in a plugin's file (src/shared/plugins.ts): a switch, a choice
 * of labelled values, an input not asked for several (`bulk: false`), an action done to ticked
 * rows (`bulk`) and how its work ends (`ends`); and how Lumovi fills them in and reads an end
 * (src/renderer/src/lib/plugins.ts). Plain data and plain functions: nothing is drawn.
 */
import { expect, test } from '@playwright/test'
import { parsePlugin } from '../../src/shared/plugins.ts'
import { actionEnded, render, renderPatch } from '../../src/renderer/src/lib/plugins.ts'
import type { ViewAction } from '../../src/shared/plugins.ts'

/** A file with one action, its lines as given (each at the action's own indent). */
const withAction = (lines: string) =>
  `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: probe }\nspec:\n  version: 1.0.0\n  needs: { lumovi: 1.0.0 }\n  groups: [example.com]\n  label: Probe\n  kinds: [{ group: example.com, kind: Widget }]\n  views:\n    - kinds: [{ group: example.com, kind: Widget }]\n      actions:\n        - name: Sync\n${lines}`
const problems = (lines: string) => parsePlugin(withAction(lines), 'probe.yaml').problems
const actionOf = (lines: string) =>
  parsePlugin(withAction(lines), 'probe.yaml').plugin!.views[0]!.actions![0]!

const SYNC = `          bulk: true
          patch: { operation: { sync: { revision: '{{ input.revision }}', prune: '{{ input.prune }}', syncStrategy: '{{ input.strategy }}' } } }
          inputs:
            - { name: revision, label: Revision, type: text, default: '', bulk: false }
            - { name: prune, label: Prune, type: switch, default: 'false' }
            - name: strategy
              label: Strategy
              type: choice
              choices: [{ label: Hook, value: { hook: {} } }, { label: Apply, value: { apply: {} } }]
          ends:
            path: .status.operationState.phase
            values:
              - { value: Succeeded, word: Synced, level: healthy }
              - { value: Failed, word: Failed, level: critical }
            message: .status.operationState.message
`

test('a switch, a choice of labelled values, one not asked for several, done to several and how it ends: all said in the file', () => {
  expect(problems(SYNC)).toEqual([])
  const action = actionOf(SYNC)
  expect(action.bulk).toBe(true)
  expect(action.inputs!.map((input) => [input.name, input.type, input.bulk])).toEqual([
    ['revision', 'text', false],
    ['prune', 'switch', undefined],
    ['strategy', 'choice', undefined],
  ])
  expect(action.ends!.values.map((each) => each.word)).toEqual(['Synced', 'Failed'])
})

test('what the file can’t say: choices beside options, a switch that starts as neither, one left out with no default, a create for several, a read input for several, a choice of objects in words', () => {
  const input = (line: string) =>
    problems(
      `          patch: { spec: { a: '{{ input.x }}' } }\n          inputs:\n            - ${line}\n`,
    )
  expect(
    input('{ name: x, label: X, type: choice, options: [a], choices: [{ label: A, value: 1 }] }'),
  ).toEqual([
    expect.stringContaining('a choice needs one of options, choices, or a path to read them from'),
  ])
  expect(input("{ name: x, label: X, type: switch, default: 'maybe' }")).toEqual([
    expect.stringContaining('a switch starts as true or false'),
  ])
  expect(input('{ name: x, label: X, bulk: false }')).toEqual([
    expect.stringContaining('one not asked for several needs a default to fill it in there'),
  ])
  expect(input('{ name: x, label: X, choices: [{ label: A, value: 1 }] }')).toEqual([
    expect.stringContaining('only a choice has options or choices'),
  ])
  expect(
    problems(
      '          bulk: true\n          create: { apiVersion: v1, kind: ConfigMap, metadata: { generateName: x- } }\n',
    ),
  ).toEqual([expect.stringContaining('only a patch is done to several at once, never a create')])
  expect(
    problems(
      "          bulk: true\n          patch: { spec: { a: '{{ input.x }}' } }\n          inputs:\n            - { name: x, label: X, type: choice, from: .spec.choices }\n",
    ),
  ).toEqual([expect.stringContaining('reads its choices off one object: say bulk: false on it')])
  expect(
    problems(
      '          patch: { spec: { a: 1 } }\n          ends: { path: .status.phase, values: [{ value: Done, word: Done, level: fine }] }\n',
    ),
  ).toEqual([expect.stringContaining('level: should be one of')])
  // A choice whose values are objects fills the patch, never what the person reads.
  const strategy =
    '          inputs:\n            - { name: s, label: S, type: choice, choices: [{ label: Hook, value: { hook: {} } }] }\n'
  for (const field of ['confirm', 'confirmTitle', 'confirmButton', 'done']) {
    expect(
      problems(
        `          patch: { spec: { s: '{{ input.s }}' } }\n          ${field}: 'Sync with {{ input.s }}'\n${strategy}`,
      ),
    ).toEqual([
      expect.stringContaining(
        `${field}: {{ input.s }} has values that aren’t words, so it can only fill the patch`,
      ),
    ])
  }
  // Words for values that are words are as before.
  expect(
    problems(
      "          patch: { spec: { s: '{{ input.s }}' } }\n          confirm: 'Sync with {{ input.s }}'\n          inputs:\n            - { name: s, label: S, type: choice, choices: [{ label: Hook, value: hook }] }\n",
    ),
  ).toEqual([])
})

test('filled in: a switch as yes or no, a choice’s value as it is, and in a longer text as its JSON', () => {
  const inputs = { revision: '', prune: true, strategy: { hook: {} } }
  expect(
    renderPatch(
      {
        operation: {
          sync: {
            revision: '{{ input.revision }}',
            prune: '{{ input.prune }}',
            syncStrategy: '{{ input.strategy }}',
          },
        },
      },
      {},
      0,
      inputs,
    ),
  ).toEqual({ operation: { sync: { prune: true, syncStrategy: { hook: {} } } } })
  expect(render('prune {{ input.prune }} with {{ input.strategy }}', {}, 0, inputs)).toBe(
    'prune true with {"hook":{}}',
  )
})

test('how an action’s work ended: none while it’s busy; its word, level and message once it isn’t; nothing for a value it doesn’t name', () => {
  const action = {
    name: 'Sync',
    type: 'merge',
    patch: {},
    busy: [{ when: { path: '.status.operationState.phase', equals: 'Running' }, word: 'Syncing' }],
    ends: {
      path: '.status.operationState.phase',
      values: [
        { value: 'Succeeded', word: 'Synced', level: 'healthy' },
        { value: 'Failed', word: 'Failed', level: 'critical' },
      ],
      message: '.status.operationState.message',
    },
  } as unknown as ViewAction
  const at = (phase: string, message?: string) => ({
    status: { operationState: { phase, ...(message ? { message } : {}) } },
  })
  expect(actionEnded(action, at('Running'))).toBeUndefined()
  expect(actionEnded(action, at('Succeeded'))).toEqual({ word: 'Synced', level: 'healthy' })
  expect(actionEnded(action, at('Failed', 'one or more objects failed to apply'))).toEqual({
    word: 'Failed',
    level: 'critical',
    message: 'one or more objects failed to apply',
  })
  expect(actionEnded(action, at('Terminating'))).toBeUndefined()
  expect(actionEnded(action, at('Failed', 'x'.repeat(600)))!.message).toHaveLength(500)
  expect(actionEnded({ ...action, ends: undefined }, at('Failed'))).toBeUndefined()
})
