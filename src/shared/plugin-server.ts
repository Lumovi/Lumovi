/**
 * A plugin's tool's own server in the cluster (`spec.server`): its code may ask Lumovi to GET a
 * path its file lists, of the one Service its file names, in the namespace of an object of its
 * own kind its page was handed. Lumovi asks through the API server's service proxy, as the
 * person, and hands back what the server answered as JSON, within Lumovi's limits: never a
 * header, a cookie, a redirect or anything but JSON. The page never writes a URL, a host or a
 * query.
 *
 * A listed path may end in a fixed query (`/api/v1/targets?state=active`), asked exactly as listed:
 * Lumovi fills nothing in it.
 *
 * Each ask is checked by the page (the door's counts, the tokens it holds) and again by the
 * main process or the server: the organization's policy, the plugin and the code its page was
 * handed, its file's `server`, the objects' kinds, the path as listed, then the Service and its
 * port.
 */
import type { ResourceKind } from './resources'

export const SERVER_LIMITS = {
  /** Paths a file lists. */
  paths: 20,
  /** Characters in a listed path. */
  pathLength: 200,
  /** Labels a Service is found by. */
  labels: 8,
  /** Segments of a path Lumovi fills from objects' names. */
  fills: 4,
  /** How long the server has to answer, all of it. */
  timeoutMs: 5000,
  /** How much it may answer. */
  bytes: 1024 * 1024,
  /** How deep what it answers may nest. */
  depth: 64,
  /** Asks of its server not yet answered: on one page (more stops it), and across its pages (more wait). */
  waitingAPage: 2,
  waitingAPlugin: 4,
} as const

/** What a plugin's file says of its tool's server, as checked. */
export interface PluginServer {
  /** The Service: by its name, or by labels exactly one Service in the namespace has. */
  service: { name: string } | { labels: Readonly<Record<string, string>> }
  /**
   * One of its own kinds, as Lumovi names them (`Widget.example.com`): the Service is in the
   * namespace of an object of it the page was handed.
   */
  in: ResourceKind
  /** A port the Service declares: by its name, or its number. */
  port: string | number
  /** The paths its code may ask for, as listed: a `{name}` segment Lumovi fills. */
  paths: string[]
}

