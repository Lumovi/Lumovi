/**
 * The door, for reading: what a plugin's code may ask Lumovi to read from the cluster, and what
 * it's handed. Three things, all plain:
 *
 * - the grammar of an ask (`readAsk`): a list kept up to date, or one object (either with its
 *   objects' live usage, if asked), an object's events; or the end of one, or a refresh. Anything
 *   else stops the plugin;
 * - the grant's check (`granted`): a plugin's file says what it reads (`spec.reads`), kind by
 *   kind; what isn't said there is refused, where the read is made and never on the page;
 * - the picking (`picked`): of an object of Kubernetes' own, a plugin is handed the fields its
 *   file names and nothing else, so the page never holds more than the plugin may have.
 *
 * And the counting (`PageReads`): how many lists a page keeps, how fast it asks.
 */
import type { Step } from './jsonpath'
import { LABEL_TERM } from './kit/declare'
import type { Stopped } from './plugin-door'
import { SERVER_LIMITS } from './plugin-server'
import { isCustomGroup, type ResourceKind } from './resources'

/**
 * What reading is held to. First lines, as the door's own: what settles them is a real plugin's
 * page on a large cluster. Over any of them the plugin is stopped.
 */
export const READ_LIMITS = {
  /** Lists kept up to date at once: by one page, and by all of a plugin's pages. */
  listsAPage: 8,
  listsAPlugin: 16,
  /** Everything a page keeps going at once: lists, objects, events and usage together. (Each
   *  is a watch on the cluster in the person's name.) */
  keptAPage: 50,
  keptAPlugin: 100,
  /** Asks in a second, and asks not yet answered. */
  asksASecond: 10,
  waiting: 20,
  /** A refresh a plugin asks for: no oftener than this, a page. (One too soon isn't made; it
   *  doesn't stop the plugin: a person's second press mustn't end a page. It's still one of its
   *  second's asks, so it can't be used to knock on the door without end.) */
  refreshEveryMs: 10_000,
  /**
   * A pod's logs its code reads (`spec.logs: read`): one answer an ask, never a follow, of at
   * most so many of its last lines (or of those it asks for: the lines of its last seconds, at
   * most so many), and so many bytes; past them, its oldest are cut, and the answer says so.
   */
  logLines: 500,
  logSeconds: 3600,
  logBytes: 64 * 1024,
} as const

/** What a plugin's file says it reads of one kind (the file checker makes these). */
export interface Granted {
  /** Each path as written, and its steps: field names only. */
  fields: readonly { path: string; steps: readonly Step[] }[]
  /** The object's status as Lumovi shows it. */
  status: boolean
  /** The events of an object of this kind. */
  events: boolean
  /** Its usage as Lumovi shows it. */
  usage: boolean
}

/** What a plugin may read: its own kinds whole, and of Kubernetes' own what its file names. */
export interface Grant {
  /** The plugin's own groups (`spec.groups`): an annotation is read only by a key under one. */
  groups: readonly string[]
  /** The kinds it claims (`group/Kind`; `group/*`, every kind of a group): read whole. */
  own: readonly string[]
  /** By kind (`group/Kind`; the core group: `/Kind`). */
  reads: Readonly<Record<string, Granted>>
  /**
   * The Secrets objects of its own kinds name, by a path its file declares, for its pages to show
   * (`spec.showsSecrets`): never read by its code. None, where none is said.
   */
  secrets?: readonly SecretsNamed[]
}

/** Where an object of one of a plugin's own kinds names a Secret its pages may show, and which keys. */
export interface SecretsNamed {
  /** One of the plugin's own kinds (`group/Kind`). */
  kind: string
  path: string
  steps: readonly Step[]
  keys: readonly string[]
}

/**
 * What a plugin's code asks. `read` is the ask's own number: new, as a part's is. A list or one
 * object can be asked for `usage` too: each object is then handed with its live usage, as Lumovi
 * shows it, read with it (one read for a list's every object, never one each). A list can be of
 * the objects whose `fields` have these values (`{ 'spec.nodeName': '' }`: pods on no node yet)
 * and that have these `labels` (terms, as a list's filter writes them): the cluster picks them,
 * so a page asks for what it shows and no more.
 */
export type ReadAsk =
  /** Every object of a kind (in a namespace, or all it may see), kept up to date. */
  | {
      read: number
      what: 'list'
      kind: string
      namespace?: string
      usage?: true
      fields?: Readonly<Record<string, string>>
      labels?: readonly string[]
    }
  /** One object, kept up to date. */
  | { read: number; what: 'object'; kind: string; namespace?: string; name: string; usage?: true }
  /** The events of an object Lumovi handed it: named by Lumovi's token for it. */
  | { read: number; what: 'events'; of: string }
  /**
   * A pod's logs, once, where its file says its code reads them (`spec.logs: read`): the pod by
   * Lumovi's token for it, one of its containers, its last lines or those of the last seconds,
   * or its previous instance's.
   */
  | {
      read: number
      what: 'logs'
      pod: string
      container: string
      tail?: number
      since?: number
      previous?: true
    }
  /**
   * A path its file lists, of its tool's own server (`spec.server`): in the namespace of an
   * object of its `in` kind, by Lumovi's token for it; each segment it fills, by the token of
   * the object whose name fills it. Answered once.
   */
  | {
      read: number
      what: 'server'
      in: string
      path: string
      with?: Readonly<Record<string, string>>
    }
  /** The end of a read it began. */
  | { stop: number }
  /** Its lists read again from the cluster. */
  | { refresh: true }

/** `group/Kind`: a group's name (none for the core group), a slash, a kind's. */
const KIND = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)?\/[A-Z][A-Za-z0-9]{0,62}$/
/** A namespace's or an object's name, as Kubernetes has them. */
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
/** An object's token, as the door gives them out. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/
/** A container's name, as Kubernetes has one: a DNS label. */
const CONTAINER = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/

/** A field a list is picked by, as a path of field names (`spec.nodeName`). */
const FIELD_PATH = /^(?=.{3,63}$)[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,3}$/
/**
 * The value it has: a name (a node's, say), a word (a phase), or nothing (`spec.nodeName` of a
 * pod on no node yet). Never a character a selector would read as more than a value.
 */
