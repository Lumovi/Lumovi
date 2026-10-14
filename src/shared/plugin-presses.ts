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
  OBJECT_NAME,
  wrongWithFields,
  type CutRef,
  type ListDestination,
  type PageDestination,
  type Reach,
  type ReachDestination,
  type ObjectRef,
  type Part,
  type SecretRef,
  type Swap,
  type WrittenDestination,
  type WrittenPage,
  type WrittenReach,
} from './kit/declare'
import type { Health } from './health'
import { CHANGE_LIMITS } from './plugin-changes'
import { NAMESPACE_NAME } from './node-shell'
import { builtinResource, kindFor } from './resources'

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
  /** Secrets named for one page's parts to show, across all its reads. */
  secretsAPage: 50_000,
  /**
   * Lists to open one page's parts are handed, each different (as many as a page could draw, and
   * then some): past it, one more opens nothing. Each is kept for as long as the page.
   */
  destinationsAPage: 1_000,
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
 * Whether what Lumovi is about to hand over names an object Kubernetes could have: anything else
 * isn't one Lumovi read, and nothing is made for it (nor could it be told apart from another).
 */
const named = ({ name, namespace }: { name: unknown; namespace?: unknown }) =>
  // (A test of what isn't text tests the text it would be: "undefined" is a name.)
  typeof name === 'string' &&
  OBJECT_NAME.test(name) &&
  (namespace === undefined || (typeof namespace === 'string' && NAMESPACE_NAME.test(namespace)))

/** Which object, as one text: its kind as resolved, its namespace, its name. */
const which = ({ kind, namespace, name }: ObjectRef) =>
  `${kind}\u0000${namespace ?? ''}\u0000${name}`

/**
 * Whether a text is a Secret's key, as Kubernetes has them: letters, digits, `-`, `_` and `.`,
 * up to 253, and never `.`, nor `..` or anything that starts with it. (Both the file checker and
 * the door ask this: a part draws a key where a person reads it.)
 */
export const isSecretKey = (key: unknown): key is string =>
  typeof key === 'string' && /^(?!\.$)(?!\.\.)[-._a-zA-Z0-9]{1,253}$/.test(key)

/** Which Secret, and which of its keys, as one text. */
const secretKey = ({ namespace, name, keys, namedBy }: SecretRef) =>
  `${namespace}\u0000${name}\u0000${JSON.stringify(keys)}\u0000${JSON.stringify(namedBy ?? null)}`

/**
 * The tokens of one page: one for each object Lumovi handed it, and for each Secret an object
 * names by a path its file declares. A token is good on the page it was handed to and on no
 * other, another page of the same plugin included; it goes with the read that brought it, and
 * with the page.
 *
 * Within a read an object has one token for as long as it's there, however often it's handed
 * over again (a list kept up to date hands a pod over every time it changes): counted once, and
 * the same token, so a plugin can keep a row by it.
 */
export class Tokens {
  readonly #plugin: PluginHanded
  readonly #make: () => string
  readonly #held = new Map<string, Held & { read: number }>()
  /**
   * Of each read: its objects' tokens by which object; and its Secrets' tokens, by which object
   * names them and then by which Secret.
   */
  readonly #byRead = new Map<
    number,
    { objects: Map<string, string>; secrets: Map<string, Map<string, string>> }
  >()
  /** The references this page's door has put in a component's hands: only these open anything. */
  readonly #given = new Set<object>()
  /** The lists to open it made, by how each was said; and as a set, to tell them apart. */
  readonly #listsBy = new Map<string, ListDestination>()
  readonly #lists = new Set<ListDestination>()
  /** The links to Lumovi's own places it made, likewise. */
  readonly #reachesBy = new Map<string, ReachDestination>()
  readonly #reaches = new Set<ReachDestination>()
  /** The links to its plugin's own pages it made, likewise. */
  readonly #pagesBy = new Map<string, PageDestination>()
  readonly #pages = new Set<PageDestination>()
  /** How reads were cut, by the token of each; and each read's one token, its latest answer's. */
  readonly #cuts = new Map<string, CutRef>()
  readonly #cutBy = new Map<number, string>()
  #objects = 0
  #secrets = 0
  #staleSaid = false
  #unnamedSaid = false
  /** The latest press's token, and when it was pressed: good once, for a moment, until the next. */
  #press: { token: string; at: number } | undefined

