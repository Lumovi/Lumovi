/**
 * The kit's Table, declared: the declaration is one the door takes; a table a plugin writes is
 * checked by it as the door checks one, a hostile one's included; it reaches the component with
 * every text a `Their` and every token its object; and what the kinds can't say is said by
 * `tableProblem`, counting as a person counts. Plain functions, so nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  handedFields,
  wrongWithFields,
  wrongWithPart,
  type Swap,
  type WrittenProps,
} from '../../src/shared/kit/declare.ts'
import { table, tableProblem, type TableProps } from '../../src/shared/kit/table.ts'

type Written = WrittenProps<typeof table>

/** What the door says of a table a plugin wrote: its kinds first, then what they can't say. */
const said = (written: unknown) =>
  wrongWithFields(written, table.props, table.required, 'Table') ??
  table.also(written as Readonly<Record<string, unknown>>)

const row = {
  key: 'web-1',
  lead: { level: 'healthy', name: 'web-1', beside: 'shop' },
  cells: [
    { kind: 'status', level: 'healthy', word: 'Running' },
    { kind: 'age', time: '2026-10-12T08:30:00Z' },
  ],
  opens: 'object-1',
} as const satisfies NonNullable<Written['rows']>[number]

const PODS = {
  title: 'Pods',
  headings: true,
  columns: [
    { name: 'Status', kind: 'status', sorts: true },
    { name: 'Age', kind: 'age', width: 'narrow' },
  ],
  rows: [row],
} as const satisfies Written

test('the Table’s declaration is one the door takes, and so is a table written to it', () => {
  expect(wrongWithPart(table)).toBeUndefined()
  expect(said(PODS)).toBeUndefined()
  // A rest with its time, and a read cut at Lumovi's limit, named by the door's token.
  const launching = { ...row, rest: { from: 1, text: 'Launching', time: '2026-10-12T08:30:00Z' } }
  expect(said({ ...PODS, rows: [launching] })).toBeUndefined()
  expect(said({ ...PODS, cut: 'cut-1' })).toBeUndefined()
  // Its lead column's heading, and a revision in fixed-width type with its whole hash.
  const hash = '4f1c9aa8b7e6f5a4c3b2a1908f7e6d5c4b3a2910'
  const synced = {
    key: hash,
    lead: { name: '3h ago' },
    cells: [{ kind: 'text', text: hash.slice(0, 7), mono: true, full: hash }],
  }
  const history = {
    title: 'History',
    headings: true,
    columns: [{ name: 'Revision', kind: 'text' }],
  }
  expect(said({ ...history, leadHeading: 'Synced', rows: [synced] })).toBeUndefined()
  expect(said({ ...history, rows: [{ ...synced, key: 'all', rows: [synced] }] })).toBeUndefined()
  // A row that goes to a list of Lumovi's own instead, as a tile does: one object of a kind.
  const { opens: _opens, ...unopened } = row
  const going = { ...unopened, goes: { list: 'apps/Deployment', name: 'web', namespace: 'shop' } }
  expect(said({ ...PODS, rows: [going] })).toBeUndefined()
})

test('a table is checked as the door checks one, and refused where it says more than it may', () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, kind: 'text' }))
  const keyless = Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'key'))
  for (const [change, refused] of [
    [{ title: 3 }, 'Table.title: should be text'],
    [{ title: 'x'.repeat(254) }, 'Table.title: is longer than 253 characters'],
    [{ style: 'color: red' }, 'Table: takes nothing named "style"'],
    [{ headings: 'yes' }, 'Table.headings: should be true or false'],
    [
      { columns: [{ name: 'Graph', kind: 'graph' }] },
      'Table.columns[0].kind: should be one of text, number, age, status, meter',
    ],
    [
      { columns: [{ name: 'Status', kind: 'status', width: '12px' }] },
      'Table.columns[0].width: should be one of narrow, normal, wide, text',
    ],
    [{ columns: nine }, 'Table.columns: is longer than 8'],
    [{ shows: 0 }, 'Table.shows: should be from 1 to 5000'],
    // A cut is only the door's token: never numbers a plugin wrote.
    [{ cut: { at: 5000, of: 12345 } }, 'Table.cut: isn’t a cut Lumovi handed this page'],
    [{ cut: 'cut 1' }, 'Table.cut: isn’t a cut Lumovi handed this page'],
    [
      { rows: [{ ...row, rest: { from: 1, text: 'Launching', time: 'just now' } }] },
      'Table.rows[0].rest.time: should be a moment, as 2026-10-12T08:30:00Z',
    ],
    [{ rows: [keyless] }, 'Table.rows[0].key: is required'],
    [
      {
        rows: [
          { ...row, cells: [{ kind: 'status', level: 'fine', word: 'Running' }, row.cells[1]] },
        ],
      },
      'Table.rows[0].cells[0].level: should be one of healthy, progressing, warning, critical, neutral',
    ],
    [
      { rows: [{ ...row, cells: [{ kind: 'html', html: '<b>x</b>' }, row.cells[1]] }] },
      'Table.rows[0].cells[0].kind: should be one of text, number, age, status, meter, none',
    ],
    [
      { rows: [{ ...row, cells: [row.cells[0], { kind: 'age', time: '3 hours ago' }] }] },
      'Table.rows[0].cells[1].time: should be a moment, as 2026-10-12T08:30:00Z',
    ],
    // An object is only ever the token Lumovi gave: never a kind and a name the plugin wrote.
    [
      { rows: [{ ...row, opens: 'Pod/shop/web-1' }] },
      'Table.rows[0].opens: should be an object Lumovi named',
    ],
    // A list it goes to is one the door makes: never a path or an address the plugin wrote.
    [
      { rows: [{ ...row, goes: '/cluster/demo/deployments?name=web' }] },
      'Table.rows[0].goes: should be a list to open, as { list: group/Kind }, or a place for an object, as { object, at }',
    ],
    [
      { rows: [{ ...row, rows: [{ ...row, rows: [row] }] }] },
      'Table.rows[0].rows[0]: takes nothing named "rows"',
    ],
    [{ state: { is: 'failed', title: 'x' } }, 'Table.state.said: is required'],
    [{ onOpen: 'javascript:alert(1)' }, 'Table.onOpen: should be a handler'],
    [{ leadHeading: 'x'.repeat(41) }, 'Table.leadHeading: is longer than 40 characters'],
    [
      { rows: [{ ...row, cells: [{ kind: 'text', text: 'abc', mono: 'yes' }, row.cells[1]] }] },
      'Table.rows[0].cells[0].mono: should be true or false',
    ],
    [
      {
        rows: [
          { ...row, cells: [{ kind: 'text', text: 'abc', full: 'x'.repeat(254) }, row.cells[1]] },
        ],
      },
      'Table.rows[0].cells[0].full: is longer than 253 characters',
    ],
    // (Only words are set in fixed-width type, or stand for something longer.)
    [
      { rows: [{ ...row, cells: [{ ...row.cells[0], mono: true }, row.cells[1]] }] },
      'Table.rows[0].cells[0]: takes nothing named "mono"',
    ],
  ] as const) {
    expect(said({ ...PODS, ...change }), refused).toBe(refused)
  }
})