const FIELD_VALUE = /^[A-Za-z0-9._-]{0,253}$/
/** Fields a list is picked by, and label terms: at most this many of each. */
export const PICKED_AT_MOST = 4

/**
 * What's wrong with how a list is picked (its `fields` and `labels`, each as written, or not
 * said), or nothing: one to four fields, each a path and a value; one to four label terms, each
 * once. Said by `readAsk`, and by `readQuery` of a page's read in the same words.
 */
function pickedProblem(fields: unknown, labels: unknown): string | undefined {
  if (fields !== undefined) {
    const entries =
      typeof fields === 'object' && fields !== null && !Array.isArray(fields)
        ? Object.entries(fields)
        : []
    if (
      entries.length < 1 ||
      entries.length > PICKED_AT_MOST ||
      !entries.every(
        ([path, value]) =>
          FIELD_PATH.test(path) && typeof value === 'string' && FIELD_VALUE.test(value),
      )
    ) {
      return `picks a list by fields that aren’t one to ${PICKED_AT_MOST} fields, each with a value`
    }
  }
  if (labels !== undefined) {
    if (
      !Array.isArray(labels) ||
      labels.length < 1 ||
      labels.length > PICKED_AT_MOST ||
      new Set(labels).size !== labels.length ||
      !labels.every((term) => typeof term === 'string' && LABEL_TERM.test(term))
    ) {
      return `picks a list by labels that aren’t one to ${PICKED_AT_MOST} label terms, each once`
    }
  }
  return undefined
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const has = (value: object, ...keys: string[]) => {
  const own = Object.keys(value)
  return own.every((key) => keys.includes(key))
}
const notAllowed = (what: string): Stopped => ({ why: 'not-allowed', what })
const tooMuch = (what: string, most: number): Stopped => ({
  why: 'too-much',
  what: `${what}: more than ${most.toLocaleString('en-US')}`,
})

/**
 * A message of a plugin's (read from its text already) as an ask to read, or why it isn't one.
 * Exactly the keys an ask has, each of its kind: nothing is guessed and nothing is passed on.
 */
export function readAsk(message: unknown): ReadAsk | Stopped {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return notAllowed('an ask that isn’t one')
  }
  const said = message as Record<string, unknown>
  if (Object.hasOwn(said, 'stop')) {
    return has(said, 'stop') && isNumber(said.stop)
      ? { stop: said.stop }
      : notAllowed('ends a read it doesn’t name')
  }
  if (Object.hasOwn(said, 'refresh')) {
    return has(said, 'refresh') && said.refresh === true
      ? { refresh: true }
      : notAllowed('an ask that isn’t one')
  }
  if (!Object.hasOwn(said, 'read') || !isNumber(said.read)) {
    return notAllowed('an ask that isn’t one')
  }
  const read = said.read
  switch (Object.hasOwn(said, 'what') ? said.what : undefined) {
    case 'list':
    case 'object': {
      const one = said.what === 'object'
      const keys = one ? ['name'] : ['fields', 'labels']
      if (!has(said, 'read', 'what', 'kind', 'namespace', 'usage', ...keys)) {
        return notAllowed('an ask with something it doesn’t take')
      }
      if (typeof said.kind !== 'string' || !KIND.test(said.kind)) {
        return notAllowed('asks for a kind that isn’t one')
      }
      const namespace = Object.hasOwn(said, 'namespace') ? said.namespace : undefined
      if (namespace !== undefined && (typeof namespace !== 'string' || !NAME.test(namespace))) {
        return notAllowed('asks in a namespace that isn’t one')
      }
      // (Asked for, or not said: nothing else stands for either.)
      const usage = Object.hasOwn(said, 'usage') ? said.usage : undefined
      if (usage !== undefined && usage !== true) {
        return notAllowed('asks for usage with something other than true')
      }
      const within = {
        ...(namespace === undefined ? {} : { namespace }),
        ...(usage === true ? { usage: true as const } : {}),
      }
      if (!one) {
        const fields = Object.hasOwn(said, 'fields') ? said.fields : undefined
        const labels = Object.hasOwn(said, 'labels') ? said.labels : undefined
        const wrong = pickedProblem(fields, labels)
        if (wrong) return notAllowed(wrong)
        return {
          read,
          what: 'list',
          kind: said.kind,
          ...within,
          ...(fields === undefined ? {} : { fields: { ...(fields as Record<string, string>) } }),
          ...(labels === undefined ? {} : { labels: [...(labels as string[])] }),
        }
      }
      const name = Object.hasOwn(said, 'name') ? said.name : undefined
      if (typeof name !== 'string' || !NAME.test(name)) {
        return notAllowed('asks for an object by a name that isn’t one')
      }
      return { read, what: 'object', kind: said.kind, ...within, name }
    }
    case 'events': {
      if (!has(said, 'read', 'what', 'of')) {
        return notAllowed('an ask with something it doesn’t take')
      }
      const of = Object.hasOwn(said, 'of') ? said.of : undefined
      if (typeof of !== 'string' || !TOKEN.test(of)) {
        return notAllowed('asks about an object Lumovi didn’t hand it')
      }
      return { read, what: 'events', of }
    }
    case 'server': {
      if (!has(said, 'read', 'what', 'in', 'path', 'with')) {
        return notAllowed('an ask with something it doesn’t take')
      }
      const within = Object.hasOwn(said, 'in') ? said.in : undefined
      if (typeof within !== 'string' || !TOKEN.test(within)) {
        return notAllowed('asks its server about an object Lumovi didn’t hand it')
      }
      const path = Object.hasOwn(said, 'path') ? said.path : undefined
      if (
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        path.length > SERVER_LIMITS.pathLength
      ) {
        return notAllowed('asks its server for a path that isn’t one')
      }
      const given = Object.hasOwn(said, 'with') ? said.with : undefined
      if (given !== undefined) {
        const fills =
          typeof given === 'object' && given !== null && !Array.isArray(given)
            ? Object.entries(given)
            : undefined
        if (
          !fills ||
          fills.length === 0 ||
          fills.length > SERVER_LIMITS.fills ||
          !fills.every(
            ([fill, token]) =>
              /^[a-z][A-Za-z0-9]{0,30}$/.test(fill) &&
              typeof token === 'string' &&
              TOKEN.test(token),
          )
        ) {
          return notAllowed('fills a path with something other than objects Lumovi handed it')
        }
      }
      return {
        read,
        what: 'server',
        in: within,
        path,
        ...(given === undefined ? {} : { with: { ...(given as Record<string, string>) } }),
      }
    }
    case 'logs': {
      if (!has(said, 'read', 'what', 'pod', 'container', 'tail', 'since', 'previous')) {
        return notAllowed('an ask with something it doesn’t take')
      }
      const pod = Object.hasOwn(said, 'pod') ? said.pod : undefined
      if (typeof pod !== 'string' || !TOKEN.test(pod)) {
        return notAllowed('asks about a pod Lumovi didn’t hand it')
      }
      const container = Object.hasOwn(said, 'container') ? said.container : undefined
      if (typeof container !== 'string' || !CONTAINER.test(container)) {
        return notAllowed('asks for a container by a name that isn’t one')
      }
      const whole = (value: unknown, most: number) =>
        Number.isInteger(value) && (value as number) >= 1 && (value as number) <= most
      const tail = Object.hasOwn(said, 'tail') ? said.tail : undefined
      if (tail !== undefined && !whole(tail, READ_LIMITS.logLines)) {
        return notAllowed(`asks for more than its last ${READ_LIMITS.logLines} lines`)
      }
      const since = Object.hasOwn(said, 'since') ? said.since : undefined
      if (since !== undefined && !whole(since, READ_LIMITS.logSeconds)) {
        return notAllowed(`asks for lines from more than ${READ_LIMITS.logSeconds} seconds back`)
      }
      const previous = Object.hasOwn(said, 'previous') ? said.previous : undefined
      if (previous !== undefined && previous !== true) {
        return notAllowed('asks for its previous instance with something other than true')
      }
      return {
        read,
        what: 'logs',
        pod,
        container,
        ...(tail === undefined ? {} : { tail: tail as number }),
        ...(since === undefined ? {} : { since: since as number }),
        ...(previous ? { previous: true as const } : {}),
      }
    }
    default:
      return notAllowed('an ask that isn’t one')
  }
}

