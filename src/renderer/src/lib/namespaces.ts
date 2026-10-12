import type { KubeList } from '@shared/api'

/**
 * The namespaces picked, as an address carries them (so a link opens on what was picked) and as a
 * page says where it's looking.
 */

/** The address's parameter: the namespaces picked, by name, between commas. */
export const NAMESPACES_PARAM = 'namespaces'

/**
 * How many may be picked: for someone who can't list the whole cluster, each is a list of its
 * own, read again and again.
 */
export const MOST_NAMESPACES = 20

/** What a namespace's name may be (a DNS label): anything else is no namespace. */
const NAMESPACE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Whether `name` could be a namespace's: an address's, a typed one, or one remembered (whatever a
 * browser's storage held: only a string can be).
 */
export const isNamespaceName = (name: unknown): name is string =>
  typeof name === 'string' && NAMESPACE_NAME.test(name)

/** Names in name order: how the picked are listed wherever they're listed. */
export const byName = (namespaces: readonly string[]) =>
  [...namespaces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * The namespaces an address picks, or nothing where it picks none: the names in it that are
 * namespaces' names, each once, in name order, the first `MOST_NAMESPACES` of them; and how many
 * it named. Anything else in it is dropped, as if it weren't there, never shown or asked for: an
 * address naming nothing that's a namespace's name picks nothing (and what's remembered is
 * shown). Only an empty one (`?namespaces=`) picks all of them (`null`).
 */
export function namespacesIn(
  search: URLSearchParams,
): { namespaces: readonly string[] | null; named: number } | undefined {
  const value = search.get(NAMESPACES_PARAM)
  if (value === null) return undefined
  if (value === '') return { namespaces: null, named: 0 }
  const names = byName([...new Set(value.split(','))].filter((name) => NAMESPACE_NAME.test(name)))
  if (names.length === 0) return undefined
  return { namespaces: names.slice(0, MOST_NAMESPACES), named: names.length }
}

/**
 * How many of a kind's namespaces are asked for at once: the rest wait their turn, so twenty don't
 * reach the API server together on every refresh.
 */
export const AT_ONCE = 5

/**
 * `ask` for each of `items`, at most `limit` at once, each settled (a failure is one item's, not
 * all of theirs), in their order.
 */
export async function settledAtMost<T, R>(
  items: readonly T[],
  limit: number,
  ask: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await ask(items[i]!) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** The address's value for `namespaces`, in name order (one pick, one address); nothing for all. */
export function namespacesParam(namespaces: readonly string[] | null): string | undefined {
  return namespaces?.length ? byName(namespaces).join(',') : undefined
}

/** Whether two picks are the same namespaces, whatever their order. */
export function sameNamespaces(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (!a?.length || !b?.length) return !a?.length && !b?.length
  return a.length === b.length && a.every((name) => b.includes(name))
}

const listed = new Intl.ListFormat('en-GB')

/**
 * The namespaces picked, in a sentence: "shop", "data and shop" (two, whole, in name order: a
 * sentence has room for them), or "3 namespaces".
 */
export function namedNamespaces(namespaces: readonly string[]): string {
  return namespaces.length <= 2
    ? listed.format(byName(namespaces))
    : `${namespaces.length} namespaces`
}

/**
 * Where a page is looking, after what it found nothing of: "in this cluster", "in shop", "in data
 * and shop", or "in 3 namespaces".
 */
export function scopeOf(namespaces: readonly string[] | null): string {
  return namespaces?.length ? `in ${namedNamespaces(namespaces)}` : 'in this cluster'
}

/** A picked namespace that couldn't be read, and why, as far as Lumovi knows. */
export interface Unread {
  namespace: string
  why: 'refused' | 'gone' | 'other'
}

/** Why a namespace's list couldn't be read: refused, not there, or something else. */
export function whyUnread(error: unknown): Unread['why'] {
  const code = (error as { code?: string } | undefined)?.code
  if (code === 'forbidden' || code === 'not-allowed') return 'refused'
  return code === 'not-found' ? 'gone' : 'other'
}

/** A list read across the picked namespaces: what came, and those that couldn't be read. */
export type PickedList = KubeList & { unread?: readonly Unread[] }

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The line that says which picked namespaces' `noun` ("pods") aren't shown, and why; with three or
 * more, or two for different reasons, a count, and each named with its reason in `each`.
 */
export function unreadLine(
  unread: readonly Unread[],
  noun: string,
): { line: string; each?: string[] } {
  const sorted = [...unread].sort((a, b) => (a.namespace < b.namespace ? -1 : 1))
  const why = sorted[0]!.why
  if (sorted.length <= 2 && sorted.every((each) => each.why === why)) {
    const names = listed.format(sorted.map((each) => each.namespace))
    const one = sorted.length === 1
    if (why === 'refused') {
      return {
        line: `${capital(noun)} in ${names} aren’t shown: your account isn’t allowed to list them there.`,
      }
    }
    if (why === 'gone') {
      return {
        line: `${names} ${one ? 'isn’t' : 'aren’t'} there any more, so nothing from ${one ? 'it' : 'them'} is shown.`,
      }
    }
    return { line: `${capital(noun)} in ${names} couldn’t be read, so they aren’t shown.` }
  }
  return {
    line: `${capital(noun)} in ${sorted.length} of the picked namespaces aren’t shown.`,
    each: sorted.map(({ namespace, why }) =>
      why === 'refused'
        ? `${namespace}: your account isn’t allowed to list ${noun} there`
        : why === 'gone'
          ? `${namespace}: isn’t there any more`
          : `${namespace}: couldn’t be read`,
    ),
  }
}

/** The unread of several lists (a page of several kinds): each namespace once, as first said. */
export function unreadOf(lists: ({ unread?: readonly Unread[] } | undefined)[]): Unread[] {
  const all = new Map<string, Unread>()
  for (const each of lists.flatMap((list) => list?.unread ?? [])) {
    if (!all.has(each.namespace)) all.set(each.namespace, each)
  }
  return [...all.values()]
}

/**
 * The picked namespaces that were read: what an empty page's scope counts, so it never says one
 * has nothing when it couldn't be looked at.
 */
export function readOf(
  namespaces: readonly string[] | null,
  unread: readonly Unread[] | undefined,
): readonly string[] | null {
  return namespaces?.filter((name) => !unread?.some((each) => each.namespace === name)) ?? null
}
