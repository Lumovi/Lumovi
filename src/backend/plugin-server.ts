/**
 * A plugin's code asking its tool's own server in the cluster (`spec.server`), as the backend
 * makes the ask: checked, in turn, against the organization's policy, the plugin Lumovi has in
 * use and the code its page was handed, its file's `server` and the objects' kinds, and the
 * path as its file lists it; then the Service found (by its name, or the one with its labels)
 * and its port, and the path asked for through the API server's service proxy, as the person.
 * What comes back is JSON or nothing: never the server's own words, headers or cookies. Every
 * ask, answered or refused, is in the history, naming the plugin.
 */
import type { KubeObject } from '@shared/api'
import { kubectl } from '@shared/kubectl'
import { mayCarryCode } from '@shared/plugin-loading'
import { ALL_CODE_ON, codeOff } from '@shared/plugin-hand-over'
import {
  filled,
  serverQuery,
  serverSaid,
  SERVER_REFUSED,
  shallow,
  type PluginServer,
  type PluginServerAnswer,
  type PluginServerQuery,
  type ServerObject,
  type ServerRefusal,
  type ServerWhere,
} from '@shared/plugin-server'
import { PLUGIN_NAME, whose } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import type { Recorded } from './audit/recorder'
import type { KubeService } from './kube/service'
import { runsCode, type HandOverTo } from './plugin-code'
import type { Place, PluginHistory } from './plugin-history'
import { refusalOf } from './plugin-reads'

interface PluginServerAsking {
  kube: Pick<KubeService, 'get' | 'list' | 'serviceProxy'>
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page that asks is, now: what turns plugins' code, and their servers, off there. */
  to?: () => HandOverTo
  /** The history, and an ask's place in it: taken before anything is made of the ask. */
  audit: PluginHistory
}

/** Whether an object of `kind` (as Lumovi names kinds) is one of a plugin's own. */
function ownKind(plugin: Readonly<KnownPlugin>, kind: string): boolean {
  const dot = kind.indexOf('.')
  if (dot < 0) return false
  const group = kind.slice(dot + 1)
  const own = plugin.grant.own
  return own.includes(`${group}/${kind.slice(0, dot)}`) || own.includes(`${group}/*`)
}

