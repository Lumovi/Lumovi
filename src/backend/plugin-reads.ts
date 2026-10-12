/**
 * A plugin's reads, made where its page can't change them: in the main process, or on the
 * server. Lumovi's page sends what `readAsk` took from a plugin's ask, and the plugin's name.
 * Here the plugin is found among those Lumovi has in use, the kind is looked up in what the
 * cluster serves, the plugin's grant is asked of it, the read is made as the person (their
 * cluster's rules and Lumovi's apply), and of what's read the plugin is handed what its file
 * says and nothing else: the page never holds more than the plugin may have.
 *
 * What isn't made comes back as a code; what the cluster said never does. Each read, made or
 * not, is in the audit history with the plugin's name, version and digest: once a while for the
 * same read, as a page keeps its lists up to date by reading them again.
 */
import type { KubeErrorCode, KubeList, KubeObject, Result } from '@shared/api'
import { mayCarryCode } from '@shared/plugin-loading'
import {
  granted,
  handedWhole,
  kindAsked,
  picked,
  READ_REFUSED,
  readQuery,
  resolvedAs,
  type HandedObject,
  type PluginRead,
  type PluginReadQuery,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { PLUGIN_NAME } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import { kindFor, pluralLabel, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import type { Recorder } from './audit/recorder'
import { toKubeError } from './kube/errors'
import type { KubeService } from './kube/service'

export interface PluginReading {
  kube: Pick<KubeService, 'resource' | 'list' | 'get'>
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  audit: Recorder
}

/** What a failure the cluster's, or Lumovi's, is to a plugin: a code and nothing it said. */
function refusalOf(code: KubeErrorCode): ReadRefusal {
  switch (code) {
    case 'forbidden':
    case 'unauthorized':
    case 'not-allowed':
      return 'not-allowed'
    case 'not-found':
      return 'not-found'
    case 'unreachable':
    case 'timeout':
      return 'unreachable'
    default:
      return 'failed'
  }
}

/** Reads for plugins' pages: one call a read, as `IPC.pluginRead` takes it. */
export function pluginReads({ kube, known, audit }: PluginReading) {
  return async function read(query: unknown): Promise<PluginRead> {
    // (Lumovi's own page sends these: one that isn't one, or names no plugin a file could name,
    // is no plugin's read, and isn't recorded: nothing a page wrote reaches the history but a
    // plugin's name.)
    const q = readQuery(query)
    if (!q || !PLUGIN_NAME.test(q.plugin)) return { ok: false, refused: 'failed' }
    const refuse = (
      where: Parameters<typeof record>[2],
      plugin: Readonly<KnownPlugin> | undefined,
      refused: ReadRefusal,
    ): PluginRead => {
      record(audit, q, where, plugin, refused)
      return { ok: false, refused }
    }
    const asked = kindAsked(q.kind)
    const named: ResourceKind = kindFor(asked.group ? `${asked.group}/v1` : 'v1', asked.kind)
    const plugin = (await known()).find((p) => p.name === q.plugin)
    // Only a plugin whose code Lumovi may run has code that reads.
    if (!plugin || !mayCarryCode(plugin.origin)) {
      return refuse({ kind: named }, undefined, 'not-in-use')
    }
    let resource: ResourceDefinition
    try {
      resource = await kube.resource(q.context, named)
    } catch (error) {
      const { code } = toKubeError(error)
      const refused = code === 'not-found' ? 'no-such-kind' : refusalOf(code)
      return refuse({ kind: named }, plugin, refused)
    }
    // Where it is, by what the cluster serves: a kind that's in no namespace is read in none,
    // whatever was asked; one object of a kind that is needs its namespace.
    const namespace = resource.namespaced ? q.namespace : undefined
    const where = { kind: resource.kind, resource, namespace }
    if (resource.namespaced && q.name !== undefined && namespace === undefined) {
      return refuse(where, plugin, 'needs-namespace')
    }
    const kind = resolvedAs(resource.group, resource.apiKind)
    const handed = granted(plugin.grant, kind, 'objects')
    if (!handed) return refuse(where, plugin, 'not-granted')
    const within = namespace === undefined ? {} : { namespace }
    const result: Result<KubeList | KubeObject> =
      q.name === undefined
        ? await kube.list({ context: q.context, kind: resource.kind, ...within })
        : await kube.get({ context: q.context, kind: resource.kind, ...within, name: q.name })
    if (!result.ok) return refuse(where, plugin, refusalOf(result.error.code))
    const list = q.name === undefined ? (result.data as KubeList) : undefined
    // More than Lumovi lists at once: never the first of them, as if they were all.
    if (list?.truncated) return refuse(where, plugin, 'too-many')
    const items = list ? list.items : [result.data as KubeObject]
    const held = { fields: 0 }
    const objects = items.map((item): HandedObject => ({
      ...(item.metadata.namespace === undefined ? {} : { namespace: item.metadata.namespace }),
      name: item.metadata.name,
      object: handed.whole
        ? handedWhole(item)
        : picked(item, kind, handed.granted, plugin.grant.groups, held),
    }))
    record(audit, q, where, plugin)
    return { ok: true, answer: { kind: resource.kind, objects, held: held.fields } }
  }
}

/**
 * A read, made or refused, in the audit history: the plugin by its name, version and digest
 * (as the backend read them, never as the page said), what it read, and how it came out. The
 * same read again within a while is one entry.
 */
function record(
  audit: Recorder,
  q: PluginReadQuery,
  where: { kind: ResourceKind; resource?: ResourceDefinition; namespace?: string },
  plugin: Readonly<KnownPlugin> | undefined,
  refused?: ReadRefusal,
): void {
  const { resource } = where
  const what =
    q.name !== undefined
      ? `${resource?.apiKind ?? where.kind} ${q.name}`
      : resource
        ? pluralLabel(resource.apiKind, resource.plural)
        : where.kind
  const namespace = resource ? where.namespace : q.namespace
  const who: Record<string, string> = plugin
    ? { plugin: plugin.name, pluginVersion: plugin.version, pluginDigest: plugin.digest }
    : { plugin: q.plugin }
  // A plugin Lumovi has in use: each of its reads apart. One it hasn't (by any name a page cares
  // to send): one entry a while, whatever it was called, so new names can't fill the history.
  const same = plugin
    ? [q.context, who, where.kind, namespace ?? '', q.name ?? '', refused ?? '']
    : [q.context, refused]
  audit.read(`plugin-read:${JSON.stringify(same)}`, {
    action: 'plugin.read',
    outcome: refused === undefined ? 'success' : REFUSED.has(refused) ? 'refused' : 'failure',
    ...(refused === undefined ? {} : { error: READ_REFUSED[refused] }),
    cluster: q.context,
    target: {
      kind: where.kind,
      ...(q.name === undefined ? {} : { name: q.name }),
      ...(namespace === undefined ? {} : { namespace }),
    },
    summary: `Read ${what} for the plugin ${q.plugin}`,
    details: { ...who, ...(refused === undefined ? {} : { refused }) },
  })
}

/** What's not allowed, rather than what failed: by the plugin's file, the cluster or Lumovi. */
const REFUSED: ReadonlySet<ReadRefusal> = new Set<ReadRefusal>([
  'not-granted',
  'not-in-use',
  'not-allowed',
  'too-many',
])
