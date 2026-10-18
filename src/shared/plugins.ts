/**
 * What a plugin's file is, and the one checker of it: read here by the app, and the same file
 * is what the plugins' own repository checks its files with. A plugin is one file: its place in
 * the sidebar, where it has one (a label and the kinds under it), and its views, each saying how
 * a kind is shown (its columns, status, details, related objects and actions). A plugin can't run
 * code: its views read fields with JSONPath and change objects only with the patches they spell
 * out. The format: https://docs.lumovi.dev/reference/plugin-format.
 */
import { parseAllDocuments } from 'yaml'
import { checkPath, parse, type Step } from './jsonpath'
import { CHANGE_ACTIONS, type ChangeAction } from './plugin-changes'
import { isSecretKey } from './plugin-presses'
import {
  LABEL_KEY,
  LABEL_VALUE,
  pathProblem,
  PORT_NAME,
  SERVER_LIMITS,
  SERVICE_NAME,
  type PluginServer,
} from './plugin-server'
import { readable, READABLE, resolvedAs, type Granted, type ResolvedKind } from './plugin-reads'
import {
  apiGroupOf,
  apiKindOf,
  builtinResource,
  isBuiltinKind,
  isCustomGroup,
  kindFor,
  RESOURCES,
  type ResourceCategory,
  type ResourceKind,
} from './resources'
import type { Health } from './health'
import { REACHES, type Reach } from './kit/declare'

export const VIEW_API_VERSION = 'lumovi.dev/v1beta1'

/** Icons a view can pick, by their Lucide names. */
export const VIEW_ICON_NAMES = [
  'activity',
  'archive',
  'bell',
  'box',
  'boxes',
  'bug',
  'camera',
  'cloud',
  'database',
  'file-check',
  'flame',
  'gauge',
  'git-branch',
  'git-merge',
  'globe',
  'hexagon',
  'key-round',
  'layers',
  'lock',
  'network',
  'package',
  'play',
  'puzzle',
  'radar',
  'refresh-cw',
  'rocket',
  'route',
  'scaling',
  'server',
  'server-cog',
  'shield-check',
  'signpost',
  'square',
  'timer',
  'waves',
  'waypoints',
  'workflow',
] as const

export type ViewIconName = (typeof VIEW_ICON_NAMES)[number]

export type ValueType = 'string' | 'number' | 'date' | 'boolean' | 'count'

export type Scalar = string | number | boolean | null

/** A value read from objects: a list column, or a fact in the details. */
export interface ViewField {
  name: string
  path: string
  type: ValueType
  /** Shown when the path finds nothing. */
  default?: string
}

export type Condition =
  | {
      path: string
      equals?: Scalar
      notEquals?: Scalar
      in?: Scalar[]
      exists?: boolean
      matches?: string
    }
  | { all: Condition[] }
  | { any: Condition[] }

export interface StatusRule {
  /** Applies when this holds; a rule without one always applies. */
  when?: Condition
  health: Health
  /** Templates: text with {{ .path }} values in it. */
  label: string
  detail?: string
}

export interface ViewLink {
  name: string
  /** Templates naming the related object: "Secret", "{{ .spec.issuerRef.kind }}.cert-manager.io"… */
  kind: string
  objectName: string
  /** The object's own namespace unless set (and none for cluster-wide kinds). */
  namespace?: string
}

/** Objects of another kind that belong to an object, listed in a tab of its own. */
export interface ViewRelated {
  /** The tab's name: "Instances", "Nodes"… */
  name: string
  /** A template naming their kind: "Pod", "NodeClaim.karpenter.sh"… */
  kind: string
  /** The labels they have, each a template: `cnpg.io/cluster: '{{ .metadata.name }}'`. */
  labels?: Record<string, string>
  /** A template: "spec.nodeName={{ .status.nodeName }}". */
  fieldSelector?: string
  /** Where they are: the object's own namespace unless set (every one, for cluster-wide objects). */
  namespace?: string
}

/**
 * How an object of the view's kind says it manages another (a workload it applied, say): labels
 * and annotations the managed one carries, each a template of the manager's. One may name the
 * managed object itself, as `{{ object.group }}`, `{{ object.kind }}`, `{{ object.namespace }}`
 * and `{{ object.name }}`. An object is managed by a manager whose values its own equal, exactly.
 */
export interface ViewManages {
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

/** What an action's inputs were given: numbers for number inputs, and text ('' when left empty). */
/** What an action's inputs were given: text, a number, yes or no, or a choice's value as it is. */
export type InputValues = Record<string, unknown>

/** A value an action asks for before it runs, filled in where its templates say `{{ input.name }}`. */
export interface ViewInput {
  name: string
  label: string
  /**
   * `text` (the default), a `number`, a `switch` (yes or no, `true` or `false` where it's a whole
   * value), or a `choice` of `options`, of what `from` finds, or of `choices`: labels the person
   * picks among, each filling in its value as it is.
   */
  type: 'text' | 'number' | 'choice' | 'switch'
  options?: Scalar[]
  from?: string
  choices?: { label: string; value: unknown }[]
  /**
   * `false`: not asked where the action is done to several at once (`bulk`); its `default` fills
   * it in for each.
   */
  bulk?: boolean
  /** A template for the value it starts with. */
  default?: string
}

/**
 * An action at work on its object, said where the action is instead of the action: while `when`
 * holds, with Lumovi's turning mark, `word`, and how long since the date at `since` where that's
 * given.
 */
export interface ActionBusy {
  when: Condition
  /** What's happening, in a word or two: "Syncing". */
  word: string
  /** A path to a date: when what's happening started. */
  since?: string
}

/** How an action's work ends, read off its own object: a path, and what its values are said as. */
export interface ActionEnds {
  /** Where the outcome is, on the action's own object. */
  path: string
  /** The values it ends on, each with its word and level ("Failed", critical). */
  values: { value: Scalar; word: string; level: Health }[]
  /** Where the message beside the outcome is, on the same object. */
  message?: string
}

export interface ViewAction {
  name: string
  icon?: ViewIconName
  /**
   * Offered in Lumovi's own bar for rows a person ticks, done to each of them: its inputs asked
   * once (those that say `bulk: false` filled in by their defaults), each judged on its own
   * object and sent with the version it was judged on.
   */
  bulk?: boolean
  /**
   * How its work ends, once its `busy` no longer holds: Lumovi follows each it sent until then,
   * and says how it ended, in these words, and nothing else of the object.
   */
  ends?: ActionEnds
  /**
   * Offered while this holds, and hidden while it doesn't; and where it holds, what the action
   * changes goes with the object's version it was judged on, so if the object has changed since,
   * nothing changes.
   */
  when?: Condition
  /**
   * Busy instead of hidden while one of these holds (the first that does): drawn where it was,
   * and it can't be pressed.
   */
  busy?: ActionBusy[]
  /**
   * Paths (up to four) that must hold, when it's sent, what they held in the object the person
   * was shown: else nothing is sent. (What tells this operation from the next, say.)
   */
  same?: string[]
  /** What it asks for first; it always asks when it has inputs. */
  inputs?: ViewInput[]
  /** The change it makes: a patch of the object, or another object to create. */
  patch?: Record<string, unknown> | Record<string, unknown>[]
  /** An object to create (templates and all), shown before it's created. */
  create?: Record<string, unknown>
  /** `merge` (the default) or `json` (a list of operations). */
  type: 'merge' | 'json'
  /** Patches the object's status instead. */
  subresource?: 'status'
  /** The patch that takes it back, offered as Undo. */
  undo?: Record<string, unknown> | Record<string, unknown>[]
  /** Asks first, with this text; otherwise it runs at once. */
  confirm?: string
  /**
   * Where it asks first: its dialog's question, in place of Lumovi's "{name} {object}?", and its
   * button, in place of its name. Templates, one line each.
   */
  confirmTitle?: string
  confirmButton?: string
  /** What happened, for the notification: "Suspended {{ .metadata.name }}". */
  done?: string
  primary?: boolean
  danger?: boolean
  /** Said by an action that asks nothing first (no confirm, no inputs, nothing created). */
  runs?: 'at-once'
}

export interface View {
  /** Its own name where it has one, or its plugin's and its place among the plugin's views. */
  name: string
  /** The plugin it's a part of. */
  plugin: string
  /** Where it came from: "Lumovi", or the user's file. */
  source: string
  kinds: ResourceKind[]
  icon?: ViewIconName
  columns?: ViewField[]
  status?: StatusRule[]
  details?: ViewField[]
  links?: ViewLink[]
  related?: ViewRelated[]
  manages?: ViewManages[]
  actions?: ViewAction[]
  /** Fields of its kinds' objects that Lumovi never shows nor hands over to anyone. */
  withholds?: ViewWithhold[]
}

/** A field a view withholds (`withholds`): field names, as `reads` has them. */
export interface ViewWithhold {
  /** As its file says it. */
  path: string
  /** As Lumovi reads it. */
  keys: string[]
  /** Why, in the plugin's words. */
  why?: string
}

/** How many fields a view may withhold. */
export const WITHHOLDS_MOST = 20

/** The sidebar's sections for Kubernetes' own kinds, which a plugin can sit in. */
export const PLUGIN_CATEGORIES = ['cluster', 'network', 'config', 'storage'] as const

/**
 * A plugin's place in the sidebar: a tool's kinds under one entry, which leads to a page with a
 * tab for each. (A plugin of nothing but views has none.)
 */
export interface PluginPlace {
  label: string
  icon?: ViewIconName
  /** A section of Kubernetes' own kinds to sit in, instead of Plugins. */
  category?: Exclude<ResourceCategory, 'workloads'>
  /** In the order of their tabs. */
  kinds: ResourceKind[]
}

/** One file: a name, a place in the sidebar where it has one, and its views. */
export interface Plugin {
  name: string
  /** Its own version: three numbers. */
  version: string
  /** What it needs to work: the oldest Lumovi, as three numbers. */
  needs: { lumovi: string }
  /**
   * The API groups its kinds are in: a fence round what it may name, and no more than that. What
   * is a plugin's own is the kinds it claims (under its place, or in a view); a group can be
   * shared by plugins.
   */
  groups: string[]
  /** Kinds of Kubernetes' own, without a page in Lumovi, that it shows and only shows. */
  shows: ResourceKind[]
  /** Where it came from: "Lumovi", or the user's file. */
  source: string
  place?: PluginPlace
  views: View[]
  /** What it adds to Lumovi's pages: only a plugin whose file may carry code has any. */
  added: Added
  /**
   * What its code may read of Kubernetes' own kinds (`spec.reads`), by kind (`group/Kind`; the
   * core group: `/Kind`): the door picks these and nothing else. Its own kinds are read whole,
   * and aren't here. Nothing, where its file says none; only a file that may carry code says any.
   */
  reads: Readonly<Record<string, Granted>>
  /**
   * The Secrets its pages may show the person (`spec.showsSecrets`): each named by an object of
   * one of its own kinds, by a path, with the keys that may be shown. Lumovi reads them as the
   * person, on the person's press; the plugin never does. Nothing, where its file says none.
   */
  showsSecrets: ShowsSecret[]
  /**
   * What its pages may propose to change (`spec.changes`): of its own kinds only, each with what
   * may be asked. Every change is the person's to confirm, in Lumovi's own dialog. Nothing, where
   * its file says none.
   */
  changes: ChangesKind[]
  /**
   * Kubernetes' own kinds whose lists in Lumovi its pages may open (`spec.opens`), as Lumovi names
   * them: at one object by its name, as well as whole. Never read, never changed: opening one is
   * the person's press, and the list is Lumovi's own, read as the person. Nothing, where its file
   * says none.
   */
  opens: ResourceKind[]
  /**
   * Lumovi's own places its pages may link to, for an object they were handed (`spec.links`): a
   * pod's Logs or Shell tab, a pod's or a service's Port forward dialog. The person opens and
   * does there what they do, as always; a link starts nothing. None, where its file says none.
   */
  links: Reach[]
  /**
   * Whether its pages show containers' logs (`spec.logs: shown`): Lumovi reads them as the
   * person and draws them in its own log view, and the plugin's code never holds a line. Or
   * whether its code reads them too (`read`), of Pods its file reads: once an ask, never a
   * follow, within Lumovi's limits. None, where its file says nothing.
   */
  logs?: 'shown' | 'read'
  /**
   * Its tool's own server in the cluster (`spec.server`): the Service, the port and the paths
   * its code may ask Lumovi to GET, as the person, through the API server, in the namespace of
   * an object of its own kind its page was handed. None, where its file says none.
   */
  server?: PluginServer
}

/** A kind of its own a plugin's page may propose changes to (`group/Kind`), and how. */
/**
 * A value in what a change sends that does harm, as a plugin's file says it: a path in the patch
 * or object (`operation.sync.prune`), and the value that harms (`is`), or that it's there at all
 * (`set`), or a value a list there holds (`contains`: `Replace=true` among a sync's options). Lumovi checks what it sends against it, draws `says` in red, and names `verb` on the
 * button ("Sync, prune and force"), whatever the plugin's code says; `unless` what's sent holds
 * the file's value at its path (a dry run: `operation.dryRun` true), which only the file says.
 */
export interface Harm {
  path: string
  is?: unknown
  set?: boolean
  contains?: unknown
  says: string
  verb: string
  unless?: { path: string; is: unknown }
}

/** How much a file may say does harm, and its words. */
export const HARM_LIMITS = { items: 8, says: 160, verb: 24 } as const

export interface ChangesKind {
  kind: string
  actions: ChangeAction[]
  harm?: Harm[]
}

/** A Secret a plugin's page may show: which of its kinds names it, where, and which keys. */
export interface ShowsSecret {
  /** One of the plugin's own kinds, as the door names it (`group/Kind`). */
  kind: string
  /** The path as the file writes it, and its steps: field names only. */
  path: string
  steps: Step[]
  keys: string[]
}

/**
 * What a plugin adds to Lumovi's pages: pages of its own (tabs of its entry in the sidebar, first
 * of them), a tab on an object of its own kinds, and commands in the palette that each open one
 * of its pages. Each is known by the plugin's name and its own id; nothing in an id is a path,
 * and no destination carries anything beyond a page's id.
 */
export interface Added {
  /**
   * Its pages. One that `takes` a kind of its own (as Lumovi names it) stands in that kind's
   * tab in the plugin's place: Lumovi's own list of the kind stays where Lumovi lists every kind.
   */
  pages: { id: string; title: string; takes?: ResourceKind }[]
  tabs: { id: string; title: string; kinds: ResourceKind[] }[]
  commands: { name: string; page: string }[]
}

/**
 * How much a plugin's code may say it reads: kinds, paths a kind, and how long a path may be (a
 * key in it is at most a label's or an annotation's, 253).
 */
export const READS_LIMITS = { kinds: 20, fields: 30, path: 253 } as const

/** How much a file may say its pages show of Secrets: items, and keys an item. */
export const SHOWS_SECRETS_LIMITS = { items: 10, keys: 20 } as const

/** How many of its kinds a file may say its pages propose changes to. */
export const CHANGES_LIMITS = { kinds: 20 } as const

/** How many of Kubernetes' own kinds a file may say its pages open lists of. */
export const OPENS_LIMITS = { kinds: 20 } as const

/** How many of each a plugin may add, and how long a title or a command's name may be. */
export const ADDED_LIMITS = { pages: 8, tabs: 4, commands: 12, name: 40 } as const

/** A plugin that has a place in the sidebar, with that place's own fields beside its name. */
export type ListedPlugin = Pick<
  Plugin,
  'name' | 'source' | 'version' | 'added' | 'opens' | 'links' | 'logs' | 'server' | 'changes'
> &
  PluginPlace & {
    /** Every kind its file names (`namedKinds`): what its pages may open a list of. */
    named: ResourceKind[]
  }

// ——— Checking ———

/** What a part of a view must look like; checked against the YAML before it's used. */
type Shape =
  | 'string'
  | 'boolean'
  | 'scalar'
  | 'path'
  | 'template'
  /** A template of a manager's, which may name the object it manages (`{{ object.name }}`). */
  | 'managing'
  | 'regex'
  | 'patch'
  /** Any value JSON can hold: a choice's value, filled in as it is. */
  | 'json'
  | { oneOf: readonly string[] }
  /** `most`: how many it can hold. */
  | { list: Shape; nonEmpty?: boolean; most?: number }
  /** Any keys, each value a `Shape`. */
  | { map: Shape }
  | {
      fields: Record<string, Shape | { shape: Shape; required: true }>
      /** A last check of the whole object, once its fields are fine. */
      refine?: (value: Record<string, unknown>) => string | undefined
    }

const HEALTHS = ['healthy', 'progressing', 'warning', 'critical', 'neutral'] as const

/** A view's kinds as Lumovi names them: "Certificate.cert-manager.io", "Secret". */
const kindId = ({ group, kind }: { group?: string; kind: string }) =>
  kindFor(group ? `${group}/v1` : 'v1', kind)

const conditionShape: Shape = {
  fields: {
    path: 'path',
    equals: 'scalar',
    notEquals: 'scalar',
    in: { list: 'scalar', nonEmpty: true },
    exists: 'boolean',
    matches: 'regex',
    get all() {
      return { list: conditionShape, nonEmpty: true }
    },
    get any() {
      return { list: conditionShape, nonEmpty: true }
    },
  },
  refine: (c) =>
    [c.path, c.all, c.any].filter((v) => v !== undefined).length === 1
      ? undefined
      : 'needs exactly one of path, all or any',
}

/**
 * A kind's own name, as Kubernetes writes kinds: its group is said beside it, never in it. (A
 * name with its group in it and no group beside it would read as a kind of no group, and be
 * taken for another kind than the one it is.)
 */
const KIND_NAME = /^[A-Z][A-Za-z0-9]*$/
const kindNameProblem = (kind: unknown) =>
  typeof kind === 'string' && !KIND_NAME.test(kind)
    ? `${quoted(kind)} should be a kind’s own name, like Certificate: its group goes under group`
    : undefined

/** An API group's name, as Kubernetes writes groups: a DNS name, and nothing a path could hide in. */
const GROUP_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const groupNameProblem = (group: unknown) =>
  typeof group === 'string' && group !== '' && !GROUP_NAME.test(group)
    ? `${quoted(group)} should be an API group’s name, like cert-manager.io`
    : undefined
/** What an object's apiVersion is: a group and a version, or a version alone. */
const API_VERSION = /^(?:([^/]*)\/)?v[0-9][a-z0-9]*$/

/** A kind as a file names it: its name, and its group beside it where it has one. */
const namedKind: Shape = {
  fields: { group: 'string', kind: { shape: 'string', required: true } },
  refine: (k) => groupNameProblem(k.group) ?? kindNameProblem(k.kind),
}

/** A kind, or every kind of a group (`kind: '*'`), like the constraints Gatekeeper's templates make. */
const kindsShape: Shape = {
  list: {
    fields: { group: 'string', kind: { shape: 'string', required: true } },
    refine: (k) =>
      groupNameProblem(k.group) ??
      (k.kind === '*'
        ? k.group
          ? undefined
          : 'every kind (*) is of a group: name it'
        : kindNameProblem(k.kind)),
  },
  nonEmpty: true,
}

const fieldShape: Shape = {
  fields: {
    name: { shape: 'string', required: true },
    path: { shape: 'path', required: true },
    type: { oneOf: ['string', 'number', 'date', 'boolean', 'count'] },
    default: 'string',
  },
}

const INPUT_NAME = /^[A-Za-z_]\w*$/

/** How many labelled values a choice may offer. */
export const CHOICES_MOST = 20

const inputShape: Shape = {
  fields: {
    name: { shape: 'string', required: true },
    label: { shape: 'string', required: true },
    type: { oneOf: ['text', 'number', 'choice', 'switch'] },
    options: { list: 'scalar', nonEmpty: true },
    from: 'path',
    choices: {
      list: {
        fields: {
          label: { shape: 'string', required: true },
          value: { shape: 'json', required: true },
        },
      },
      nonEmpty: true,
      most: CHOICES_MOST,
    },
    default: 'template',
    bulk: 'boolean',
  },
  refine: (input) => {
    if (!INPUT_NAME.test(input.name as string)) {
      return `${quoted(input.name)} should be letters, digits and _, like replicas`
    }
    const choice = input.type === 'choice'
    const given = [input.options, input.from, input.choices].filter((v) => v !== undefined).length
    if (choice && given !== 1) {
      return 'a choice needs one of options, choices, or a path to read them from'
    }
    if (!choice && given > 0) return 'only a choice has options or choices'
    if (input.type === 'switch' && input.default !== undefined) {
      if (input.default !== 'true' && input.default !== 'false') {
        return 'a switch starts as true or false'
      }
    }
    // (A labelled choice starts at its first: a default would be read nowhere.)
    if (input.choices !== undefined && input.default !== undefined) {
      return 'a labelled choice starts at its first choice: put the one to start at first'
    }
    // (One left out of several needs what it's filled in with there.)
    if (input.bulk === false && input.default === undefined && input.choices === undefined) {
      return 'one not asked for several needs a default to fill it in there'
    }
    return undefined
  },
}

/**
 * Whether a patch as a file writes it (a merge's object, or a JSON patch's operations) may write
 * `path` (`operation.sync.prune`): it's there, or a placeholder or an operation stands for what
 * holds it, so what's filled in could.
 */
function writesPath(patch: unknown, path: string): boolean {
  if (Array.isArray(patch)) {
    return (patch as { op?: unknown; path?: unknown }[]).some((op) => {
      if (op.op === 'remove' || op.op === 'test' || typeof op.path !== 'string') return false
      const at = op.path
        .split('/')
        .slice(1)
        .map((name) => name.replace(/~1/g, '/').replace(/~0/g, '~'))
        .join('.')
      return at === path || path.startsWith(`${at}.`) || at.startsWith(`${path}.`)
    })
  }
  let at: unknown = patch
  for (const name of path.split('.')) {
    if (typeof at === 'string') return true
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, name)) return false
    at = (at as Record<string, unknown>)[name]
  }
  return true
}