/**
 * A kind as Lumovi resolved it: the resource it will really read, never the text of an ask.
 * Every rule about a kind here is asked of one of these. (An ask says "group/Kind" in a
 * plugin's own spelling; what that names in the cluster is Lumovi's to find, and a rule asked
 * of the spelling is a rule a second spelling walks round.)
 */
export interface ResolvedKind {
  /** The resource's API group, as the cluster serves it; none for the core group. */
  readonly group: string
  readonly kind: string
  readonly [RESOLVED]: true
}
declare const RESOLVED: unique symbol

/**
 * Says a kind is resolved. Only where Lumovi has looked the resource up (the main process, the
 * server), with the group and kind the cluster gave: never with what a plugin wrote.
 */
export const resolvedAs = (group: string, kind: string) => ({ group, kind }) as ResolvedKind

/** A resolved kind as a grant names it: `group/Kind`. */
const idOf = ({ group, kind }: ResolvedKind) => `${group}/${kind}`

/** Never read by a plugin's code, whatever a file says: checked here as well as there. */
const never = (kind: ResolvedKind) => kind.group === '' && kind.kind === 'Secret'

/** What a plugin is handed of a kind's objects: all of each, or the fields its file names. */
export type Handed = { whole: true } | { whole: false; granted: Granted }

/**
 * Whether `grant` lets a plugin have `what` of `kind`'s objects, and then how much of each:
 * `objects` is a list or one object; `status`, `events` and `usage` are those of an object.
 * Nothing means no: what a file doesn't say is refused. (Refused, with a code: not a reason to
 * stop the plugin. One written for a newer grant than its file's shouldn't lose its page for
 * asking.)
 */
export function granted(
  grant: Grant,
  kind: ResolvedKind,
  what: 'objects' | 'status' | 'events' | 'usage',
): Handed | undefined {
  if (never(kind)) return undefined
  const id = idOf(kind)
  // Its own kinds, whole: everything of them (`group/*`: every kind of a group it claims). A
  // tool's kinds only: one of Kubernetes' own is never whole, whatever claims it.
  if (mayBeOwn(kind.group) && (grant.own.includes(id) || grant.own.includes(`${kind.group}/*`))) {
    return { whole: true }
  }
  // One of Kubernetes' own: only a kind Lumovi keeps a list for.
  if (!isCustomGroup(kind.group) && !Object.hasOwn(READABLE, id)) return undefined
  const said = Object.hasOwn(grant.reads, id) ? grant.reads[id] : undefined
  // Events, status and usage are read only of things whose objects it may see at all.
  if (!said || said.fields.length === 0) return undefined
  return what === 'objects' || said[what] ? { whole: false, granted: said } : undefined
}

/**
 * Whether a plugin's file names a kind at all, by the kind as a page spelled it: asked before
 * the cluster is, and only ever a reason to refuse. A spelling its file doesn't name is refused
 * in one way whatever the cluster serves, so a refusal tells a plugin's code nothing of the
 * cluster. What's handed is still decided by `granted`, of the kind as resolved: a spelling
 * that passes here has let nothing through.
 *
 * And how it names it: the kind itself (`'kind'`: the spelling is then the file's own, letter
 * for letter), or only its group, claimed whole (`'group'`: the kind's word is still the
 * page's, and is nobody's to write down until the cluster has said what it is).
 */
export function namesAsSpelled(
  grant: Grant,
  spelled: { group: string; kind: string },
): 'kind' | 'group' | undefined {
  if (granted(grant, spelled as ResolvedKind, 'objects') === undefined) return undefined
  const id = `${spelled.group}/${spelled.kind}`
  return grant.own.includes(id) || Object.hasOwn(grant.reads, id) ? 'kind' : 'group'
}

