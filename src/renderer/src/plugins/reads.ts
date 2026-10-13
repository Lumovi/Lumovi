/**
 * A plugin's page, reading: what its code asks to read, counted by the door, made by the main
 * process or the server (which checks the grant and picks what the plugin may have), and what
 * comes back handed to its code with a token for each object. A list is kept up to date by
 * reading it again, as Lumovi's own lists are, while the window shows.
 *
 * What goes down to a plugin's code, as text:
 * - `{ read, objects: [{ token, object, usage?, secrets? }], noUsage?, cut? }`: what a read found,
 *   each time it's read again; where usage was asked for, each object's (`usage: { cpu, memory }`,
 *   in cores and bytes), or why none has any (`noUsage`: 'unmeasured', 'not-allowed'); of an
 *   object of its own kind, for each path its file declares, a token for each Secret the object
 *   names there (`secrets: [{ path, tokens }]`), for its page's parts to show; and of a list cut
 *   at Lumovi's limit, a token for how (`cut`), this answer's alone, for a part to name;
 * - `{ read, lines: [{ time?, text }], cut? }`: a pod's logs, once, where its file says its code
 *   reads them: its last lines, oldest first, each with when it was written; `cut`, where Lumovi
 *   kept only the last of them. The read is over;
 * - `{ read, json }`: what its tool's own server answered a path its file lists, once, as JSON.
 *   The read is over;
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
  type Cut,
  type PluginCount,
  type PluginLogs,
  type PluginRead,
  type PluginReadQuery,
  type ReadAsk,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { Tokens, type PluginHanded } from '@shared/plugin-presses'
import {
  SERVER_LIMITS,
  type PluginServerAnswer,
  type ServerObject,
  serverSaid,
  type ServerRefusal,
} from '@shared/plugin-server'
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

/**
 * Asks of each plugin's server going now, across its pages in this window, by its name; and
 * those waiting their turn, first asked first.
 */
const servers = new Map<string, { going: number; waiting: (() => void)[] }>()

/** Starts an ask of a plugin's server now, or once one of its others is answered. */
function inTurn(plugin: string, start: () => void): void {
  let asking = servers.get(plugin)
  if (!asking) servers.set(plugin, (asking = { going: 0, waiting: [] }))
  if (asking.going < SERVER_LIMITS.waitingAPlugin) {
    asking.going++
    start()
  } else {
    asking.waiting.push(start)
  }
}

/** An ask of a plugin's server is answered: the next waiting has its turn. */
function turnDone(plugin: string): void {
  const asking = servers.get(plugin)
  if (!asking) return
  const next = asking.waiting.shift()
  if (next) next()
  else if (--asking.going === 0) servers.delete(plugin)
}

/** What ends a read, rather than failing once: said as its end. */
const ENDS: ReadonlySet<ReadRefusal> = new Set<ReadRefusal>([
  'changed',
  'code-off',
  'logs-off',
  'not-yet',
  'not-granted',
  'not-in-use',
  'no-such-kind',
  'needs-namespace',
  'not-found',
  'not-allowed',
  'too-many',
  'not-pickable',
])

interface Going {
  query: PluginReadQuery
  list: boolean
  /** What it handed last: an object no longer in it has its token taken back. */
  last: ObjectRef[] | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  reading: boolean
}

/**
 * What Lumovi's own page says of a page's reads, round what its plugin draws and never by it:
 * decided from Lumovi's answers alone, whatever the plugin's code does with them.
 */
export interface ReadNotices {
  /** A read that had answers is failing now: Lumovi's sentence for why. Its last answer stays. */
  stale?: string
  /**
   * A list cut at Lumovi's limit: how, where one read is; `several`, where more are (each cut at
   * that limit, `at`, and of no one count).
   */
  cut?: Cut & { several?: true }
}