/** What of an object's metadata is the cluster's, or its owner's, and no plugin's to set. */
const GUARDED_IN_A_CREATE = ['ownerReferences', 'finalizers', 'managedFields']
const GUARDED_IN_A_PATCH = [
  ...GUARDED_IN_A_CREATE,
  'namespace',
  'name',
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
]

/**
 * What a patch (a merge's object, or a list of operations) or a new object does to an object's
 * metadata that isn't a plugin's to do, as the file writes it. Checked on what's written, so
 * what's written there can't be something filled in later: metadata is a map written out, and
 * an operation's path holds no placeholder; and none replaces metadata whole, or the object.
 *
 * It's used twice. On the file, where it's the first wall: what's written. And on the change as
 * it is once it's filled in, where it's sent (`changeProblem`): whatever got past the first, by
 * a way nobody thought of, is held to the same list there.
 */
function metadataProblem(body: unknown, guarded: string[]): string | undefined {
  const named = (key: string) => `changes metadata.${key}, which a plugin can’t change`
  if (Array.isArray(body)) {
    for (const op of body as unknown[]) {
      // (An operation that's one placeholder would be whatever it finds: any operation at all.)
      if (typeof op !== 'object' || op === null || Array.isArray(op)) {
        return 'fills in an operation whole, which a plugin can’t: write it out'
      }
      const { path, from } = op as { path?: unknown; from?: unknown }
      if (typeof path !== 'string' || (from !== undefined && typeof from !== 'string')) {
        return 'needs each operation’s path written out, as text'
      }
      for (const place of [path, from].filter((p) => p !== undefined)) {
        if (place.includes('{{')) {
          return 'fills in where an operation changes, which a plugin can’t: write its path out'
        }
        if (place === '' || place === '/') return 'replaces the object whole, which a plugin can’t'
        if (place === '/metadata') {
          return 'replaces all of an object’s metadata, which a plugin can’t change'
        }
        const key = guarded.find(
          (k) => place === `/metadata/${k}` || place.startsWith(`/metadata/${k}/`),
        )
        if (key) return named(key)
      }
    }
    return undefined
  }
  if (typeof body !== 'object' || body === null || !('metadata' in body)) return undefined
  const { metadata } = body as { metadata: unknown }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return 'fills in an object’s metadata whole, which a plugin can’t: write it out'
  }
  const key = guarded.find((k) => Object.hasOwn(metadata, k))
  return key && named(key)
}

/**
 * Why a change a plugin's action came to, filled in and ready to send, isn't a plugin's to make;
 * nothing, for one that is. The second wall: the file was checked when it was read, and this is
 * the same check on what would be sent.
 */
export function changeProblem(change: {
  action: string
  patch?: unknown
  object?: unknown
}): string | undefined {
  if (change.action === 'patch') return metadataProblem(change.patch, GUARDED_IN_A_PATCH)
  return change.action === 'create'
    ? metadataProblem(change.object, GUARDED_IN_A_CREATE)
    : 'isn’t a patch or a new object, which is all a plugin’s action makes'
}

/** What's wrong with an action as a whole, once its fields are fine. */
function actionProblem(a: Record<string, unknown>): string | undefined {
  if ((a.patch === undefined) === (a.create === undefined)) {
    return 'needs a patch, or an object to create (not both)'
  }
  // Done to several at once: a change to each, its inputs asked once for all of them; never one
  // read off a single object.
  if (a.bulk === true) {
    if (a.create !== undefined) return 'only a patch is done to several at once, never a create'
    const read = ((a.inputs ?? []) as { name: string; from?: string; bulk?: boolean }[]).find(
      (input) => input.from !== undefined && input.bulk !== false,
    )
    if (read) {
      return `{{ input.${read.name} }} reads its choices off one object: say bulk: false on it to do this to several`
    }
  }
  if (a.create !== undefined) {
    const { apiVersion, kind, metadata } = a.create as Record<string, unknown>
    const { name, generateName } = (metadata ?? {}) as Record<string, unknown>
    const text = (value: unknown) => typeof value === 'string' && value !== ''
    if (
      typeof apiVersion !== 'string' ||
      typeof kind !== 'string' ||
      !(text(name) || text(generateName))
    ) {
      return 'what it creates needs an apiVersion, a kind, and a metadata.name or generateName'
    }
    if (kindNameProblem(kind)) return `what it creates: ${kindNameProblem(kind)}`
    const version = API_VERSION.exec(apiVersion)
    if (!version || groupNameProblem(version[1])) {
      return `what it creates: ${quoted(apiVersion)} should be an API version, like cert-manager.io/v1`
    }
    if (a.undo !== undefined) return 'can’t undo creating something'
  }
  if (
    ![a.patch, a.undo].every((p) => p === undefined || Array.isArray(p) === (a.type === 'json'))
  ) {
    return 'patches are an object for type merge, and a list for type json'
  }
  const inputs = new Set(((a.inputs ?? []) as { name: string }[]).map((input) => input.name))
  const used = JSON.stringify([
    a.patch,
    a.create,
    a.confirm,
    a.confirmTitle,
    a.confirmButton,
    a.done,
  ]).matchAll(INPUT_PLACEHOLDER)
  const unknown = [...used].find(([, name]) => !inputs.has(name!))
  if (unknown) return `{{ input.${unknown[1]} }} isn’t one of its inputs`
  // What the person reads is words: a choice whose values are objects or lists fills a patch,
  // never a sentence (it would read as JSON).
  const valued = new Set(
    ((a.inputs ?? []) as { name: string; choices?: { value: unknown }[] }[])
      .filter((input) =>
        input.choices?.some((c) => c.value !== null && typeof c.value === 'object'),
      )
      .map((input) => input.name),
  )
  const worded = (['confirm', 'confirmTitle', 'confirmButton', 'done'] as const).flatMap((field) =>
    [...JSON.stringify(a[field] ?? '').matchAll(INPUT_PLACEHOLDER)]
      .filter(([, name]) => valued.has(name!))
      .map(
        ([, name]) =>
          `${field}: {{ input.${name} }} has values that aren’t words, so it can only fill the patch`,
      ),
  )
  if (worded[0]) return worded[0]
  const guarded =
    metadataProblem(a.patch, GUARDED_IN_A_PATCH) ??
    metadataProblem(a.undo, GUARDED_IN_A_PATCH) ??
    metadataProblem(a.create, GUARDED_IN_A_CREATE)
  if (guarded) return guarded
  // Its dialog's own question and button: only where it asks first, and each a line.
  const said = a.confirm !== undefined || a.inputs !== undefined
  // Writing an object's status on the object itself (a tool's kind with no status of its own to
  // ask) is what no plugin otherwise does: only one that asks first may. (Through the status
  // subresource it's another permission, said as that.)
  const patch = a.patch as Record<string, unknown> | { path?: unknown }[] | undefined
  const writesStatus =
    a.subresource !== 'status' &&
    (Array.isArray(patch)
      ? patch.some((op) => typeof op.path === 'string' && /^\/status(\/|$)/.test(op.path))
      : patch !== undefined && 'status' in patch)
  if (writesStatus && !said) {
    return 'writes the object’s status, so it has to ask first: give it confirm'
  }
  for (const [field, most] of [
    ['confirmTitle', CONFIRM_TITLE_LENGTH],
    ['confirmButton', CONFIRM_BUTTON_LENGTH],
  ] as const) {
    const text = a[field] as string | undefined
    if (text === undefined) continue
    if (!said) return `${field}: only an action that asks first (with confirm or inputs) has one`
    if (/[\r\n]/.test(text)) return `${field}: should be one line`
    if (text.length > most) return `${field}: is longer than ${most} characters`
  }
  for (const [i, busy] of ((a.busy ?? []) as { word: string }[]).entries()) {
    if (/[\r\n]/.test(busy.word)) return `busy[${i}].word: should be one line`
    if (busy.word.length > BUSY_WORD_LENGTH) {
      return `busy[${i}].word: is longer than ${BUSY_WORD_LENGTH} characters`
    }
  }
  // An action that asks nothing first says so, where a reviewer sees it; and only such a one. One
  // done to several may still have inputs: pressed for one it runs at once with their defaults,
  // and they're asked once for several (Argo CD's Refresh: normal, or hard for those ticked).
  const asks = a.confirm !== undefined || a.inputs !== undefined || a.create !== undefined
  if (!asks && a.runs === undefined) return 'runs at once, so it has to say so: runs: at-once'
  if (asks && a.runs !== undefined) {
    if (a.confirm !== undefined || a.create !== undefined || a.bulk !== true) {
      return 'asks first, so it can’t say runs: at-once (one done to several may, with inputs only)'
    }
    const unfilled = (
      (a.inputs ?? []) as { name: string; default?: unknown; choices?: unknown }[]
    ).find((input) => input.default === undefined && input.choices === undefined)
    if (unfilled) {
      return `runs at once for one, filled in with its inputs’ defaults: ${unfilled.name} needs one`
    }
  }
  return undefined
}

