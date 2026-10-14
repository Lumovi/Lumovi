/**
 * A plugin's page, drawn: the door's tree, each part by Lumovi's own component for it, each text
 * as a text that isn't Lumovi's. Nothing here is the plugin's code: it only said which parts,
 * with which properties, and the door checked every word.
 */
import { createContext, memo, useCallback, useId, useSyncExternalStore } from 'react'
import { ROOT } from '@shared/plugin-door'
import type { OpenPage } from './page'
import { TheirText } from './TheirText'

/** Which page a part is on, for what's counted a page (its Logs parts' streams). */
export const PageKey = createContext('')

/**
 * Which open page a part is of, the same for as long as that page is open and another's for
 * another (a tab on another object, say): what keeps a header's button its own page's to the
 * keyboard (lib/focus-back.ts).
 */
export const PageIdentity = createContext('')
const identities = new WeakMap<OpenPage, string>()
let opened = 0
const identityOf = (page: OpenPage) => {
  let identity = identities.get(page)
  if (identity === undefined) identities.set(page, (identity = `page-${++opened}`))
  return identity
}

/**
 * A part or a text of the page, drawn again only when it has something new to draw: what a part
 * holds is drawn by its own, each of them likewise, so a change deep in the page draws that and
 * nothing round it.
 */
const Drawn = memo(function Drawn({ page, id }: { page: OpenPage; id: number }) {
  useSyncExternalStore(
    useCallback((changed: () => void) => page.subscribeTo(id, changed), [page, id]),
    // (What Lumovi holds of it beside: a button held busy, which the plugin didn't draw.)
    () => `${page.tree.changedAt(id)}:${page.heldAt(id)}`,
  )
  const node = page.tree.node(id)
  if (!node) return null
  const inside = node.children.map((child) => <Drawn key={child} page={page} id={child} />)
  if (id === ROOT) return inside
  // (A text under a part runs on with the texts beside it; the part that holds it clips it.)
  if (node.part === undefined) return <TheirText text={node.text ?? ''} lines inline />
  const { draw: Part } = page.parts[node.part]!
  return (
    <Part
      props={page.handed(node.part, node.props, id)}
      go={page.go}
      {...(page.by ? { by: page.by } : {})}
      {...(page.code ? { code: page.code } : {})}
    >
      {inside}
    </Part>
  )
})

/** The page of `page`, as it is now. */
export function PluginSurface({ page }: { page: OpenPage }) {
  const key = useId()
  return (
    <div data-testid="plugin-surface" className="flex flex-col gap-4 p-4">
      <PageKey.Provider value={key}>
        <PageIdentity.Provider value={identityOf(page)}>
          <Drawn page={page} id={ROOT} />
        </PageIdentity.Provider>
      </PageKey.Provider>
    </div>
  )
}
