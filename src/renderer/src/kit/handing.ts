/**
 * The kit page's own stand-in for the door: each object a part here opens has a token, as one
 * Lumovi gave a plugin would be, and this is what the token stands for. The page's own, and
 * nobody else's: nothing of Lumovi's hands a part an object a door didn't make.
 */
import {
  handedFields,
  type CutRef,
  type ListDestination,
  type Part,
  type PropsOf,
  type Swap,
  type WrittenProps,
} from '@shared/kit/declare'
import type { ObjectRef } from '@shared/kit/table'
import { kindFor } from '@shared/resources'

const OBJECTS = new Map<string, ObjectRef>()
/** The token each object was given: one an object, however often it's written. */
const TOKENS = new Map<string, string>()

/** The token that stands for `object`, as a plugin would hold it. */
export function token(object: ObjectRef): string {
  const said = JSON.stringify(object)
  let made = TOKENS.get(said)
  if (made === undefined) {
    made = `object-${OBJECTS.size + 1}`
    OBJECTS.set(made, object)
    TOKENS.set(said, made)
  }
  return made
}

/** The kit page's cut reads, by the tokens it holds for them, as a door's answer would name them. */
export const KIT_CUTS: Readonly<Record<string, CutRef>> = {
  'cut-waiting': { at: 5000 },
  'cut-unscheduled': { at: 5000, of: 12345 },
  'cut-pods': { at: 5000 },
}

export const KIT_SWAP: Swap = {
  object: (made) => OBJECTS.get(made),
  secret: () => undefined,
  // (A token it doesn't hold, made up, says nothing.)
  cut: (made) => (Object.hasOwn(KIT_CUTS, made) ? KIT_CUTS[made] : undefined),
  // A list a part here opens, as a door would make it (of any kind: this page names them all).
  destination: (said) =>
    Object.freeze({
      to: 'list',
      kind: kindFor(
        said.list.startsWith('/') ? 'v1' : `${said.list.slice(0, said.list.lastIndexOf('/'))}/v1`,
        said.list.slice(said.list.lastIndexOf('/') + 1),
      ),
      ...(said.health ? { health: said.health as ListDestination['health'] } : {}),
      ...(said.labels ? { labels: said.labels } : {}),
    }),
  handler: () => undefined,
}

/** A part's description as the door hands it to its component: every text a `Their`, every token its object. */
export const handedAs = <P extends Part>(written: WrittenProps<P>, part: P) =>
  handedFields(written, part.props, KIT_SWAP) as PropsOf<P>
