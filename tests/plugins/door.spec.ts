/**
 * The door, tried with what a plugin's code might send, a hostile one's included: a part's
 * declaration and what's checked against it, and the page a plugin describes. Plain functions,
 * so nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  choice,
  handler,
  list,
  number,
  object,
  oneOf,
  record,
  text,
  time,
  wrongWith,
  wrongWithFields,
  wrongWithPart,
  yesOrNo,
  type Part,
} from '../../src/shared/kit/declare.ts'
import { DOOR_LIMITS, PluginPage, ROOT, type Stopped } from '../../src/shared/plugin-door.ts'

const PARTS: Record<string, Part> = {
  Stack: { name: 'Stack', holds: 'parts', props: { gap: number(0, 8, true) } },
  Label: { name: 'Label', holds: 'text', props: { tone: oneOf(['plain', 'quiet']) } },
  Row: { name: 'Row', holds: ['Label'], props: {} },
  Button: {
    name: 'Button',
    holds: 'nothing',
    props: { label: text(80), onPress: handler('press'), of: object },
    required: ['label'],
    events: { press: {} },
  },
}

/** A page with a fixed clock, and `send` for a commit's steps. */
function page(clock = { now: 0 }) {
  const page = new PluginPage(PARTS, () => clock.now)
  const send = (...steps: unknown[]) => page.take(JSON.stringify({ commit: steps }))
  return { page, send, clock }
}

const stopped = (result: unknown): Stopped => {
  expect(result).toHaveProperty('why')
  return result as Stopped
}

test.describe('a value against its kind', () => {
  const cases: [string, Parameters<typeof wrongWith>[1], unknown[], unknown[]][] = [
    ['text', text(5), ['', 'hello'], ['hello!', 5, null, ['a'], {}]],
    ['number', number(0, 10), [0, 2.5, 10], [-1, 11, '3', Number.NaN, null]],
    ['whole number', number(0, 10, true), [3], [2.5]],
    ['yes or no', yesOrNo, [true, false], [0, 'true', null]],
    ['one of', oneOf(['a', 'b']), ['a'], ['c', 'toString', 1, null]],
    ['time', time, ['2026-10-12T08:30:00Z'], ['yesterday', '2026-13-40T99:00:00Z', 5]],
    ['object', object, ['o_1-A'], ['', 'a b', '../x', 'x'.repeat(65), { kind: 'Pod' }]],
    ['handler', handler('press'), ['h7'], ['() => 1', 7, null]],
    ['list', list(text(3), 2), [[], ['a', 'b']], [['a', 'b', 'c'], ['long'], 'ab', { 0: 'a' }]],
    [
      'record',
      record({ name: text(10), size: number(0, 5) }, ['name']),
      [{ name: 'a' }, { name: 'a', size: 1 }],
      [{}, { size: 1 }, { name: 'a', other: 1 }, [], null, 'a'],
    ],
    [
      'choice',
      choice('kind', { none: {}, text: { value: text(5) } }),
      [{ kind: 'none' }, { kind: 'text', value: 'a' }],
      [
        {},
        { kind: 'other' },
        { kind: 'text' },
        { kind: 'none', value: 'a' },
        { kind: 'constructor' },
      ],
    ],
  ]
  for (const [name, kind, right, wrong] of cases) {
    test(name, () => {
      for (const value of right)
        expect(wrongWith(value, kind, 'it'), JSON.stringify(value)).toBeUndefined()
      for (const value of wrong)
        expect(wrongWith(value, kind, 'it'), JSON.stringify(value)).toMatch(/^it/)
    })
  }

  test('a name every object has is never a property', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const value = JSON.parse(`{"${key}": "a"}`) as unknown
      expect(wrongWithFields(value, { [key]: text(5) }, [], 'Part')).toBe(
        `Part.${key}: isn’t something it takes`,
      )
    }
  })

  test('a value nested deeper than anything a part takes is refused, not followed', () => {
    let kind = text(5)
    let value: unknown = 'a'
    for (let i = 0; i < 40; i++) {
      kind = list(kind, 1)
      value = [value]
    }
    expect(wrongWith(value, kind, 'it')).toContain('nested deeper')
  })
})