/** How long an action's dialog's own question and button can be, and its busy word. */
const CONFIRM_TITLE_LENGTH = 80
const CONFIRM_BUTTON_LENGTH = 24
const BUSY_WORD_LENGTH = 24

/** A label's or an annotation's key, as Kubernetes has them: a name, after a DNS prefix and a / where it has one. */
const QUALIFIED_KEY =
  /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
/** How many ways a view's managers can say so, and how many labels and annotations each is. */
const MANAGES_MOST = 4
const MANAGES_KEYS = 8

/** What's wrong with one of a view's `manages`, once its labels and annotations are templates. */
function managesProblem(entry: Record<string, unknown>): string | undefined {
  const maps = [entry.labels, entry.annotations].filter(Boolean) as Record<string, string>[]
  const keys = maps.flatMap((map) => Object.keys(map))
  if (keys.length === 0) return 'needs the labels or annotations that say so'
  if (keys.length > MANAGES_KEYS) {
    return `says so with ${keys.length} labels and annotations, and ${MANAGES_KEYS} is the most`
  }
  const wrong = keys.find((key) => !QUALIFIED_KEY.test(key))
  if (wrong) {
    return `${quoted(wrong)} should be a label’s or an annotation’s key, like kustomize.toolkit.fluxcd.io/name`
  }
  // (What every manager would come to alike says nothing of which one it is.)
  const ownField = maps
    .flatMap((map) => Object.values(map))
    .some((template) =>
      [...template.matchAll(PLACEHOLDER)].some(([, expression]) =>
        EXPRESSION.exec(expression!)?.[1]?.startsWith('.'),
      ),
    )
  return ownField
    ? undefined
    : 'should name its manager: a template of one of the manager’s fields, like {{ .metadata.name }}'
}

const VIEW_SHAPE: Shape = {
  fields: {
    kinds: { shape: kindsShape, required: true },
    icon: { oneOf: VIEW_ICON_NAMES },
    columns: { list: fieldShape },
    status: {
      list: {
        fields: {
          when: conditionShape,
          health: { shape: { oneOf: HEALTHS }, required: true },
          label: { shape: 'template', required: true },
          detail: 'template',
        },
      },
    },
    details: { list: fieldShape },
    links: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          kind: { shape: 'template', required: true },
          objectName: { shape: 'template', required: true },
          namespace: 'template',
        },
      },
    },
    related: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          kind: { shape: 'template', required: true },
          labels: { map: 'template' },
          fieldSelector: 'template',
          namespace: 'template',
        },
        // Without a selector, they'd be every object of the kind.
        refine: (r) =>
          r.labels || r.fieldSelector ? undefined : 'needs labels or a fieldSelector to find them',
      },
    },
    manages: {
      list: {
        fields: { labels: { map: 'managing' }, annotations: { map: 'managing' } },
        refine: managesProblem,
      },
      nonEmpty: true,
      most: MANAGES_MOST,
    },
    withholds: {
      list: {
        fields: { path: { shape: 'string', required: true }, why: 'string' },
      },
      nonEmpty: true,
      most: WITHHOLDS_MOST,
    },
    actions: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          icon: { oneOf: VIEW_ICON_NAMES },
          when: conditionShape,
          busy: {
            list: {
              fields: {
                when: { shape: conditionShape, required: true },
                word: { shape: 'string', required: true },
                since: 'path',
              },
            },
            nonEmpty: true,
            most: 4,
          },
          same: { list: 'path', nonEmpty: true, most: 4 },
          inputs: { list: inputShape, nonEmpty: true },
          bulk: 'boolean',
          ends: {
            fields: {
              path: { shape: 'path', required: true },
              values: {
                shape: {
                  list: {
                    fields: {
                      value: { shape: 'scalar', required: true },
                      word: { shape: 'string', required: true },
                      level: { shape: { oneOf: HEALTHS }, required: true },
                    },
                  },
                  nonEmpty: true,
                  most: 8,
                },
                required: true,
              },
              message: 'path',
            },
          },
          patch: 'patch',
          create: 'patch',
          type: { oneOf: ['merge', 'json'] },
          subresource: { oneOf: ['status'] },
          runs: { oneOf: ['at-once'] },
          undo: 'patch',
          confirm: 'template',
          confirmTitle: 'template',
          confirmButton: 'template',
          done: 'template',
          primary: 'boolean',
          danger: 'boolean',
        },
        refine: actionProblem,
      },
    },
  },
}

/** What a plugin says of its place in the sidebar; its views are each checked as a view. */
const PLACE_SHAPE: Shape = {
  fields: {
    label: 'string',
    icon: { oneOf: VIEW_ICON_NAMES },
    category: { oneOf: PLUGIN_CATEGORIES },
    kinds: kindsShape,
  },
  refine: (spec) => {
    // Its place in the sidebar is its kinds, under its label: both, or neither.
    if (spec.kinds === undefined) {
      return Object.keys(spec).length > 0
        ? 'a label, an icon or a category is for a place in the sidebar, and that needs kinds'
        : undefined
    }
    if (spec.label === undefined) return 'needs a label for its place in the sidebar'
    // Kubernetes' own kinds have their pages, each in its place in the sidebar.
    return (spec.kinds as { group?: string; kind: string }[])
      .map(kindId)
      .filter(isBuiltinKind)
      .map((kind) => `${kind} has a page of its own, so it can’t be in a plugin`)[0]
  },
}

/** A place in the sidebar for a plugin with pages of its own: a label, an icon, kinds or none. */
const PAGES_PLACE_SHAPE: Shape = {
  fields: {
    label: 'string',
    icon: { oneOf: VIEW_ICON_NAMES },
    category: { oneOf: PLUGIN_CATEGORIES },
    kinds: kindsShape,
  },
  refine: (spec) => {
    if (spec.label === undefined) return 'pages need a place in the sidebar: give it a label'
    // A plugin's pages stand with the plugins: Lumovi's own sections are Lumovi's.
    if (spec.category !== undefined) {
      return 'a plugin with pages of its own stands under Plugins in the sidebar: leave out its category'
    }
    return ((spec.kinds ?? []) as { group?: string; kind: string }[])
      .map(kindId)
      .filter(isBuiltinKind)
      .map((kind) => `${kind} has a page of its own, so it can’t be in a plugin`)[0]
  },
}

/** One kind a plugin's code reads (`spec.reads`): which, which fields, and what else of it. */
const READ_SHAPE: Shape = {
  fields: {
    group: { shape: 'string', required: true },
    kind: { shape: 'string', required: true },
    fields: { shape: { list: 'string', nonEmpty: true }, required: true },
    status: 'boolean',
    events: 'boolean',
    usage: 'boolean',
  },
  refine: (item) => {
    const no = (['status', 'events', 'usage'] as const).find((key) => item[key] === false)
    if (no) return `${no} should be true, or left out`
    if (item.kind === '*') return 'a read is of one kind, named: never every kind of a group'
    return groupNameProblem(item.group) ?? kindNameProblem(item.kind)
  },
}

/** A kind as Lumovi finds it in the cluster, from how a file names it: never by its spelling. */
function resolvedOf(named: NamedKind): ResolvedKind {
  const id = kindId(named)
  const builtin = builtinResource(id)
  return builtin
    ? resolvedAs(builtin.group, builtin.apiKind)
    : resolvedAs(apiGroupOf(id), apiKindOf(id))
}

/** A path as a file writes it under `reads`: field names, a key in brackets where it has dots. */
const READ_PATH = /^[A-Za-z0-9_]/
/**
 * A step of one: a field's name, or a key as Kubernetes has a label's or an annotation's (a name,
 * after a DNS prefix and a / where it has one). Nothing else is drawn where a person reads it.
 */
const READ_STEP =
  /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/

interface ReadItem {
  group: string
  kind: string
  fields: string[]
  status?: true
  events?: true
  usage?: true
}

/**
 * What's wrong with what a file says its code reads, once it may say it: each line starts at
 * its place in `spec`. Every kind is asked of as Lumovi resolves it, and every path of the
 * door's own list (`readable`), so the checker and the door can't disagree.
 */
function readsProblems(
  reads: unknown,
  groups: readonly string[],
  own: ReadonlySet<ResourceKind>,
): string[] {
  const shaped = check(reads, { list: READ_SHAPE, nonEmpty: true }, 'spec.reads', 'a read')
  if (Array.isArray(reads) && reads.length > READS_LIMITS.kinds) {
    shaped.push(
      `spec.reads: holds ${reads.length}, and a plugin’s code reads ${READS_LIMITS.kinds} kinds at most`,
    )
  }
  if (shaped.length) return shaped
  const problems: string[] = []
  const said = new Map<string, number>()
  ;(reads as ReadItem[]).forEach((item, i) => {
    const at = `spec.reads[${i}]`
    const id = kindId(item)
    const kind = resolvedOf(item)
    const key = `${kind.group}/${kind.kind}`
    if (own.has(id) || own.has(kindId({ group: item.group, kind: '*' }))) {
      problems.push(
        `${at}: ${id} is one of this plugin’s own kinds, which its code reads whole: leave it out`,
      )
      return
    }
    if (kind.group === '' && kind.kind === 'Secret') {
      problems.push(`${at}: a Secret is never read by a plugin’s code`)
      return
    }
    if (isCustomGroup(kind.group)) {
      problems.push(
        `${at}: ${id} is neither this plugin’s own kind nor one of Kubernetes’: its code reads only those`,
      )
      return
    }
    const first = said.get(key)
    if (first !== undefined) {
      problems.push(`${at}: ${id} is said already, in spec.reads[${first}]: one item a kind`)
      return
    }
    said.set(key, i)
    if (!Object.hasOwn(READABLE, key)) {
      problems.push(`${at}: ${id} isn’t on Lumovi’s list of what a plugin may read yet`)
      return
    }
    if (item.fields.length > READS_LIMITS.fields) {
      problems.push(
        `${at}.fields: holds ${item.fields.length}, and an item names ${READS_LIMITS.fields} paths at most`,
      )
      return
    }
    const seen = new Set<string>()
    item.fields.forEach((path, j) => {
      const where = `${at}.fields[${j}]`
      if (path.length > READS_LIMITS.path) {
        problems.push(`${where}: is longer than ${READS_LIMITS.path} characters`)
        return
      }
      let steps
      try {
        if (!READ_PATH.test(path) || path !== path.trim()) throw new Error()
        steps = parse(`.${path}`)
      } catch {
        problems.push(`${where}: ${quoted(path)} should be field names, like metadata.name`)
        return
      }
      if (steps.some((step) => 'key' in step && !READ_STEP.test(step.key))) {
        problems.push(`${where}: ${quoted(path)} should be field names, like metadata.name`)
        return
      }
      // (The same field however it's spelt: `metadata["name"]` is `metadata.name`.)
      const same = JSON.stringify(steps.map((step) => ('key' in step ? step.key : step)))
      if (!steps.every((step) => 'key' in step)) {
        problems.push(
          `${where}: ${quoted(path)} should name one field: no wildcard, index or filter`,
        )
      } else if (seen.has(same)) {
        problems.push(`${where}: ${quoted(path)} is said twice`)
      } else if (!readable(kind, steps, groups)) {
        problems.push(
          `${where}: ${quoted(path)} isn’t on Lumovi’s list of what a plugin may read of ${id} yet`,
        )
      }
      seen.add(same)
    })
  })
  return problems
}

/** What a file says its code reads, by kind: once it's found right. */
function readsOf(reads: unknown): Record<string, Granted> {
  return Object.fromEntries(
    ((reads ?? []) as ReadItem[]).map((item) => {
      const kind = resolvedOf(item)
      return [
        `${kind.group}/${kind.kind}`,
        {
          fields: item.fields.map((path) => ({ path, steps: parse(`.${path}`) })),
          status: item.status === true,
          events: item.events === true,
          usage: item.usage === true,
        },
      ]
    }),
  )
}