export function pluginServer({ kube, known, audit, to }: PluginServerAsking) {
  return async function ask(query: unknown): Promise<PluginServerAnswer> {
    // (Lumovi's own page sends these: one that isn't one names no plugin, and isn't recorded.)
    const q = serverQuery(query)
    if (!q || !PLUGIN_NAME.test(q.plugin)) {
      return { ok: false, refused: 'failed', said: serverSaid('failed') }
    }
    // (What's known of the ask so far, for the history and for Lumovi's sentence.)
    const asked: {
      plugin?: Readonly<KnownPlugin>
      where: ServerWhere
      /** The path the page wrote is one its file lists: only then is it in the history. */
      listed?: true
      path?: string
    } = {
      where: { namespace: q.in.namespace },
    }
    // (Where what comes of the ask is written: until its plugin is known, nobody's ask.)
    let write: Place['record'] = (key, input) => audit.unknown(key, input)
    const refuse = (refused: ServerRefusal, status?: number): PluginServerAnswer => {
      const { plugin, where, path, listed } = asked
      record(write, q, plugin, where, {
        refused,
        ...(listed ? { listed } : {}),
        ...(path === undefined ? {} : { path }),
        ...(status === undefined ? {} : { status }),
      })
      return { ok: false, refused, said: serverSaid(refused, { ...where, status }) }
    }
    const switches = to?.().switches ?? ALL_CODE_ON
    // The organization's policy lets no plugin talk to servers in the cluster.
    if (switches.serversOff) return refuse('servers-off')
    const found = (await known()).find((p) => p.name === q.plugin)
    // (A plugin without code has no page that could ask.)
    if (
      !found ||
      !(to ? runsCode(found, to()) : mayCarryCode(found.origin)) ||
      found.codeDigest === undefined
    ) {
      return refuse('not-in-use')
    }
    const plugin = (asked.plugin = found)
    // Its place among the different reads a while allows, before anything is made of it.
    const place = audit.take(plugin, q.context, JSON.stringify(['server', q.in, q.path, q.with]))
    if ('refused' in place) {
      return { ok: false, refused: place.refused, said: serverSaid(place.refused, place) }
    }
    write = (key, input) => place.record(key, input)
    if (q.digest !== plugin.digest || q.codeDigest !== plugin.codeDigest) return refuse('changed')
    if (codeOff(plugin.name, switches)) return refuse('code-off')
    const server = plugin.server
    // Its file names its server, in the namespace of an object of its `in` kind; it fills a
    // path only with the names of objects of its own kinds.
    if (!server || q.in.kind !== server.in || q.in.namespace === undefined) {
      return refuse('not-granted')
    }
    const namespace = q.in.namespace
    asked.where = { ...asked.where, ...serviceWhere(server), port: server.port }
    if (!Object.values(q.with ?? {}).every((object) => ownKind(plugin, object.kind))) {
      return refuse('not-granted')
    }
    // The path as its file lists it, filled with those objects' names.
    if (!server.paths.includes(q.path)) return refuse('not-listed')
    asked.listed = true
    const path = filled(q.path, namesOf(q.with ?? {}))
    if (path === undefined) return refuse('not-granted')
    asked.path = path
    // The Service: by its name, or the one there with its labels.
    const service = await serviceOf(kube, q.context, namespace, server)
    if ('refused' in service) {
      return refuse(service.refused)
    }
    asked.where = { ...asked.where, name: service.name }
    const ports = (service.object.spec?.ports ?? []) as { name?: string; port?: number }[]
    if (!ports.some(({ name, port }) => name === server.port || port === server.port)) {
      return refuse('no-port')
    }
    const sent = await kube.serviceProxy({
      context: q.context,
      namespace,
      service: service.name,
      port: server.port,
      path,
    })
    if (!sent.ok) {
      const refused = sent.error.code === 'timeout' ? 'timeout' : refusalOf(sent.error.code)
      return refuse(
        refused === 'not-allowed' || refused === 'unreachable' || refused === 'timeout'
          ? refused
          : 'failed',
      )
    }
    const answer = sent.data
    if ('tooBig' in answer) return refuse('too-big')
    if (answer.status === 403 && isForbidden(answer.body)) return refuse('not-allowed', 403)
    if (answer.status < 200 || answer.status >= 300) return refuse('error', answer.status)
    if (answer.type !== 'application/json' && !answer.type.endsWith('+json')) {
      return refuse('not-json', answer.status)
    }
    let json: unknown
    try {
      json = JSON.parse(answer.body)
    } catch {
      return refuse('not-json', answer.status)
    }
    if (!shallow(json)) return refuse('not-json', answer.status)
    record(write, q, plugin, asked.where, {
      listed: true,
      path,
      status: answer.status,
      bytes: Buffer.byteLength(answer.body),
    })
    return { ok: true, json }
  }
}

const namesOf = (given: Readonly<Record<string, ServerObject>>) =>
  Object.fromEntries(Object.entries(given).map(([fill, { name }]) => [fill, name]))

const serviceWhere = ({ service }: PluginServer): ServerWhere =>
  'name' in service ? { name: service.name } : { byLabels: true }

/** The API server's own refusal (a Kubernetes Status), not the server's answer. */
function isForbidden(body: string): boolean {
  try {
    const said = JSON.parse(body) as { kind?: unknown; reason?: unknown }
    return said.kind === 'Status' && said.reason === 'Forbidden'
  } catch {
    return false
  }
}

