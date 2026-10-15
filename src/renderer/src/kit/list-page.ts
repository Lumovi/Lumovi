/**
 * A plugin's page that is a list: one Table, a Header above it at most, at the top of the page or
 * of its one Stack. Lumovi draws it as its own lists are drawn (features/resources/list-look.ts):
 * the bar, the headings and the rows across the page, the rows scrolling under the headings.
 * Decided by Lumovi from the page's shape, never by anything the plugin says.
 */
import { createContext } from 'react'

/** Whether the page is a list: its Stack and its Header give the list the page's height. */
export const ListPage = createContext(false)

/** Whether this Table is the page's list. */
export const IsPageList = createContext(false)

/**
 * The object open beside the page, as Lumovi's address names it (`Kind/namespace/name`): a page's
 * list picks out its row, as Lumovi's lists do. None where there's no address (the tests' stage).
 */
export const OpenBeside = createContext<string | null>(null)

/** What's needed of a page's tree to tell: a node's part, and what's under it. */
interface Shaped {
  node(id: number): { part?: string; children: readonly number[] } | undefined
}

/** The one Stack the page's parts stand in, where they stand in one. */
export function stackOf(tree: Shaped, root: number): number | undefined {
  const top = tree.node(root)?.children ?? []
  return top.length === 1 && tree.node(top[0]!)?.part === 'Stack' ? top[0] : undefined
}

/** The page's list, where it's one: the Table's id. */
export function listOf(tree: Shaped, root: number): number | undefined {
  const stack = stackOf(tree, root)
  const parts = tree.node(stack ?? root)?.children ?? []
  const table = parts.at(-1)
  if (table === undefined || tree.node(table)?.part !== 'Table') return undefined
  // (Before it, a Header at most.)
  if (parts.length > 2 || (parts.length === 2 && tree.node(parts[0]!)?.part !== 'Header')) {
    return undefined
  }
  return table
}
