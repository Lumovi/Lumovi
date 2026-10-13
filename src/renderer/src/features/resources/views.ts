/**
 * A list's saved views, as the list reads and writes them: what it shows now as a view would keep
 * it, whether that's still the view it was opened as, and the address a view opens at. The open
 * view is named in the address (`?view=`), so Back and a link keep it, and a list opened afresh
 * has none.
 */
import type { ColumnChoices, SavedView } from '@shared/marks'
import type { ResourceKind } from '@shared/resources'
import { byName, namespacesParam, NAMESPACES_PARAM } from '@renderer/lib/namespaces'
import { kindPath } from '@renderer/lib/routes'
import { usePrefs } from '@renderer/state/prefs'
import type { ListState } from './list-state'

/** The address's parameter: the open view's name. */
export const VIEW_PARAM = 'view'

/** What a list shows now, kept as a view of that name (a cluster-wide kind keeps no namespaces). */
export function viewOfList({
  name,
  kind,
  state,
  namespaced,
  namespaces,
  columns,
}: {
  name: string
  kind: ResourceKind
  state: ListState
  namespaced: boolean
  namespaces: readonly string[] | null
  columns: ColumnChoices | undefined
}): SavedView {
  return {
    name,
    kind,
    ...(state.q ? { q: state.q } : {}),
    ...(state.health.length ? { health: [...state.health] } : {}),
    ...(state.labels ? { labels: state.labels } : {}),
    sort: state.sort,
    ...(state.desc ? { desc: true } : {}),
    ...(namespaced ? { namespaces: namespaces ? byName(namespaces) : null } : {}),
    ...(columns ? { columns } : {}),
  }
}

/** A value written the same way whatever order its keys were set in. */
function settled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(settled)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, settled((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** Whether a list shows what a view keeps: its name aside, and its health in any order. */
export function sameView(a: SavedView, b: SavedView): boolean {
  const kept = ({ name: _name, health, namespaces, ...rest }: SavedView) =>
    JSON.stringify(
      settled({
        ...rest,
        health: [...(health ?? [])].sort(),
        namespaces: namespaces && byName(namespaces),
      }),
    )
  return kept(a) === kept(b)
}

/**
 * Where a view opens: its kind's list, its filters in the address (its namespaces too, which a
 * link shows without changing what the cluster remembers).
 */
export function viewPath(context: string, view: SavedView): string {
  const params = new URLSearchParams()
  params.set(VIEW_PARAM, view.name)
  if (view.q) params.set('q', view.q)
  if (view.health?.length) params.set('health', view.health.join(','))
  if (view.labels) params.set('labels', view.labels)
  if (view.sort) params.set('sort', view.sort)
  if (view.desc) params.set('desc', '1')
  // (All of them is the parameter empty.)
  if (view.namespaces !== undefined) {
    params.set(NAMESPACES_PARAM, namespacesParam(view.namespaces) ?? '')
  }
  return `${kindPath(context, view.kind)}?${params}`
}

/** Opens a view: its columns become the list's (Lumovi's where it kept none), then its address. */
export function openView(context: string, view: SavedView, go: (to: string) => void) {
  usePrefs.getState().setColumns(`${context}/${view.kind}`, view.columns)
  go(viewPath(context, view))
}