/** One kind whose objects name a Secret its pages may show (`spec.showsSecrets`). */
const SHOWS_SECRET_SHAPE: Shape = {
  fields: {
    group: { shape: 'string', required: true },
    kind: { shape: 'string', required: true },
    path: { shape: 'string', required: true },
    keys: { shape: { list: 'string', nonEmpty: true }, required: true },
  },
  refine: (item) => {
    if (item.kind === '*')
      return 'a Secret is named by an object of one kind, named: never every kind of a group'
    return groupNameProblem(item.group) ?? kindNameProblem(item.kind)
  },
}

interface ShowsSecretItem {
  group: string
  kind: string
  path: string
  keys: string[]
}

/**
 * What's wrong with what a file says its pages show of Secrets, once it may say it. The kind is
 * one of the plugin's own (whether it's in a namespace is the cluster's to say, and the door's
 * to hold: an object in none names no Secret); the path is field names, as `reads` has them, and
 * never under `metadata`; the keys are Secrets' keys, each once.
 */
function showsSecretsProblems(shows: unknown, own: ReadonlySet<ResourceKind>): string[] {
  const shaped = check(
    shows,
    { list: SHOWS_SECRET_SHAPE, nonEmpty: true },
    'spec.showsSecrets',
    'an item',
  )
  if (Array.isArray(shows) && shows.length > SHOWS_SECRETS_LIMITS.items) {
    shaped.push(
      `spec.showsSecrets: holds ${shows.length}, and a file says ${SHOWS_SECRETS_LIMITS.items} at most`,
    )
  }
  if (shaped.length) return shaped
  const problems: string[] = []
  const said = new Map<string, number>()
  ;(shows as ShowsSecretItem[]).forEach((item, i) => {
    const at = `spec.showsSecrets[${i}]`
    const id = kindId(item)
    if (!own.has(id) && !own.has(kindId({ group: item.group, kind: '*' }))) {
      problems.push(
        `${at}: ${id} isn’t one of this plugin’s own kinds: only an object of its own kinds names a Secret its pages show`,
      )
      return
    }
    const { path } = item
    if (path.length > READS_LIMITS.path) {
      problems.push(`${at}.path: is longer than ${READS_LIMITS.path} characters`)
      return
    }
    let steps: Step[]
    try {
      if (!READ_PATH.test(path) || path !== path.trim()) {
        throw new Error()
      }
      steps = parse(`.${path}`)
    } catch {
      problems.push(`${at}.path: ${quoted(path)} should be field names, like spec.secretName`)
      return
    }
    if (!steps.every((step) => 'key' in step && READ_STEP.test(step.key))) {
      problems.push(`${at}.path: ${quoted(path)} should be field names, like spec.secretName`)
      return
    }
    if ((steps[0] as { key: string }).key === 'metadata') {
      problems.push(
        `${at}.path: ${quoted(path)} is under metadata: a Secret is named in an object’s spec or its status`,
      )
      return
    }
    // (The same field however it's spelt: one item a kind and a path.)
    const same = `${id}\u0000${JSON.stringify(steps.map((step) => (step as { key: string }).key))}`
    const first = said.get(same)
    if (first !== undefined) {
      problems.push(
        `${at}: ${id}’s ${quoted(path)} is said already, in spec.showsSecrets[${first}]`,
      )
      return
    }
    said.set(same, i)
    if (item.keys.length > SHOWS_SECRETS_LIMITS.keys) {
      problems.push(
        `${at}.keys: holds ${item.keys.length}, and an item names ${SHOWS_SECRETS_LIMITS.keys} keys at most`,
      )
      return
    }
    const keys = new Set<string>()
    item.keys.forEach((key, k) => {
      if (!isSecretKey(key)) {
        problems.push(`${at}.keys[${k}]: ${quoted(key)} should be a Secret’s key, like tls.crt`)
      } else if (keys.has(key)) {
        problems.push(`${at}.keys[${k}]: ${quoted(key)} is said twice`)
      }
      keys.add(key)
    })
  })
  return problems
}

/** A withheld field's keys, as Lumovi reads its path; or nothing, where it isn't field names. */
function withheldKeys(path: string): string[] | undefined {
  if (path.length > READS_LIMITS.path || !READ_PATH.test(path) || path !== path.trim()) return
  let steps: Step[]
  try {
    steps = parse(`.${path}`)
  } catch {
    return
  }
  const keys = steps.map((step) => ('key' in step && READ_STEP.test(step.key) ? step.key : ''))
  return keys.every(Boolean) ? keys : undefined
}

/**
 * What's wrong with what a file's views withhold (`withholds`), each where it is. A view
 * withholds fields of its plugin's own kinds alone, each named (never every kind of a group,
 * nor one of Kubernetes'); a path is field names, as `reads` has them, a step into a list taken
 * of each item; and what Lumovi tells of every object is never withheld: its kind, its metadata
 * and its status, whatever file says it. A path that can't be read is the file's problem, never
 * nothing withheld.
 */
function withholdsProblems(
  views: { kinds: NamedKind[]; withholds?: { path: string }[] }[],
): string[] {
  const problems: string[] = []
  views.forEach((view, i) => {
    if (!view.withholds) return
    const at = `spec.views[${i}].withholds`
    for (const kind of view.kinds) {
      const id = kindId(kind)
      const group = kind.group ?? ''
      if (kind.kind === '*') {
        problems.push(
          `${at}: a view withholds fields of kinds named one by one, never every kind of a group`,
        )
      } else if (isBuiltinKind(id) || !isCustomGroup(group) || kubernetesOwnName(group)) {
        problems.push(
          `${at}: a view withholds fields of its plugin’s own kinds alone, and ${id} is Kubernetes’`,
        )
      }
    }
    const said = new Map<string, number>()
    view.withholds.forEach(({ path }, w) => {
      const keys = withheldKeys(path)
      if (!keys) {
        problems.push(
          `${at}[${w}].path: ${quoted(path)} should be field names, like report.secrets.match`,
        )
        return
      }
      const [first] = keys
      if (first === 'metadata' || first === 'apiVersion' || first === 'kind') {
        problems.push(
          `${at}[${w}].path: ${quoted(path)} is what every object says of itself, which Lumovi always shows`,
        )
      } else if (first === 'status') {
        // (What Lumovi says of an object is read from its status: never a plugin's to decide.)
        problems.push(
          `${at}[${w}].path: ${quoted(path)} is under status, which says how the object is: Lumovi always shows it`,
        )
      }
      // (A patch's step that's a number is an item of a list, which a withheld path never names:
      // one of its own would be a key a patch reaches unseen.)
      if (keys.some((key) => /^\d+$/.test(key))) {
        problems.push(
          `${at}[${w}].path: ${quoted(path)}: a step of a withheld path is a field’s name, not a number`,
        )
      }
      // (The same field however it's spelt.)
      const same = JSON.stringify(keys)
      const before = said.get(same)
      if (before !== undefined) {
        problems.push(`${at}[${w}].path: ${quoted(path)} is said already, in withholds[${before}]`)
      }
      said.set(same, w)
    })
  })
  return problems
}

/** What a file says its pages show of Secrets: once it's found right. */
const CHANGES_SHAPE: Shape = {
  fields: {
    group: { shape: 'string', required: true },
    kind: { shape: 'string', required: true },
    actions: { shape: { list: 'string', nonEmpty: true }, required: true },
    harm: {
      list: {
        fields: {
          path: { shape: 'string', required: true },
          is: 'json',
          set: 'boolean',
          contains: 'json',
          says: { shape: 'string', required: true },
          verb: { shape: 'string', required: true },
          unless: {
            fields: {
              path: { shape: 'string', required: true },
              is: { shape: 'json', required: true },
            },
          },
        },
        refine: (harm) => {
          if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(harm.path as string)) {
            return 'its path should be names with dots between, as operation.sync.prune'
          }
          const unless = harm.unless as { path: string } | undefined
          if (unless && !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(unless.path)) {
            return 'unless.path: should be names with dots between, as operation.sync.dryRun'
          }
          const said = [harm.is, harm.set, harm.contains].filter((each) => each !== undefined)
          if (said.length !== 1) {
            return 'needs one of: the value that harms (is), set: true (that it’s there at all), or a value a list there holds (contains)'
          }
          if (harm.set === false) return 'set says it harms where it’s there: it’s true'
          if ((harm.says as string).length > HARM_LIMITS.says) {
            return `says: is longer than ${HARM_LIMITS.says} characters`
          }
          if (
            (harm.verb as string).length > HARM_LIMITS.verb ||
            /[\r\n]/.test(harm.verb as string)
          ) {
            return `verb: should be a word or two, ${HARM_LIMITS.verb} characters at most`
          }
          return undefined
        },
      },
      nonEmpty: true,
      most: HARM_LIMITS.items,
    },
  },
  refine: (item) => {
    if (item.kind === '*')
      return 'a change is proposed to kinds named one by one: never every kind of a group'
    return groupNameProblem(item.group) ?? kindNameProblem(item.kind)
  },
}

interface ChangesItem {
  group: string
  kind: string
  actions: string[]
}

/**
 * What's wrong with what a file says its pages propose changes to: its own kinds only (never one
 * of Kubernetes' own, which a plugin never claims), each once, with actions Lumovi knows.
 */
function changesProblems(changes: unknown, own: ReadonlySet<ResourceKind>): string[] {
  const shaped = check(changes, { list: CHANGES_SHAPE, nonEmpty: true }, 'spec.changes', 'an item')
  if (Array.isArray(changes) && changes.length > CHANGES_LIMITS.kinds) {
    shaped.push(
      `spec.changes: holds ${changes.length}, and a file says ${CHANGES_LIMITS.kinds} at most`,
    )
  }
  if (shaped.length) return shaped
  const problems: string[] = []
  const said = new Set<ResourceKind>()
  ;(changes as ChangesItem[]).forEach((item, i) => {
    const at = `spec.changes[${i}]`
    const id = kindId(item)
    if (!own.has(id) && !own.has(kindId({ group: item.group, kind: '*' }))) {
      problems.push(
        `${at}: ${id} isn’t one of this plugin’s own kinds: a plugin proposes changes only to its own`,
      )
      return
    }
    if (said.has(id)) problems.push(`${at}: ${id} is said once`)
    said.add(id)
    const wrong = item.actions.find(
      (action) => !(CHANGE_ACTIONS as readonly string[]).includes(action),
    )
    if (wrong !== undefined) {
      problems.push(`${at}.actions: ${quoted(wrong)} should be one of ${CHANGE_ACTIONS.join(', ')}`)
    } else if (new Set(item.actions).size !== item.actions.length) {
      problems.push(`${at}.actions: each once`)
    }
  })
  return problems
}

const SERVER_KEYS = ['service', 'in', 'port', 'paths']

/**
 * What's wrong with what a file says of its tool's own server: the Service by its name or by
 * labels, one of its own kinds whose objects' namespace it's in, a port of it, and the paths
 * its code may ask for, each as Lumovi asks for it.
 */
function serverProblems(server: unknown, own: ReadonlySet<ResourceKind>): string[] {
  const at = 'spec.server'
  const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isMap(server)) {
    return [`${at}: should be a map of service, in, port and paths, not ${describe(server)}`]
  }
  const problems = Object.keys(server)
    .filter((key) => !SERVER_KEYS.includes(key))
    .map((key) => `${at}.${plain(key)}: isn’t something a server has`)
  const { service, in: within, port, paths } = server
  if (service === undefined) {
    problems.push(`${at}.service: is needed: the Service, by its name or by its labels`)
  } else if (!isMap(service) || Object.keys(service).length !== 1) {
    problems.push(`${at}.service: should have a name or labels, one of the two`)
  } else if (Object.hasOwn(service, 'name')) {
    if (typeof service.name !== 'string' || !SERVICE_NAME.test(service.name)) {
      problems.push(`${at}.service.name: should be a Service’s name, not ${describe(service.name)}`)
    }
  } else if (Object.hasOwn(service, 'labels')) {
    const labels = service.labels
    if (!isMap(labels)) {
      problems.push(`${at}.service.labels: should be a map of labels, not ${describe(labels)}`)
    } else if (Object.keys(labels).length === 0) {
      problems.push(`${at}.service.labels: should name at least one label`)
    } else if (Object.keys(labels).length > SERVER_LIMITS.labels) {
      problems.push(`${at}.service.labels: should be at most ${SERVER_LIMITS.labels} labels`)
    } else {
      for (const [key, value] of Object.entries(labels)) {
        if (!LABEL_KEY.test(key)) {
          problems.push(`${at}.service.labels: ${plain(key)} isn’t a label’s key`)
        } else if (typeof value !== 'string' || !LABEL_VALUE.test(value)) {
          problems.push(
            `${at}.service.labels.${key}: should be a label’s value, not ${describe(value)}`,
          )
        }
      }
    }
  } else {
    problems.push(`${at}.service: should have a name or labels, one of the two`)
  }
  if (within === undefined) {
    problems.push(`${at}.in: is needed: the kind of the objects whose namespace the Service is in`)
  } else if (
    !isMap(within) ||
    !Object.keys(within).every((key) => key === 'group' || key === 'kind') ||
    typeof within.kind !== 'string' ||
    (within.group !== undefined && typeof within.group !== 'string')
  ) {
    problems.push(`${at}.in: should be one of its own kinds, as { group, kind }`)
  } else {
    const id = kindId(within as unknown as NamedKind)
    if (within.kind === '*' || !own.has(id)) {
      problems.push(`${at}.in: should be one of its own kinds, and ${plain(id)} isn’t`)
    }
  }
  if (port === undefined) {
    problems.push(`${at}.port: is needed: a port the Service declares, by its name or number`)
  } else if (
    !(typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) &&
    !(typeof port === 'string' && PORT_NAME.test(port))
  ) {
    problems.push(`${at}.port: should be a port’s name or number, not ${describe(port)}`)
  }
  if (paths === undefined) {
    problems.push(`${at}.paths: is needed: the paths its code may ask for`)
  } else if (!Array.isArray(paths) || paths.length === 0) {
    problems.push(`${at}.paths: should be a list of paths, not ${describe(paths)}`)
  } else if (paths.length > SERVER_LIMITS.paths) {
    problems.push(`${at}.paths: should be at most ${SERVER_LIMITS.paths} paths`)
  } else {
    paths.forEach((path, i) => {
      const wrong =
        typeof path !== 'string' ? `should be a path, not ${describe(path)}` : pathProblem(path)
      if (wrong) problems.push(`${at}.paths[${i}]: ${wrong}`)
      else if (paths.indexOf(path) < i) problems.push(`${at}.paths[${i}]: is listed once`)
    })
  }
  return problems
}

