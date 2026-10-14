/**
 * A table's filters, Lumovi's own: the menus its bar offers (each filter's values, with how many
 * rows have each), and the rows that are kept by what's chosen and typed. A row is kept when its
 * name, or the word beside it, has what's typed, and when it has one of the values chosen in each
 * filter where any is: values in one filter are either, filters together are all. A row's own
 * rows go with it. The plugin is told none of it.
 *
 * What's chosen is keyed by the plugin's words in a Map, never as an object's keys.
 */
import { HEALTH_RANK, type Health } from '@shared/health'
import type { PageDestination } from '@shared/kit/declare'
import type { DrawnRow, TableProps } from '@shared/kit/table'

export type TableFilter = NonNullable<TableProps['filters']>[number]

/** The values chosen in each filter, by its key. */
export type Chosen = ReadonlyMap<string, ReadonlySet<string>>

/** A filter's menu: its values, with how many rows have each, the most first. */
export interface FilterMenu {
  filter: TableFilter
  values: { value: string; count: number }[]
}

/** The levels a level filter's values are, worst first. */
const LEVELS = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

/** A row's values for a filter: its lead's level, for a level filter; else what it gives. */
function valuesOf(row: DrawnRow, filter: TableFilter): string[] {
  if (filter.level) return row.lead?.level ? [row.lead.level] : []
  const key = filter.key.their
  return (row.facets ?? []).flatMap((facet) =>
    facet.filter.their === key ? [facet.value.their] : [],
  )
}

/**
 * Each filter's menu, of `rows`: the values they have, with how many have each; the most first,
 * then as they come. A level filter's, worst first.
 */
export function menusOf(rows: readonly DrawnRow[], filters: readonly TableFilter[]): FilterMenu[] {
  return filters.map((filter) => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      // (A row with one value twice is counted once.)
      for (const value of new Set(valuesOf(row, filter))) {
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
    }
    const values = [...counts].map(([value, count]) => ({ value, count }))
    if (filter.level) {
      values.sort((a, b) => LEVELS.indexOf(a.value as Health) - LEVELS.indexOf(b.value as Health))
    } else values.sort((a, b) => b.count - a.count)
    return { filter, values }
  })
}

/** Whether anything is chosen, or typed. */
export const filtering = (chosen: Chosen, search: string) =>
  search.trim() !== '' || [...chosen.values()].some((values) => values.size > 0)

/** The rows kept by what's chosen and typed: those that match, each with its own rows. */
export function keptRows(
  rows: readonly DrawnRow[],
  filters: readonly TableFilter[],
  chosen: Chosen,
  search: string,
): readonly DrawnRow[] {
  if (!filtering(chosen, search)) return rows
  const typed = search.trim().toLowerCase()
  const asked = filters.filter((filter) => (chosen.get(filter.key.their)?.size ?? 0) > 0)
  return rows.filter((row) => {
    if (typed) {
      const said = `${row.lead?.name?.their ?? ''}\n${row.lead?.beside?.their ?? ''}`.toLowerCase()
      if (!said.includes(typed)) return false
    }
    return asked.every((filter) => {
      const wanted = chosen.get(filter.key.their)!
      return valuesOf(row, filter).some((value) => wanted.has(value))
    })
  })
}

/**
 * A page's start, from what Lumovi put in its navigation (a link of its plugin's): its filters as
 * pairs of a key and its values, and a search, where they're that; nothing otherwise.
 */
export function startFromState(
  state: unknown,
): Pick<PageDestination, 'filters' | 'search'> | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const { filters, search } = state as { filters?: unknown; search?: unknown }
  if (!Array.isArray(filters)) return undefined
  const pairs = filters.filter(
    (pair): pair is readonly [string, readonly string[]] =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      Array.isArray(pair[1]) &&
      pair[1].every((value: unknown) => typeof value === 'string'),
  )
  return { filters: pairs, ...(typeof search === 'string' ? { search } : {}) }
}

/**
 * What a table starts with, from a link to its page: the values set for the filters it has (a
 * level filter's only where they're levels), and the search. Keys and values it has no filter
 * for set nothing.
 */
export function startOf(
  filters: readonly TableFilter[],
  start: Pick<PageDestination, 'filters' | 'search'> | undefined,
): { chosen: Chosen; search: string } {
  const chosen = new Map<string, ReadonlySet<string>>()
  for (const [key, values] of start?.filters ?? []) {
    const filter = filters.find((each) => each.key.their === key)
    if (!filter) continue
    const kept = filter.level
      ? values.filter((value) => (LEVELS as string[]).includes(value))
      : values
    if (kept.length) chosen.set(key, new Set(kept))
  }
  return { chosen, search: start?.search ?? '' }
}
