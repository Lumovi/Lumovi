/**
 * The door, for what a person presses on a plugin's page: what a press may do, and who decides.
 *
 * A plugin's code names things; it never holds them. An object is a token Lumovi gave it with
 * the object; a handler is a handle of its own. Before a part of Lumovi's is drawn the door
 * puts the object's reference where the token was, and a function where the handle was
 * (`swapFor`). Then:
 *
 * - only Lumovi's own component opens anything, on the person's press, by a reference the door
 *   put there. Nothing a plugin's code can send opens anything;
 * - a press that a part reports is one message to the plugin: the handle it named, and what
 *   the part's declaration says that event carries, and nothing else (`callOf`);
 * - what a press would DO is the door's to say, never a button's own word about itself: it
 *   tells the plugin, it opens something, or it changes the cluster (`mayStart`). On a phone a
 *   press that would change is refused here, whatever was drawn.
 */
import {
  wrongWithFields,
  type ObjectRef,
  type Part,
  type SecretRef,
  type Swap,
} from './kit/declare'

/**
 * How much Lumovi hands over. Not a ceiling on a plugin, which doesn't choose how many objects
 * a cluster has: a read that would hand a page more than its share is refused with a code, and
 * the plugin can ask for less (a namespace, another kind). First lines; what settles them is a
 * real page on the largest cluster there is to try.
 */
export const HANDED_LIMITS = {
  /** Objects handed to one page, across all its reads; and to all of a plugin's pages. */
  objectsAPage: 50_000,
  objectsAPlugin: 100_000,
} as const

/** What a token stands for. The two sorts never stand in for each other. */
type Held = { sort: 'object'; ref: ObjectRef } | { sort: 'secret'; ref: SecretRef }

/** What all of a plugin's pages have been handed between them. */
export interface PluginHanded {
  objects: number
}

/** At least 128 random bits, as text a token is made of. */
function random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_')
}

/**
 * The tokens of one page: one for each object Lumovi handed it, and for each Secret an object
 * names by a path its file declares. A token is good on the page it was handed to and on no
 * other, another page of the same plugin included; it goes with the read that brought it, and
 * with the page.
 */
export class Tokens {
  readonly #plugin: PluginHanded
  readonly #make: () => string
  readonly #held = new Map<string, Held & { read: number }>()
  readonly #byRead = new Map<number, string[]>()
  /** The references this page's door has put in a component's hands: only these open anything. */
  readonly #given = new WeakSet<object>()
  #objects = 0
  #staleSaid = false

  constructor(plugin: PluginHanded, make: () => string = random) {
    this.#plugin = plugin
    this.#make = make
  }

  /**
   * Whether `count` more objects may be handed to this page. Where not, the read that would
   * bring them is refused with a code ("too many to hand over"): it isn't a reason to stop the
   * plugin, which didn't choose the size of the cluster.
   */
  room(count: number): boolean {
    return (
      this.#objects + count <= HANDED_LIMITS.objectsAPage &&
      this.#plugin.objects + count <= HANDED_LIMITS.objectsAPlugin
    )
  }

  /** A token for an object handed over by `read`. */
  object(read: number, ref: ObjectRef): string {
    this.#objects++
    this.#plugin.objects++
    return this.#keep(read, { sort: 'object', ref: Object.freeze({ ...ref }) })
  }