/** A file's `server`, as checked. */
interface RawServer {
  service: { name: string } | { labels: Record<string, string> }
  in: NamedKind
  port: string | number
  paths: string[]
}

const serverOf = ({ service, in: within, port, paths }: RawServer): PluginServer => ({
  service: 'name' in service ? { name: service.name } : { labels: { ...service.labels } },
  in: kindId(within),
  port,
  paths: [...paths],
})

/** What's wrong with what a file says its pages link to: Lumovi's own places, each once. */
function linksProblems(links: unknown): string[] {
  if (!Array.isArray(links)) {
    return [`spec.links: should be a list of ${REACHES.join(', ')}, not ${describe(links)}`]
  }
  if (links.length === 0) return ['spec.links: should not be empty']
  const problems: string[] = []
  const said = new Set<unknown>()
  links.forEach((place, i) => {
    if (!REACHES.includes(place as Reach)) {
      problems.push(
        `spec.links[${i}]: should be one of ${REACHES.join(', ')}, not ${describe(place)}`,
      )
    } else if (said.has(place)) problems.push(`spec.links[${i}]: ${place as string} is said once`)
    said.add(place)
  })
  return problems
}

/**
 * What's wrong with what a file says its pages open lists of: Kubernetes' own kinds that Lumovi
 * has a list of (its own kinds' lists its pages open already), each once, as their group has them.
 */
function opensProblems(opens: unknown): string[] {
  const shaped = check(opens, { list: namedKind, nonEmpty: true }, 'spec.opens', 'an item')
  if (Array.isArray(opens) && opens.length > OPENS_LIMITS.kinds) {
    shaped.push(`spec.opens: holds ${opens.length}, and a file says ${OPENS_LIMITS.kinds} at most`)
  }
  if (shaped.length) return shaped
  const problems: string[] = []
  const said = new Set<ResourceKind>()
  ;(opens as NamedKind[]).forEach((item, i) => {
    const at = `spec.opens[${i}]`
    const id = kindId(item)
    const builtin = builtinResource(id)
    if (!builtin || builtin.group !== (item.group ?? '')) {
      problems.push(
        `${at}: ${item.group ?? ''}/${item.kind} isn’t a kind Lumovi has a list of: a page opens Lumovi’s lists of Kubernetes’ own kinds`,
      )
      return
    }
    if (said.has(id)) problems.push(`${at}: ${item.group ?? ''}/${item.kind} is said once`)
    said.add(id)
  })
  return problems
}

function changesOf(changes: unknown): ChangesKind[] {
  return ((changes ?? []) as (ChangesItem & { harm?: Harm[] })[]).map((item) => {
    const kind = resolvedOf(item)
    return {
      kind: `${kind.group}/${kind.kind}`,
      actions: [...item.actions] as ChangeAction[],
      ...(item.harm ? { harm: item.harm.map((harm) => ({ ...harm })) } : {}),
    }
  })
}

function showsSecretsOf(shows: unknown): ShowsSecret[] {
  return ((shows ?? []) as ShowsSecretItem[]).map((item) => {
    const kind = resolvedOf(item)
    return {
      kind: `${kind.group}/${kind.kind}`,
      path: item.path,
      steps: parse(`.${item.path}`),
      keys: [...item.keys],
    }
  })
}

const PAGE_SHAPE: Shape = {
  fields: {
    id: { shape: 'string', required: true },
    title: { shape: 'string', required: true },
    takes: namedKind,
  },
}
const TAB_SHAPE: Shape = {
  fields: {
    id: { shape: 'string', required: true },
    title: { shape: 'string', required: true },
    kinds: { shape: kindsShape, required: true },
  },
}
const COMMAND_SHAPE: Shape = {
  fields: { name: { shape: 'string', required: true }, page: { shape: 'string', required: true } },
}

/**
 * The tabs Lumovi gives an object, by their names: a plugin's tab can't be called one of them.
 * Keep it the detail's own list (features/details/DetailPanel.tsx); a test holds the two to it.
 */
export const LUMOVIS_TABS = [
  'Overview',
  'Pods',
  'Logs',
  'Shell',
  'Metrics',
  'Map',
  'Events',
  'Audit',
  'YAML',
]
/**
 * What the palette itself has, by name, besides each kind's list: a plugin's command can't be
 * called one of them. Keep it the palette's own (features/shell/CommandPalette.tsx); a test holds
 * the two to it.
 */
export const LUMOVIS_COMMANDS = [
  'Overview',
  'Workloads',
  'Metrics',
  'Alerts',
  'Right-sizing',
  'Helm releases',
  'API resources',
  'All plugins',
  'All namespaces',
  'All clusters',
  'Open the last several clusters',
  'Create…',
  'New terminal',
  'New window',
  'Copy link',
  'Copy link to this view',
  'Metrics source…',
  'AI assistants…',
  'Audit log',
  'Access',
  'Your access',
  'Settings',
  'Keyboard shortcuts',
]
/**
 * The pages Lumovi's own bar names, but its Overview (a plugin's page may be one, and Lumovi's own
 * mark for it isn't one a plugin can choose): a plugin's page or tab can't be called one of them,
 * nor a kind's list, nor one of the palette's own. Keep it the bar's own
 * (features/shell/Header.tsx's PAGES); a test holds the two to it.
 */
export const LUMOVIS_PAGES = [
  'Workloads',
  'Metrics',
  'Alerts',
  'API resources',
  'Compare',
  'Helm releases',
  'Plugins',
  'Settings',
  'Search',
]
/**
 * What a plugin may do is Lumovi's to say, in its own places (the bar's More, the palette's
 * Actions): no page, tab or command of a plugin's can read as it. Not "What … may do", nor any
 * "may do", "can do", "may read" or "may change" (the Plugins page's own words for what it asks),
 * nor its permissions, by any words round them: failing closed, a plugin about access calls its
 * pages "Bindings" or "Policies".
 */
const SAYS_WHAT_IT_MAY_DO = /\b(?:may\s+(?:do|read|change)|can\s+do|permissions?)\b/iu
/**
 * What a command's name may not start with: a command only opens a page, and a name that says it
 * changes something would tell a lie in the palette, where a person types to act.
 */
const CHANGING = [
  'delete',
  'remove',
  'restart',
  'scale',
  'apply',
  'sync',
  'roll back',
  'rollback',
  'promote',
  'abort',
  'suspend',
  'resume',
  'create',
  'edit',
  'drain',
  'cordon',
  'uncordon',
  'evict',
  'stop',
  'run',
  'install',
  'upgrade',
  'uninstall',
  'patch',
  'reconcile',
  'trigger',
]

/** Greek and Cyrillic letters that are drawn as Latin ones, by the Latin letter each reads as. */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  [
    ['АВЕКМНОРСТХІЈЅҮԚԜ', 'ABEKMHOPCTXIJSYQW'],
    ['аеорсухіјѕԁӏүԛԝһ', 'aeopcyxijsdlyqwh'],
    ['ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', 'ABEZHIKMNOPTYX'],
    ['αοινκρυ', 'aoivkpu'],
  ].flatMap(([from, to]) => [...from!].map((letter, i) => [letter, to![i]!])),
)

/**
 * Latin, and the alphabets with letters drawn as Latin ones: a word with letters of two of them
 * can look like a word it isn't. (Others, Han and kana among them, have none to mistake: "API网关"
 * is a name.)
 */
const DRAWN_ALIKE = [
  'Latin',
  'Greek',
  'Cyrillic',
  'Armenian',
  'Cherokee',
  'Coptic',
  'Lisu',
  'Canadian_Aboriginal',
  'Georgian',
  'Tifinagh',
].map((script) => new RegExp(`\\p{Script=${script}}`, 'u'))

/**
 * A name as it's compared with another: its compatibility forms folded (full-width letters,
 * ligatures), Greek and Cyrillic letters drawn as Latin ones read as those, without its case,
 * its spaces or the punctuation at its ends.
 */
const squeezed = (name: string) =>
  [...name.normalize('NFKC')]
    .map((letter) => LOOKALIKES[letter] ?? letter)
    .join('')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/^\p{P}+|\p{P}+$/gu, '')

/**
 * A verb's forms a name may start with: "restart", "restarts", "restarting". (Not "restarted":
 * what's done describes what a page shows, "Stopped pods".)
 */
function verbForms(verb: string): string[] {
  const stem = verb.replace(/e$/, '')
  const doubled = `${verb}${verb.at(-1)}`
  // ("apply": "applies".)
  const ies = /[^aeiou]y$/.test(verb) ? [`${verb.slice(0, -1)}ies`] : []
  return [verb, `${verb}s`, `${verb}es`, ...ies, `${stem}ing`, `${doubled}ing`]
}

/** Whether a name starts with a verb that changes something, in any of its forms, as it reads. */
function changing(name: string): boolean {
  const words = name
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return CHANGING.some((verb) => {
    const [first, ...rest] = verb.split(' ')
    return (
      verbForms(first!).includes(words[0] ?? '') && rest.every((word, i) => words[i + 1] === word)
    )
  })
}

/**
 * What's wrong with what a file adds to Lumovi's pages: that it may not add any, or how what it
 * adds is written. Each line starts at its place in `spec`.
 */
function addedProblems(
  added: { pages: unknown; tabs: unknown; commands: unknown },
  place: Record<string, unknown>,
  /** Where it may carry code; where it may not, why not, of a field. */
  uncoded: ((field: string) => string) | undefined,
): string[] {
  const given = (['pages', 'tabs', 'commands'] as const).filter((key) => added[key] !== undefined)
  if (given.length === 0) return []
  // (Only a plugin that may carry code may: its pages are drawn from its own code.)
  if (uncoded) return given.map((key) => uncoded(`spec.${key}`))
  const problems: string[] = []
  const lists = { pages: PAGE_SHAPE, tabs: TAB_SHAPE, commands: COMMAND_SHAPE } as const
  for (const key of given) {
    const value = added[key]
    const most = ADDED_LIMITS[key]
    problems.push(
      ...check(
        value,
        { list: lists[key], nonEmpty: true },
        `spec.${key}`,
        `a plugin’s ${key.slice(0, -1)}`,
      ),
    )
    if (Array.isArray(value) && value.length > most) {
      problems.push(`spec.${key}: holds ${value.length}, and a plugin may add ${most} at most`)
    }
  }
  if (added.commands !== undefined && added.pages === undefined) {
    problems.push('spec.commands: a command opens one of the plugin’s pages, and it has none')
  }
  if (problems.length) return problems

  const pages = (added.pages ?? []) as { id: string; title: string; takes?: unknown }[]
  const tabs = (added.tabs ?? []) as { id: string; title: string; kinds: NamedKind[] }[]
  const commands = (added.commands ?? []) as { name: string; page: string }[]
  /**
   * What's wrong with a title or a command's name, as any of the three may have it: nothing (an
   * empty list) where what's wrong is said already, of every text in the file.
   */
  const nameProblem = (name: string, where: string, theirs: string[]): string[] | undefined => {
    if (characterProblems(name, where, false).length) return []
    if (name.trim() === '' || name !== name.trim())
      return [`${where}: should be a name, with nothing round it`]
    if (name.length > ADDED_LIMITS.name) {
      return [`${where}: is longer than ${ADDED_LIMITS.name} characters`]
    }
    // (A line break isn't a name's, though a sentence may have one.)
    const broken = characterProblems(name, where, true)
    if (broken.length) return broken
    // A word with letters of two alphabets drawn alike reads as another ("YАML").
    const mixed = name
      .normalize('NFKC')
      .split(/[^\p{L}\p{M}]+/u)
      .some((word) => DRAWN_ALIKE.filter((alphabet) => alphabet.test(word)).length > 1)
    if (mixed) {
      return [
        `${where}: ${quoted(name)} mixes letters of two alphabets in one word, so it can look like a word it isn’t`,
      ]
    }
    if (/[/:]/.test(name.normalize('NFKC')))
      return [`${where}: ${quoted(name)} holds a / or a :, which read as an address`]
    if (squeezed(name).startsWith('lumovi')) {
      return [`${where}: ${quoted(name)} starts with Lumovi’s own name`]
    }
    // (Anywhere in it, whatever's before it, its letters as they read: as `squeezed` takes them,
    // its spaces kept.)
    const read = [...name.normalize('NFKC')].map((letter) => LOOKALIKES[letter] ?? letter).join('')
    if (SAYS_WHAT_IT_MAY_DO.test(read)) {
      return [
        `${where}: ${quoted(name)} reads as Lumovi’s own word on what the plugin may do, which is Lumovi’s alone to say: name it after the page`,
      ]
    }
    if (theirs.some((own) => squeezed(own) === squeezed(name))) {
      return [
        `${where}: ${quoted(name)} is a name Lumovi itself uses there, so a person pressing it would expect Lumovi’s`,
      ]
    }
    return undefined
  }
  const ids = new Map<string, string>()
  const id = (value: string, where: string) => {
    if (!PLUGIN_NAME.test(value)) {
      problems.push(
        `${where}: ${quoted(value, true)} should be lowercase letters, digits and hyphens, starting with a letter and ending with a letter or a digit`,
      )
    } else if (ids.has(value)) {
      problems.push(`${where}: ${value} is already the id of ${ids.get(value)}`)
    } else ids.set(value, where.slice(0, where.lastIndexOf('.')))
  }
  const once = (names: Map<string, string>, name: string, where: string) => {
    const first = names.get(squeezed(name))
    if (first !== undefined)
      problems.push(`${where}: ${quoted(name)} is already the name of ${first}`)
    else names.set(squeezed(name), where.slice(0, where.lastIndexOf('.')))
  }
  // The entry's own tabs: All, and its kinds (their names, one and many).
  const entrysOwn = [
    'All',
    ...((place.kinds ?? []) as NamedKind[]).flatMap(({ kind }) => [kind, `${kind}s`]),
  ]
  // Lumovi's own pages, kinds' lists and palette's: never a plugin's page's or tab's, whose title
  // the bar and the tabs say as their own.
  const lumovis = [
    ...LUMOVIS_PAGES,
    ...LUMOVIS_COMMANDS.filter((name) => name !== 'Overview'),
    ...RESOURCES.map(({ label }) => label),
  ]
  const titles = new Map<string, string>()
  // A page that takes a kind's tab: of a kind of the plugin's own place, one page a kind; and its
  // title may be that kind's own, as the tab it stands in was.
  const ownKinds = ((place.kinds ?? []) as NamedKind[]).map(kindId)
  const taken = new Map<ResourceKind, string>()
  pages.forEach((page, p) => {
    id(page.id, `spec.pages[${p}].id`)
    // (One its shape refused is said so already: nothing more of it here.)
    const takes =
      typeof page.takes === 'object' &&
      page.takes !== null &&
      typeof (page.takes as NamedKind).kind === 'string'
        ? (page.takes as NamedKind)
        : undefined
    const its = takes ? [takes.kind, `${takes.kind}s`] : []
    const wrong = nameProblem(page.title, `spec.pages[${p}].title`, [
      ...entrysOwn.filter((name) => !its.includes(name)),
      ...lumovis,
    ])
    if (wrong) problems.push(...wrong)
    else once(titles, page.title, `spec.pages[${p}].title`)
    if (takes) {
      const kindName = kindId(takes)
      const where = `spec.pages[${p}].takes`
      if (!ownKinds.includes(kindName)) {
        problems.push(
          `${where}: ${quoted(takes.kind)} isn’t one of the plugin’s own kinds (spec.kinds)`,
        )
      } else if (taken.has(kindName)) {
        problems.push(`${where}: ${quoted(takes.kind)} is already taken by ${taken.get(kindName)}`)
      } else taken.set(kindName, `spec.pages[${p}]`)
    }
  })
  const tabTitles = new Map<string, string>()
  const tabbed = new Map<ResourceKind, string>()
  tabs.forEach((tab, t) => {
    id(tab.id, `spec.tabs[${t}].id`)
    const wrong = nameProblem(tab.title, `spec.tabs[${t}].title`, [...LUMOVIS_TABS, ...lumovis])
    if (wrong) problems.push(...wrong)
    else once(tabTitles, tab.title, `spec.tabs[${t}].title`)
    tab.kinds.forEach((kind, k) => {
      const kindName = kindId(kind)
      const first = tabbed.get(kindName)
      if (first !== undefined) {
        problems.push(
          `spec.tabs[${t}].kinds[${k}]: ${kindName} already has a tab of this plugin’s, ${first}`,
        )
      } else tabbed.set(kindName, `spec.tabs[${t}]`)
    })
  })
  const names = new Map<string, string>()
  const pageIds = new Set(pages.map((page) => page.id))
  commands.forEach((command, c) => {
    const where = `spec.commands[${c}]`
    const wrong = nameProblem(command.name, `${where}.name`, [
      ...LUMOVIS_COMMANDS,
      // (And each kind's list, which the palette goes to by its name.)
      ...RESOURCES.map(({ label }) => label),
    ])
    if (wrong) problems.push(...wrong)
    else {
      if (changing(command.name)) {
        problems.push(
          `${where}.name: ${quoted(command.name)}: a command only opens a page: name it after the page`,
        )
      } else once(names, command.name, `${where}.name`)
    }
    if (!pageIds.has(command.page)) {
      problems.push(
        `${where}.page: ${quoted(command.page, true)} isn’t the id of one of the plugin’s pages`,
      )
    }
  })
  return problems
}