/** The plugin's Service in `namespace`: by its name, or the one with its labels; or why not. */
async function serviceOf(
  kube: Pick<KubeService, 'get' | 'list'>,
  context: string,
  namespace: string,
  { service }: PluginServer,
): Promise<{ name: string; object: KubeObject } | { refused: ServerRefusal; name?: string }> {
  if ('name' in service) {
    const got = await kube.get({ context, kind: 'Service', namespace, name: service.name })
    if (got.ok) return { name: service.name, object: got.data }
    const refused = refusalOf(got.error.code)
    return { refused: refused === 'not-found' ? 'no-service' : asServer(refused) }
  }
  const labelSelector = Object.entries(service.labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
  const listed = await kube.list({ context, kind: 'Service', namespace, labelSelector })
  if (!listed.ok) return { refused: asServer(refusalOf(listed.error.code)) }
  const [one, ...more] = listed.data.items
  if (!one) return { refused: 'no-service' }
  if (more.length > 0) return { refused: 'several' }
  return { name: one.metadata.name, object: one }
}

const asServer = (refused: string): ServerRefusal =>
  refused === 'not-allowed' || refused === 'unreachable' ? refused : 'failed'

function record(
  write: Place['record'],
  q: PluginServerQuery,
  plugin: Readonly<KnownPlugin> | undefined,
  where: ServerWhere,
  {
    refused,
    listed,
    path,
    status,
    bytes,
  }: {
    refused?: ServerRefusal
    /** The path as the page wrote it is one its file lists. */
    listed?: true
    path?: string
    status?: number
    bytes?: number
  },
): void {
  const who: Record<string, string> = plugin
    ? {
        plugin: plugin.name,
        pluginVersion: plugin.version,
        pluginDigest: plugin.digest,
        ...(plugin.codeDigest === undefined ? {} : { codeDigest: plugin.codeDigest }),
      }
    : { plugin: q.plugin }
  const entry: Recorded = {
    action: 'plugin.server',
    outcome:
      refused === undefined ? 'success' : SERVER_REFUSED.has(refused) ? 'refused' : 'failure',
    ...(refused === undefined ? {} : { error: serverSaid(refused, { ...where, status }) }),
    cluster: q.context,
    target: {
      kind: 'Service',
      ...(where.name === undefined ? {} : { name: where.name }),
      ...(q.in.namespace === undefined ? {} : { namespace: q.in.namespace }),
    },
    // (The path as its file lists it, not as filled: its filled path is in its details. And
    // only a path its file lists: until the page's is known to be one, it's the page's own text,
    // up to 200 characters of anything, and none of that is written into the history.)
    summary: `Asked ${where.name === undefined ? 'a Service' : `the Service ${where.name}`} in ${q.in.namespace ?? 'no namespace'} for ${listed ? q.path : 'a path its file doesn’t list'}, for the plugin ${whose(plugin?.label ?? q.plugin)} page`,
    // Where the Service and the path are known: the same ask, as kubectl makes it.
    ...(where.name !== undefined && where.port !== undefined && path !== undefined
      ? {
          command: kubectl(
            q.context,
            undefined,
            'get',
            '--raw',
            `/api/v1/namespaces/${q.in.namespace}/services/${where.name}:${where.port}/proxy${path}`,
          ),
        }
      : {}),
    details: {
      ...who,
      ...(path === undefined ? {} : { path }),
      ...(listed ? { listed: q.path } : {}),
      ...(where.port === undefined ? {} : { port: String(where.port) }),
      ...(status === undefined ? {} : { status }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(refused === undefined ? {} : { refused }),
    },
  }
  // A plugin Lumovi has in use: an ask that was made is one entry a while for the same Service
  // and path, as a page asks again to keep what it shows up to date. One that was refused or
  // failed: one entry a while for that plugin and that refusal, however often it asks and
  // whatever it asks for. One Lumovi hasn't in use (by any name a page cares to send): one a
  // while, whatever it was called. So neither asks nor names can fill the history.
  const same =
    plugin && refused === undefined
      ? [q.context, plugin.name, q.in.namespace, where.name, path]
      : [q.context, ...(plugin ? [plugin.name] : []), refused]
  write(`plugin-server:${JSON.stringify(same)}`, entry)
}