/**
 * Of Kubernetes' own kinds, what a plugin's file can be granted at all: for each kind a plugin's
 * code may read, the fields, and nothing that isn't here. A list of what may be read, not of
 * what may not: taking things out of an object can't be finished (the next tool writes its own
 * annotation, the next kind has its own field), so nothing of these kinds is handed over unless
 * a line here says so. A kind with no lines can't be read.
 *
 * Each line is a path to a leaf, or to a small thing known to be safe whole. It starts with
 * what Karpenter's page needs, and grows a line at a time, each line read before it's added.
 */
export const READABLE: Readonly<Record<string, readonly string[]>> = {
  '/Pod': [
    'metadata.name',
    'metadata.namespace',
    'metadata.labels',
    'metadata.creationTimestamp',
    // What made it: kind, name and uid are how anything is tied to its owner; none is a secret.
    'metadata.ownerReferences',
    'spec.nodeName',
    'spec.containers.name',
    'spec.containers.image',
    'spec.containers.resources',
    'status.phase',
    // Whole, with its message: a controller writes it for people to read, and it's drawn as any
    // text of someone else's. (A container's last termination message is not a condition, and
    // is not on this list: it's the tail of its log.)
    'status.conditions',
    'status.containerStatuses.name',
    'status.containerStatuses.ready',
    'status.containerStatuses.restartCount',
    // Off it, by decision: status.podIP and hostIP (where it is on the network); a container's
    // state and last state (the last termination message is the tail of its log); its
    // command, arguments, environment, probes, hooks, ports and volumes; init and ephemeral
    // containers; every annotation but the plugin's own groups'.
  ],
  '/Node': [
    'metadata.name',
    'metadata.labels',
    'metadata.creationTimestamp',
    'spec.taints',
    'status.capacity',
    'status.allocatable',
    'status.conditions',
    // Off it, by decision: spec.providerID (an account's instance); status.addresses (where it
    // is on the network); status.nodeInfo and status.images (what runs there, exactly).
  ],
}

/**
 * Whether a path is a line: step for step, each a field's name and the same as the line's. (Not
 * by its names joined: a step with a dot in it would spell a line it isn't.)
 */
const isLine = (steps: readonly Step[], line: string) => {
  const names = line.split('.')
  return (
    steps.length === names.length &&
    steps.every((step, i) => 'key' in step && step.key === names[i])
  )
}

/**
 * Whether a file may be granted `steps` of a kind of Kubernetes' own, for a plugin with these
 * groups: a line of the list, exactly; or one annotation by a key under one of the plugin's own
 * groups (`karpenter.sh/do-not-disrupt` for a plugin that names `karpenter.sh`): nobody else's,
 * whose value is whatever some other tool wrote there. The file checker asks this too, and says
 * of a path that fails it that it isn't on the list yet.
 */
export function readable(
  kind: ResolvedKind,
  steps: readonly Step[],
  groups: readonly string[],
): boolean {
  const lines = Object.hasOwn(READABLE, idOf(kind)) ? READABLE[idOf(kind)]! : undefined
  if (!lines || never(kind) || isCustomGroup(kind.group)) return false
  if (!steps.every((step) => 'key' in step)) return false
  if (lines.some((line) => isLine(steps, line))) return true
  return ownAnnotation(steps as readonly { key: string }[], groups) === true
}

/**
 * The fields a list can be picked by, by kind: those the cluster picks by (its field selectors)
 * that a plugin can be granted, of Kubernetes' own kinds; and of every kind, its name and its
 * namespace. A field not here picks nothing, whatever a file grants.
 */
export const PICKED_BY: Readonly<Record<string, readonly string[]>> = {
  '/Pod': ['spec.nodeName', 'status.phase'],
}
const PICKED_BY_ANY = ['metadata.name', 'metadata.namespace']

/**
 * Whether a list of `kind` may be picked by these fields and labels, for a plugin handed its
 * objects as `handed` says: each field one the cluster picks by, and one its file grants (any,
 * of its own kinds, which it reads whole); labels only where it may read an object's labels. A
 * list is never picked by what its plugin couldn't read of its objects. Nothing when it may.
 */
export function pickedRefusal(
  kind: ResolvedKind,
  handed: Handed,
  fields: Readonly<Record<string, string>> | undefined,
  labels: readonly string[] | undefined,
): 'not-granted' | 'not-pickable' | undefined {
  const ofKind = Object.hasOwn(PICKED_BY, idOf(kind)) ? PICKED_BY[idOf(kind)]! : []
  const pickable = [...PICKED_BY_ANY, ...ofKind]
  const reads = (line: string) =>
    handed.whole || handed.granted.fields.some(({ steps }) => isLine(steps, line))
  for (const path of Object.keys(fields ?? {})) {
    if (!pickable.includes(path)) return 'not-pickable'
    if (!reads(path)) return 'not-granted'
  }
  if (labels !== undefined && !reads('metadata.labels')) return 'not-granted'
  return undefined
}

/** How a list is picked, as the cluster takes it: a field selector and a label selector. */
export function selectors(picked: {
  fields?: Readonly<Record<string, string>>
  labels?: readonly string[]
}): { fieldSelector?: string; labelSelector?: string } {
  const fields = Object.entries(picked.fields ?? {})
  return {
    ...(fields.length === 0
      ? {}
      : { fieldSelector: fields.map(([path, value]) => `${path}=${value}`).join(',') }),
    ...(picked.labels === undefined ? {} : { labelSelector: picked.labels.join(',') }),
  }
}

/**
 * Of a path of field names: whether it's one annotation by its key (`metadata.annotations` and
 * a key), and then whether the key is under one of the plugin's own groups. Nothing if the path
 * isn't an annotation's. On any kind that isn't the plugin's own, nobody else's annotation is
 * read: its value is whatever another tool wrote there (often its own copy of the object).
 */
/**
 * Whether a group can be a plugin's own at all, whatever its file claims: never `kubernetes.io`
 * or a name under it, never `k8s.io` itself, never one of Kubernetes' built-in API groups (an
 * add-on's group under `k8s.io`, the Gateway API's say, can be). Kubernetes' own annotations
 * live under those names: the command line that made a change, for one.
 */