  constructor(plugin: PluginHanded, make: () => string = random) {
    this.#plugin = plugin
    this.#make = make
  }

  #read(read: number) {
    let of = this.#byRead.get(read)
    if (!of) this.#byRead.set(read, (of = { objects: new Map(), secrets: new Map() }))
    return of
  }

  /**
   * Hands `read`'s page these objects: a token for each, in order; the one it has already for
   * an object this read handed before. Or `'too-many'`, and then none is handed and nothing is
   * counted: more than a page's or a plugin's share of objects. That refuses the read with a
   * code; it isn't a reason to stop the plugin, which didn't choose the size of the cluster.
   * Or `'not-a-name'`, likewise: one of them has a name or a namespace no object could have.
   */
  hand(read: number, refs: readonly ObjectRef[]): string[] | 'too-many' | 'not-a-name' {
    if (!refs.every(named)) return 'not-a-name'
    const of = this.#read(read)
    const fresh = new Set(refs.map(which).filter((key) => !of.objects.has(key))).size
    if (
      this.#objects + fresh > HANDED_LIMITS.objectsAPage ||
      this.#plugin.objects + fresh > HANDED_LIMITS.objectsAPlugin
    ) {
      return 'too-many'
    }
    return refs.map((ref) => {
      const key = which(ref)
      let token = of.objects.get(key)
      if (token === undefined) {
        token = this.#make()
        this.#held.set(token, { sort: 'object', ref: Object.freeze({ ...ref }), read })
        of.objects.set(key, token)
        this.#objects++
        this.#plugin.objects++
      }
      return token
    })
  }

  /**
   * An object left `read` (deleted, or no longer in its list): its token is no more, nor those
   * of the Secrets it named.
   */
  gone(read: number, ref: ObjectRef): void {
    const of = this.#byRead.get(read)
    const token = of?.objects.get(which(ref))
    if (token === undefined) return
    of!.objects.delete(which(ref))
    this.#forget(token)
    for (const secret of of!.secrets.get(which(ref))?.values() ?? []) this.#forget(secret)
    of!.secrets.delete(which(ref))
  }

  /**
   * The tokens for the Secrets that `owner`, an object `read` handed, names by a declared path:
   * `refs`, each in the object's own namespace with the keys the file names. A Secret it named
   * before has the token it had; one it no longer names has its token taken back. Nothing in the
   * place of a name or a namespace no Secret could have, and nothing at all for an object this
   * read didn't hand. Or `'too-many'`, and nothing is made or taken back: more than a page's
   * share, which refuses the read as an object's would. Nothing of a Secret is read to make one.
   */
  secrets(
    read: number,
    owner: ObjectRef,
    refs: readonly SecretRef[],
  ): (string | undefined)[] | 'too-many' {
    const of = this.#byRead.get(read)
    const whose = which(owner)
    if (!of?.objects.has(whose)) return refs.map(() => undefined)
    const was = of.secrets.get(whose) ?? new Map<string, string>()
    // (A Secret is always in a namespace; and the keys a part may show are Secrets' keys, each
    // drawn where a person reads it.)
    const keys = refs.map((ref) =>
      ref.namespace !== undefined && named(ref) && ref.keys.every(isSecretKey)
        ? secretKey(ref)
        : undefined,
    )
    const wanted = new Set(keys.filter((key) => key !== undefined))
    const fresh = [...wanted].filter((key) => !was.has(key)).length
    const leaving = [...was.keys()].filter((key) => !wanted.has(key)).length
    if (this.#secrets + fresh - leaving > HANDED_LIMITS.secretsAPage) return 'too-many'
    const now = new Map<string, string>()
    const tokens = refs.map((ref, i) => {
      const key = keys[i]
      if (key === undefined) return undefined
      let token = now.get(key) ?? was.get(key)
      if (token === undefined) {
        token = this.#make()
        const kept = Object.freeze({
          ...ref,
          keys: Object.freeze([...ref.keys]),
          ...(ref.namedBy ? { namedBy: Object.freeze({ ...ref.namedBy }) } : {}),
        })
        this.#held.set(token, { sort: 'secret', ref: kept, read })
        this.#secrets++
      }
      now.set(key, token)
      return token
    })
    for (const [key, token] of was) if (!now.has(key)) this.#forget(token)
    if (now.size > 0) of.secrets.set(whose, now)
    else of.secrets.delete(whose)
    return tokens
  }

  #forget(token: string): void {
    const held = this.#held.get(token)
    if (!held) return
    if (held.sort === 'object') {
      this.#objects--
      this.#plugin.objects--
    } else this.#secrets--
    // (What a component was handed for it opens nothing any more.)
    this.#given.delete(held.ref)
    this.#held.delete(token)
  }

  /**
   * The token for how `read`'s answer was cut, as Lumovi's backend said it: made anew for each
   * answer, the one before it taken back. So a part that names it carries Lumovi's numbers for
   * the read's latest answer, and a part drawn from an earlier one, another read's or another
   * page's names a token not held here, and says nothing of any cut.
   */
  cutFor(read: number, cut: CutRef): string {
    this.uncut(read)
    const token = this.#make()
    this.#cuts.set(token, Object.freeze({ ...cut }))
    this.#cutBy.set(read, token)
    return token
  }

  /** `read`'s answer wasn't cut, or the read is over: the token for how it was is no more. */
  uncut(read: number): void {
    const token = this.#cutBy.get(read)
    if (token === undefined) return
    this.#cuts.delete(token)
    this.#cutBy.delete(read)
  }

  /** How a read was cut, by its token on this page; nothing for one not held. The swap's alone. */
  cutOf(token: string): CutRef | undefined {
    return this.#cuts.get(token)
  }

  /**
   * The object a token stands for on this page; nothing for a Secret's token, or one not held.
   * Called by the door's swap alone: what it gives is the right to open, and anything else that
   * looked tokens up would be handing that out.
   */
  objectOf(token: string): ObjectRef | undefined {
    const held = this.#held.get(token)
    if (held?.sort !== 'object') return undefined
    this.#given.add(held.ref)
    return held.ref
  }

  /**
   * The pod a token stands for on this page, for its code's ask for the pod's logs: nothing for
   * an object of another kind, a Secret's token, or one not held. (Handed to no part, it opens
   * nothing.)
   */
  podOf(token: string): ObjectRef | undefined {
    const held = this.heldOf(token)
    return held?.kind === 'Pod' ? held : undefined
  }

  /**
   * The object a token stands for on this page, for its code's ask of its server: nothing for a
   * Secret's token, or one not held. (Handed to no part, it opens nothing.)
   */
  heldOf(token: string): ObjectRef | undefined {
    const held = this.#held.get(token)
    return held?.sort === 'object' ? held.ref : undefined
  }

  /**
   * Where a press on something that opens `object` goes: a name Lumovi makes from what it
   * handed over, never text. Nothing unless `object` is the very reference this page's door put
   * in a component's hands, for a read that's still going: one that merely looks like it, or
   * whose read has ended, opens nothing.
   */
  destinationOf(object: unknown): Destination | undefined {
    if (typeof object !== 'object' || object === null || !this.#given.has(object)) return undefined
    if (this.#lists.has(object as ListDestination)) return object as ListDestination
    if (this.#reaches.has(object as ReachDestination)) return object as ReachDestination
    if (this.#pages.has(object as PageDestination)) return object as PageDestination
    return { to: 'object', object: object as ObjectRef }
  }

  /**
   * A link to one of Lumovi's own places for an object this page holds, as the door hands it to
   * a part: only where `links` (what its plugin's file says its pages link to) has that place,
   * and only for an object of a kind that place is for (`REACHED`); frozen, the same one each
   * time it's said the same way. Anything else gives nothing, and `unlinked` is told which place.
   */
  reachOf(
    said: WrittenReach,
    links: ReadonlySet<Reach>,
    unlinked: (at: string) => void = () => undefined,
  ): ReachDestination | undefined {
    const at = said.at as Reach
    if (!links.has(at)) {
      unlinked(at)
      return undefined
    }
    const key = JSON.stringify([said.object, at, said.container ?? null, said.port ?? null])
    const made = this.#reachesBy.get(key)
    if (made) return made
    if (this.#reachesBy.size >= HANDED_LIMITS.destinationsAPage) return undefined
    const object = this.objectOf(said.object)
    if (!object || !REACHED[at].has(object.kind)) return undefined
    const reach: ReachDestination = Object.freeze({
      to: 'reach',
      at,
      object,
      ...(said.container !== undefined ? { container: said.container } : {}),
      ...(said.port !== undefined ? { port: said.port } : {}),
    })
    this.#reachesBy.set(key, reach)
    this.#reaches.add(reach)
    this.#given.add(reach)
    return reach
  }

  /**
   * A list to open, as the door hands it to a part: of a kind among `kinds` (Lumovi's names for
   * the kinds its plugin's file names), frozen, the same one each time it's said the same way
   * (its levels in any order), and one this page's door made, so `destinationOf` opens it.
   * Nothing past a page's share; nor for another kind, which `unnamed` is told of, as the plugin
   * wrote it; nor at one object's name for a kind not among `opens` (those its file says its
   * pages open), or without its namespace where its kind has them (or with one where it hasn't),
   * which `unnamed` is told of too.
   */
  listOf(
    said: WrittenDestination,
    kinds: ReadonlySet<string>,
    unnamed: (kind: string, by?: Unopened) => void = () => undefined,
    opens: ReadonlySet<string> = new Set(),
  ): ListDestination | undefined {
    const slash = said.list.lastIndexOf('/')
    const group = said.list.slice(0, slash)
    const kind = kindFor(group ? `${group}/v1` : 'v1', said.list.slice(slash + 1))
    if (!kinds.has(kind)) {
      unnamed(said.list)
      return undefined
    }
    if (said.name !== undefined && !opens.has(kind)) {
      unnamed(said.list, 'opens')
      return undefined
    }
    // (One object of a kind with namespaces is in one, and the page knows which: it says it.)
    if (said.name !== undefined && (said.namespace !== undefined) !== isNamespaced(kind)) {
      unnamed(said.list, 'namespace')
      return undefined
    }
    const levels = said.health ? [...said.health].sort() : null
    const key = JSON.stringify([
      kind,
      levels,
      said.labels ?? null,
      said.name ?? null,
      said.namespace ?? null,
    ])
    const made = this.#listsBy.get(key)
    if (made) return made
    if (this.#listsBy.size >= HANDED_LIMITS.destinationsAPage) return undefined
    const list: ListDestination = Object.freeze({
      to: 'list',
      kind,
      ...(said.health ? { health: Object.freeze([...said.health] as Health[]) } : {}),
      ...(said.labels ? { labels: Object.freeze([...said.labels]) } : {}),
      ...(said.name !== undefined ? { name: said.name } : {}),
      ...(said.namespace !== undefined ? { namespace: said.namespace } : {}),
    })
    this.#listsBy.set(key, list)
    this.#lists.add(list)
    this.#given.add(list)
    return list
  }

  /**
   * A link to one of its plugin's own pages, as the door hands it to a part: only to a page among
   * `pages` (the ids its plugin's file names), frozen, the same one each time it's said the same
   * way (its filters in any order), and one this page's door made, so `destinationOf` opens it.
   * Nothing past a page's share; nor for a page that isn't its plugin's, which `unknown` is told.
   * Its filters are kept in pairs, never as an object keyed by the plugin's words.
   */
  pageOf(
    said: WrittenPage,
    pages: ReadonlySet<string>,
    unknown: (page: string) => void = () => undefined,
  ): PageDestination | undefined {
    if (!pages.has(said.page)) {
      unknown(said.page)
      return undefined
    }
    const filters = Object.entries(said.filters ?? {})
      .map(([key, values]) => [key, [...values].sort()] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const key = JSON.stringify([said.page, filters, said.search ?? null])
    const made = this.#pagesBy.get(key)
    if (made) return made
    if (this.#pagesBy.size + this.#listsBy.size >= HANDED_LIMITS.destinationsAPage) {
      return undefined
    }
    const page: PageDestination = Object.freeze({
      to: 'page',
      page: said.page,
      filters: Object.freeze(
        filters.map(([name, values]) => Object.freeze([name, Object.freeze(values)] as const)),
      ),
      ...(said.search !== undefined ? { search: said.search } : {}),
    })
    this.#pagesBy.set(key, page)
    this.#pages.add(page)
    this.#given.add(page)
    return page
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

  /**
   * Whether to say, in the log for a plugin's author, that its page named a list of a kind its
   * file doesn't (`unnamedLine`): true the first time on this page and never again. (To the
   * person nothing is said: a tile that opens nothing is quiet.)
   */
  unnamedToSay(): boolean {
    if (this.#unnamedSaid) return false
    return (this.#unnamedSaid = true)
  }

  /** A read ended: the tokens it brought are no more, nor what was handed out for them. */
  ended(read: number): void {
    this.uncut(read)
    const of = this.#byRead.get(read)
    if (!of) return
    for (const token of of.objects.values()) this.#forget(token)
    for (const named of of.secrets.values()) for (const token of named.values()) this.#forget(token)
    this.#byRead.delete(read)
  }

  /**
   * The person pressed something of the page's (`now`, in ms): a token for that press, which a
   * proposal of a change must carry. It lets go of the one before: only the latest press counts.
   */
  pressed(now: number): string {
    const token = this.#make()
    this.#press = { token, at: now }
    return token
  }

  /**
   * Spends a press's token: true once, for the latest press, within its moment
   * (`CHANGE_LIMITS.pressMs`); never again, and never for one let go.
   */
  spendPress(token: string, now: number): boolean {
    const press = this.#press
    if (
      !press ||
      press.token !== token ||
      now - press.at > CHANGE_LIMITS.pressMs ||
      now < press.at
    ) {
      return false
    }
    this.#press = undefined
    return true
  }

  /** Lets go of the latest press's token: the page is hidden, or its cluster changed. */
  letPressGo(): void {
    this.#press = undefined
  }

  /** The page is gone, and every token with it. */
  close(): void {
    for (const read of new Set([...this.#byRead.keys(), ...this.#cutBy.keys()])) this.ended(read)
    this.#press = undefined
  }
}

/**
 * What the log says, for a plugin's author, of a list its page named of a kind its file doesn't:
 * the kind as the plugin wrote it (as its file would), and whose page, as `whose` says it.
 */
/** Why a list at one object, of a kind its file names, isn't opened. */
export type Unopened = 'opens' | 'namespace'

/** Whether a kind's objects are each in a namespace: those Lumovi doesn't know are taken to be. */
const isNamespaced = (kind: string) => builtinResource(kind)?.namespaced ?? true

export const unnamedLine = (kind: string, whose: string, by?: Unopened): string =>
  by === 'opens'
    ? `Lumovi opens no list of ${kind} at one name for ${whose} page: its file doesn’t name that kind under spec.opens.`
    : by === 'namespace'
      ? `Lumovi opens no list of ${kind} at one name for ${whose} page: a name of that kind goes with its namespace where the kind has them, and with none where it hasn’t.`
      : `Lumovi opens no list of ${kind} for ${whose} page: its file doesn’t name that kind.`

/** A press a part reports: which handle the plugin named for it, the event, what it carries. */
export type Call = (handle: string, event: string, carries: unknown) => void

/**
 * What the door puts in the place of what a plugin named, for one page: the object or the
 * Secret a token stands for there, a function for a handler, a list it made for a list to open
 * (of a kind among `kinds`, Lumovi's names for those its plugin's file names; at one object only
 * of one among `opens`). A token this page doesn't hold gives nothing, and so does a list of
 * another kind (`unnamed` is told which): the component shows what it would for a row that opens
 * nothing, never anything the plugin wrote in its place.
 */
export function swapFor(
  tokens: Tokens,
  call: Call,
  stale: () => void = () => undefined,
  kinds: ReadonlySet<string> = new Set(),
  unnamed: (kind: string, by?: Unopened) => void = () => undefined,
  opens: ReadonlySet<string> = new Set(),
  links: ReadonlySet<Reach> = new Set(),
  unlinked: (at: string) => void = () => undefined,
  pages: ReadonlySet<string> = new Set(),
  unknownPage: (page: string) => void = () => undefined,
): Swap {
  const held = <T>(found: T | undefined): T | undefined => {
    if (found === undefined) stale()
    return found
  }
  return {
    object: (token) => held(tokens.objectOf(token)),
    secret: (token) => held(tokens.secretOf(token)),
    // (Lumovi's numbers for a read's latest cut answer; a token no longer held says nothing.)
    cut: (token) => held(tokens.cutOf(token)),
    destination: (said) =>
      'object' in said
        ? tokens.reachOf(said, links, unlinked)
        : 'page' in said
          ? tokens.pageOf(said, pages, unknownPage)
          : tokens.listOf(said, kinds, unnamed, opens),
    handler: (handle, event) => (carries) => call(handle, event, carries),
  }
}

/**
 * The one message a press sends a plugin: the handle it named, and what the part's declaration
 * says the event carries, checked against it even though a component of Lumovi's made it. An
 * event the part doesn't declare, or carrying what it doesn't declare, sends nothing: never
 * Lumovi's own reference to anything, nor a field of an object the plugin wasn't granted. Nor
 * does a press of what `drawn` (the part's description, as it was drawn) has no press for now:
 * a header's button that's off, or gone (the part's `heeds`). A part that heeds what it drew,
 * pressed with nothing said of what it drew, sends nothing: no press of it skips the asking.
 * With the press's token (`Tokens.pressed`, made by `press` only for a press that's sent),
 * which a proposal of a change that follows it carries.
 */
export function callOf(
  part: Part,
  event: string,
  handle: string,
  carries: unknown,
  { drawn, press }: { drawn?: Readonly<Record<string, unknown>>; press?: () => string } = {},
): string | undefined {
  const declared = Object.hasOwn(part.events ?? {}, event) ? part.events![event]! : undefined
  if (!declared) return undefined
  if (wrongWithFields(carries, declared, Object.keys(declared), part.name)) return undefined
  if (part.heeds && (!drawn || !part.heeds(drawn, event, carries))) return undefined
  const token = press?.()
  return JSON.stringify(
    token === undefined ? { call: handle, carries } : { call: handle, carries, press: token },
  )
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
export function mayStart(does: Does, layout: unknown): true | { refused: string } {
  // It says what may start, and refuses the rest. A sort of press nobody has decided about
  // starts nowhere, on any screen: that's a gap in Lumovi's own table, and it says so (a larger
  // screen wouldn't help). A layout this doesn't know, or a wrong word, is not a larger screen.
  if (!ON_A_LARGER.has(does)) return { refused: UNDECIDED }
  const may = LARGER.has(layout as string) ? ON_A_LARGER : ON_A_PHONE
  return may.has(does) ? true : { refused: ON_A_LARGER_SCREEN }
}

/** What a person is told of a press Lumovi has no rule for. (And the log is told: it's a gap.) */
export const UNDECIDED = 'Lumovi doesn’t know what this would do, so it didn’t.'

/** The app's layouts that aren't a phone, by name (`Layout` in the page's `lib/layout`). */
const LARGER: ReadonlySet<string> = new Set(['wide', 'tablet'])
/** What a press may start on a phone, and on a larger screen. */
const ON_A_PHONE: ReadonlySet<string> = new Set<Does>(['tells', 'opens'])
const ON_A_LARGER: ReadonlySet<string> = new Set<Does>(['tells', 'opens', 'changes'])

/**
 * Where a press that opens goes: a name Lumovi makes from what it handed over, never text. An
 * object's page, a list of Lumovi's own, or one of Lumovi's own places for an object (the list
 * or the link itself, as the door made it).
 */
export type Destination =
  { to: 'object'; object: ObjectRef } | ListDestination | ReachDestination | PageDestination

/** The kinds of object each of Lumovi's own places is for, as Lumovi names them. */
export const REACHED: Readonly<Record<Reach, ReadonlySet<string>>> = {
  logs: new Set(['Pod']),
  shell: new Set(['Pod']),
  'port-forward': new Set(['Pod', 'Service']),
}
