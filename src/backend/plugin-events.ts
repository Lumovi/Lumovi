/**
 * An object's warning events a plugin's code reads (`events: true` on its file's read of the
 * kind): of an object its page holds, kept up to date as the object is. Checked as a read is, in
 * turn: a plugin Lumovi has in use whose code it runs, its place among the different reads a
 * while allows, its file naming the kind, the file and code its page was handed, its code not
 * turned off, the kind as the cluster serves it, and its file's `events` of it. Then the object
 * is read as the person, and its warning events by its uid, so an object made again under the
 * same name isn't handed the old one's. Of each, a few fields (`handedEvent`), the newest
 * `READ_LIMITS.events`. Every one, read or refused, is in the history, naming the plugin.
 */
import { kubectl } from '@shared/kubectl'
import { lastSeen } from '@shared/events'
import { mayCarryCode } from '@shared/plugin-loading'
import {
  eventsQuery,
  granted,
  handedEvent,
  kindAsked,
  namesAsSpelled,
  READ_LIMITS,
  READ_REFUSED,
  resolvedAs,
  type PluginEvents,
  type PluginEventsQuery,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { ALL_CODE_ON, codeOff } from '@shared/plugin-hand-over'
import { PLUGIN_NAME, whose } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import { kindFor, type ResourceDefinition } from '@shared/resources'
import { toKubeError } from './kube/errors'
import type { KubeService } from './kube/service'
import { runsCode, type HandOverTo } from './plugin-code'
import type { Place, PluginHistory } from './plugin-history'
import { REFUSED, refusalOf } from './plugin-reads'

interface PluginEventReading {
  kube: Pick<KubeService, 'resource' | 'get' | 'list'>
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page that asks is, now: what turns plugins' code off there. */
  to?: () => HandOverTo
  /** The history, and an ask's place in it: taken before anything is made of the ask. */
  audit: PluginHistory
}

/** Where it read, once the cluster resolved the kind: what the history names. */
type Where = { resource: ResourceDefinition; namespace?: string }

export function pluginEvents({ kube, known, audit, to }: PluginEventReading) {
  return async function read(query: unknown): Promise<PluginEvents> {
    // (Lumovi's own page sends these: one that isn't one names no plugin, and isn't recorded.)
    const q = eventsQuery(query)
    if (!q || !PLUGIN_NAME.test(q.plugin)) return { ok: false, refused: 'failed' }
    // (Where what comes of the ask is written: until its plugin is known, nobody's read.)
    let write: Place['record'] = (key, input) => audit.unknown(key, input)
    const refuse = (
      plugin: Readonly<KnownPlugin> | undefined,
      where: Where | undefined,
      refused: ReadRefusal,
    ): PluginEvents => {
      record(write, q, plugin, where, refused)
      return { ok: false, refused }
    }
    const plugin = (await known()).find((p) => p.name === q.plugin)
    // (A plugin without code has no page that could ask.)
    if (
      !plugin ||
      !(to ? runsCode(plugin, to()) : mayCarryCode(plugin.origin)) ||
      plugin.codeDigest === undefined
    ) {
      return refuse(undefined, undefined, 'not-in-use')
    }
    // Its place among the different reads a while allows, before anything is made of it.
    const place = audit.take(
      plugin,
      q.context,
      JSON.stringify(['events', q.kind, q.namespace, q.name]),
    )
    if ('refused' in place) return { ok: false, ...place }
    write = (key, input) => place.record(key, input)
    // Its file first, by the kind as the page wrote it, as any read's: a kind it doesn't name is
    // refused in one way, before the cluster is asked anything.
    const asked = kindAsked(q.kind)
    if (!namesAsSpelled(plugin.grant, asked)) return refuse(plugin, undefined, 'not-granted')
    if (q.digest !== plugin.digest || q.codeDigest !== plugin.codeDigest) {
      return refuse(plugin, undefined, 'changed')
    }
    if (codeOff(plugin.name, to?.().switches ?? ALL_CODE_ON)) {
      return refuse(plugin, undefined, 'code-off')
    }
    let resource: ResourceDefinition
    try {
      resource = await kube.resource(
        q.context,
        kindFor(asked.group ? `${asked.group}/v1` : 'v1', asked.kind),
      )
    } catch (error) {
      const { code } = toKubeError(error)
      return refuse(plugin, undefined, code === 'not-found' ? 'no-such-kind' : refusalOf(code))
    }
    // Its file again, by the kind as the cluster resolved it: its events, said of that kind.
    if (!granted(plugin.grant, resolvedAs(resource.group, resource.apiKind), 'events')) {
      return refuse(plugin, undefined, 'not-granted')
    }
    const namespace = resource.namespaced ? q.namespace : undefined
    const where: Where = { resource, ...(namespace === undefined ? {} : { namespace }) }
    if (resource.namespaced && namespace === undefined) {
      return refuse(plugin, where, 'needs-namespace')
    }
    // The object, as the person reads it: its uid is what its events are picked by.
    const within = namespace === undefined ? {} : { namespace }
    const object = await kube.get({
      context: q.context,
      kind: resource.kind,
      ...within,
      name: q.name,
    })
    if (!object.ok) return refuse(plugin, where, refusalOf(object.error.code))
    const uid = object.data.metadata.uid
    if (typeof uid !== 'string' || uid === '') return refuse(plugin, where, 'failed')
    const listed = await kube.list({
      context: q.context,
      kind: 'Event',
      ...within,
      fieldSelector: selectorOf(resource.apiKind, q.name, namespace, uid),
    })
    if (!listed.ok) return refuse(plugin, where, refusalOf(listed.error.code))
    // (The cluster picked them; what isn't this object's warning is left out all the same.)
    const events = listed.data.items
      .filter(
        (event) =>
          event.type === 'Warning' &&
          (event.involvedObject as { uid?: unknown } | undefined)?.uid === uid,
      )
      .sort((a, b) => Date.parse(lastSeen(b)) - Date.parse(lastSeen(a)))
      .slice(0, READ_LIMITS.events)
      .map(handedEvent)
    record(write, q, plugin, where)
    return { ok: true, events }
  }
}

/** Its warning events, as the cluster picks them: the object's kind, name, namespace and uid. */
function selectorOf(apiKind: string, name: string, namespace: string | undefined, uid: string) {
  return [
    `involvedObject.kind=${apiKind}`,
    `involvedObject.name=${name}`,
    ...(namespace === undefined ? [] : [`involvedObject.namespace=${namespace}`]),
    `involvedObject.uid=${uid}`,
    'type=Warning',
  ].join(',')
}

/**
 * A read of an object's events, made or refused, in the history: the plugin by its name, version
 * and digest (as the backend read them), and the object. Refused before the cluster resolved its
 * kind: no word the page chose, and one entry a while for the plugin. Refused after: one entry a
 * while for the kind, whatever object was named.
 */
function record(
  write: Place['record'],
  q: PluginEventsQuery,
  plugin: Readonly<KnownPlugin> | undefined,
  where: Where | undefined,
  refused?: ReadRefusal,
): void {
  const who: Record<string, string> = plugin
    ? {
        plugin: plugin.name,
        pluginVersion: plugin.version,
        pluginDigest: plugin.digest,
        ...(plugin.codeDigest === undefined ? {} : { codeDigest: plugin.codeDigest }),
      }
    : { plugin: q.plugin }
  const label = whose(plugin?.label ?? q.plugin)
  if (!where) {
    const why = refused ?? 'failed'
    write(`plugin-events:${JSON.stringify([q.context, plugin ? who : undefined, why])}`, {
      action: 'plugin.read',
      outcome: REFUSED.has(why) ? 'refused' : 'failure',
      error: READ_REFUSED[why],
      cluster: q.context,
      summary: plugin
        ? `Asked to read an object’s warning events, for the plugin ${label} code`
        : `Asked to read warning events for the plugin ${q.plugin}, which isn’t in use`,
      details: { ...who, refused: why },
    })
    return
  }
  const { resource, namespace } = where
  const read = refused === undefined
  const same = read
    ? [q.context, who, resource.kind, namespace ?? '', q.name]
    : [q.context, who, resource.kind, refused]
  write(`plugin-events:${JSON.stringify(same)}`, {
    action: 'plugin.read',
    outcome: read ? 'success' : REFUSED.has(refused) ? 'refused' : 'failure',
    ...(read ? {} : { error: READ_REFUSED[refused] }),
    cluster: q.context,
    target: {
      kind: resource.kind,
      ...(read ? { name: q.name } : {}),
      ...(read && namespace !== undefined ? { namespace } : {}),
    },
    summary: read
      ? `Read the warning events of ${resource.apiKind} ${q.name}, for the plugin ${label} code`
      : `Read the warning events of a ${resource.apiKind}, for the plugin ${label} code`,
    // The same read, as kubectl makes it: where it was made.
    ...(read
      ? {
          command: kubectl(
            q.context,
            namespace,
            'get',
            'events',
            `--field-selector=involvedObject.kind=${resource.apiKind},involvedObject.name=${q.name},type=Warning`,
          ),
        }
      : {}),
    details: { ...who, events: true, ...(read ? {} : { refused }) },
  })
}