const mayBeOwn = (group: string) =>
  group !== '' &&
  group !== 'k8s.io' &&
  group !== 'kubernetes.io' &&
  !group.endsWith('.kubernetes.io') &&
  isCustomGroup(group)

function ownAnnotation(
  steps: readonly { key: string }[],
  groups: readonly string[],
): boolean | undefined {
  const [first, second, key, ...more] = steps
  if (first?.key !== 'metadata' || second?.key !== 'annotations' || !key) return undefined
  if (more.length > 0) return false
  const slash = key.key.indexOf('/')
  const group = slash > 0 ? key.key.slice(0, slash) : ''
  return groups.includes(group) && mayBeOwn(group) && !neverHanded(key.key)
}

/** A step that's never taken, in any path: the names every object answers to. */
const NEVER_STEPS = new Set(['__proto__', 'constructor', 'prototype'])
/**
 * What's never a step of a path of another tool's kind, and never in what's handed over whole,
 * at any depth, whoever names it: a container's environment, its command and its arguments (the
 * commonest places a credential sits outside a Secret), a pod template and what a pod's spec
 * holds, who manages which field, and the
 * annotations a tool keeps for itself, the one that holds the object as it was last applied
 * among them (for a ConfigMap its data, for a Pod its environment).
 */
const NEVER_HANDED = new Set([
  'env',
  'args',
  'command',
  'managedFields',
  // Of a kind that isn't the plugin's own, nothing inside a pod template is read: neither the
  // template nor what a pod's spec holds, under whatever name a kind keeps one.
  'template',
  'jobTemplate',
  'containers',
  'initContainers',
  'ephemeralContainers',
  'volumes',
])
const NEVER_ANNOTATIONS = /^(?:kubectl\.kubernetes\.io|control-plane\.alpha\.kubernetes\.io)\//
const neverHanded = (key: string) =>
  NEVER_HANDED.has(key) || NEVER_STEPS.has(key) || NEVER_ANNOTATIONS.test(key)
/**
 * Where a path can't end: it would hand over far more than it names. All of an object's
 * metadata or annotations (one of the plugin's own annotations by its key is fine), all of a
 * spec.
 */
const NEVER_WHOLE = new Set(['metadata', 'annotations', 'spec'])

/**
 * Whether a path of another tool's kind may be handed over (the file checker refuses these; so
 * does the door).
 */
function mayBePicked(
  steps: readonly Step[],
  groups: readonly string[],
): steps is readonly { key: string }[] {
  if (steps.length === 0) return false
  if (!steps.every((step) => 'key' in step && !NEVER_STEPS.has(step.key))) return false
  const keys = (steps as readonly { key: string }[]).map((step) => step.key)
  // No never-handed name is a step: but the last step under a map of labels is a label's own
  // name, a person's word, whatever it is. (Whether that map really is one is seen as it's
  // picked: where it isn't, the name is held back there.)
  const label = keys.length > 1 && PERSONS_OWN.has(keys.at(-2)!)
  if (keys.some((key, i) => neverHanded(key) && !(label && i === keys.length - 1))) return false
  if (NEVER_WHOLE.has(keys.at(-1)!)) return false
  return ownAnnotation(steps as readonly { key: string }[], groups) !== false
}

/** The paths a plugin may have, as a tree of field names: `whole` where one ends. */
interface Named {
  whole: boolean
  under: Map<string, Named>
}

/** Maps whose keys are a person's own words, not fields: a label may well be called `env`. */
const PERSONS_OWN = new Set(['labels', 'matchLabels', 'nodeSelector'])
/**
 * Whether `value`, under `key`, really is such a map: one of those names, and text to text and
 * nothing else. (A kind Lumovi doesn't know can keep anything under a key it chose to call
 * `labels`; only what labels are is left alone.)
 */
const personsOwn = (key: string, value: unknown) =>
  PERSONS_OWN.has(key) &&
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((text) => typeof text === 'string')

/** How many fields were held back from what a plugin asked for: said once, to its author. */
export interface HeldBack {
  fields: number
}

/**
 * A copy of `value`. With `dropping`, nothing in it that's never handed over (each one counted
 * in `held`): but never a key of a map whose keys are a person's own (a label named `env` is a
 * label).
 */
function handedOver(value: unknown, dropping: boolean, held: HeldBack): unknown {
  if (Array.isArray(value)) return value.map((item) => handedOver(item, dropping, held))
  if (typeof value !== 'object' || value === null) return value
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (NEVER_STEPS.has(key)) continue
    if (dropping && neverHanded(key)) {
      held.fields++
      continue
    }
    const inner = (value as Record<string, unknown>)[key]
    copy[key] = handedOver(inner, dropping && !personsOwn(key, inner), held)
  }
  return copy
}

/**
 * Of `value`, what `named` names. A step into a list is taken of each item: the list's shape is
 * kept, and of each item only what's named. `dropping`: whether the never-handed names are
 * kept out, as a step and in what's handed over whole (of another tool's kind; a line of
 * Lumovi's own list was read before it was added, and is handed over as it is). Inside a real
 * map of labels nothing is dropped and any name is a step: there a name is a person's word.
 */
