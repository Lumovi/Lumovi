/**
 * A plugin's page, drawn: the door's tree, each part by Lumovi's own component for it, each text
 * as a text that isn't Lumovi's. Nothing here is the plugin's code: it only said which parts,
 * with which properties, and the door checked every word.
 */
import { memo, useCallback, useSyncExternalStore } from 'react'
import { ROOT } from '@shared/plugin-door'
import type { OpenPage } from './page'
import { TheirText } from './TheirText'

/**
 * A part or a text of the page, drawn again only when it has something new to draw: what a part
 * holds is drawn by its own, each of them likewise, so a change deep in the page draws that and
 * nothing round it.
 */
const Drawn = memo(function Drawn({ page, id }: { page: OpenPage; id: number }) {
  useSyncExternalStore(
    useCallback((changed: () => void) => page.subscribeTo(id, changed), [page, id]),
    () => page.tree.changedAt(id),
  )
  const node = page.tree.node(id)
  if (!node) return null
  const inside = node.children.map((child) => <Drawn key={child} page={page} id={child} />)
  if (id === ROOT) return inside
  // (A text under a part runs on with the texts beside it; the part that holds it clips it.)
  if (node.part === undefined) return <TheirText text={node.text ?? ''} lines inline />
  const { draw: Part } = page.parts[node.part]!
  return (
    <Part props={page.handed(node.part, node.props)} go={page.go}>
      {inside}
    </Part>
  )
})

/** The page of `page`, as it is now. */
export function PluginSurface({ page }: { page: OpenPage }) {
  return (
    <div data-testid="plugin-surface" className="flex flex-col gap-4 p-4">
      <Drawn page={page} id={ROOT} />
    </div>
  )
}