test.describe('a part’s declaration', () => {
  test('the parts here are declared rightly', () => {
    for (const part of Object.values(PARTS)) expect(wrongWithPart(part)).toBeUndefined()
  })

  test('a careless one is named', () => {
    const wrong: Part[] = [
      { name: 'two words', holds: 'parts', props: {} },
      { name: 'A', holds: 'nothing', props: { label: text(0) } },
      { name: 'A', holds: 'nothing', props: { size: number(5, 1) } },
      { name: 'A', holds: 'nothing', props: { tone: oneOf([]) } },
      { name: 'A', holds: 'nothing', props: { onPress: handler('press') } },
      { name: 'A', holds: 'nothing', props: {}, required: ['label'] },
    ]
    for (const part of wrong) expect(wrongWithPart(part), JSON.stringify(part)).toBeTruthy()
  })
})

test.describe('a plugin’s page', () => {
  test('is what its plugin described: parts, their properties, texts, in order', () => {
    const { page, send } = page_()
    expect(
      send(
        ['make', 1, 'Stack', { gap: 2 }],
        ['make', 2, 'Label', { tone: 'quiet' }],
        ['text', 3, 'Nodes'],
        ['put', 2, 3],
        ['make', 4, 'Button', { label: 'Refresh', onPress: 'h1' }],
        ['put', 1, 4],
        ['put', 1, 2, 4],
        ['put', ROOT, 1],
      ),
    ).toEqual({ changed: [2, 1, ROOT] })
    expect(page.node(ROOT)?.children).toEqual([1])
    expect(page.node(1)).toMatchObject({ part: 'Stack', props: { gap: 2 }, children: [2, 4] })
    expect(page.node(3)?.text).toBe('Nodes')
    expect(page.holds.nodes).toBe(4)
  })

  test('changes: a text, a part’s properties, the order, and what’s taken away is gone whole', () => {
    const { page, send } = page_()
    send(
      ['make', 1, 'Stack', {}],
      ['put', ROOT, 1],
      ['make', 2, 'Label', {}],
      ['text', 3, 'a'],
      ['put', 2, 3],
      ['put', 1, 2],
      ['make', 4, 'Button', { label: 'b' }],
      ['put', 1, 4],
    )
    const before = page.holds.characters
    expect(send(['text', 3, 'abc'], ['change', 4, { label: 'bcd' }])).toEqual({ changed: [3, 4] })
    expect(page.holds.characters).toBe(before + 4)
    expect(page.node(4)?.props).toEqual({ label: 'bcd' })
    // Moved: to the end, and back before the other.
    send(['put', 1, 2])
    expect(page.node(1)?.children).toEqual([4, 2])
    send(['put', 1, 2, 4])
    expect(page.node(1)?.children).toEqual([2, 4])
    // Taken away, with the text under it; what was changed and then taken isn't to be drawn.
    expect(send(['text', 3, 'x'], ['take', 1, 2])).toEqual({ changed: [1] })
    expect(page.node(2)).toBeUndefined()
    expect(page.node(3)).toBeUndefined()
    expect(page.holds.nodes).toBe(2)
    expect(page.stopped).toBeUndefined()
  })

  test('a message that isn’t a commit stops it', () => {
    const messages: unknown[] = [
      '',
      '{',
      'null',
      '[]',
      '"commit"',
      '{}',
      '{"commit": {}}',
      '{"commit": [], "more": 1}',
      '{"commit": [], "__proto__": {}}',
      '{"__proto__": {"commit": []}}',
      '{"commit": [5]}',
      '{"commit": [[]]}',
      '{"commit": [[1, 2]]}',
      '{"commit": [["eval", "1"]]}',
      '{"commit": [["make", 1, "Stack"]]}',
      '{"commit": [["make", 1, "Stack", {}, 1]]}',
      '{"commit": [["put", 0]]}',
      5,
      { commit: [] },
    ]
    for (const message of messages) {
      const page = new PluginPage(PARTS, () => 0)
      const result = stopped(page.take(message as string))
      expect(result.why, String(message)).toBe('not-allowed')
      expect(page.stopped).toEqual(result)
    }
  })

  test('once stopped it takes nothing more, and says the same', () => {
    const { page, send } = page_()
    const first = stopped(send(['make', 1, 'Nothing', {}]))
    expect(first).toEqual({ why: 'not-allowed', what: 'step 1: names a part Lumovi doesn’t have' })
    expect(send(['make', 1, 'Stack', {}])).toEqual(first)
    expect(page.node(1)).toBeUndefined()
  })

  test('a part gets only what’s declared for it', () => {
    const wrong: unknown[][] = [
      ['make', 1, 'Stack', { gap: 9 }],
      ['make', 1, 'Stack', { style: 'color: red' }],
      ['make', 1, 'Stack', { dangerouslySetInnerHTML: { __html: '<img>' } }],
      ['make', 1, 'Stack', null],
      ['make', 1, 'Stack', []],
      ['make', 1, 'Button', {}],
      ['make', 1, 'Button', { label: 'a', onPress: 'javascript:alert(1)' }],
      ['make', 1, 'Button', { label: 'a', of: { kind: 'Secret', name: 'a' } }],
      ['make', 1, 'toString', {}],
      ['make', 1, 'constructor', {}],
      ['make', 1, 5, {}],
    ]
    for (const step of wrong) {
      expect(stopped(page_().send(step)).why, JSON.stringify(step)).toBe('not-allowed')
    }
    // And a change is checked as a making is.
    const { send } = page_()
    send(['make', 1, 'Stack', {}])
    expect(stopped(send(['change', 1, { gap: 2, onPress: 'h1' }])).what).toBe(
      'step 1: Stack.onPress: isn’t something it takes',
    )
  })

  test('a number is new once, and only a whole one above nothing', () => {
    for (const id of [0, -1, 1.5, '1', null, 2 ** 53, [1]]) {
      expect(stopped(page_().send(['make', id, 'Stack', {}])).why, String(id)).toBe('not-allowed')
    }
    const { send } = page_()
    send(['make', 5, 'Stack', {}])
    expect(stopped(send(['make', 5, 'Stack', {}])).what).toContain('isn’t new')
    // Not one that was passed over, nor one whose part is gone.
    expect(stopped(page_().send(['make', 5, 'Stack', {}], ['make', 4, 'Stack', {}])).why).toBe(
      'not-allowed',
    )
    expect(
      stopped(
        page_().send(
          ['make', 1, 'Stack', {}],
          ['put', ROOT, 1],
          ['take', ROOT, 1],
          ['make', 1, 'Stack', {}],
        ),
      ).why,
    ).toBe('not-allowed')
  })

  test('one parent, no loop, and only what a part holds', () => {
    const base: unknown[][] = [
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Stack', {}],
      ['make', 3, 'Label', {}],
      ['text', 4, 'a'],
      ['make', 5, 'Row', {}],
      ['make', 6, 'Button', { label: 'a' }],
      ['put', 1, 2],
    ]
    const wrong: [unknown[], string][] = [
      [['put', 1, 1], 'under itself'],
      [['put', 2, 1], 'under itself'],
      [['put', ROOT, 2], 'under another'],
      [['put', 1, 4], 'doesn’t hold'],
      [['put', ROOT, 4], 'doesn’t hold'],
      [['put', 3, 6], 'doesn’t hold'],
      [['put', 5, 6], 'doesn’t hold'],
      [['put', 6, 3], 'doesn’t hold'],
      [['put', 4, 3], 'doesn’t hold'],
      [['put', 1, 9], 'isn’t there'],
      [['put', 9, 1], 'isn’t there'],
      [['put', '0', 1], 'isn’t there'],
      [['put', 1, 3, 6], 'isn’t beside it'],
      [['put', 1, 3, 3], 'isn’t beside it'],
      [['put', 1, 3, 'x'], 'isn’t beside it'],
      [['take', 1, 3], 'isn’t there'],
      [['take', 2, 2], 'isn’t there'],
      [['take', 9, 2], 'isn’t there'],
      [['text', 1, 'a'], 'isn’t a text'],
      [['text', 4, 5], 'isn’t text'],
      [['change', 4, {}], 'isn’t a part'],
      [['change', ROOT, {}], 'isn’t a part'],
      [['change', 9, {}], 'isn’t a part'],
    ]
    for (const [step, what] of wrong) {
      const result = stopped(page_().send(...base, step))
      expect(result.why, JSON.stringify(step)).toBe('not-allowed')
      expect(result.what, JSON.stringify(step)).toContain(what)
    }
    // What a Row holds by name, it holds.
    expect(page_().send(...base, ['put', 5, 3])).toEqual({ changed: [1, 5] })
  })

  test('over a ceiling it’s stopped: a message, a commit’s steps, a text', () => {
    const { page } = page_()
    expect(stopped(page.take(' '.repeat(DOOR_LIMITS.message + 1)))).toEqual({
      why: 'too-much',
      what: 'a message: more than 1,048,576',
    })
    const steps = Array.from({ length: DOOR_LIMITS.stepsACommit + 1 }, (_, i) => [
      'text',
      i + 1,
      '',
    ])
    expect(stopped(page_().send(...steps)).what).toBe('the steps of a commit: more than 2,000')
    expect(page_().send(...steps.slice(1))).toEqual({ changed: [] })
    expect(page_().send(['text', 1, 'a'.repeat(DOOR_LIMITS.text)])).toEqual({ changed: [] })
    expect(stopped(page_().send(['text', 1, 'a'.repeat(DOOR_LIMITS.text + 1)])).what).toBe(
      'step 1: a text: more than 4,000',
    )
  })

  test('over a ceiling it’s stopped: commits and steps in a second, by Lumovi’s clock', () => {
    const { send, clock } = page_()
    for (let i = 0; i < DOOR_LIMITS.commitsASecond; i++) expect(send()).toEqual({ changed: [] })
    // The next second starts the count again.
    clock.now = 1000
    for (let i = 0; i < DOOR_LIMITS.commitsASecond; i++) expect(send()).toEqual({ changed: [] })
    clock.now = 1999
    expect(stopped(send()).what).toBe('commits in a second: more than 60')

    const other = page_()
    const full = Array.from({ length: DOOR_LIMITS.stepsACommit }, () => ['text', 1, ''])
    expect(other.send(['text', 1, ''])).toEqual({ changed: [] })
    other.clock.now = 5000
    for (let i = 0; i < DOOR_LIMITS.stepsASecond / DOOR_LIMITS.stepsACommit; i++) {
      expect(other.send(...full)).toEqual({ changed: [1] })
    }
    expect(stopped(other.send(['text', 1, ''])).what).toBe('steps in a second: more than 20,000')
  })

  test('over a ceiling it’s stopped: how many parts, and they’re counted off the page too', () => {
    const { page, send, clock } = page_()
    let id = 0
    while (id < DOOR_LIMITS.nodes) {
      clock.now += 1000
      const some = Array.from({ length: 1000 }, () => ['make', ++id, 'Stack', {}])
      expect(send(...some)).toEqual({ changed: [] })
    }
    expect(page.holds.nodes).toBe(DOOR_LIMITS.nodes)
    expect(stopped(send(['text', ++id, ''])).what).toBe('step 1: a page’s parts: more than 5,000')
  })

  test('over a ceiling it’s stopped: all a page holds, a changed text and property counted', () => {
    const { page, send, clock } = page_()
    const full = 'a'.repeat(DOOR_LIMITS.text)
    const texts = Math.floor(DOOR_LIMITS.held / DOOR_LIMITS.text)
    let id = 0
    while (id < texts) {
      clock.now += 1000
      expect(send(...Array.from({ length: 131 }, () => ['text', ++id, full]))).toEqual({
        changed: [],
      })
    }
    // 524 texts of 4,000: 1,152 characters are left.
    expect(DOOR_LIMITS.held - page.holds.characters).toBe(1152)
    clock.now += 1000
    expect(
      send(['text', ++id, 'a'.repeat(1152)], ['text', id, ''], ['make', ++id, 'Stack', {}]),
    ).toEqual({
      changed: [id - 1],
    })
    expect(stopped(send(['text', id - 1, 'a'.repeat(1151)])).what).toBe(
      'step 1: what a page holds: more than 2,097,152',
    )
    // A part's properties count as a text does: 1,152 left, less the 12 of a button with no label.
    const other = page_()
    let made = 0
    while (made < texts) {
      other.clock.now += 1000
      other.send(...Array.from({ length: 131 }, () => ['text', ++made, full]))
    }
    other.clock.now += 1000
    expect(
      other.send(['make', 1000, 'Button', { label: '' }], ['text', 1001, 'a'.repeat(1000)]),
    ).toEqual({
      changed: [],
    })
    expect(other.send(['change', 1000, { label: 'a'.repeat(80), of: 'o'.repeat(52) }])).toEqual({
      changed: [1000],
    })
    expect(DOOR_LIMITS.held - other.page.holds.characters).toBe(0)
    const result = other.send(['change', 1000, { label: 'a'.repeat(80), of: 'o'.repeat(53) }])
    expect(stopped(result).why).toBe('too-much')
  })

  test('over a ceiling it’s stopped: how deep, however the page is put together', () => {
    // From the top down: the 32nd level is the last.
    const down = page_()
    const makes = Array.from({ length: DOOR_LIMITS.depth + 1 }, (_, i) => [
      'make',
      i + 1,
      'Stack',
      {},
    ])
    expect(down.send(...makes, ['put', ROOT, 1])).toEqual({ changed: [ROOT] })
    for (let i = 1; i < DOOR_LIMITS.depth; i++)
      expect(down.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(down.send(['put', DOOR_LIMITS.depth, DOOR_LIMITS.depth + 1])).what).toBe(
      'step 1: how deep a page goes: more than 32',
    )

    // From the bottom up, off the page: stopped as it would go on.
    const up = page_()
    up.send(...makes)
    for (let i = DOOR_LIMITS.depth; i > 0; i--)
      expect(up.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(up.send(['put', ROOT, 1])).what).toBe(
      'step 1: how deep a page goes: more than 32',
    )

    // Two halves, each allowed, joined in the middle.
    const halves = page_()
    halves.send(...makes, ['make', 40, 'Stack', {}], ['put', ROOT, 1])
    for (let i = 1; i < 20; i++) halves.send(['put', i, i + 1])
    for (let i = 21; i < DOOR_LIMITS.depth + 1; i++) halves.send(['put', i, i + 1])
    expect(halves.page.stopped).toBeUndefined()
    expect(stopped(halves.send(['put', 20, 21])).why).toBe('too-much')

    // And what's taken away makes room again.
    const room = page_()
    room.send(...makes, ['make', 40, 'Stack', {}], ['put', ROOT, 1])
    for (let i = 1; i < DOOR_LIMITS.depth; i++) room.send(['put', i, i + 1])
    expect(room.send(['take', 20, 21], ['put', 20, 40])).toEqual({ changed: [20] })
  })
})

function page_() {
  return page()
}