function pick(value: unknown, named: Named, dropping: boolean, held: HeldBack): unknown {
  if (named.whole) return handedOver(value, dropping, held)
  if (Array.isArray(value)) return value.map((item) => pick(item, named, dropping, held) ?? {})
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, under] of named.under) {
    if (!Object.hasOwn(value, key)) continue
    if (dropping && neverHanded(key)) {
      held.fields++
      continue
    }
    const inner = (value as Record<string, unknown>)[key]
    const found = pick(inner, under, dropping && !personsOwn(key, inner), held)
    if (found !== undefined) out[key] = found
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Of `object` (one of `kind`), the fields `granted` names and nothing else: built from what the
 * plugin may see, field by field, never from the object with things taken out. (Of another
 * tool's kind, what's handed over whole still has the never-handed names dropped from it: a
 * second net, not the wall. A line of Lumovi's own list is handed over as it is.) A copy, so
 * nothing that holds it holds what was read. Own fields only; a path that isn't there leaves
 * nothing.
 */
export function picked(
  object: unknown,
  kind: ResolvedKind,
  { fields }: Granted,
  groups: readonly string[],
  /** Counts what was held back, if given: so a wrong-looking object has its reason somewhere. */
  held: HeldBack = { fields: 0 },
): Record<string, unknown> {
  if (never(kind) || Array.isArray(object)) return {}
  // One of Kubernetes' own: what's on Lumovi's list for it. Another tool's kind, where Lumovi
  // can have no list: any path but the ones that hand over more than they name.
  const may = (steps: readonly Step[]): steps is readonly { key: string }[] =>
    isCustomGroup(kind.group) ? mayBePicked(steps, groups) : readable(kind, steps, groups)
  const root: Named = { whole: false, under: new Map() }
  for (const { steps } of fields) {
    if (!may(steps)) {
      // (A path a file names and the door won't pick is held back too, and counted.)
      held.fields++
      continue
    }
    let at = root
    for (const { key } of steps) {
      let next = at.under.get(key)
      if (!next) at.under.set(key, (next = { whole: false, under: new Map() }))
      at = next
    }
    // (Where a path and one under it are both named, the shorter one has it all.)
    at.whole = true
  }
  // (A path that ends inside a map of a person's own words names one of them: handed as it is.)
  return (
    (pick(object, root, isCustomGroup(kind.group), held) as Record<string, unknown> | undefined) ??
    {}
  )
}

/**
 * An object of one of the plugin's own kinds, as it's handed over: all of it, but for the
 * names no object is read by (`__proto__` and its kin), who manages which field, and the
 * annotations Kubernetes' own tools keep for themselves (the object as it was last applied).
 * The same whether it was read in a list or alone. A copy.
 */
export function handedWhole(object: unknown): Record<string, unknown> {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) return {}
  const copy = handedOver(object, false, { fields: 0 }) as Record<string, unknown>
  const metadata = copy.metadata
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>
    delete meta.managedFields
    const annotations = meta.annotations
    if (typeof annotations === 'object' && annotations !== null && !Array.isArray(annotations)) {
      for (const key of Object.keys(annotations)) {
        if (NEVER_ANNOTATIONS.test(key)) delete (annotations as Record<string, unknown>)[key]
      }
    }
  }
  return copy
}

/** The most Secrets one object may name by one declared path: past it, none. */
export const SECRETS_NAMED_AT_MOST = 20

/**
 * The Secrets an object of a plugin's own kind names by a path its file declares
 * (`spec.showsSecrets`): each a name Lumovi reads from the object as it holds it, never
 * anything a plugin sent. Field names only; a step into a list is taken of each item. Nothing
 * if the path is under `metadata` (a label or an annotation is too easily written by something
 * else to be what names a Secret), if anything it finds isn't a Secret's name, or if it finds
 * more than twenty: past that none, not the first twenty.
 *
 * Only names: nothing of a Secret is read to make them, and a token made for one is for that
 * Secret, in the object's own namespace, and the keys the file names.
 */
export function secretsNamed(object: unknown, steps: readonly Step[]): string[] {
  if (steps.length === 0 || !steps.every((step) => 'key' in step && !NEVER_STEPS.has(step.key))) {
    return []
  }
  const keys = (steps as readonly { key: string }[]).map((step) => step.key)
  if (keys[0] === 'metadata' || Array.isArray(object)) return []
  let found: unknown[] = [object]
  for (const key of keys) {
    const next: unknown[] = []
    for (const value of found) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          Object.hasOwn(item, key)
        ) {
          next.push((item as Record<string, unknown>)[key])
        }
      }
    }
    found = next
  }
  // (A path that ends at a list of names names each.)
  const names = found.flatMap((value) => (Array.isArray(value) ? value : [value]))
  if (names.length === 0 || names.length > SECRETS_NAMED_AT_MOST) return []
  if (!names.every((name): name is string => typeof name === 'string' && NAME.test(name))) return []
  return [...new Set(names)]
}

/**
 * A read for a plugin's page, as Lumovi's own page asks the main process or the server to make
 * it: never a plugin's text passed on, but what `readAsk` took from it, checked again where it's
 * read.
 */
export interface PluginReadQuery {
  context: string
  /** The plugin whose page asks, by its name: what else it is, the backend knows. */
  plugin: string
  /**
   * What the page's code was handed with (`PluginCode`): its file's digest and its code's. A
   * read is made only for the plugin as the backend has it now, so a grant is never applied to
   * code it wasn't read with.
   */
  digest: string
  codeDigest: string
  /** As the plugin asked: `group/Kind`. What it names is the backend's to find. */
  kind: string
  namespace?: string
  /** One object; none for a list. */
  name?: string
  /** Each object's live usage too, which its file must grant (`usage: true` on its read). */
  usage?: true
  /** A list's objects with these values of these fields, which its file must grant. */
  fields?: Readonly<Record<string, string>>
  /** A list's objects with these labels: its file must grant an object's labels. */
  labels?: readonly string[]
}

/** An object's live usage, as Lumovi shows it: CPU in cores, memory in bytes. */
export interface HandedUsage {
  cpu: number
  memory: number
}

/** An object handed to a plugin's page: which, and what the plugin may have of it. */
export interface HandedObject {
  namespace?: string
  name: string
  object: Record<string, unknown>
  /** Its live usage, where it was asked for and the cluster measures it. */
  usage?: HandedUsage
  /**
   * The Secrets it names by each path its plugin's file declares for its kind, read from the
   * object as Lumovi read it (never from what the plugin is handed): for the page to make a
   * token for each, in the object's own namespace, with the file's keys.
   */
  secrets?: { path: string; keys: string[]; names: string[] }[]
}

/** What a read hands a plugin's page. */
export interface PluginReadAnswer {
  /** The kind as Lumovi resolved it (Lumovi's own name for it): what each object's token names. */
  kind: ResourceKind
  objects: HandedObject[]
  /** How many fields of what its file names were held back: said once, to its author. */
  held: number
  /**
   * Where usage was asked for and no object has any: why. (An object can have none where the
   * rest do: one just started, say.)
   */
  noUsage?: NoUsage
  /**
   * A list with more objects than Lumovi lists at once (as its own lists have, and say): the
   * first `at`, which are these, of `of` where the cluster said how many there are. Lumovi's own
   * page says so whenever a read is cut, in a line its plugin can't hide.
   */
  cut?: Cut
}