/**
 * What a plugin's name may be: what it's known by wherever it's granted something, so it's
 * fixed while nobody has one of their own.
 */
export const PLUGIN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Why `name` can't be a plugin's name, or nothing if it can: the pattern, and the names that
 * would read as Lumovi's own or the cluster's (what Lumovi says a change is from is a plugin's
 * name). The one place this is decided, for everything that's named as a plugin is.
 */
export function nameProblem(name: string): string | undefined {
  if (!PLUGIN_NAME.test(name)) {
    return `${quoted(name, true)} should be lowercase letters, digits and hyphens, starting with a letter and ending with a letter or a digit, at most 63 characters`
  }
  if (name === 'lumovi') return '"lumovi" is Lumovi’s own name, which a plugin can’t have'
  if (name === 'kubernetes')
    return '"kubernetes" is Kubernetes’ own name, which a plugin can’t have'
  return name.startsWith('lumovi-')
    ? `${quoted(name, true)} starts with Lumovi’s own name, which a plugin can’t have`
    : undefined
}

/** A version: three numbers, and nothing that would need comparing any other way. */
const THREE_NUMBERS = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/

/**
 * Whether version `a` is older than `b`, three numbers each. (A Lumovi between releases has a
 * tail after its numbers, "1.22.0-beta.1": it counts as its release.)
 */
export function older(a: string, b: string): boolean {
  const [x, y] = [a, b].map((version) => version.split(/[-+]/)[0]!.split('.').map(Number))
  const at = x!.findIndex((part, i) => part !== y![i])
  return at >= 0 && x![at]! < y![at]!
}

/** What a plugin needs to work; one thing so far. */
const NEEDS_SHAPE: Shape = { fields: { lumovi: { shape: 'string', required: true } } }

/** How long a name or a label may be, and a sentence. */
const NAME_LENGTH = 80
const SENTENCE_LENGTH = 500
const NAMES = new Set(['name', 'label', 'default'])
const SENTENCES = new Set(['confirm', 'detail', 'done', 'why'])
/**
 * Characters nobody sees, which can make a text read as another: the ones that turn its
 * direction, the ones with no width or that only look like a space, the breaks that aren't a
 * line's end, and the tags.
 */
// (The joiner among them combines with what's before it, which is why it's here.)
/* eslint-disable no-misleading-character-class */
const UNSEEN =
  /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0001}-\u{e007f}]/u
/* eslint-enable no-misleading-character-class */
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u

const codePoint = (character: string) =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * A line about a file, safe to show: what a file holds is quoted in it (a name, a value, the
 * file's own name), and a character that can't be seen there could turn Lumovi's own sentence
 * round. Each is shown as its code point instead; and no line is a page long.
 */
export function plain(line: string): string {
  const shown = line
    .replace(new RegExp(UNSEEN, 'gu'), codePoint)
    .replace(new RegExp(NOT_TEXT, 'gu'), codePoint)
  return shown.length > LINE_LENGTH ? `${shown.slice(0, LINE_LENGTH)}…` : shown
}
const LINE_LENGTH = 400

/** How much of what a file says is quoted back in a line about it. */
const QUOTED_LENGTH = 40

/** What a file says, quoted in a line about it: cut short, a name in its middle (its end tells two apart). */
function quoted(value: unknown, name = false): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const cut =
    text.length <= QUOTED_LENGTH
      ? text
      : name
        ? `${text.slice(0, QUOTED_LENGTH - 7)}…${text.slice(-6)}`
        : `${text.slice(0, QUOTED_LENGTH - 1)}…`
  return typeof value === 'string' ? JSON.stringify(cut) : cut
}

/** What's wrong with the texts of a plugin, each where it is: every text is plain, and a name short. */
function textProblems(value: unknown, where: string, key = '', sent = false): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => textProblems(item, `${where}[${i}]`, key, sent))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([field, item]) => [
      // (A key is shown too: a label's, in the YAML a person agrees to.)
      ...characterProblems(field, `${where}.${plain(field)}`, true),
      // What's sent to the cluster is the cluster's to limit: lengths are for a plugin's own texts.
      ...textProblems(item, `${where}.${plain(field)}`, field, sent || BODIES.has(field)),
    ])
  }
  if (typeof value !== 'string') return []
  const characters = characterProblems(value, where, NAMES.has(key) && !sent)
  if (characters.length || sent) return characters
  // (A status rule's label is a template, as long as the paths in it; what it comes to is short.)
  const template = key === 'label' && where.includes('.status[')
  const most =
    NAMES.has(key) && !template
      ? NAME_LENGTH
      : SENTENCES.has(key) || template
        ? SENTENCE_LENGTH
        : Infinity
  return value.length > most ? [`${where}: is longer than ${most} characters`] : []
}

/** The parts of an action that are sent to the cluster as they're written. */
const BODIES = new Set(['patch', 'undo', 'create'])

/** The first character of `text` that can't be seen, or isn't text (a line break is, but not in a name). */
function characterProblems(text: string, where: string, name: boolean): string[] {
  const unseen = UNSEEN.exec(text)
  if (unseen) return [`${where}: holds a character that can’t be seen (${codePoint(unseen[0])})`]
  const notText = NOT_TEXT.exec(text) ?? (name ? /[\n\t]/.exec(text) : null)
  return notText ? [`${where}: holds a character that isn’t text (${codePoint(notText[0])})`] : []
}

/** A view as a plugin lists it: a view's fields, and a name where it's worth one. */
const VIEW_ITEM_SHAPE: Shape = {
  ...(VIEW_SHAPE as Extract<Shape, { fields: unknown }>),
  fields: { name: 'string', ...(VIEW_SHAPE as Extract<Shape, { fields: unknown }>).fields },
}

/**
 * `{{ .path }}` in a template, with a fallback for when it finds nothing:
 * `{{ .path ?? "text" }}` or `{{ .path ?? .other.path }}`. `{{ now }}` is the time.
 */
