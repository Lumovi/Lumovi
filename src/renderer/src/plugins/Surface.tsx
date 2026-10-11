/**
 * A plugin's page, drawn: the door's tree, each part by Lumovi's own component for it, each text
 * as a text that isn't Lumovi's. Nothing here is the plugin's code: it only said which parts,
 * with which properties, and the door checked every word.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { handedFields } from '@shared/kit/declare'
import { ROOT, type DoorPage } from '@shared/plugin-door'
import type { KitPart, OpenPage } from './page'
import { TheirText } from './TheirText'

function draw(tree: DoorPage, parts: Readonly<Record<string, KitPart>>, id: number): ReactNode {
  const node = tree.node(id)
  if (!node) return null
  // (A text under a part runs on with the texts beside it; the part that holds it clips it.)
  if (node.part === undefined) return <TheirText key={id} text={node.text ?? ''} lines inline />
  const { draw: Part, declared } = parts[node.part]!
  return (
    <Part key={id} props={handedOnce(node.props, declared.props)}>
      {node.children.map((child) => draw(tree, parts, child))}
    </Part>
  )
}

/** What a part is handed, made once for the properties the door holds (they're never changed). */
const made = new WeakMap<object, Readonly<Record<string, unknown>>>()
function handedOnce(
  props: Readonly<Record<string, unknown>>,
  fields: Parameters<typeof handedFields>[1],
) {
  let handed = made.get(props)
  if (!handed) made.set(props, (handed = handedFields(props, fields)))
  return handed
}

/** The page of `page`, as it is now; drawn again when it changes. */
export function PluginSurface({ page }: { page: OpenPage }) {
  const { parts } = page
  useSyncExternalStore(page.subscribe, () => page.version)
  return (
    <div data-testid="plugin-surface" className="flex flex-col gap-4 p-4">
      {page.tree.node(ROOT)!.children.map((id) => draw(page.tree, parts, id))}
    </div>
  )
}