  /**
   * A token for a Secret an object names by a declared path: that Secret, in the object's own
   * namespace, and the keys the file names. Nothing of the Secret is read to make it.
   */
  secret(read: number, ref: SecretRef): string {
    return this.#keep(read, {
      sort: 'secret',
      ref: Object.freeze({ ...ref, keys: Object.freeze([...ref.keys]) }),
    })
  }

  #keep(read: number, held: Held): string {
    const token = this.#make()
    this.#held.set(token, { ...held, read })
    const tokens = this.#byRead.get(read)
    if (tokens) tokens.push(token)
    else this.#byRead.set(read, [token])
    return token
  }

  /** The object a token stands for on this page; nothing for a Secret's token, or one not held. */
  objectOf(token: string): ObjectRef | undefined {
    const held = this.#held.get(token)
    if (held?.sort !== 'object') return undefined
    this.#given.add(held.ref)
    return held.ref
  }

  /**
   * Where a press on something that opens `object` goes: a name Lumovi makes from what it
   * handed over, never text. Nothing unless `object` is the very reference this page's door put
   * in the component's hands: one that merely looks like it opens nothing.
   */
  destinationOf(object: unknown): Destination | undefined {
    return typeof object === 'object' && object !== null && this.#given.has(object)
      ? { to: 'object', object: object as ObjectRef }
      : undefined
  }

  /** The Secret a token stands for on this page; nothing for an object's token, or one not held. */
  secretOf(token: string): SecretRef | undefined {
    const held = this.#held.get(token)
    return held?.sort === 'secret' ? held.ref : undefined
  }

  /**
   * Whether to say, in the log for a plugin's author, that a token it named isn't held: true the
   * first time on this page and never again. (To the person nothing is said: a row that doesn't
   * open is quiet.)
   */
  staleToSay(): boolean {
    if (this.#staleSaid) return false
    return (this.#staleSaid = true)
  }

  /** A read ended: the tokens it brought are no more. */
  ended(read: number): void {
    for (const token of this.#byRead.get(read) ?? []) {
      if (this.#held.get(token)?.sort === 'object') {
        this.#objects--
        this.#plugin.objects--
      }
      this.#held.delete(token)
    }
    this.#byRead.delete(read)
  }

  /** The page is gone, and every token with it. */
  close(): void {
    for (const read of [...this.#byRead.keys()]) this.ended(read)
  }
}

/** A press a part reports: which handle the plugin named for it, the event, what it carries. */
export type Call = (handle: string, event: string, carries: unknown) => void

/**
 * What the door puts in the place of what a plugin named, for one page: the object or the
 * Secret a token stands for there, a function for a handler. A token this page doesn't hold
 * gives nothing, and the component shows what it would for a row that opens nothing: never
 * anything the plugin wrote in the token's place.
 */
export function swapFor(tokens: Tokens, call: Call, stale: () => void = () => undefined): Swap {
  const held = <T>(found: T | undefined): T | undefined => {
    if (found === undefined) stale()
    return found
  }
  return {
    object: (token) => held(tokens.objectOf(token)),
    secret: (token) => held(tokens.secretOf(token)),
    handler: (handle, event) => (carries) => call(handle, event, carries),
  }
}

/**
 * The one message a press sends a plugin: the handle it named, and what the part's declaration
 * says the event carries, checked against it even though a component of Lumovi's made it. An
 * event the part doesn't declare, or carrying what it doesn't declare, sends nothing: never
 * Lumovi's own reference to anything, nor a field of an object the plugin wasn't granted.
 */
export function callOf(
  part: Part,
  event: string,
  handle: string,
  carries: unknown,
): string | undefined {
  const declared = Object.hasOwn(part.events ?? {}, event) ? part.events![event]! : undefined
  if (!declared) return undefined
  if (wrongWithFields(carries, declared, Object.keys(declared), part.name)) return undefined
  return JSON.stringify({ call: handle, carries })
}

/** What a press would do, as the door classes it. */
export type Does =
  /** It tells the plugin (a handler's call): nothing in the cluster or in Lumovi changes. */
  | 'tells'
  /** It opens something of Lumovi's own: an object's page. */
  | 'opens'
  /** It changes the cluster. */
  | 'changes'

/** What a person is told where a press is refused on a phone. (Nothing of the plugin: they did
 *  nothing wrong, and needn't know whose word was.) */
export const ON_A_LARGER_SCREEN = 'Open Lumovi on a larger screen to do this.'

/**
 * Whether a press may start what it would do, on this screen. Asked by what the press does,
 * never by what a button said of itself: a plugin's "this one changes nothing" decides what's
 * drawn, and nothing else. On a phone nothing a plugin's page starts is a change.
 *
 * (Today no press of a plugin's page changes anything on any screen: changes through the door
 * come later. They come through here.)
 */
export function mayStart(does: Does, layout: string): true | { refused: string } {
  return does === 'changes' && layout === 'phone' ? { refused: ON_A_LARGER_SCREEN } : true
}

/** Where a press that opens goes: a name Lumovi makes from what it handed over, never text. */
export type Destination = { to: 'object'; object: ObjectRef }