export const PLACEHOLDER = /\{\{\s*(.*?)\s*\}\}/g
export const EXPRESSION = /^(\S+?)(?:\s*\?\?\s*(?:"([^"]*)"|(\.\S*)))?$/
/** `{{ input.name }}`: an action's input, wherever it is in a template. */
const INPUT_PLACEHOLDER = /\{\{\s*input\.(\w+)/g
/** A template that's one placeholder and nothing else: a value of its own. */
export const ONLY_PLACEHOLDER = /^\{\{\s*([^{}]*?)\s*\}\}$/
/** An input's value as a path in a template. */
export const INPUT_PATH = /^input\.\w+$/
/** The object a manager manages, in a view's `manages` (and nowhere else): `{{ object.name }}`. */
export const OBJECT_PATH = /^object\.(group|kind|namespace|name)$/
/**
 * What marks where the managed object's own name and the rest go, in a manager's values as Lumovi
 * finds managers by them: never in a plugin's `manages`, nor a manager's text it reads.
 */
export const MANAGING_MARK = '\uE000'

/** What's wrong with a template; `managing`, for one of a view's `manages`. */
function templateProblem(template: string, managing = false): string | undefined {
  if (managing && template.includes(MANAGING_MARK)) {
    return `holds ${codePoint(MANAGING_MARK)}, which Lumovi keeps for itself in manages`
  }
  for (const [, expression] of template.matchAll(PLACEHOLDER)) {
    const [, path, , fallback] = EXPRESSION.exec(expression!) ?? []
    if (!path) return `{{ ${expression} }} should be a path, maybe with ?? "a fallback"`
    for (const p of [path, fallback]) {
      if (!p) continue
      if (p.startsWith('object.')) {
        if (!managing) return `{{ ${p} }} is an object a manager manages, which only manages names`
        if (!OBJECT_PATH.test(p)) {
          return `{{ ${p} }} should be object.group, object.kind, object.namespace or object.name`
        }
      } else if (managing && (p === 'now' || INPUT_PATH.test(p))) {
        return `{{ ${p} }} isn’t something a manager is known by: name its fields, or the object’s`
      }
    }
    try {
      for (const p of [path, fallback]) {
        if (p && p !== 'now' && !INPUT_PATH.test(p) && !OBJECT_PATH.test(p)) checkPath(p)
      }
    } catch (error) {
      return (error as Error).message
    }
  }
  return undefined
}

const describe = (value: unknown) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'a list'
      : typeof value === 'object'
        ? 'an object'
        : `a ${typeof value}`

/** Problems with `value` as `shape`, each prefixed with where it is; `noun` is what it's part of. */
function check(value: unknown, shape: Shape, where: string, noun: string): string[] {
  const fail = (message: string) => [`${where}: ${message}`]
  if (typeof shape === 'string') {
    switch (shape) {
      case 'boolean':
        return typeof value === 'boolean'
          ? []
          : fail(`should be true or false, not ${describe(value)}`)
      case 'scalar':
        return ['string', 'number', 'boolean'].includes(typeof value) || value === null
          ? []
          : fail(`should be a single value, not ${describe(value)}`)
      case 'patch':
        return typeof value === 'object' && value !== null
          ? []
          : fail(`should be a patch (an object or a list), not ${describe(value)}`)
      case 'json':
        return value === undefined ? fail('should be a value') : []
      default: {
        if (typeof value !== 'string') return fail(`should be text, not ${describe(value)}`)
        try {
          if (shape === 'path') checkPath(value)
          if (shape === 'regex') new RegExp(value)
        } catch (error) {
          return fail((error as Error).message)
        }
        const problem =
          shape === 'template' || shape === 'managing'
            ? templateProblem(value, shape === 'managing')
            : undefined
        return problem ? fail(problem) : []
      }
    }
  }
  if ('oneOf' in shape) {
    return shape.oneOf.includes(value as string)
      ? []
      : fail(`should be one of ${shape.oneOf.join(', ')}, not ${quoted(value)}`)
  }
  if ('list' in shape) {
    if (!Array.isArray(value)) return fail(`should be a list, not ${describe(value)}`)
    if (shape.nonEmpty && value.length === 0) return fail('should not be empty')
    if (shape.most !== undefined && value.length > shape.most) {
      return fail(`holds ${value.length}, and ${shape.most} is the most`)
    }
    return value.flatMap((item, i) => check(item, shape.list, `${where}[${i}]`, noun))
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`should be a map of fields, not ${describe(value)}`)
  }
  if ('map' in shape) {
    return Object.entries(value).flatMap(([key, item]) =>
      check(item, shape.map, `${where}.${key}`, noun),
    )
  }
  const fields = value as Record<string, unknown>
  const problems = Object.keys(fields)
    // (Its own fields, by name: every object answers to `constructor` and `toString`, and a
    // file's key of that name is no field of anything.)
    .filter((key) => !Object.hasOwn(shape.fields, key))
    .map((key) => `${where}.${key}: isn’t something ${noun} has`)
  for (const [key, rule] of Object.entries(shape.fields)) {
    const { shape: inner, required } =
      typeof rule === 'object' && 'required' in rule ? rule : { shape: rule, required: false }
    if (fields[key] === undefined) {
      if (required) problems.push(`${where}.${key}: is required`)
    } else {
      problems.push(...check(fields[key], inner, `${where}.${key}`, noun))
    }
  }
  const refined = problems.length === 0 ? shape.refine?.(fields) : undefined
  return refined ? [...problems, `${where}: ${refined}`] : problems
}

export interface ParseOptions {
  /** The Lumovi that's reading it, where that's known: a plugin that needs a newer one is refused. */
  lumovi?: string
  /** The kinds of Kubernetes' own that Lumovi's own views show: no plugin's to show. */
  lumovisOwn?: readonly ResourceKind[]
  /**
   * It's the file of Lumovi's own views of Kubernetes' kinds: written as a plugin is, and no
   * plugin, so not held inside groups. Decided by where the file is, in Lumovi's own code;
   * nothing a file says, and no folder a person or a server has, makes it so.
   */
  ownViews?: boolean
  /**
   * The file may carry code (`mayCarryCode`: it came inside Lumovi). Said by whoever reads it,
   * from where it came; nothing a file says makes it so, and unsaid it's false: what such a file
   * adds to Lumovi's pages is refused.
   */
  carriesCode?: boolean
  /**
   * Whose a file that may not carry code is (unsaid: a person's): a person's own file, beside the
   * folders their Developer mode reads, or a server's. What only code uses is refused in its
   * words.
   */
  from?: 'yours' | 'server'
}

/**
 * Why a file that may not carry code can't say what only code uses (`field`): a person's draws
 * pages only from a folder of its own, in Developer mode; a server's plugins are data. `name` is
 * the file's own, said back as its folder: only ever a name a plugin may have (a file whose
 * name isn't one is refused for that, before anything of its spec is read).
 */
const onlyCode = (field: string, from: 'yours' | 'server', name: string) =>
  from === 'server'
    ? `${field}: this server’s plugins are data: only the plugins that come with Lumovi draw pages here`
    : `${field}: a plugin of yours draws pages only from a folder of its own, for Developer mode: ${name}/plugin.yaml, with its plugin.js`

/** A kind as a file names it. */
interface NamedKind {
  group?: string
  kind: string
}

/**
 * A name that's Kubernetes' own and no add-on's: `kubernetes.io` and every name under it (where
 * its own labels and annotations live), and `k8s.io` itself. A name under `k8s.io` may be an
 * add-on's group (the Gateway API's is), and those stay a plugin's to have; the ones that are
 * Kubernetes' built-in API groups are refused as such.
 */
const kubernetesOwnName = (group: string) =>
  group === 'k8s.io' || group === 'kubernetes.io' || group.endsWith('.kubernetes.io')

/**
 * What a plugin names outside its fence, each where it is. Its declared groups are the fence:
 * none of them Kubernetes' own or Lumovi's, every kind of a tool's that it names in one of
 * them, and nothing created but kinds it claims itself (a group can be shared by plugins, so
 * being in the group isn't enough to make one).
 *
 * Kubernetes' own kinds are outside it, with one allowance: a kind Lumovi has no page for can
 * be shown, and only shown, by a plugin that names it under `shows`. Such a view has no
 * actions, the kind isn't under the plugin's place in the sidebar, and what Lumovi itself
 * shows (`lumovisOwn`) stays Lumovi's.
 */
function fenceProblems(
  groups: string[],
  shows: NamedKind[],
  placed: NamedKind[] | undefined,
  views: {
    kinds: NamedKind[]
    actions?: { create?: Record<string, unknown> }[]
    manages?: ViewManages[]
  }[],
  lumovisOwn: readonly ResourceKind[],
): string[] {
  const problems = groups.flatMap((group, g) =>
    group === 'lumovi.dev' || group.endsWith('.lumovi.dev')
      ? [`spec.groups[${g}]: lumovi.dev is Lumovi’s own, so a plugin can’t have it`]
      : group !== '' && !group.includes('.')
        ? [`spec.groups[${g}]: ${group} has no dot, and no custom resource’s group can be one`]
        : isCustomGroup(group) && !kubernetesOwnName(group)
          ? []
          : [
              `spec.groups[${g}]: ${group || 'the core group'} is Kubernetes’ own, so a plugin can’t have it`,
            ],
  )
  /** Why a kind of Kubernetes' own can't be shown by a plugin at all, if it can't. */
  const never = (id: ResourceKind) =>
    isBuiltinKind(id)
      ? `${id} has a page of its own, so it can’t be in a plugin`
      : lumovisOwn.includes(id)
        ? `${id} is shown by Lumovi itself, so it can’t be in a plugin`
        : undefined
  shows.forEach((kind, i) => {
    const id = kindId(kind)
    const group = id.includes('.') ? id.slice(id.indexOf('.') + 1) : ''
    const problem =
      never(id) ??
      (isCustomGroup(group)
        ? `${id} isn’t Kubernetes’ own: a view names it once ${group} is in spec.groups`
        : undefined)
    if (problem) problems.push(`spec.shows[${i}]: ${problem}`)
  })
  // Every question below is asked of a kind as Lumovi resolves it (the id its views and its
  // changes are found by), never of how the file spelt it: whatever a spelling comes to is what's
  // judged, so one that comes to another kind is judged as that kind.
  const resolved = (kind: NamedKind) => {
    const id = kindId(kind)
    const group = id.includes('.') ? id.slice(id.indexOf('.') + 1) : ''
    return { id, group, tools: isCustomGroup(group) }
  }
  const shown = new Set(shows.map(kindId))
  // (What's said at the top is what's used: a kind named there and shown nowhere is more reach
  // than the plugin has.)
  const viewed = new Set(views.flatMap((view) => view.kinds.map(kindId)))
  shows.forEach((kind, i) => {
    if (!viewed.has(kindId(kind)) && problems.every((p) => !p.startsWith(`spec.shows[${i}]:`))) {
      problems.push(`spec.shows[${i}]: ${kindId(kind)} isn’t shown by any of its views`)
    }
  })
  const outside = (group: string) =>
    groups.includes(group) ? undefined : `isn’t in one of its groups: add ${group} to spec.groups`
  placed?.forEach((kind, k) => {
    const { id, group, tools } = resolved(kind)
    const problem =
      never(id) ??
      (tools
        ? outside(group) && `${id} ${outside(group)}`
        : `${id} is Kubernetes’ own, so it can’t be under a plugin’s place in the sidebar`)
    if (problem) problems.push(`spec.kinds[${k}]: ${problem}`)
  })
  views.forEach((view, i) => {
    view.kinds.forEach((kind, k) => {
      const { id, group, tools } = resolved(kind)
      const problem =
        never(id) ??
        (tools
          ? outside(group) && `${id} ${outside(group)}`
          : shown.has(id)
            ? undefined
            : `${id} is Kubernetes’ own: to show it, name it under spec.shows`)
      if (problem) problems.push(`spec.views[${i}].kinds[${k}]: ${problem}`)
    })
    if (view.actions && view.kinds.some((kind) => !resolved(kind).tools)) {
      problems.push(
        `spec.views[${i}].actions: a view of Kubernetes’ own kind only shows it, so it can’t have actions`,
      )
    }
    // A manager is a tool's object, of a kind named: Lumovi lists that kind to find them.
    if (view.manages && view.kinds.some((kind) => !resolved(kind).tools)) {
      problems.push(
        `spec.views[${i}].manages: a view of Kubernetes’ own kind only shows it, so it can’t say what its objects manage`,
      )
    } else if (view.manages && view.kinds.some((kind) => kind.kind === '*')) {
      problems.push(
        `spec.views[${i}].manages: its managers’ kinds should be named, not every kind of a group`,
      )
    }
    // What Lumovi says manages an object is said by its tool's own labels and annotations: a
    // key under the group of the managers' own kind (or a name under it), never Kubernetes'.
    const own = [...new Set(view.kinds.map((kind) => resolved(kind).group))]
    const keys = (view.manages ?? []).flatMap((entry) => [
      ...Object.keys(entry.labels ?? {}),
      ...Object.keys(entry.annotations ?? {}),
    ])
    for (const key of new Set(keys)) {
      const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : ''
      const kubernetes = /(^|\.)(kubernetes\.io|k8s\.io)$/.test(prefix)
      const under = own.some(
        (group) => group !== '' && (prefix === group || prefix.endsWith(`.${group}`)),
      )
      if (!prefix || kubernetes || !under) {
        problems.push(
          `spec.views[${i}].manages: the key ${quoted(key)} isn’t under the group of this view’s kinds (${own.map((group) => quoted(group)).join(', ')})`,
        )
      }
    }
  })
  const claimed = new Set(
    [...(placed ?? []), ...views.flatMap((view) => view.kinds)]
      .filter((kind) => resolved(kind).tools)
      .map(kindId),
  )
  views.forEach((view, i) =>
    view.actions?.forEach(({ create }, a) => {
      if (!create) return
      const made = kindFor(create.apiVersion as string, create.kind as string)
      const group = made.includes('.') ? made.slice(made.indexOf('.') + 1) : ''
      if (!claimed.has(made) && !claimed.has(`*.${group}`)) {
        problems.push(
          `spec.views[${i}].actions[${a}].create: makes a ${made}, which isn’t one of this plugin’s kinds`,
        )
      }
    }),
  )
  return problems
}

/**
 * The plugin a file holds (YAML, one document), or everything that's wrong with it: a plugin is
 * used whole or not at all. (Its name comes with the problems where it could be read, for
 * saying what's shown in its stead.)
 */
export function parsePlugin(
  text: string,
  source: string,
  options: ParseOptions = {},
): { plugin?: Plugin; name?: string; problems: string[] } {
  const read = readPlugin(text, source, options)
  return { ...read, problems: read.problems.map(plain) }
}

function readPlugin(
  text: string,
  source: string,
  { lumovi, lumovisOwn = [], ownViews = false, carriesCode = false, from = 'yours' }: ParseOptions,
): { plugin?: Plugin; name?: string; problems: string[] } {
  const refused = (problem: string) => ({ problems: [`${source}: ${problem}`] })
  const documents = parseAllDocuments(text)
  const broken = documents.find((document) => document.errors.length)
  if (broken) return refused(broken.errors[0]!.message)
  let read: unknown[]
  try {
    read = documents.map((document) => document.toJS() as unknown).filter((doc) => doc !== null)
  } catch (error) {
    // (YAML can read as YAML and still not make an object: an alias to an anchor that isn't
    // set before it is found out only here.)
    return refused((error as Error).message)
  }
  if (read.length === 0) return refused('holds nothing')
  const doc = read[0] as Record<string, unknown>
  const start = `should start with apiVersion: ${VIEW_API_VERSION} and kind: Plugin`
  if (typeof doc !== 'object' || doc.apiVersion !== VIEW_API_VERSION) return refused(start)
  if (doc.kind === 'View') {
    return refused(
      'a view goes inside a plugin: start with kind: Plugin and put this under its views.',
    )
  }
  if (doc.kind !== 'Plugin') return refused(start)
  if (read.length > 1) return refused(`holds ${read.length} documents, and a file is one plugin`)
  const name = (doc.metadata as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string' || !name) return refused('needs metadata.name')
  const unfit = nameProblem(name)
  if (unfit) return refused(`metadata.name: ${unfit}`)
  if (doc.spec === undefined) return { name, ...refused('needs spec') }
  if (typeof doc.spec !== 'object' || doc.spec === null || Array.isArray(doc.spec)) {
    return { name, ...refused(`spec: should be a map of fields, not ${describe(doc.spec)}`) }
  }
  const {
    views: listed,
    version,
    needs,
    groups,
    shows,
    pages,
    tabs,
    commands,
    reads,
    showsSecrets,
    changes,
    opens,
    links,
    logs,
    server,
    ...place
  } = doc.spec as Record<string, unknown>
  // (With pages of its own, a place in the sidebar needs no kinds: its pages are its tabs.)
  const problems = check(
    place,
    pages === undefined ? PLACE_SHAPE : PAGES_PLACE_SHAPE,
    `${source}: spec`,
    'a plugin',
  )
  // What a file says beside its spec is its start and its name, and nothing else: an unknown
  // key there is as unknown as one anywhere.
  const unknown = (object: object, known: string[], where: string) =>
    Object.keys(object)
      .filter((key) => !known.includes(key))
      .map((key) => `${source}: ${where}${plain(key)}: isn’t something a plugin has`)
  problems.push(
    ...unknown(doc, ['apiVersion', 'kind', 'metadata', 'spec'], ''),
    ...unknown(doc.metadata as object, ['name'], 'metadata.'),
  )
  const threeNumbers = (value: unknown, where: string, like: string) => {
    if (value === undefined) problems.push(`${source}: ${where}: is required`)
    else if (typeof value !== 'string' || !THREE_NUMBERS.test(value)) {
      // (As it's written: YAML reads 1.0 as the number 1.)
      const node = documents[0]!.getIn(where.split('.'), true) as { source?: string } | undefined
      const written = typeof value === 'number' ? (node?.source ?? value) : value
      problems.push(`${source}: ${where}: ${quoted(written)} should be three numbers, like ${like}`)
    }
  }
  threeNumbers(version, 'spec.version', '1.0.0')
  if (needs === undefined) problems.push(`${source}: spec.needs.lumovi: is required`)
  else {
    const wrong = check(needs, NEEDS_SHAPE, `${source}: spec.needs`, 'a plugin')
    problems.push(...wrong)
    if (wrong.length === 0) {
      threeNumbers((needs as { lumovi: string }).lumovi, 'spec.needs.lumovi', '1.22.0')
    }
  }
  if (groups === undefined) {
    if (!ownViews) {
      problems.push(
        `${source}: spec.groups: is required: the API groups its kinds are in, like [example.com]`,
      )
    }
  } else {
    problems.push(...check(groups, { list: 'string' }, `${source}: spec.groups`, 'a plugin'))
    if (Array.isArray(groups)) {
      groups.forEach((group, g) => {
        const problem = groupNameProblem(group)
        if (problem) problems.push(`${source}: spec.groups[${g}]: ${problem}`)
      })
    }
  }
  if (shows !== undefined) {
    problems.push(...check(shows, { list: namedKind }, `${source}: spec.shows`, 'a plugin'))
  }
  problems.push(...textProblems(doc.spec, `${source}: spec`))
  if (listed !== undefined && !Array.isArray(listed)) {
    problems.push(`${source}: spec.views: should be a list, not ${describe(listed)}`)
  }
  const items = Array.isArray(listed) ? (listed as unknown[]) : []
  items.forEach((item, i) => {
    problems.push(...check(item, VIEW_ITEM_SHAPE, `${source}: spec.views[${i}]`, 'a view'))
  })
  if (problems.length === 0) {
    // A kind is shown one way: a second view of it in the same file would be dropped unsaid.
    const shownBy = new Map<ResourceKind, number>()
    items.forEach((item, i) => {
      ;(item as { kinds: { group?: string; kind: string }[] }).kinds.forEach((kind, k) => {
        const first = shownBy.get(kindId(kind))
        if (first === undefined) shownBy.set(kindId(kind), i)
        else {
          problems.push(
            `${source}: spec.views[${i}].kinds[${k}]: ${kindId(kind)} is already shown by spec.views[${first}]`,
          )
        }
      })
    })
  }
  if (problems.length === 0 && !ownViews) {
    problems.push(
      ...fenceProblems(
        (groups ?? []) as string[],
        (shows ?? []) as NamedKind[],
        place.kinds as NamedKind[] | undefined,
        items as { kinds: NamedKind[]; actions?: { create?: Record<string, unknown> }[] }[],
        lumovisOwn,
      ).map((problem) => `${source}: ${problem}`),
    )
  }
  // (Lumovi's own views' file as anyone's: what it shows is Kubernetes', and never withheld.)
  if (problems.length === 0) {
    problems.push(
      ...withholdsProblems(items as { kinds: NamedKind[]; withholds?: { path: string }[] }[]).map(
        (problem) => `${source}: ${problem}`,
      ),
    )
  }
  const needed = (needs as { lumovi: string } | undefined)?.lumovi
  if (problems.length === 0 && lumovi && older(lumovi, needed!)) {
    problems.push(`${source}: needs Lumovi ${needed} or newer; this is ${lumovi}`)
  }
  // Where it may not carry code, why not, of a field: in the words of whose file it is.
  const uncoded = carriesCode ? undefined : (field: string) => onlyCode(field, from, name)
  problems.push(
    ...addedProblems({ pages, tabs, commands }, place, uncoded).map(
      (problem) => `${source}: ${problem}`,
    ),
  )
  // (Only a plugin that may carry code says what its code reads, what its pages show, propose,
  // open and link to, whose logs they show and whether they ask its server.)
  if (uncoded) {
    const coded = { reads, showsSecrets, changes, opens, links, logs, server }
    for (const [key, value] of Object.entries(coded)) {
      if (value !== undefined) problems.push(`${source}: ${uncoded(`spec.${key}`)}`)
    }
  } else {
    if (opens !== undefined) {
      problems.push(...opensProblems(opens).map((problem) => `${source}: ${problem}`))
    }
    if (links !== undefined) {
      problems.push(...linksProblems(links).map((problem) => `${source}: ${problem}`))
    }
    if (logs !== undefined && logs !== 'shown' && logs !== 'read') {
      problems.push(`${source}: spec.logs: should be shown or read, not ${describe(logs)}`)
    }
  }
  if (problems.length === 0) {
    // A tab is on the plugin's own kinds only: ones it claims, in a group of its own (its code
    // reads the object through the door, by the door's reading rules for that kind and that
    // person, never as Lumovi read it). Never one of Kubernetes' own, which a plugin may show but
    // never claims, whatever views it has of it. A view of every kind of a group claims each.
    const own = new Set<ResourceKind>(
      [
        ...((place.kinds ?? []) as NamedKind[]),
        ...items.flatMap((item) => (item as { kinds: NamedKind[] }).kinds),
      ]
        .filter(({ group }) => isCustomGroup(group ?? '') && !kubernetesOwnName(group ?? ''))
        .map(kindId)
        .filter((kind) => !isBuiltinKind(kind)),
    )
    // What its code reads of other kinds: Kubernetes' own, by the door's list.
    if (reads !== undefined) {
      problems.push(
        ...readsProblems(reads, (groups ?? []) as string[], own).map(
          (problem) => `${source}: ${problem}`,
        ),
      )
    }
    // Its code reads the logs of pods it was handed: of Pods, which its file reads.
    if (logs === 'read' && problems.length === 0 && !Object.hasOwn(readsOf(reads), '/Pod')) {
      problems.push(
        `${source}: spec.logs: read needs Pods in spec.reads: its code reads the logs only of pods it was handed`,
      )
    }
    // Its tool's own server: in the namespace of one of its own kinds' objects.
    if (server !== undefined && carriesCode) {
      problems.push(...serverProblems(server, own).map((problem) => `${source}: ${problem}`))
    }
    // What its pages show of Secrets: named by objects of its own kinds.
    if (showsSecrets !== undefined) {
      problems.push(
        ...showsSecretsProblems(showsSecrets, own).map((problem) => `${source}: ${problem}`),
      )
    }
    // What its pages may propose to change: its own kinds, the person confirming each.
    if (changes !== undefined) {
      problems.push(...changesProblems(changes, own).map((problem) => `${source}: ${problem}`))
    }
    ;((tabs ?? []) as { kinds: NamedKind[] }[]).forEach((tab, t) => {
      tab.kinds.forEach((kind, k) => {
        const id = kindId(kind)
        // (The core group, the groups Kubernetes serves and its own names are never a plugin's.)
        const group = kind.group ?? ''
        const kubernetes = isBuiltinKind(id) || !isCustomGroup(group) || kubernetesOwnName(group)
        if (kind.kind === '*') {
          // (An object's tabs are found by its kind, so a tab names each of its kinds.)
          problems.push(
            `${source}: spec.tabs[${t}].kinds[${k}]: a tab is on kinds named one by one; it can’t be on every kind of a group`,
          )
        } else if (kubernetes) {
          problems.push(
            `${source}: spec.tabs[${t}].kinds[${k}]: a tab is only on the plugin’s own kinds, and ${id} is Kubernetes’`,
          )
        } else if (!own.has(id) && !own.has(kindId({ group: kind.group, kind: '*' }))) {
          problems.push(
            `${source}: spec.tabs[${t}].kinds[${k}]: a tab is only on the plugin’s own kinds, and ${id} isn’t one it claims`,
          )
        }
      })
    })
  }
  if (problems.length === 0 && items.length === 0 && place.kinds === undefined && !pages) {
    problems.push(`${source}: spec: needs views, or kinds for a place in the sidebar`)
  }
  // An action that runs at once asks nothing, so it shows no harm: one whose patch writes what
  // this file says harms a kind of its view has to ask first.
  const harmed = new Map<string, Harm[]>()
  for (const item of (Array.isArray(changes) ? changes : []) as {
    group?: string
    kind?: string
    harm?: Harm[]
  }[]) {
    if (item.harm) harmed.set(`${item.group ?? ''}/${item.kind}`, item.harm)
  }
  for (const [i, item] of items.entries()) {
    const view = item as {
      kinds?: { group?: string; kind: string }[]
      actions?: { runs?: string; patch?: unknown }[]
    }
    const harms = (view.kinds ?? []).flatMap(
      (each) => harmed.get(`${each.group ?? ''}/${each.kind}`) ?? [],
    )
    for (const [a, action] of (view.actions ?? []).entries()) {
      if (action.runs !== 'at-once' || action.patch === undefined) continue
      const harm = harms.find((each) => writesPath(action.patch, each.path))
      if (harm) {
        problems.push(
          `${source}: spec.views[${i}].actions[${a}]: writes ${harm.path}, which this file says harms (${harm.verb}), so it has to ask first`,
        )
      }
    }
  }
  if (problems.length) return { name, problems }
  const withType = (fields?: ViewField[]) =>
    fields?.map((f) => ({ ...f, type: f.type ?? 'string' }))
  const views = items.map((item, i): View => {
    const spec = item as Omit<View, 'name' | 'plugin' | 'source' | 'kinds'> & {
      name?: string
      kinds: { group?: string; kind: string }[]
    }
    return {
      ...spec,
      name: spec.name ?? `${name} ${i + 1}`,
      plugin: name,
      source,
      kinds: spec.kinds.map(kindId),
      columns: withType(spec.columns),
      details: withType(spec.details),
      ...(spec.withholds
        ? {
            withholds: spec.withholds.map(({ path, why }) => ({
              path,
              keys: withheldKeys(path)!,
              ...(why?.trim() ? { why } : {}),
            })),
          }
        : {}),
      actions: spec.actions?.map((a) => ({
        ...a,
        type: a.type ?? 'merge',
        inputs: a.inputs?.map((input) => ({ ...input, type: input.type ?? 'text' })),
      })),
    }
  })
  const { kinds, ...rest } = place as Omit<PluginPlace, 'kinds'> & {
    kinds?: { group?: string; kind: string }[]
  }
  return {
    plugin: {
      name,
      version: version as string,
      needs: needs as { lumovi: string },
      groups: (groups ?? []) as string[],
      shows: ((shows ?? []) as NamedKind[]).map(kindId),
      source,
      ...(kinds || pages ? { place: { ...rest, kinds: (kinds ?? []).map(kindId) } } : {}),
      views,
      added: {
        pages: ((pages ?? []) as { id: string; title: string; takes?: NamedKind }[]).map(
          ({ id, title, takes }) => ({ id, title, ...(takes ? { takes: kindId(takes) } : {}) }),
        ),
        tabs: ((tabs ?? []) as { id: string; title: string; kinds: NamedKind[] }[]).map(
          ({ id, title, kinds: on }) => ({ id, title, kinds: on.map(kindId) }),
        ),
        commands: ((commands ?? []) as Added['commands']).map(({ name, page }) => ({
          name,
          page,
        })),
      },
      reads: readsOf(reads),
      showsSecrets: showsSecretsOf(showsSecrets),
      changes: changesOf(changes),
      opens: ((opens ?? []) as NamedKind[]).map(kindId),
      links: [...((links ?? []) as Reach[])],
      ...(logs === 'shown' || logs === 'read' ? { logs: logs as 'shown' | 'read' } : {}),
      ...(server !== undefined ? { server: serverOf(server as RawServer) } : {}),
    },
    problems: [],
  }
}

/**
 * Which of `plugins` can't be used beside the ones before it, and why: a kind is one plugin's.
 * A group can be shared (three tools have kinds in argoproj.io), but not a kind in it; and a
 * plugin that shows every kind of a group (`*.group`) has that group to itself. Of two that
 * clash it's always the later that loses, so the same one on every start. `held` are plugins
 * in use before these and not judged with them: Lumovi's own, before a person's.
 */
/** "flux’s", "argo-rollouts’". */
export const whose = (name: string) => (name.endsWith('s') ? `${name}’` : `${name}’s`)

/**
 * The kinds a plugin claims as its own, as its code's reads name them (`group/Kind`; `group/*`
 * for every kind of a group): under its place or in a view, each in a tool's group. Never one
 * of Kubernetes' own, whatever views it has of one. What its code reads whole.
 */
export function ownKinds(plugin: Pick<Plugin, 'place' | 'views'>): string[] {
  const kinds = [...(plugin.place?.kinds ?? []), ...plugin.views.flatMap((view) => view.kinds)]
  return [
    ...new Set(
      kinds
        .filter((kind) => !isBuiltinKind(kind))
        .map((kind) => ({ group: apiGroupOf(kind), kind: apiKindOf(kind) }))
        .filter(({ group }) => isCustomGroup(group) && !kubernetesOwnName(group))
        .map(({ group, kind }) => `${group}/${kind}`),
    ),
  ]
}

/**
 * Every kind a plugin's file names, as Lumovi names it (`NodePool.karpenter.sh`, `Node`): under
 * its place, in a view, of Kubernetes' own that it shows, those its code reads, and those whose
 * lists its pages open. A list its page opens is of one of these and of no other. (A view of
 * `*.group` names no one kind.)
 */
export function namedKinds(
  plugin: Pick<Plugin, 'place' | 'views' | 'shows' | 'reads' | 'opens'>,
): ResourceKind[] {
  const read = Object.keys(plugin.reads).map((id) => {
    const slash = id.lastIndexOf('/')
    const group = id.slice(0, slash)
    return kindFor(group ? `${group}/v1` : 'v1', id.slice(slash + 1))
  })
  const kinds = [
    ...(plugin.place?.kinds ?? []),
    ...plugin.views.flatMap((view) => view.kinds),
    ...plugin.shows,
    ...read,
    ...plugin.opens,
  ]
  return [...new Set(kinds.filter((kind) => !kind.startsWith('*.')))]
}

export function clashes(plugins: Plugin[], held: Plugin[] = []): Map<Plugin, string> {
  const lost = new Map<Plugin, string>()
  const owner = new Map<ResourceKind, string>()
  const whole = new Map<string, string>()
  const present = new Map<string, string>()
  const groupOf = (kind: ResourceKind) =>
    kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : ''
  const claims = (plugin: Plugin) => {
    const kinds = [...(plugin.place?.kinds ?? []), ...plugin.views.flatMap((view) => view.kinds)]
    return { kinds, groups: new Set([...plugin.groups, ...kinds.map(groupOf)]) }
  }
  const keep = (plugin: Plugin) => {
    const { kinds, groups } = claims(plugin)
    for (const kind of kinds) {
      owner.set(kind, plugin.name)
      if (kind.startsWith('*.')) whole.set(groupOf(kind), plugin.name)
    }
    for (const group of groups) if (!present.has(group)) present.set(group, plugin.name)
  }
  // What's held already (the plugins Lumovi comes with, before a person's) isn't judged, and
  // what it has can be had one way only: by a plugin of its name, in its place.
  held.forEach(keep)
  const heldNames = new Set(held.map((plugin) => plugin.name))
  const instead = (name: string) =>
    heldNames.has(name) ? `. A plugin of yours named ${name} takes its place, all of it` : undefined
  for (const plugin of plugins) {
    const { kinds, groups } = claims(plugin)
    const problem =
      [...groups].flatMap((group) => {
        const all = whole.get(group)
        if (all === undefined) return []
        return [
          `${group} is all ${whose(all)}${instead(all) ?? ', so another plugin can’t have it'}`,
        ]
      })[0] ??
      kinds.flatMap((kind) => {
        if (kind.startsWith('*.') && present.has(groupOf(kind))) {
          const first = present.get(groupOf(kind))
          return [
            `${groupOf(kind)} is in ${whose(first!)} groups too, so this plugin can’t have every kind of it`,
          ]
        }
        const has = owner.get(kind)
        if (has === undefined) return []
        return [
          instead(has)
            ? `${kind} is ${whose(has)} kind${instead(has)}`
            : `${kind} is already ${whose(has)} kind`,
        ]
      })[0]
    if (problem) lost.set(plugin, problem)
    else keep(plugin)
  }
  return lost
}