/** How a list was cut: the first `at` of it read, of `of` where the cluster said how many. */
export interface Cut {
  at: number
  of?: number
}

/**
 * Why a read asked for usage has none: nothing measures it in this cluster (no metrics API), or
 * the person may read the objects and not their usage.
 */
export type NoUsage = 'unmeasured' | 'not-allowed'

/**
 * Why a read for a plugin wasn't made, or failed: a code, and Lumovi's own sentence for it
 * (`READ_REFUSED`). Never the cluster's words, which can name the person and the cluster's
 * address.
 */
export type ReadRefusal =
  /** Its file doesn't say it reads this. */
  | 'not-granted'
  /** The plugin isn't one Lumovi has in use (any more): its file was taken away, say. */
  | 'not-in-use'
  /** The cluster serves no such kind. */
  | 'no-such-kind'
  /** One object of a kind that's in a namespace, asked for without one. */
  | 'needs-namespace'
  | 'not-found'
  /** The person may not read it: the cluster's rules, or Lumovi's. */
  | 'not-allowed'
  /** More objects than Lumovi hands a page at once: its share of them, or its plugin's. */
  | 'too-many'
  /** A list picked by a field the cluster doesn't pick its kind by, or Lumovi doesn't. */
  | 'not-pickable'
  | 'unreachable'
  | 'failed'
  /** A read Lumovi doesn't make for a plugin yet: an object's events. */
  | 'not-yet'
  /** Its code is turned off: by the person, a server's administrator, or the organization's policy. */
  | 'code-off'
  /** The organization's policy lets no plugin show or read containers' logs (`pluginLogs: off`). */
  | 'logs-off'
  /** The plugin's file or code isn't what the page was handed with: it changed since. */
  | 'changed'

/** What a plugin's code is told, with the code, of a read that wasn't made. */
export const READ_REFUSED: Readonly<Record<ReadRefusal, string>> = {
  'not-granted': 'This plugin’s file doesn’t ask to read this.',
  'not-in-use': 'This plugin isn’t in use in Lumovi.',
  'no-such-kind': 'This cluster doesn’t serve this kind.',
  'needs-namespace': 'Objects of this kind are in a namespace: name it as well as the object.',
  'not-found': 'There’s no such object.',
  'not-allowed': 'Whoever is using Lumovi isn’t allowed to read this.',
  'too-many':
    'There are more of these than Lumovi hands a page at once: ask within one namespace, or for one by name.',
  'not-pickable': 'Lumovi doesn’t pick objects of this kind by that field.',
  unreachable: 'The cluster didn’t answer.',
  failed: 'Lumovi couldn’t read this.',
  'not-yet': 'Lumovi doesn’t read this for a plugin yet.',
  changed: 'This plugin changed since its page was opened.',
  'code-off': 'This plugin’s code is turned off.',
  'logs-off': 'Your organization’s policy doesn’t let plugins show or read containers’ logs.',
}

/**
 * A pod's logs a plugin's code asks for, once (`spec.logs: read`), as Lumovi's own page sends it
 * to the backend: the pod by its name, found from the token the page holds for it.
 */
export interface PluginLogsQuery {
  context: string
  plugin: string
  /** What the page's code was handed with, as a read's are. */
  digest: string
  codeDigest: string
  namespace: string
  pod: string
  container: string
  tail?: number
  since?: number
  previous?: true
}

/** A line of a pod's logs, as its code is handed it: when it was written, and what. */
export interface LogLine {
  time?: string
  text: string
}

export type PluginLogs =
  { ok: true; lines: LogLine[]; cut?: true } | { ok: false; refused: ReadRefusal }

/** A plugin's ask for logs as the backend takes it from a page, or nothing: exactly its keys. */
export function logsQuery(value: unknown): PluginLogsQuery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const q = value as Record<string, unknown>
  const keys = ['context', 'plugin', 'digest', 'codeDigest', 'namespace', 'pod', 'container']
  if (!has(q, ...keys, 'tail', 'since', 'previous')) return undefined
  const text = (key: string) => typeof q[key] === 'string' && (q[key] as string).length > 0
  if (!keys.every(text)) return undefined
  if (!NAME.test(q.namespace as string) || !NAME.test(q.pod as string)) return undefined
  if (!CONTAINER.test(q.container as string)) return undefined
  const whole = (key: string, most: number) =>
    !Object.hasOwn(q, key) ||
    (Number.isInteger(q[key]) && (q[key] as number) >= 1 && (q[key] as number) <= most)
  if (!whole('tail', READ_LIMITS.logLines) || !whole('since', READ_LIMITS.logSeconds)) {
    return undefined
  }
  if (Object.hasOwn(q, 'previous') && q.previous !== true) return undefined
  return q as unknown as PluginLogsQuery
}

/** What a read for a plugin comes to. */
/** What a person is told where the organization's policy lets no plugin show what's in a Secret. */
export const SECRETS_OFF = 'Your organization’s policy doesn’t let plugins show what’s in Secrets.'

export type PluginRead =
  { ok: true; answer: PluginReadAnswer } | { ok: false; refused: ReadRefusal }

/**
 * A read as the backend takes it from a page, or nothing: exactly its keys, each of its kind, by
 * the same rules `readAsk` holds a plugin's ask to.
 */