test('handed over, every text is a Their, and every token its object or nothing', () => {
  const swap: Swap = {
    object: (token) =>
      token === 'object-1' ? { kind: 'Pod', name: 'web-1', namespace: 'shop' } : undefined,
    secret: () => undefined,
    cut: (made) => (made === 'cut-1' ? { at: 5000, of: 12345 } : undefined),
    destination: () => undefined,
    handler: () => undefined,
  }
  const handed = handedFields(PODS, table.props, swap) as TableProps
  expect(handed.title).toEqual({ their: 'Pods' })
  expect(handed.columns![0]!.name).toEqual({ their: 'Status' })
  expect(handed.rows![0]!.lead!.name).toEqual({ their: 'web-1' })
  expect(handed.rows![0]!.cells![0]).toEqual({
    kind: 'status',
    level: 'healthy',
    word: { their: 'Running' },
  })
  expect(handed.rows![0]!.opens).toEqual({ kind: 'Pod', name: 'web-1', namespace: 'shop' })
  // A token this page doesn't hold: as if the plugin hadn't said it.
  const unknown = handedFields(
    { ...PODS, rows: [{ ...row, opens: 'object-9' }] },
    table.props,
    swap,
  ) as TableProps
  expect(unknown.rows![0]!).not.toHaveProperty('opens')
})

test('what the kinds can’t say, said where a person counts, quoting nothing of the table’s', () => {
  const inner = (key: string) => ({ key, lead: { name: key }, cells: row.cells })
  for (const [rows, problem] of [
    [[row, row], 'Rows 1 and 2 have the same key.'],
    [
      [
        { ...row, key: 'a' },
        { ...row, key: 'b', rows: [inner('x'), inner('x')] },
      ],
      'In row 2, inner rows 1 and 2 have the same key.',
    ],
    [[{ ...row, cells: [row.cells[0]] }], 'Row 1 has 1 cell, and the table has 2 columns.'],
    [
      [{ ...row, cells: [row.cells[1], row.cells[1]] }],
      'Row 1, cell 1 is an age, and its column takes a status.',
    ],
    [
      [
        {
          ...row,
          rows: [{ ...inner('x'), cells: [row.cells[0], { kind: 'text', text: 'late' }] }],
        },
      ],
      'In row 1, inner row 1, cell 2 is text, and its column takes an age.',
    ],
    [
      [{ ...row, rest: { from: 2, text: 'Nowhere' } }],
      'Row 1’s rest starts at column 3, and the table has 2 columns.',
    ],
    // A row is pressed for one thing: the object it opens, or the list it goes to.
    [
      [{ ...row, goes: { list: 'apps/Deployment' } }],
      'Row 1 opens an object and goes to a list: a row is pressed for one of them.',
    ],
    [
      [{ ...row, rows: [{ ...inner('x'), opens: 'object-2', goes: { list: '/Node' } }] }],
      'In row 1, inner row 1 opens an object and goes to a list: a row is pressed for one of them.',
    ],
    [[{ ...row, cells: [row.cells[0], { kind: 'none' }] }], undefined],
  ] as const) {
    expect(tableProblem({ ...PODS, rows }), problem).toBe(problem)
  }
})
