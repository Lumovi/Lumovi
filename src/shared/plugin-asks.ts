/**
 * What a plugin asks for, read from its file: what it may change and create, what it reads, and
 * each of its actions with what it sends. For a page that says it in Lumovi's words: nothing here
 * is the plugin's own account of itself.
 */
import { Scalar, stringify } from 'yaml'
import type { ChangeAction } from './plugin-changes'
import type { Plugin, View, ViewAction } from './plugins'
import { isCustomGroup, kindFor, type ResourceKind } from './resources'

/** An action, as a person is told of it. */
export interface AskedAction {
  name: string
  /** Whether its button sends at once, or a dialog shows what it would send first. */
  runs: 'at-once' | 'asks'
  /** The kinds its view is for: where its button is. */
  kinds: ResourceKind[]
  /** The patch as it's written (YAML), with what's filled in later shown as what it is. */
  patch?: string
  /** The object it creates, likewise. */
  creates?: string
  /** The patch that takes it back, which is sent too, later, when Undo is pressed. */
  undo?: string
  /** It patches the object's status, which is another thing to be allowed than the object. */
  status?: true
  /** Its patch is a list of JSON patch operations, not a merge. */
  json?: true
  /**
   * The fields of the object's status it writes on the object itself (not through the status
   * subresource, where a tool's kind has none): each one's path, `status.operationState.phase`.
   */
  writesStatus?: string[]
  /** What must still be as the person saw it when it's sent: each path, as the file writes it. */
  same?: string[]
  /** Its dialog's own question and button, as the file writes them. */
  confirmTitle?: string
  confirmButton?: string
}

export interface Asks {
  /** The tools' kinds it shows: what its actions may change. */
  kinds: ResourceKind[]
  /** The API groups it names, which those are all in. */
  groups: string[]
  /** The kinds its actions create: each one of `kinds`. */
  creates: ResourceKind[]
  /** Kinds of Kubernetes' own that it shows and can't change. */
  shows: ResourceKind[]
  /** The kinds its related lists list beside an object; `templated` when one is named by the object. */
  related: { kinds: string[]; templated: boolean }
  /** The kinds it links to by name. */
  links: { kinds: string[]; templated: boolean }
  /**
   * What its code reads of Kubernetes' own kinds (`spec.reads`): each kind, its paths as the file
   * writes them, and whether its status, events and usage too.
   */
  reads: {
    kind: ResourceKind
    fields: string[]
    status: boolean
    events: boolean
    usage: boolean
  }[]
  /**
   * The Secrets its pages show the person (`spec.showsSecrets`): which of its kinds names each,
   * by which path as the file writes it, and which keys. Its code never reads them.
   */
  secrets: { kind: ResourceKind; path: string; keys: string[] }[]
  /** The kinds whose objects it says manage workloads: lists Lumovi reads, in the whole cluster. */
  manages: ResourceKind[]
  /**
   * The kinds whose links are listed where they lead (`listedThere`): lists Lumovi reads, by their
   * labels, beside each object they might point at.
   */
  listed: ResourceKind[]
  /**
   * The kinds whose links count against workloads (`counts`): lists Lumovi reads, by their
   * labels, in the whole cluster, for workloads' Findings.
   */
  counted: ResourceKind[]
  /**
   * What its pages may propose to change (`spec.changes`): each of its own kinds, and how. The
   * person confirms each in Lumovi's own dialog.
   */
  changes: { kind: ResourceKind; actions: ChangeAction[] }[]
  actions: AskedAction[]
}

const groupOf = (kind: ResourceKind) =>
  kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : ''
const unique = <T>(items: T[]) => [...new Set(items)]

/** What Lumovi's own markers are written in: a text of the file's own that has one is quoted. */
const MARKER = /[()]/

/** What's filled in later, as what it is: the time, a choice of the person's, a field of the object. */
function filled(text: string): string {
  return text.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) =>
    expression === 'now'
      ? '(now)'
      : expression.startsWith('input.')
        ? '(what you choose)'
        : '(from the object)',
  )
}

/**
 * A patch or an object as YAML, with placeholders said as what they are. In a merge patch a null
 * takes the field away, and is said so; anywhere else a null is a null.
 */
function written(body: unknown, merge = false): string {
  const said = (value: unknown): unknown => {
    if (typeof value === 'string') {
      // (A text of the file's own that reads as one of these is quoted, whole: only what Lumovi
      // puts there for something filled in later stands bare.)
      const own = value.replace(/\{\{.*?\}\}/g, '')
      if (!MARKER.test(own)) return filled(value)
      const quoted = new Scalar(filled(value))
      quoted.type = Scalar.QUOTE_DOUBLE
      return quoted
    }
    if (value === null) return merge ? '(removed)' : null
    if (Array.isArray(value)) return value.map(said)
    if (typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, said(item)]))
  }
  return stringify(said(body), { lineWidth: 0 }).trimEnd()
}