export function readQuery(value: unknown): PluginReadQuery | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const q = value as Record<string, unknown>
  const keys = ['context', 'plugin', 'digest', 'codeDigest', 'kind', 'namespace', 'name', 'usage']
  if (!has(q, ...keys, 'fields', 'labels')) return undefined
  const optional = (key: string) => (Object.hasOwn(q, key) ? q[key] : undefined)
  const { namespace, name } = { namespace: optional('namespace'), name: optional('name') }
  const usage = optional('usage')
  const { fields, labels } = { fields: optional('fields'), labels: optional('labels') }
  // (Only a list is picked: one object is named.)
  const whole = fields === undefined && labels === undefined
  if (!whole && (name !== undefined || pickedProblem(fields, labels))) return undefined
  const fine =
    typeof q.context === 'string' &&
    q.context !== '' &&
    typeof q.plugin === 'string' &&
    q.plugin !== '' &&
    typeof q.digest === 'string' &&
    DIGEST.test(q.digest) &&
    typeof q.codeDigest === 'string' &&
    DIGEST.test(q.codeDigest) &&
    typeof q.kind === 'string' &&
    KIND.test(q.kind) &&
    (namespace === undefined || (typeof namespace === 'string' && NAME.test(namespace))) &&
    (name === undefined || (typeof name === 'string' && NAME.test(name))) &&
    (usage === undefined || usage === true)
  if (!fine) return undefined
  return {
    context: q.context as string,
    plugin: q.plugin as string,
    digest: q.digest as string,
    codeDigest: q.codeDigest as string,
    kind: q.kind as string,
    ...(namespace === undefined ? {} : { namespace: namespace as string }),
    ...(name === undefined ? {} : { name: name as string }),
    ...(usage === true ? { usage: true as const } : {}),
    ...(fields === undefined ? {} : { fields: { ...(fields as Record<string, string>) } }),
    ...(labels === undefined ? {} : { labels: [...(labels as string[])] }),
  }
}

/** A digest, as the backend makes them: `sha256:` and the hex. */
const DIGEST = /^sha256:[0-9a-f]{64}$/

/** `group/Kind` as its two halves. */
export function kindAsked(kind: string): { group: string; kind: string } {
  const slash = kind.lastIndexOf('/')
  return { group: kind.slice(0, slash), kind: kind.slice(slash + 1) }
}

/** What all of a plugin's pages keep between them: counted in one place. */
export interface PluginCount {
  lists: number
  /** Everything kept going: lists, objects, events and usage together. */
  kept: number
}

/**
 * A page's reads, counted: which are going, how fast it asks. `now` is a clock in milliseconds
 * that only goes forward.
 */
export class PageReads {
  readonly #plugin: PluginCount
  readonly #now: () => number
  /** Reads going, by their number: whether each is a list kept up to date, or an ask of its server. */
  readonly #going = new Map<number, { list: boolean; server: boolean; answered: boolean }>()
  #newest = 0
  #second = { since: 0, asks: 0 }
  #refreshed: number | undefined

  constructor(plugin: PluginCount, now: () => number = () => performance.now()) {
    this.#plugin = plugin
    this.#now = now
  }

  /**
   * Counts an ask: nothing if it may be made, `'too-soon'` for a refresh that isn't made, or why
   * the plugin is stopped.
   */
  take(ask: ReadAsk): undefined | 'too-soon' | Stopped {
    const now = this.#now()
    if (now - this.#second.since >= 1000 || now < this.#second.since) {
      this.#second = { since: now, asks: 0 }
    }
    if (++this.#second.asks > READ_LIMITS.asksASecond) {
      return tooMuch('asks in a second', READ_LIMITS.asksASecond)
    }
    if ('refresh' in ask) {
      if (this.#refreshed !== undefined && now - this.#refreshed < READ_LIMITS.refreshEveryMs) {
        return 'too-soon'
      }
      this.#refreshed = now
      return undefined
    }
    if ('stop' in ask) {
      // A read never asked for can't be ended. One that was, and isn't going any more (Lumovi
      // refused it, or it was ended already), has nothing to end: messages cross.
      if (ask.stop > this.#newest) return notAllowed('ends a read it never asked for')
      this.#forget(ask.stop)
      return undefined
    }
    if (ask.read <= this.#newest) return notAllowed('asks under a number that isn’t new')
    this.#newest = ask.read
    const waiting = [...this.#going.values()].filter((read) => !read.answered).length
    if (waiting >= READ_LIMITS.waiting) return tooMuch('asks not yet answered', READ_LIMITS.waiting)
    if (this.#going.size >= READ_LIMITS.keptAPage) {
      return tooMuch('reads a page keeps going', READ_LIMITS.keptAPage)
    }
    if (this.#plugin.kept >= READ_LIMITS.keptAPlugin) {
      return tooMuch('reads a plugin keeps going', READ_LIMITS.keptAPlugin)
    }
    const list = ask.what === 'list'
    const server = ask.what === 'server'
    if (server) {
      const asking = [...this.#going.values()].filter((read) => read.server).length
      if (asking >= SERVER_LIMITS.waitingAPage) {
        return tooMuch('asks of its server not yet answered', SERVER_LIMITS.waitingAPage)
      }
    }
    if (list) {
      const mine = [...this.#going.values()].filter((read) => read.list).length
      if (mine >= READ_LIMITS.listsAPage)
        return tooMuch('lists a page keeps', READ_LIMITS.listsAPage)
      if (this.#plugin.lists >= READ_LIMITS.listsAPlugin) {
        return tooMuch('lists a plugin keeps', READ_LIMITS.listsAPlugin)
      }
      this.#plugin.lists++
    }
    this.#plugin.kept++
    this.#going.set(ask.read, { list, server, answered: false })
    return undefined
  }

  /** A read answered once, and over (a pod's logs, an ask of its server): it isn't going. */
  over(read: number): void {
    this.#forget(read)
  }

  /** A read has its first answer: it no longer waits. */
  answered(read: number): void {
    const going = this.#going.get(read)
    if (going) going.answered = true
  }

  /**
   * A read that was refused, or failed: it isn't going. (An ask for what a file doesn't grant
   * is refused with a code and counted among its second's asks; it doesn't stop the plugin: one
   * written for a newer grant than its file's shouldn't lose its page for asking.)
   */
  refused(read: number): void {
    this.#forget(read)
  }

  /** The page is gone: nothing of it is going, and its lists are no longer the plugin's. */
  close(): void {
    for (const read of [...this.#going.keys()]) this.#forget(read)
  }

  #forget(read: number): void {
    const going = this.#going.get(read)
    if (!going) return
    if (going.list) this.#plugin.lists--
    this.#plugin.kept--
    this.#going.delete(read)
  }
}
