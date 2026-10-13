/**
 * What a plugin is granted, as a person agrees to it: what its file asks (`asks`), what it adds
 * to Lumovi's pages and which lists they open, and whether its code comes with it. Two versions
 * are compared by these, never by the words they're said in: a change of Lumovi's wording is
 * never a new permission, and a real change never hides behind a line that looks the same.
 */
import { asks, type Asks } from '@shared/plugin-asks'
import type { Reach } from '@shared/kit/declare'
import type { AskedField } from '@shared/plugin-store'
import type { Plugin } from '@shared/plugins'
import type { ResourceKind } from '@shared/resources'

export interface Granted {
  asks: Asks
  added: Plugin['added']
  opens: ResourceKind[]
  /** Lumovi's own places its pages may link to: a pod's Logs or Shell tab, Port forward. */
  links: Reach[]
  /** What its pages do with containers' logs. None, where its file says nothing. */
  logs?: Plugin['logs']
  code: boolean
}

/**
 * The fields a person agrees to as they are (`PLUGIN_FIELDS`' `asked`), each compared below:
 * TypeScript asks for a new one here, so it's never agreed to unseen.
 */
const COMPARED = { added: true, opens: true, links: true, logs: true } as const satisfies Record<
  AskedField,
  true
>
void COMPARED

export const grantedOf = (plugin: Plugin, code: boolean): Granted => ({
  asks: asks(plugin),
  added: plugin.added,
  opens: plugin.opens,
  links: plugin.links,
  ...(plugin.logs ? { logs: plugin.logs } : {}),
  code,
})

/**
 * How much of containers' logs each way gives, least first: a step up is new, as a new field is.
 * Each way is said here (TypeScript holds it), so a new one is never compared as nothing.
 */
const LOGS = { shown: 1, read: 2 } as const satisfies Record<NonNullable<Plugin['logs']>, number>
const logsLevel = (logs: Plugin['logs']) => (logs === undefined ? 0 : LOGS[logs])

/** What's in `a` and not in `b`, in `a`'s order. */
const beyond = <T>(a: readonly T[], b: readonly T[], key: (item: T) => string = String) => {
  const there = new Set(b.map(key))
  return a.filter((item) => !there.has(key(item)))
}
const json = (value: unknown) => JSON.stringify(value)

/** What `next` grants that `was` doesn't: each part holding only that. */
function more(next: Granted, was: Granted): Granted {
  const n = next.asks
  const w = was.asks
  const listed = (a: { kinds: string[]; templated: boolean }, b: typeof a) => ({
    kinds: beyond(a.kinds, b.kinds),
    templated: a.templated && !b.templated,
  })
  return {
    asks: {
      kinds: beyond(n.kinds, w.kinds),
      groups: beyond(n.groups, w.groups),
      creates: beyond(n.creates, w.creates),
      shows: beyond(n.shows, w.shows),
      related: listed(n.related, w.related),
      links: listed(n.links, w.links),
      // Of a kind it read before, the fields (and status, events, usage) it reads now and didn't.
      reads: n.reads.flatMap((read) => {
        const before = w.reads.find(({ kind }) => kind === read.kind)
        const fields = beyond(read.fields, before?.fields ?? [])
        const flags = {
          status: read.status && !before?.status,
          events: read.events && !before?.events,
          usage: read.usage && !before?.usage,
        }
        return fields.length > 0 || flags.status || flags.events || flags.usage
          ? [{ kind: read.kind, fields, ...flags }]
          : []
      }),
      // Of a Secret it showed before, the keys it shows now and didn't.
      secrets: n.secrets.flatMap((shown) => {
        const before = w.secrets.find(
          ({ kind, path }) => kind === shown.kind && path === shown.path,
        )
        const keys = beyond(shown.keys, before?.keys ?? [])
        return keys.length > 0 ? [{ ...shown, keys }] : []
      }),
      manages: beyond(n.manages, w.manages),
      changes: n.changes.flatMap((change) => {
        const before = w.changes.find(({ kind }) => kind === change.kind)
        const actions = beyond(change.actions, before?.actions ?? [])
        return actions.length > 0 ? [{ kind: change.kind, actions }] : []
      }),
      // An action is what it is whole: its name, its kinds, how it runs, what it sends.
      actions: beyond(n.actions, w.actions, json),
    },
    added: {
      pages: beyond(next.added.pages, was.added.pages, json),
      tabs: beyond(next.added.tabs, was.added.tabs, json),
      commands: beyond(next.added.commands, was.added.commands, json),
    },
    opens: beyond(next.opens, was.opens),
    links: beyond(next.links, was.links),
    ...(next.logs !== undefined && logsLevel(next.logs) > logsLevel(was.logs)
      ? { logs: next.logs }
      : {}),
    code: next.code && !was.code,
  }
}

/** Whether it grants nothing at all. */
export function isEmpty(granted: Granted): boolean {
  const { asks: a, added, opens, links, logs, code } = granted
  return (
    !code &&
    logs === undefined &&
    [
      a.kinds,
      a.groups,
      a.creates,
      a.shows,
      a.related.kinds,
      a.links.kinds,
      a.reads,
      a.secrets,
      a.manages,
      a.changes,
      a.actions,
      added.pages,
      added.tabs,
      added.commands,
      opens,
      links,
    ].every((part) => part.length === 0) &&
    !a.related.templated &&
    !a.links.templated
  )
}

/**
 * Two versions compared: what the next one grants that the one in use doesn't (`added`), what it
 * no longer does (`gone`), and what it grants as before (`same`).
 */
export function compared(
  was: Granted,
  next: Granted,
): { added: Granted; gone: Granted; same: Granted } {
  const added = more(next, was)
  const gone = more(was, next)
  // As before: what the next grants, less what's new in it.
  const same = more(next, added)
  return { added, gone, same }
}
