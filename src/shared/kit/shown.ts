/**
 * What a plugin's page can show without ever holding it: a Secret's value, a pod's logs, an
 * object's events. A plugin says which thing, by a reference Lumovi gave it; Lumovi reads it as
 * the person, under the person's own rights, and draws it with its own parts.
 *
 * Nothing goes back: these parts have no handlers. Not a value, not its length, not whether it
 * was revealed or copied, not whether the read was refused, not how many lines or events there
 * are. By their types, a description has no place for any of it.
 *
 * This is what the components are given. As a plugin says it, a Secret, a pod or an object is a
 * token Lumovi handed out (a Secret's from a path the plugin's file declares), which the door
 * swaps for the reference here.
 */
import type { ObjectRef } from './table'

/** How much may be said: counted where a description is taken in. */
export const SHOWN_LIMITS = {
  /** Keys of a Secret one part shows. */
  keys: 20,
  /** Parts of these kinds on one page. */
  parts: 20,
  /** Characters of a title. */
  text: 253,
} as const

/**
 * A Secret, as Lumovi names it, and the keys of it a plugin's file lets its pages show. Lumovi's
 * own to give: the door makes it from the token a plugin was handed, and hands none whose
 * namespace or name isn't a name as Kubernetes has them (a Secret's name comes from a field of
 * an object in the cluster, which is anyone's text until it's held to that).
 */
export interface SecretRef {
  namespace: string
  name: string
  keys: readonly string[]
  /**
   * What named it, as the door handed it (the object, and the path its plugin's file declares):
   * a press on a plugin's page sends it, and the backend holds the read to it.
   */
  namedBy?: { kind: string; name: string; path: string }
}

/** Some of a Secret's values. Nothing of it is read until the person presses. */
export interface SecretShown {
  /** What the plugin calls it. The Secret's own name and namespace are always shown beside it. */
  title: string
  /** The Secret; none where the object the plugin read names none. */
  secret?: SecretRef
  /** Which of the keys the file allows; all of them, unless said. It can only narrow them. */
  keys?: string[]
}

/**
 * A pod's logs, in Lumovi's own log view. The pod may be absent: what a plugin pointed at can be
 * gone by the time the page is drawn, and the part then says there's nothing to show.
 */
export interface LogsShown {
  title: string
  pod?: ObjectRef
}

/** An object's events, as its detail lists them. The object may be absent, as a pod may. */
export interface EventsShown {
  title: string
  of?: ObjectRef
}

/**
 * Whose page it is: Lumovi's own knowledge, handed beside a description and never part of one.
 * It's named in the part's caption and where something can't be shown.
 */
export interface By {
  name: string
  version: string
}

/** The keys a Secret's part shows: the file's, narrowed by the description's, each once. */
export function shownKeys(shown: SecretShown): string[] {
  const allowed = [...new Set(shown.secret?.keys ?? [])]
  const asked = shown.keys
  return (asked ? allowed.filter((key) => asked.includes(key)) : allowed).slice(
    0,
    SHOWN_LIMITS.keys,
  )
}
