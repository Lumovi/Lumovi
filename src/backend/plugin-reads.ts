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
import type {
  KubeError,
  KubeErrorCode,
  KubeList,
  KubeObject,
  Result,
  SecretValuesQuery,
} from '@shared/api'
import { mayCarryCode } from '@shared/plugin-loading'
import {
  granted,
  handedWhole,
  kindAsked,
  picked,
  READ_REFUSED,
  readQuery,
  resolvedAs,
  secretsNamed,
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
    // The Secrets an object of its own kind names, where its file says where: of its own kinds
    // only, and from the object as it was read, before anything of it was picked.
    const id = `${kind.group}/${kind.kind}`
    const declared = handed.whole
      ? (plugin.grant.secrets ?? []).filter((item) => item.kind === id)
      : []
    const objects = items.map((item): HandedObject => ({
      ...(item.metadata.namespace === undefined ? {} : { namespace: item.metadata.namespace }),
      name: item.metadata.name,
      object: handed.whole
        ? handedWhole(item)
        : picked(item, kind, handed.granted, plugin.grant.groups, held),
      ...(declared.length === 0
        ? {}
        : {
            secrets: declared.map(({ path, steps, keys }) => ({
              path,
              keys: [...keys],
              names: secretsNamed(item, steps),
            })),
          }),
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

/** What's said when a plugin's page asks for keys of a Secret its file doesn't say it shows. */
export const SECRET_KEYS_UNDECLARED = 'This plugin’s file doesn’t say its pages show these keys.'

/** A namespace's or an object's name, as Kubernetes has them. */
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

/**
 * Of a read of a Secret's keys (`IPC.secretValues`): whose page asked, where a plugin's did
 * (`forPlugin`, which only Lumovi's own page code fills, from what it knows of the page), as
 * the backend knows that plugin; and the read as it's made, without it. A name no plugin could
 * have is no read at all; a plugin not in use whose code Lumovi runs, or a key its file doesn't
 * say its pages show, is refused before anything is read (the second in the history, with the
 * plugin, once the Secret's own name is one a Secret could have).
 *
 * The keys are held to every key any of the plugin's items declares, not to the item that named
 * this Secret: the press carries the Secret, not the object that named it. What holds a press to
 * its item's keys is the token and the part (the Secret's token carries that item's keys, and a
 * part can only narrow them); this is a second net, a little wider than the file.
 */
export async function secretsAskedFor(
  query: unknown,
  known: () => Promise<readonly Readonly<KnownPlugin>[]>,
): Promise<
  | { query: unknown; plugin?: Readonly<KnownPlugin> }
  | { refused: KubeError; recorded?: { query: SecretValuesQuery; plugin: Readonly<KnownPlugin> } }
> {
  if (typeof query !== 'object' || query === null || !Object.hasOwn(query, 'forPlugin')) {
    return { query }
  }
  const { forPlugin: name, ...rest } = query as Record<string, unknown>
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) {
    return { refused: { code: 'invalid', message: 'Expected a plugin’s name' } }
  }
  const plugin = (await known()).find((p) => p.name === name)
  if (!plugin || !mayCarryCode(plugin.origin)) {
    return { refused: { code: 'not-allowed', message: READ_REFUSED['not-in-use'] } }
  }
  const { keys, namespace, name: secret } = rest
  // (What isn't a list of keys, the read itself refuses as it would any page's.)
  if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
    const declared = new Set((plugin.grant.secrets ?? []).flatMap((item) => item.keys))
    if (!keys.every((key) => declared.has(key))) {
      const refused: KubeError = { code: 'not-allowed', message: SECRET_KEYS_UNDECLARED }
      const named =
        typeof namespace === 'string' &&
        NAME.test(namespace) &&
        typeof secret === 'string' &&
        NAME.test(secret)
      return named
        ? { refused, recorded: { query: rest as unknown as SecretValuesQuery, plugin } }
        : { refused }
    }
  }
  return { query: rest, plugin }
}