export class PageReading {
  readonly tokens: Tokens
  readonly #reads: PageReads
  readonly #going = new Map<number, Going>()
  /** Asks for a pod's logs not yet answered: each is answered once. */
  readonly #logs = new Set<number>()
  /** Asks of its server not yet answered (or waiting their turn): each is answered once. */
  readonly #asking = new Set<number>()
  /** Of the reads going: those failing now, and why; those whose last answer was cut, and how. */
  readonly #failing = new Map<number, ReadRefusal>()
  readonly #cut = new Map<number, Cut>()
  #notices: ReadNotices = {}
  readonly #heard = new Set<() => void>()
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
    if (ask.what === 'events') {
      // An object's events: refused with a code (a plugin written for a later Lumovi doesn't
      // lose its page for asking).
      this.#refuse(ask.read, 'not-yet')
      return undefined
    }
    if (ask.what === 'logs') {
      this.#readLogs(ask)
      return undefined
    }
    if (ask.what === 'server') {
      this.#askServer(ask)
      return undefined
    }
    const { kind, namespace, usage } = ask
    const query: PluginReadQuery = {
      context: this.#context,
      plugin: this.#plugin,
      ...this.#handed,
      kind,
      ...(namespace === undefined ? {} : { namespace }),
      ...(ask.what === 'object' ? { name: ask.name } : {}),
      ...(usage ? { usage } : {}),
      ...(ask.what === 'list' && ask.fields ? { fields: ask.fields } : {}),
      ...(ask.what === 'list' && ask.labels ? { labels: ask.labels } : {}),
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
      this.#failing.set(read, result.refused)
      this.#noticed()
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
    this.#failing.delete(read)
    // A list cut at Lumovi's limit: Lumovi's page says so, and the plugin is handed a token for
    // how, made anew each answer, which a part it draws from these objects can name. (Both from
    // the backend's answer alone.)
    let cut: string | undefined
    if (result.answer.cut) {
      this.#cut.set(read, result.answer.cut)
      cut = this.tokens.cutFor(read, result.answer.cut)
    } else {
      this.#cut.delete(read)
      this.tokens.uncut(read)
    }
    this.#noticed()
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
        ...(objects[i]!.usage ? { usage: objects[i]!.usage } : {}),
        ...(objects[i]!.secrets ? { secrets: secrets[i] } : {}),
      })),
      ...(result.answer.noUsage ? { noUsage: result.answer.noUsage } : {}),
      ...(cut === undefined ? {} : { cut }),
    })
    this.#again(read, going, refs.length)
  }

  /** A pod's logs, once: the backend checks the plugin's file says its code reads them. */
  #readLogs({ read, pod: token, container, tail, since, previous }: LogsAsk): void {
    // (A token that's no pod's, or no longer held: as a read of what isn't there.)
    const pod = this.tokens.podOf(token)
    if (!pod?.namespace) return this.#refuse(read, 'not-found')
    this.#logs.add(read)
    void api.kube
      .pluginLogs({
        context: this.#context,
        plugin: this.#plugin,
        ...this.#handed,
        namespace: pod.namespace,
        pod: pod.name,
        container,
        ...(tail === undefined ? {} : { tail }),
        ...(since === undefined ? {} : { since }),
        ...(previous ? { previous } : {}),
      })
      .catch((): PluginLogs => ({ ok: false, refused: 'failed' }))
      .then((result) => {
        // (Ended by its code meanwhile, or the page is gone: nobody's asking.)
        if (this.#closed || !this.#logs.delete(read)) return
        if (!result.ok) return this.#refuse(read, result.refused)
        this.#reads.over(read)
        this.#tell({ read, lines: result.lines, ...(result.cut ? { cut: true } : {}) })
      })
  }

  /**
   * A path of its tool's own server, once: the objects by the tokens its page holds, and the
   * rest (its file's `server`, the path listed, the kinds) the backend's to check. In its turn:
   * a plugin's pages ask so many at once.
   */
  #askServer({ read, in: token, path, with: given = {} }: ServerAsk): void {
    const named = (ref: ObjectRef): ServerObject => ({
      kind: ref.kind,
      ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }),
      name: ref.name,
    })
    const within = this.tokens.heldOf(token)
    const fills = Object.entries(given).map(([fill, of]) => [fill, this.tokens.heldOf(of)] as const)
    // (A token that's no object's, or no longer held: as asking about what isn't there.)
    if (!within || fills.some(([, ref]) => !ref)) {
      return this.#serverEnded(read, { refused: 'not-found', said: SAID_NOT_FOUND })
    }
    this.#asking.add(read)
    inTurn(this.#plugin, () => {
      // (Ended by its code while it waited its turn, or the page is gone: nobody's asking.)
      if (this.#closed || !this.#asking.has(read)) return turnDone(this.#plugin)
      void api.kube
        .pluginServer({
          context: this.#context,
          plugin: this.#plugin,
          ...this.#handed,
          in: named(within),
          path,
          ...(fills.length > 0
            ? { with: Object.fromEntries(fills.map(([fill, ref]) => [fill, named(ref!)])) }
            : {}),
        })
        .catch((): PluginServerAnswer => ({ ok: false, refused: 'failed', said: SAID_FAILED }))
        .then((answer) => {
          turnDone(this.#plugin)
          if (this.#closed || !this.#asking.delete(read)) return
          if (!answer.ok) return this.#serverEnded(read, answer)
          this.#reads.over(read)
          this.#tell({ read, json: answer.json })
        })
    })
  }

  /** An ask of its server that got no answer: over, with Lumovi's code and sentence for why. */
  #serverEnded(read: number, { refused, said }: { refused: ServerRefusal; said: string }): void {
    this.#end(read)
    this.#reads.refused(read)
    this.#tell({ read, ended: refused, said })
    if (refused === 'changed') this.#changed()
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
    this.#logs.delete(read)
    this.#asking.delete(read)
    this.tokens.ended(read)
    this.#failing.delete(read)
    this.#cut.delete(read)
    this.#noticed()
  }

  /** What Lumovi's page says of the reads now: the same object until that changes. */
  get notices(): ReadNotices {
    return this.#notices
  }

  /** Hears when what Lumovi's page says of the reads changes. */
  subscribeNotices(heard: () => void): () => void {
    this.#heard.add(heard)
    return () => void this.#heard.delete(heard)
  }

  /** The person's "Retry": every read that's failing is read again now. */
  retry(): void {
    for (const read of this.#failing.keys()) this.#read(read)
  }

  #noticed(): void {
    const [failing] = this.#failing.values()
    const cuts = [...this.#cut.values()]
    const now: ReadNotices = {
      ...(failing === undefined ? {} : { stale: READ_REFUSED[failing] }),
      ...(cuts.length === 1
        ? { cut: cuts[0]! }
        : cuts.length > 1
          ? { cut: { at: Math.max(...cuts.map(({ at }) => at)), several: true as const } }
          : {}),
    }
    if (JSON.stringify(now) === JSON.stringify(this.#notices)) return
    this.#notices = now
    for (const heard of this.#heard) heard()
  }

  #tell(message: object): void {
    if (!this.#closed) this.#send(JSON.stringify(message))
  }

  /**
   * Lumovi's first word to the code of a tab on `object`: the object, read for the plugin as an
   * object of its own kind is (whole, and only while its file and code are the ones the page was
   * handed), with a token for it like any it reads; or why not. (Lumovi's own read, not one the
   * plugin asked for: counted as none of its asks, and its token held until the page goes.)
   */
  open(tab: string, object: ObjectRef): void {
    const query: PluginReadQuery = {
      context: this.#context,
      plugin: this.#plugin,
      ...this.#handed,
      kind: askedKind(object.kind),
      ...(object.namespace === undefined ? {} : { namespace: object.namespace }),
      name: object.name,
    }
    void api.kube
      .pluginRead(query)
      .catch((): PluginRead => ({ ok: false, refused: 'failed' }))
      .then((result) => {
        if (this.#closed) return
        const [found] = result.ok ? result.answer.objects : []
        const tokens = found ? this.tokens.hand(OPENED, [object]) : undefined
        if (!result.ok || !found || tokens === undefined || typeof tokens === 'string') {
          const refused = result.ok ? 'failed' : result.refused
          this.#tell({ open: { tab, ended: refused, said: READ_REFUSED[refused] } })
          if (refused === 'changed') this.#changed()
          return
        }
        this.#tell({ open: { tab, object: { token: tokens[0], object: found.object } } })
      })
  }

  /** The page is gone: nothing more is read for it, and what it kept is no longer counted. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const read of [...this.#going.keys()]) this.#end(read)
    this.#heard.clear()
    this.#reads.close()
    this.tokens.close()
  }
}

type LogsAsk = Extract<ReadAsk, { what: 'logs' }>
type ServerAsk = Extract<ReadAsk, { what: 'server' }>

const SAID_NOT_FOUND = serverSaid('not-found')
const SAID_FAILED = serverSaid('failed')

const key = ({ kind, namespace, name }: ObjectRef) => `${kind}\u0000${namespace ?? ''}\u0000${name}`

/** The read a tab's object is handed by: none a plugin can number (theirs start at 1). */
const OPENED = 0

/** A kind as Lumovi names it (`Widget.example.com`, `Pod`), as a plugin asks for it (`example.com/Widget`). */
const askedKind = (kind: string) => {
  const dot = kind.indexOf('.')
  return dot < 0 ? `/${kind}` : `${kind.slice(dot + 1)}/${kind.slice(0, dot)}`
}
