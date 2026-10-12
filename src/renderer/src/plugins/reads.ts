/**
 * A plugin's page, reading: what its code asks to read, counted by the door, made by the main
 * process or the server (which checks the grant and picks what the plugin may have), and what
 * comes back handed to its code with a token for each object. A list is kept up to date by
 * reading it again, as Lumovi's own lists are, while the window shows.
 *
 * What goes down to a plugin's code, as text:
 * - `{ read, objects: [{ token, object, secrets? }] }`: what a read found, each time it's read
 *   again; and of an object of its own kind, for each path its file declares, a token for each
 *   Secret the object names there (`secrets: [{ path, tokens }]`), for its page's parts to show;
 * - `{ read, ended, said }`: the read is over (refused, or what it read is gone): a code, and
 *   Lumovi's sentence for it;
 * - `{ read, failing, said }`: reading it again failed this time; it's tried again.
 */
import type { ObjectRef } from '@shared/kit/declare'
import type { Stopped } from '@shared/plugin-door'
import {
  PageReads,
  READ_REFUSED,
  readAsk,
  type PluginCount,
  type PluginRead,
  type PluginReadQuery,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { Tokens, type PluginHanded } from '@shared/plugin-presses'
import { whose } from '@shared/plugins'
import { listPollInterval, POLL_INTERVAL } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'

/** What all of a plugin's pages in this window keep and were handed, by its name. */
const plugins = new Map<string, PluginCount & PluginHanded>()
const countOf = (plugin: string) => {
  let count = plugins.get(plugin)
  if (!count) plugins.set(plugin, (count = { lists: 0, kept: 0, objects: 0 }))
  return count
}

/** What ends a read, rather than failing once: said as its end. */
const ENDS: ReadonlySet<ReadRefusal> = new Set<ReadRefusal>([
  'changed',
  'not-yet',
  'not-granted',
  'not-in-use',
  'no-such-kind',
  'needs-namespace',
  'not-found',
  'not-allowed',
  'too-many',
])

interface Going {
  query: PluginReadQuery
  list: boolean
  /** What it handed last: an object no longer in it has its token taken back. */
  last: ObjectRef[] | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  reading: boolean
}

export class PageReading {
  readonly tokens: Tokens
  readonly #reads: PageReads
  readonly #going = new Map<number, Going>()
  readonly #context: string
  readonly #plugin: string
  /** What the page's code was handed with: every read names them. */
  readonly #handed: { digest: string; codeDigest: string }
  readonly #send: (text: string) => void
  readonly #changed: () => void
  #heldSaid = false
  #closed = false

  constructor(options: {
    context: string
    plugin: string
    /** The digests of the file and the code the page was handed (`PluginCode`). */
    handed: { digest: string; codeDigest: string }
    send: (text: string) => void
    /** The plugin changed since the page was handed its code: the page is to end, said so. */
    changed: () => void
  }) {
    this.#context = options.context
    this.#plugin = options.plugin
    this.#handed = options.handed
    this.#send = options.send
    this.#changed = options.changed
    const count = countOf(options.plugin)
    this.#reads = new PageReads(count)
    this.tokens = new Tokens(count)
  }

  /** One of its code's asks (read from its text already): nothing, or why the plugin is stopped. */
  ask(message: unknown): Stopped | undefined {
    const ask = readAsk(message)
    if ('why' in ask) return ask
    const counted = this.#reads.take(ask)
    if (counted === 'too-soon') return undefined
    if (counted) return counted
    if ('stop' in ask) {
      this.#end(ask.stop)
      return undefined
    }
    if ('refresh' in ask) {
      // Its own lists, and nothing of anyone else's.
      for (const [read, going] of this.#going) if (going.list) this.#read(read)
      return undefined
    }
    if (ask.what !== 'list' && ask.what !== 'object') {
      // An object's events, its usage: refused with a code (a plugin written for a later Lumovi
      // doesn't lose its page for asking).
      this.#refuse(ask.read, 'not-yet')
      return undefined
    }
    const { kind, namespace } = ask
    const query: PluginReadQuery = {
      context: this.#context,
      plugin: this.#plugin,
      ...this.#handed,
      kind,
      ...(namespace === undefined ? {} : { namespace }),
      ...(ask.what === 'object' ? { name: ask.name } : {}),
    }
    this.#going.set(ask.read, {
      query,
      list: ask.what === 'list',
      last: undefined,
      timer: undefined,
      reading: false,
    })
    this.#read(ask.read)
    return undefined
  }

  #read(read: number): void {
    const going = this.#going.get(read)
    if (!going || going.reading) return
    clearTimeout(going.timer)
    going.reading = true
    void api.kube
      .pluginRead(going.query)
      .catch((): PluginRead => ({ ok: false, refused: 'failed' }))
      .then((result) => {
        going.reading = false
        if (this.#closed || this.#going.get(read) !== going) return
        this.#answer(read, going, result)
      })
  }

  #answer(read: number, going: Going, result: PluginRead): void {
    if (!result.ok) {
      // A read's first answer that's a refusal ends it; so does what's gone, or not allowed any
      // more. A failure of a read that had answers is said, and it's tried again.
      if (going.last === undefined || ENDS.has(result.refused))
        return this.#refuse(read, result.refused)
      this.#tell({ read, failing: result.refused, said: READ_REFUSED[result.refused] })
      return this.#again(read, going, going.last.length)
    }
    const { kind, objects, held } = result.answer
    const refs: ObjectRef[] = objects.map(({ namespace, name }) => ({
      kind,
      name,
      ...(namespace === undefined ? {} : { namespace }),
    }))
    // What left the read since it was last handed: its token is no more.
    const now = new Set(refs.map(key))
    for (const ref of going.last ?? []) if (!now.has(key(ref))) this.tokens.gone(read, ref)
    const tokens = this.tokens.hand(read, refs)
    // (Lumovi read these from the cluster: one that's no object's name is no read of a plugin's.)
    if (tokens === 'too-many' || tokens === 'not-a-name') {
      return this.#refuse(read, tokens === 'too-many' ? 'too-many' : 'failed')
    }
    // A token for each Secret an object names by a path its file declares: in the object's own
    // namespace, with the file's keys. (One that's no Secret's name, or an object in none, has
    // none.) The names are the backend's, read from the object as it was read.
    const secrets: { path: string; tokens: string[] }[][] = []
    for (const [i, { namespace, secrets: named = [] }] of objects.entries()) {
      const found: { path: string; tokens: string[] }[] = []
      const made = this.tokens.secrets(
        read,
        refs[i]!,
        named.flatMap(({ path, keys, names }) =>
          names.map((name) => ({
            namespace: namespace as string,
            name,
            keys,
            namedBy: { kind, name: refs[i]!.name, path },
          })),
        ),
      )
      if (made === 'too-many') return this.#refuse(read, 'too-many')
      let at = 0
      for (const { path, names } of named) {
        const tokens = made.slice(at, (at += names.length))
        found.push({ path, tokens: tokens.filter((token) => token !== undefined) })
      }
      secrets.push(found)
    }
    going.last = refs
    this.#reads.answered(read)
    if (held > 0 && !this.#heldSaid) {
      this.#heldSaid = true
      console.warn(
        `Lumovi held back ${held} ${held === 1 ? 'field' : 'fields'} that ${whose(this.#plugin)} file names: a plugin may not read them.`,
      )
    }
    this.#tell({
      read,
      objects: tokens.map((token, i) => ({
        token,
        object: objects[i]!.object,
        ...(objects[i]!.secrets ? { secrets: secrets[i] } : {}),
      })),
    })
    this.#again(read, going, refs.length)
  }

  /** Reads it again in a while: a list as often as Lumovi's own list of as many. */
  #again(read: number, going: Going, count: number): void {
    going.timer = setTimeout(
      () => {
        // (While the window doesn't show, nobody's looking: read once it does.)
        if (document.visibilityState === 'visible') this.#read(read)
        else this.#again(read, going, count)
      },
      going.list ? listPollInterval(count) : POLL_INTERVAL,
    )
  }

  #refuse(read: number, refused: ReadRefusal): void {
    this.#end(read)
    this.#reads.refused(read)
    this.#tell({ read, ended: refused, said: READ_REFUSED[refused] })
    // (A page whose plugin changed under it ends: its code is not the plugin's any more.)
    if (refused === 'changed') this.#changed()
  }

  /** A read is over: nothing of it is read again, and its tokens are no more. */
  #end(read: number): void {
    const going = this.#going.get(read)
    if (going) clearTimeout(going.timer)
    this.#going.delete(read)
    this.tokens.ended(read)
  }

  #tell(message: object): void {
    if (!this.#closed) this.#send(JSON.stringify(message))
  }

  /** The page is gone: nothing more is read for it, and what it kept is no longer counted. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const read of [...this.#going.keys()]) this.#end(read)
    this.#reads.close()
    this.tokens.close()
  }
}

const key = ({ kind, namespace, name }: ObjectRef) => `${kind}\u0000${namespace ?? ''}\u0000${name}`
