/**
 * A table's filters, Lumovi's own (src/renderer/src/lib/table-filters.ts): each filter's menu of
 * the values its rows have, with how many have each; the rows kept by what's chosen and typed;
 * and what a link to the page starts it with. Plain functions: nothing is drawn.
 */
import { expect, test } from '../temp-folders.ts'
import type { DrawnRow } from '../../src/shared/kit/table.ts'
import {
  keptRows,
  menusOf,
  startFromState,
  startOf,
  type TableFilter,
} from '../../src/renderer/src/lib/table-filters.ts'

const their = (text: string) => ({ their: text })
const filter = (key: string, more: Partial<TableFilter> = {}): TableFilter =>
  ({ key: their(key), name: their(key), ...more }) as TableFilter
const FILTERS = [
  filter('health', { level: true }),
  filter('sync'),
  filter('labels', { more: true }),
]
const row = (name: string, level: string, beside: string, facets: [string, string][]) =>
  ({
    key: their(name),
    lead: { level, name: their(name), beside: their(beside) },
    cells: [],
    facets: facets.map(([key, value]) => ({ filter: their(key), value: their(value) })),
  }) as unknown as DrawnRow
const ROWS = [
  row('checkout', 'healthy', 'shop', [
    ['sync', 'Synced'],
    ['labels', 'team=shop'],
  ]),
  row('storefront', 'progressing', 'shop', [
    ['sync', 'Out of sync'],
    ['labels', 'team=shop'],
    ['labels', 'tier=web'],
  ]),
  row('payments', 'healthy', 'payments', [
    ['sync', 'Synced'],
    ['labels', 'team=payments'],
  ]),
  row('legacy-batch', 'critical', 'batch', [
    ['sync', 'Out of sync'],
    ['labels', 'team=shop'],
    ['labels', 'team=shop'],
  ]),
]
const names = (rows: readonly DrawnRow[]) => rows.map((each) => each.key.their)

test('each filter’s menu: the values its rows have, how many have each, the most first; a level filter’s, worst first', () => {
  const [health, sync, labels] = menusOf(ROWS, FILTERS)
  expect(health!.values).toEqual([
    { value: 'critical', count: 1 },
    { value: 'progressing', count: 1 },
    { value: 'healthy', count: 2 },
  ])
  expect(sync!.values).toEqual([
    { value: 'Synced', count: 2 },
    { value: 'Out of sync', count: 2 },
  ])
  // (A row that gives one value twice is counted once.)
  expect(labels!.values).toEqual([
    { value: 'team=shop', count: 3 },
    { value: 'tier=web', count: 1 },
    { value: 'team=payments', count: 1 },
  ])
})

test('kept: either within a filter, all across filters, and what’s typed in a name or the word beside it', () => {
  const chosen = (...pairs: [string, string[]][]) => new Map(pairs.map(([k, v]) => [k, new Set(v)]))
  expect(keptRows(ROWS, FILTERS, chosen(), '')).toBe(ROWS)
  expect(names(keptRows(ROWS, FILTERS, chosen(['sync', ['Out of sync']]), ''))).toEqual([
    'storefront',
    'legacy-batch',
  ])
  expect(names(keptRows(ROWS, FILTERS, chosen(['health', ['healthy', 'critical']]), ''))).toEqual([
    'checkout',
    'payments',
    'legacy-batch',
  ])
  expect(
    names(keptRows(ROWS, FILTERS, chosen(['sync', ['Out of sync']], ['labels', ['tier=web']]), '')),
  ).toEqual(['storefront'])
  expect(names(keptRows(ROWS, FILTERS, chosen(), '  SHOP '))).toEqual(['checkout', 'storefront'])
  expect(names(keptRows(ROWS, FILTERS, chosen(['sync', []]), 'pay'))).toEqual(['payments'])
  expect(keptRows(ROWS, FILTERS, chosen(['sync', ['Gone']]), '')).toEqual([])
})

test('a link starts a table with the filters it has: a level filter only with levels; a key it hasn’t sets nothing', () => {
  const { chosen, search } = startOf(FILTERS, {
    filters: [
      ['sync', ['Out of sync']],
      ['health', ['critical', 'Broken']],
      ['nowhere', ['x']],
      ['toString', ['x']],
    ],
    search: 'shop',
  })
  expect([...chosen].map(([key, values]) => [key, [...values]])).toEqual([
    ['sync', ['Out of sync']],
    ['health', ['critical']],
  ])
  expect(search).toBe('shop')
  expect(startOf(FILTERS, undefined)).toEqual({ chosen: new Map(), search: '' })
  // What's in a navigation is read only where it's that shape.
  expect(startFromState({ filters: [['sync', ['Synced']], ['bad', 'x'], 7], search: 3 })).toEqual({
    filters: [['sync', ['Synced']]],
  })
  expect(startFromState(null)).toBeUndefined()
  expect(startFromState({ filters: 'sync' })).toBeUndefined()
})