/** The kinds a list of templates names: the ones written out, and whether any is filled in. */
function named(kinds: string[]): { kinds: string[]; templated: boolean } {
  return {
    kinds: unique(kinds.filter((kind) => !kind.includes('{{'))),
    templated: kinds.some((kind) => kind.includes('{{')),
  }
}

function asked(view: View, action: ViewAction): AskedAction {
  const merge = action.type === 'merge'
  return {
    name: action.name,
    runs: action.runs === 'at-once' ? 'at-once' : 'asks',
    kinds: view.kinds,
    ...(action.patch !== undefined ? { patch: written(action.patch, merge) } : {}),
    ...(action.create !== undefined ? { creates: written(action.create) } : {}),
    ...(action.undo !== undefined ? { undo: written(action.undo, merge) } : {}),
    ...(action.subresource === 'status' ? { status: true } : {}),
    ...(action.type === 'json' && action.patch !== undefined ? { json: true } : {}),
    ...(statusWritten(action).length > 0 ? { writesStatus: statusWritten(action) } : {}),
    ...(action.same !== undefined ? { same: [...action.same] } : {}),
    ...(action.confirmTitle !== undefined ? { confirmTitle: action.confirmTitle } : {}),
    ...(action.confirmButton !== undefined ? { confirmButton: action.confirmButton } : {}),
  }
}

/**
 * The status fields an action's patch writes on the object itself: a merge patch's leaves under
 * `status`, a JSON patch's paths there. (Through the status subresource, it's said as that.)
 */
function statusWritten(action: ViewAction): string[] {
  if (action.subresource === 'status' || action.patch === undefined) return []
  if (Array.isArray(action.patch)) {
    return unique(
      action.patch.flatMap(({ path }) =>
        typeof path === 'string' && /^\/status(\/|$)/.test(path)
          ? [path.slice(1).split('/').join('.')]
          : [],
      ),
    )
  }
  const leaves = (value: unknown, at: string): string[] =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, item]) => leaves(item, `${at}.${key}`))
      : [at]
  const status = (action.patch as Record<string, unknown>).status
  return status === undefined ? [] : leaves(status, 'status')
}

/** The same action on several of a plugin's views is one action, on all their kinds. */
function folded(actions: AskedAction[]): AskedAction[] {
  const byWhatItIs = new Map<string, AskedAction>()
  for (const action of actions) {
    const { kinds, ...rest } = action
    const key = JSON.stringify(rest)
    const same = byWhatItIs.get(key)
    if (same) same.kinds = unique([...same.kinds, ...kinds])
    else byWhatItIs.set(key, { ...action, kinds: [...kinds] })
  }
  return [...byWhatItIs.values()]
}

export function asks(plugin: Plugin): Asks {
  const all = unique([
    ...(plugin.place?.kinds ?? []),
    ...plugin.views.flatMap((view) => view.kinds),
  ])
  const actions = folded(
    plugin.views.flatMap((view) => (view.actions ?? []).map((a) => asked(view, a))),
  )
  return {
    kinds: all.filter((kind) => isCustomGroup(groupOf(kind))),
    groups: plugin.groups,
    creates: unique(
      plugin.views.flatMap((view) =>
        (view.actions ?? []).flatMap(({ create }) => {
          if (!create) return []
          const { apiVersion, kind } = create as { apiVersion: string; kind: string }
          const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : ''
          return [group ? `${kind}.${group}` : kind]
        }),
      ),
    ),
    shows: plugin.shows,
    related: named(plugin.views.flatMap((view) => (view.related ?? []).map(({ kind }) => kind))),
    links: named(plugin.views.flatMap((view) => (view.links ?? []).map(({ kind }) => kind))),
    reads: Object.entries(plugin.reads).map(([id, read]) => {
      const group = id.slice(0, id.indexOf('/'))
      return {
        kind: kindFor(group ? `${group}/v1` : 'v1', id.slice(id.indexOf('/') + 1)),
        fields: read.fields.map(({ path }) => path),
        status: read.status,
        events: read.events,
        usage: read.usage,
      }
    }),
    secrets: plugin.showsSecrets.map(({ kind, path, keys }) => {
      const group = kind.slice(0, kind.indexOf('/'))
      return {
        kind: kindFor(group ? `${group}/v1` : 'v1', kind.slice(kind.indexOf('/') + 1)),
        path,
        keys: [...keys],
      }
    }),
    manages: unique(plugin.views.flatMap((view) => (view.manages ? view.kinds : []))),
    counted: unique(
      plugin.views.flatMap((view) =>
        (view.links ?? []).some((link) => link.listedThere && link.counts) ? view.kinds : [],
      ),
    ),
    listed: unique(
      plugin.views.flatMap((view) =>
        (view.links ?? []).some((link) => link.listedThere) ? view.kinds : [],
      ),
    ),
    changes: plugin.changes.map(({ kind, actions: how }) => {
      const group = kind.slice(0, kind.indexOf('/'))
      return {
        kind: kindFor(group ? `${group}/v1` : 'v1', kind.slice(kind.indexOf('/') + 1)),
        actions: [...how],
      }
    }),
    actions,
  }
}