/** A Service's name: a DNS label that starts with a letter. */
export const SERVICE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/
/** A port's name, as a Service's ports have them: lowercase, a letter in it, at most 15. */
export const PORT_NAME = /^(?=.{1,15}$)(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A label a Service is found by: Kubernetes' rules for its key and its value. */
export const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
export const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/
/** A segment of a listed path: what a path holds as it is, unencoded. */
const SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/
/** What a listed path's fixed query holds as it is: never anything Lumovi fills. */
const QUERY = /^[A-Za-z0-9._~!$&'()*+,;=:@/?-]+$/
/** A segment Lumovi fills from an object's name: `{name}`. */
const FILL = /^\{([a-z][A-Za-z0-9]{0,30})\}$/
/** An object's name, as Kubernetes has them: never `/`, `.` or `..`. */
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

/**
 * A character a path can't hold, as a problem says it: quoted where it can be seen; else (a space,
 * one nobody sees, one that turns a line round, any beyond plain ASCII) as its code point, so the
 * line reads as written.
 */
const said = (character: string) =>
  /^[\x21-\x7e]$/.test(character)
    ? `“${character}”`
    : `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/** A listed path's own path, and its fixed query (none, where it has none). */
export function queryApart(listed: string): [path: string, query: string | undefined] {
  const at = listed.indexOf('?')
  return at < 0 ? [listed, undefined] : [listed.slice(0, at), listed.slice(at + 1)]
}

/** The segments of a listed path Lumovi fills, by their names, in order. */
export function fillsOf(path: string): string[] {
  return queryApart(path)[0]
    .split('/')
    .flatMap((segment) => FILL.exec(segment)?.[1] ?? [])
}

/** What's wrong with a path as a file lists it, or nothing. */
export function pathProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return 'should start with /'
  if (path.length > SERVER_LIMITS.pathLength) {
    return `is longer than ${SERVER_LIMITS.pathLength} characters`
  }
  if (path.includes('#')) return 'takes no fragment: Lumovi asks for the path as listed'
  if (path.includes('%')) {
    return 'has a %-escape: write it as it reads, and Lumovi encodes what it fills'
  }
  const [own, query] = queryApart(path)
  if (query !== undefined) {
    if (query === '') return 'has an empty query'
    if (/[{}]/.test(query)) return 'fills nothing in its query: Lumovi asks for it as listed'
    if (!QUERY.test(query)) {
      return `has ${said([...query.replace(/[A-Za-z0-9._~!$&'()*+,;=:@/?-]/g, '')][0]!)} in its query, which a query can’t hold as it is`
    }
  }
  const fills: string[] = []
  for (const segment of own.slice(1).split('/')) {
    if (segment === '') return 'has an empty segment'
    if (segment === '.' || segment === '..') return 'can’t step with . or ..'
    const fill = FILL.exec(segment)?.[1]
    if (fill !== undefined) {
      if (fills.includes(fill)) return `fills {${fill}} once`
      fills.push(fill)
    } else if (/[{}]/.test(segment)) {
      return 'fills only a whole segment, as /a/{name}/b'
    } else if (!SEGMENT.test(segment)) {
      return `has ${said([...segment.replace(/[A-Za-z0-9._~!$&'()*+,;=:@-]/g, '')][0]!)}, which a path can’t hold as it is`
    }
  }
  if (fills.length > SERVER_LIMITS.fills) {
    return `fills more than ${SERVER_LIMITS.fills} segments`
  }
  return undefined
}

/**
 * The path to ask for: a listed one, each `{name}` filled with the name of the object given for
 * it, encoded. Nothing, where one isn't given, or isn't a name an object could have.
 */
export function filled(path: string, names: Readonly<Record<string, string>>): string | undefined {
  const fills = fillsOf(path)
  const given = Object.keys(names)
  if (given.length !== fills.length || !fills.every((fill) => Object.hasOwn(names, fill))) {
    return undefined
  }
  if (!fills.every((fill) => NAME.test(names[fill]!))) return undefined
  const [own, query] = queryApart(path)
  const asked = own
    .split('/')
    .map((segment) => {
      const fill = FILL.exec(segment)?.[1]
      return fill === undefined ? segment : encodeURIComponent(names[fill]!)
    })
    .join('/')
  // (Its query, as listed.)
  return query === undefined ? asked : `${asked}?${query}`
}

/** An object as Lumovi's page names it to the backend: by kind, namespace and name. */
export interface ServerObject {
  kind: string
  namespace?: string
  name: string
}

/** A plugin's ask of its server, as Lumovi's page sends it to the backend. */
export interface PluginServerQuery {
  context: string
  plugin: string
  /** What the page's code was handed with, as a read's are. */
  digest: string
  codeDigest: string
  /** The object of its `in` kind the page holds: the Service is in its namespace. */
  in: ServerObject
  /** The path as its file lists it. */
  path: string
  /** For each segment it fills, the object whose name fills it. */
  with?: Readonly<Record<string, ServerObject>>
}

/** Why an ask of a plugin's server got no answer. */
export type ServerRefusal =
  /** The plugin isn't one Lumovi has in use, or has no code. */
  | 'not-in-use'
  /** Its file or code isn't what the page was handed with. */
  | 'changed'
  /** Its code is turned off. */
  | 'code-off'
  /** The organization's policy lets no plugin talk to servers in the cluster. */
  | 'servers-off'
  /** Its file names no server, or these aren't objects of the kinds it says. */
  | 'not-granted'
  /** An object it named isn't one its page holds now. */
  | 'not-found'
  /** Its file doesn't list the path. */
  | 'not-listed'
  /** Its pages have made as many different reads as a while allows: this would be one more. */
  | 'too-many-reads'
  /** No Service by that name there; or, by labels, none has them. */
  | 'no-service'
  /** More than one Service there has its labels. */
  | 'several'
  /** The Service declares no such port. */
  | 'no-port'
  /** The person may not reach it: `get` on `services/proxy`, or Lumovi's access. */
  | 'not-allowed'
  /** It didn't answer in time. */
  | 'timeout'
  /** It answered with something other than JSON. */
  | 'not-json'
  /** It answered more than Lumovi hands over. */
  | 'too-big'
  /** It answered an error. */
  | 'error'
  /** The cluster didn't answer. */
  | 'unreachable'
  | 'failed'

export type PluginServerAnswer =
  { ok: true; json: unknown } | { ok: false; refused: ServerRefusal; said: string }

/** What fills Lumovi's sentences for a failure: the Service, where, and what it said. */
export interface ServerWhere {
  name?: string
  namespace?: string
  port?: string | number
  byLabels?: boolean
  status?: number
  /** Past the different reads a while allows: how long is left of the while, in minutes. */
  minutes?: number
}

/**
 * What a page is told of a read past the different reads a while allows, an ask of its server
 * among them (`READ_LIMITS.differentAWhile`): with how long is left of the while. (Here, where a
 * read's sentences and a server ask's both reach it.)
 */
export const tooManyReads = (minutes: number): string =>
  `Lumovi lists everything a plugin’s page reads. This page has read more different things in ten minutes than Lumovi lists, so it can read nothing new for ${minutes <= 1 ? 'another minute' : `${minutes} more minutes`}.`

/** (A while, in minutes: what's left of it where nothing says.) */
const TEN_MINUTES = 10

/** Lumovi's sentence for a failure: never what the server or the cluster said. */
export function serverSaid(refused: ServerRefusal, where: ServerWhere = {}): string {
  const name = where.name ?? 'The server'
  switch (refused) {
    case 'not-in-use':
      return 'This plugin isn’t in use in Lumovi.'
    case 'changed':
      return 'This plugin changed since its page was opened.'
    case 'code-off':
      return 'This plugin’s code is turned off.'
    case 'servers-off':
      return 'Your organization’s policy doesn’t let plugins talk to servers in the cluster.'
    case 'not-granted':
      return 'This plugin’s file doesn’t ask to read this.'
    case 'not-found':
      return 'There’s no such object.'
    case 'not-listed':
      return 'This plugin’s file doesn’t list that path.'
    case 'too-many-reads':
      return tooManyReads(where.minutes ?? TEN_MINUTES)
    case 'no-service':
      return where.byLabels
        ? `No Service in ${where.namespace} has those labels.`
        : `There’s no Service ${where.name} in ${where.namespace}.`
    case 'several':
      return `More than one Service in ${where.namespace} has those labels, so Lumovi asked none.`
    case 'no-port':
      return `The Service ${where.name} has no port ${where.port}.`
    case 'not-allowed':
      return `You may not reach ${where.name ?? 'its server'} in ${where.namespace}: it takes get on services/proxy.`
    case 'timeout':
      return `${name} didn’t answer in ${SERVER_LIMITS.timeoutMs / 1000} seconds.`
    case 'not-json':
      return `${name} answered with something other than JSON.`
    case 'too-big':
      return `${name} answered with more than 1 MiB.`
    case 'error':
      return `${name} answered ${where.status}.`
    case 'unreachable':
      return 'The cluster didn’t answer.'
    case 'failed':
      return 'Lumovi couldn’t ask this.'
  }
}

/** Whether a refusal is Lumovi's or the person's not allowing it, rather than a failure. */
export const SERVER_REFUSED: ReadonlySet<ServerRefusal> = new Set<ServerRefusal>([
  'not-in-use',
  'changed',
  'code-off',
  'servers-off',
  'not-granted',
  'not-listed',
  'not-allowed',
  'too-many-reads',
])

const isObject = (value: unknown): value is ServerObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (!Object.keys(o).every((key) => ['kind', 'namespace', 'name'].includes(key))) return false
  return (
    typeof o.kind === 'string' &&
    o.kind.length > 0 &&
    o.kind.length <= 320 &&
    typeof o.name === 'string' &&
    NAME.test(o.name) &&
    (o.namespace === undefined || (typeof o.namespace === 'string' && NAME.test(o.namespace)))
  )
}

/** A plugin's ask of its server as the backend takes it from a page, or nothing: exactly its keys. */
export function serverQuery(value: unknown): PluginServerQuery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const q = value as Record<string, unknown>
  const keys = ['context', 'plugin', 'digest', 'codeDigest', 'in', 'path', 'with']
  if (!Object.keys(q).every((key) => keys.includes(key))) return undefined
  for (const key of ['context', 'plugin', 'digest', 'codeDigest', 'path']) {
    if (typeof q[key] !== 'string' || (q[key] as string).length === 0) return undefined
  }
  if ((q.path as string).length > SERVER_LIMITS.pathLength) return undefined
  if (!isObject(q.in)) return undefined
  if (q.with !== undefined) {
    if (typeof q.with !== 'object' || q.with === null || Array.isArray(q.with)) return undefined
    const given = Object.entries(q.with as Record<string, unknown>)
    if (given.length > SERVER_LIMITS.fills) return undefined
    if (
      !given.every(([fill, object]) => /^[a-z][A-Za-z0-9]{0,30}$/.test(fill) && isObject(object))
    ) {
      return undefined
    }
  }
  return q as unknown as PluginServerQuery
}

/** Whether what a server answered nests no deeper than Lumovi hands over. */
export function shallow(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return true
  if (depth >= SERVER_LIMITS.depth) return false
  return (Array.isArray(value) ? value : Object.values(value)).every((item) =>
    shallow(item, depth + 1),
  )
}
