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
  shared,
  text,
  time,
  handedFields,
  wrongWith,
  wrongWithFields,
  wrongWithPart,
  wrongWithParts,
  yesOrNo,
  type Kind,
  type Part,
} from '../../src/shared/kit/declare.ts'
import { DOOR_LIMITS, DoorPage, ROOT, type Stopped } from '../../src/shared/plugin-door.ts'

const CARDS = shared('Card and Tag parts', 20)

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
  /** One a page may have only two of. */
  Badge: { name: 'Badge', holds: 'nothing', props: {}, most: 2 },
  /** Two a page may have twenty of between them (each naming the ceiling for itself). */
  Card: { name: 'Card', holds: 'nothing', props: {}, counts: CARDS },
  Tag: { name: 'Tag', holds: 'nothing', props: {}, counts: shared('Card and Tag parts', 20) },
}

/** A page with a fixed clock, and `send` for a commit's steps. */
function page(clock = { now: 0 }) {
  const page = new DoorPage(PARTS, () => clock.now)
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
        `Part: takes nothing named "${key}"`,
      )
    }
  })

  test('a value nested deeper than anything a part takes is refused, not followed', () => {
    let kind: Kind = text(5)
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
    expect(wrongWithParts(PARTS)).toBeUndefined()
  })

  test('a careless one is named', () => {
    const wrong: Part[] = [
      { name: 'two words', holds: 'parts', props: {} },
      { name: 'A', holds: 'nothing', props: { label: text(0) } },
      { name: 'A', holds: 'nothing', props: { size: number(5, 1) } },
      { name: 'A', holds: 'nothing', props: { tone: oneOf([]) } },
      { name: 'A', holds: 'nothing', props: { onPress: handler('press') } },
      { name: 'A', holds: 'nothing', props: {}, required: ['label'] },
      { name: 'A', holds: 'nothing', props: {}, most: 0 },
      { name: 'A', holds: 'nothing', props: {}, most: 1.5 },
      { name: 'A', holds: 'nothing', props: {}, counts: shared('A parts', 0) },
    ]
    for (const part of wrong) expect(wrongWithPart(part), JSON.stringify(part)).toBeTruthy()
    // Said with where it is: a list, a choice, a property's name, an event, and what it carries.
    const named: [Part, string][] = [
      [
        { name: 'A', holds: 'nothing', props: { rows: list(text(3), 0) } },
        'A.rows: a list needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('two words', { a: {} }) } },
        'A.cell: two words isn’t a property’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', {}) } },
        'A.cell: chooses between nothing',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', { a: { kind: text(3) } }) } },
        'A.cell.a: declares kind itself',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', { a: { value: text(0) } }) } },
        'A.cell.a.value: a text needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: { 'two words': text(3) } },
        'A.two words: isn’t a property’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { 'two words': {} } },
        'A: two words isn’t an event’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { press: { row: text(0) } } },
        'A.press.row: a text needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { press: { then: handler('press') } } },
        'A.press: a call can’t carry a handler',
      ],
    ]
    for (const [part, said] of named) expect(wrongWithPart(part)).toBe(said)
    // And one declared deeper than anything is checked; and a choice declared rightly.
    let deep: Kind = text(5)
    for (let i = 0; i < 40; i++) deep = list(deep, 1)
    expect(wrongWithPart({ name: 'A', holds: 'nothing', props: { deep } })).toContain(
      'declared deeper',
    )
    expect(
      wrongWithPart({
        name: 'A',
        holds: 'nothing',
        props: { cell: choice('kind', { none: {}, text: { value: text(5) } }) },
      }),
    ).toBeUndefined()
    // Together: a shared ceiling that says two things.
    const chip = {
      name: 'Chip',
      holds: 'nothing',
      props: {},
      counts: shared('Card and Tag parts', 21),
    }
    const said =
      'Chip: Card and Tag parts is 21 here and 20 where Card names it, and a shared ceiling has one number'
    expect(wrongWithParts({ ...PARTS, Chip: chip } as Record<string, Part>)).toBe(said)
    // And the door starts no page with them.
    expect(() => new DoorPage({ ...PARTS, Chip: chip } as Record<string, Part>)).toThrow(
      `Lumovi’s own parts are declared wrongly: ${said}`,
    )
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

  test('says which commit last changed what’s drawn of each part and text, and only ever later', () => {
    const { page, send } = page_()
    send(
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Label', {}],
      ['text', 3, 'a'],
      ['put', 2, 3],
      ['put', 1, 2],
      ['make', 4, 'Button', { label: 'b' }],
      ['put', 1, 4],
      ['put', ROOT, 1],
    )
    // Made and put in this commit: the parts things were put into are changed by it; a part or a
    // text made in it, and changed by nothing since, by none.
    expect([ROOT, 1, 2, 3, 4].map((id) => page.changedAt(id))).toEqual([1, 1, 1, 0, 0])
    // Each later commit stamps what it changed, and only that.
    send(['text', 3, 'abc'])
    send(['change', 4, { label: 'bcd' }])
    expect([ROOT, 1, 2, 3, 4].map((id) => page.changedAt(id))).toEqual([1, 1, 1, 2, 3])
    send(['put', 1, 2])
    expect(page.changedAt(1)).toBe(4)
    // One that's taken away is no more: nothing of it is kept.
    send(['take', 1, 2])
    expect([1, 2, 3].map((id) => page.changedAt(id))).toEqual([5, 0, 0])
    // A commit that stops the page stamps nothing.
    stopped(send(['change', 4, { label: 7 }]))
    expect(page.changedAt(4)).toBe(3)
  })

  test('has no more of a part than its declaration lets a page have: made and not taken away', () => {
    const { page, send } = page_()
    send(['make', 1, 'Stack', {}], ['put', ROOT, 1], ['make', 2, 'Badge', {}], ['put', 1, 2])
    // One more, even made and never put anywhere, is the last it may have.
    send(['make', 3, 'Badge', {}])
    // One taken away makes room for another, wherever it was.
    send(['take', 1, 2], ['make', 4, 'Badge', {}], ['put', 1, 4])
    send(['take', null, 3], ['make', 5, 'Badge', {}])
    // And with the part that held one, that one goes too.
    send(['take', ROOT, 1], ['make', 6, 'Badge', {}])
    expect(page.stopped).toBeUndefined()
    expect(stopped(send(['make', 7, 'Badge', {}]))).toEqual({
      why: 'too-much',
      what: 'step 1: a page’s Badge parts: more than 2',
    })
  })

  test('has no more between them of parts that share a ceiling than it lets a page have', () => {
    const cards = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ['make', from + i, i % 2 ? 'Tag' : 'Card', {}])
    // Twenty of the two, mixed: the twenty-first of either stops the page.
    for (const last of ['Card', 'Tag']) {
      const { page, send } = page_()
      send(...cards(1, 20))
      expect(page.stopped).toBeUndefined()
      expect(stopped(send(['make', 21, last, {}]))).toEqual({
        why: 'too-much',
        what: 'step 1: a page’s Card and Tag parts: more than 20',
      })
    }
    // One of either taken away makes room for one of either.
    const { page, send } = page_()
    send(...cards(1, 20))
    send(['take', null, 2], ['make', 21, 'Card', {}])
    expect(page.stopped).toBeUndefined()
    // A part that doesn't count against it isn't counted.
    send(['make', 22, 'Badge', {}])
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
      '{"commit": [["text", 1]]}',
      '{"commit": [["change", 1]]}',
      '{"commit": [["put", 0, 1, 2, 3]]}',
      '{"commit": [["take", 1]]}',
      5,
      { commit: [] },
    ]
    for (const message of messages) {
      const page = new DoorPage(PARTS, () => 0)
      const result = stopped(page.take(message as string))
      expect(result.why, String(message)).toBe('not-allowed')
      expect(page.stopped).toEqual(result)
    }
  })

  test('once stopped it takes nothing more, and says the same', () => {
    const { page, send } = page_()
    const first = stopped(send(['make', 1, 'Nothing', {}]))
    expect(first).toEqual({
      why: 'not-allowed',
      what: 'step 1: names a part Lumovi doesn’t have: "Nothing"',
    })
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
      'step 1: Stack: takes nothing named "onPress"',
    )
  })

  test('what a plugin wrote is never said back as it wrote it: short, one line, nothing unseen', () => {
    const long = `style\n2026-10-12 Lumovi: all is well\u202E${'x'.repeat(10_000)}`
    const lines = [
      stopped(page_().send(['make', 1, 'Stack', { [long]: 1 }])).what,
      stopped(page_().send(['make', 1, long, {}])).what,
      stopped(page_().send(['make', long, 'Stack', {}])).what,
      stopped(page_().send(['make', 1, 'Stack', { gap: { [long]: long } }])).what,
      stopped(page_().send(['make', 1, 'Button', { label: long }])).what,
      stopped(page_().send(['make', 1, 'Button', { label: 'a', onPress: long }])).what,
      stopped(page_().send([long, 1])).what,
    ]
    for (const line of lines) {
      expect(line.length, line).toBeLessThan(120)
      expect(line, line).not.toMatch(/[\n\u202E]/)
      // (Quoted, so what follows the break reads as the plugin's and not as a line of Lumovi's.)
      expect(line, line).not.toContain('xxxx')
    }
    expect(lines[0]).toBe(
      'step 1: Stack: takes nothing named "style 2026-10-12 Lumovi: all is well U+202E xxx…"',
    )
  })

  test('a text is taken whatever its characters: what’s in a cluster isn’t the plugin’s to answer for', () => {
    // (What can't be seen is drawn as a mark of Lumovi's by the part that shows it: `inPieces`.)
    const texts = [
      '👨\u200D👩\u200D👧',
      'می\u200Cخواهم',
      'un\u00ADseen',
      'safe\u202Egnp.exe',
      'a\u0000b',
      'a\uD83Db',
    ]
    const { send, page } = page_()
    for (const [i, text] of texts.entries()) {
      expect(
        send(['text', 2 * i + 1, text], ['make', 2 * i + 2, 'Button', { label: text }]),
      ).toEqual({ changed: [] })
      expect(page.node(2 * i + 1)?.text).toBe(text)
      expect(page.node(2 * i + 2)?.props.label).toBe(text)
    }
    expect(page.stopped).toBeUndefined()
  })

  test('what a part’s kinds can’t say, the part says: one property agreeing with another', () => {
    const parts: Record<string, Part> = {
      Pair: {
        name: 'Pair',
        holds: 'nothing',
        props: { names: list(text(10), 5), values: list(number(0, 9), 5) },
        also: (props) =>
          (props.names as string[] | undefined)?.length ===
          (props.values as number[] | undefined)?.length
            ? undefined
            : 'a value for every name',
      },
    }
    const made = (props: unknown) =>
      new DoorPage(parts, () => 0).take(JSON.stringify({ commit: [['make', 1, 'Pair', props]] }))
    expect(made({ names: ['a'], values: [1] })).toEqual({ changed: [] })
    expect(made({ names: ['a'], values: [] })).toEqual({
      why: 'not-allowed',
      what: 'step 1: Pair: a value for every name',
    })
    // A check that throws refuses; the door doesn't throw.
    parts.Pair = { ...parts.Pair!, also: () => (undefined as unknown as { a: string }).a }
    expect(made({ names: [], values: [] })).toEqual({
      why: 'not-allowed',
      what: 'step 1: Pair: has properties it can’t check',
    })
    delete parts.Pair.also
    // (Only what passed its kinds is asked about.)
    expect(stopped(made({ names: 'a', values: [] })).what).toBe(
      'step 1: Pair.names: should be a list',
    )
  })

  test('a part is handed every text as one that isn’t Lumovi’s, wherever it is in its properties', () => {
    const fields = {
      label: text(10),
      size: number(0, 9),
      rows: list(
        record({ name: text(10), cell: choice('kind', { none: {}, text: { text: text(10) } }) }),
        5,
      ),
    }
    const props = {
      label: 'a',
      size: 2,
      rows: [{ name: 'b', cell: { kind: 'text', text: 'c' } }, { cell: { kind: 'none' } }],
    }
    expect(wrongWithFields(props, fields, [], 'Part')).toBeUndefined()
    const given = handedFields(props, fields)
    expect(given).toEqual({
      label: { their: 'a' },
      size: 2,
      rows: [
        { name: { their: 'b' }, cell: { kind: 'text', text: { their: 'c' } } },
        { cell: { kind: 'none' } },
      ],
    })
    expect(Object.isFrozen(given) && Object.isFrozen((given.rows as unknown[])[0])).toBe(true)
  })

  test('what was checked can’t be changed after', () => {
    const parts: Record<string, Part> = {
      ...PARTS,
      Rows: {
        name: 'Rows',
        holds: 'nothing',
        props: { rows: list(record({ name: text(10) }), 5) },
      },
    }
    const page = new DoorPage(parts, () => 0)
    page.take(JSON.stringify({ commit: [['make', 1, 'Rows', { rows: [{ name: 'a' }] }]] }))
    const props = page.node(1)!.props as { rows: { name: string }[] }
    expect(
      Object.isFrozen(props) && Object.isFrozen(props.rows) && Object.isFrozen(props.rows[0]),
    ).toBe(true)
    page.take(JSON.stringify({ commit: [['change', 1, { rows: [] }]] }))
    expect(Object.isFrozen(page.node(1)!.props.rows)).toBe(true)
  })

  test('a clock set back doesn’t stop an honest page, nor give it more', () => {
    const { send, clock } = page_()
    clock.now = 50_000
    for (let i = 0; i < DOOR_LIMITS.commitsASecond; i++) send()
    // Back forty seconds: nothing is filled, nothing is taken; then time passes as before.
    clock.now = 10_000
    for (let i = 0; i < DOOR_LIMITS.commitsASecond; i++) expect(send()).toEqual({ changed: [] })
    clock.now = 11_000
    for (let i = 0; i < DOOR_LIMITS.commitsASecond; i++) expect(send()).toEqual({ changed: [] })
    expect(stopped(send()).why).toBe('too-much')
    // And with no clock given it has one of its own.
    expect(new DoorPage(PARTS).take('{"commit":[]}')).toEqual({ changed: [] })
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
      [['put', 1, 4], 'which holds'],
      [['put', ROOT, 4], 'which holds'],
      [['put', 3, 6], 'which holds'],
      [['put', 5, 6], 'which holds'],
      [['put', 6, 3], 'which holds'],
      [['put', 4, 3], 'which holds'],
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
    // Said with the thing itself, for whoever writes the plugin.
    expect(stopped(page_().send(...base, ['put', 5, 6])).what).toBe(
      'step 8: puts a Button into a Row, which holds only Label',
    )
    expect(stopped(page_().send(...base, ['put', ROOT, 4])).what).toBe(
      'step 8: puts a text into the page itself, which holds only parts',
    )
    expect(stopped(page_().send(...base, ['put', 6, 3])).what).toBe(
      'step 8: puts a Label into a Button, which holds nothing',
    )
    expect(stopped(page_().send(...base, ['make', 3, 'Stack', {}])).what).toBe(
      'step 8: makes something under a number that isn’t new: 3',
    )
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

  /** A tenth of a second's worth of steps, exactly. */
  const EXACT = JSON.stringify({
    commit: Array.from({ length: DOOR_LIMITS.stepsASecond / 10 }, () => ['text', 1, '']),
  })

  test('over a ceiling it’s stopped: commits and steps in a second, by Lumovi’s clock', () => {
    // A second's worth for every second that passes, and two seconds' worth in hand at most:
    // messages arrive in bunches when Lumovi's own page is busy, and that isn't the plugin's doing.
    const most = DOOR_LIMITS.secondsAtOnce
    const { send, clock } = page_()
    for (let i = 0; i < DOOR_LIMITS.commitsASecond * most; i++)
      expect(send()).toEqual({ changed: [] })
    // Half a second later: half a second's worth, and no more.
    clock.now = 500
    for (let i = 0; i < DOOR_LIMITS.commitsASecond / 2; i++) expect(send()).toEqual({ changed: [] })
    expect(stopped(send()).what).toBe('commits in a second: more than 60')
    // However long it's quiet, never more than two seconds' worth at once.
    const quiet = page_()
    quiet.send()
    quiet.clock.now = 3_600_000
    for (let i = 0; i < DOOR_LIMITS.commitsASecond * most; i++)
      expect(quiet.send()).toEqual({ changed: [] })
    expect(stopped(quiet.send()).why).toBe('too-much')

    const other = page_()
    const full = Array.from({ length: DOOR_LIMITS.stepsACommit }, () => ['text', 1, ''])
    expect(other.send(['text', 1, ''])).toEqual({ changed: [] })
    other.clock.now = 5000
    for (let i = 0; i < (DOOR_LIMITS.stepsASecond * most) / DOOR_LIMITS.stepsACommit; i++) {
      expect(other.send(...full)).toEqual({ changed: [1] })
    }
    expect(stopped(other.send(['text', 1, ''])).what).toBe('steps in a second: more than 20,000')
    // A plugin that takes exactly what's filled, with nothing in hand, by a clock that isn't
    // whole numbers (as a real one isn't): never stopped for the hair that arithmetic leaves
    // under a whole step. (Counted strictly, this stops at its eleventh round.)
    const exact = page_()
    exact.clock.now = 0.1
    for (let i = 0; i < (DOOR_LIMITS.stepsASecond * most) / DOOR_LIMITS.stepsACommit; i++) {
      exact.send(...full)
    }
    for (let round = 1; round <= 2000; round++) {
      exact.clock.now = 0.1 + round * 100
      if ('why' in exact.page.take(EXACT)) throw new Error(`stopped at round ${round}`)
    }
    // And one step more than what's filled is still one too many.
    expect(stopped(exact.send(['text', 1, ''])).what).toBe('steps in a second: more than 20,000')
    // A plugin that keeps to its second, whose messages come late and together: never stopped.
    const late = page_()
    late.send(['text', 1, ''])
    for (let second = 1; second <= 30; second++) {
      // (Nothing for 1.9 s, then what it sent in that time, at once.)
      late.clock.now += 1900
      for (let i = 0; i < 19; i++)
        expect(late.send(...full.slice(0, 1000))).toEqual({ changed: [1] })
    }
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

  test('over a ceiling it’s stopped: what one part holds, and a move isn’t one more', () => {
    const { send, clock } = page_()
    let id = 1
    send(['make', 1, 'Stack', {}], ['put', ROOT, 1])
    while (id <= DOOR_LIMITS.inOnePart) {
      clock.now += 1000
      const steps: unknown[][] = []
      for (let i = 0; i < 500; i++) steps.push(['make', ++id, 'Stack', {}], ['put', 1, id])
      expect(send(...steps)).toEqual({ changed: [1] })
    }
    expect(send(['put', 1, 2], ['put', 1, 3, 2])).toEqual({ changed: [1] })
    expect(stopped(send(['make', ++id, 'Stack', {}], ['put', 1, id])).what).toBe(
      'step 2: what one part holds: more than 1,000',
    )
  })

  test('the worst second the ceilings allow costs Lumovi far less than a second', () => {
    // The widest part there can be, and every step of a second moving something across it; then
    // a page of the most parts, taken away and made again.
    const { send, clock, page } = page_()
    let id = 1
    send(['make', 1, 'Stack', {}], ['put', ROOT, 1])
    for (let n = 0; n < 2; n++) {
      clock.now += 1000
      const steps: unknown[][] = []
      for (let i = 0; i < 500; i++) steps.push(['make', ++id, 'Stack', {}], ['put', 1, id])
      send(...steps)
    }
    const commits = Array.from(
      { length: DOOR_LIMITS.stepsASecond / DOOR_LIMITS.stepsACommit },
      (_, c) =>
        JSON.stringify({
          commit: Array.from({ length: DOOR_LIMITS.stepsACommit }, (_, i) =>
            (i + c) % 2
              ? ['put', 1, 2 + (i % 1000)]
              : ['put', 1, 1001 - (i % 1000), 2 + ((i + 500) % 1000)],
          ),
        }),
    )
    clock.now += 1000
    const started = performance.now()
    for (const commit of commits) expect(page.take(commit)).toEqual({ changed: [1] })
    const moving = performance.now() - started
    expect(page.stopped).toBeUndefined()
    // (Measured: about 20 ms on a laptop. A fifth of a second leaves room for a slow machine.)
    expect(moving).toBeLessThan(200)
  })

  test('the other worst second: a leaf put and taken at the bottom of wide parts', () => {
    // 31 parts one under another, four of them holding 990 others; then every step of a second
    // making, putting and taking a leaf under the last.
    const { send, clock, page } = page_()
    let id = 0
    const chain: number[] = []
    for (let level = 0; level < 31; level++) {
      clock.now += 1000
      const steps: unknown[][] = [
        ['make', ++id, 'Stack', {}],
        ['put', chain.at(-1) ?? ROOT, id],
      ]
      chain.push(id)
      if (level % 8 === 3) {
        for (let i = 0; i < 990; i++)
          steps.push(['make', ++id, 'Stack', {}], ['put', chain.at(-1)!, id])
      }
      expect(send(...steps)).toHaveProperty('changed')
    }
    expect(page.holds.nodes).toBe(31 + 4 * 990)
    const bottom = chain.at(-1)!
    const commits = Array.from(
      { length: DOOR_LIMITS.stepsASecond / DOOR_LIMITS.stepsACommit },
      () => {
        const steps: unknown[][] = []
        while (steps.length + 3 <= DOOR_LIMITS.stepsACommit)
          steps.push(['make', ++id, 'Stack', {}], ['put', bottom, id], ['take', bottom, id])
        return JSON.stringify({ commit: steps })
      },
    )
    clock.now += 1000
    const started = performance.now()
    for (const commit of commits) expect(page.take(commit)).toEqual({ changed: [bottom] })
    const taking = performance.now() - started
    // (Measured: about 40 ms on a laptop.)
    expect(taking).toBeLessThan(200)
    // And the heights it keeps are still right: one more level fits, and no more.
    expect(send(['make', ++id, 'Stack', {}], ['put', bottom, id])).toEqual({ changed: [bottom] })
    expect(stopped(send(['make', ++id, 'Stack', {}], ['put', id - 1, id])).why).toBe('too-much')
  })

  test('what was made and never put anywhere can be let go of', () => {
    const { send, page } = page_()
    send(['make', 1, 'Stack', {}], ['make', 2, 'Stack', {}], ['put', 1, 2], ['text', 3, 'abc'])
    expect(page.holds).toEqual({ nodes: 3, characters: 7 })
    expect(send(['take', null, 1], ['take', null, 3])).toEqual({ changed: [] })
    expect(page.holds).toEqual({ nodes: 0, characters: 0 })
    // Not what's under something, not the page itself, not what's gone.
    for (const id of [2, ROOT, 9, '1']) {
      const other = page_()
      other.send(['make', 1, 'Stack', {}], ['make', 2, 'Stack', {}], ['put', 1, 2])
      expect(stopped(other.send(['take', null, id])).what, String(id)).toBe(
        'step 1: takes away what isn’t there',
      )
    }
  })

  test('what’s read of the page is a copy nobody can change', () => {
    const { send, page } = page_()
    send(['make', 1, 'Stack', {}], ['make', 2, 'Stack', {}], ['put', 1, 2], ['put', ROOT, 1])
    const node = page.node(1)!
    expect(Object.isFrozen(node) && Object.isFrozen(node.children)).toBe(true)
    expect(() => (node.children as number[]).push(5)).toThrow()
    expect(node).toEqual({ part: 'Stack', props: {}, children: [2] })
    send(['text', 3, 'a'])
    expect(Object.isFrozen(page.node(3)!.props) && Object.isFrozen(page.node(ROOT)!.props)).toBe(
      true,
    )
    expect(page.node(1)?.children).toEqual([2])
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

    // Off the page it's the same rule, from the bottom up and from the top down: nothing is
    // built that could never be put on.
    const up = page_()
    up.send(...makes)
    for (let i = DOOR_LIMITS.depth; i > 1; i--)
      expect(up.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(up.send(['put', 1, 2])).what).toBe('step 1: how deep a page goes: more than 32')
    const loose = page_()
    loose.send(...makes)
    for (let i = 1; i < DOOR_LIMITS.depth; i++)
      expect(loose.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(loose.send(['put', DOOR_LIMITS.depth, DOOR_LIMITS.depth + 1])).why).toBe(
      'too-much',
    )
    // And 32 built off the page go on whole.
    const whole = page_()
    whole.send(...makes)
    for (let i = DOOR_LIMITS.depth - 1; i > 0; i--) whole.send(['put', i, i + 1])
    expect(whole.send(['put', ROOT, 1])).toEqual({ changed: [ROOT] })

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
