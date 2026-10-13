/**
 * A plugin's reads, made where its page can't change them: in the main process, or on the
 * server. Lumovi's page sends what `readAsk` took from a plugin's ask, and the plugin's name.
 * Here the plugin is found among those Lumovi has in use, the kind is looked up in what the
 * cluster serves, the plugin's grant is asked of it, the read is made as the person (their
 * cluster's rules and Lumovi's apply), and of what's read the plugin is handed what its file
 * says and nothing else: the page never holds more than the plugin may have. Where its file
 * says it reads a kind's usage (nodes', pods'), a read can ask for each object's live usage too,
 * read with the objects as Lumovi's own pages read it.
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
  UsageSample,
} from '@shared/api'
import { mayCarryCode } from '@shared/plugin-loading'
import {
  granted,
  handedWhole,
  kindAsked,
  picked,
  pickedRefusal,
  READ_REFUSED,
  readQuery,
  resolvedAs,
  secretsNamed,
  selectors,
  type HandedObject,
  type NoUsage,
  type PluginRead,
  type PluginReadQuery,
  type ReadRefusal,
} from '@shared/plugin-reads'
import { PLUGIN_NAME } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import type { SecretNamedBy } from '@shared/kit/declare'
import {
  isResourceKind,
  kindFor,
  pluralLabel,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { isRefusal } from './audit/describe'
import type { Recorder } from './audit/recorder'
import { toKubeError } from './kube/errors'
import type { KubeService } from './kube/service'
import { ALL_CODE_ON, codeOff } from '@shared/plugin-hand-over'
import type { HandOverTo } from './plugin-code'

export interface PluginReading {
  kube: Pick<KubeService, 'resource' | 'list' | 'get' | 'metrics'>
  /** The plugins in use, as the backend reads them now. */
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page that asks is, now: what turns plugins' code off there. */
  to?: () => HandOverTo
  audit: Recorder
}

/** What a failure the cluster's, or Lumovi's, is to a plugin: a code and nothing it said. */
export function refusalOf(code: KubeErrorCode): ReadRefusal {
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
export function pluginReads({ kube, known, audit, to }: PluginReading) {
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
    // And only the code, and the file, its page was handed: never a grant read since, for code
    // that came before it (or a plugin that has no code at all).
    if (q.digest !== plugin.digest || q.codeDigest !== plugin.codeDigest) {
      return refuse({ kind: named }, plugin, 'changed')
    }
    // And never for code that's turned off (by the person, the server or the organization), as
    // nothing is handed it or proposed for it: whatever a page of it that's still open asks.
    if (codeOff(plugin.name, to?.().switches ?? ALL_CODE_ON)) {
      return refuse({ kind: named }, plugin, 'code-off')
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
    // Its usage too, where it's asked for: its file must say it reads it, of a kind the cluster
    // measures.
    const measures = q.usage ? MEASURED[`${kind.group}/${kind.kind}`] : undefined
    if (q.usage && (!measures || !granted(plugin.grant, kind, 'usage'))) {
      return refuse(where, plugin, 'not-granted')
    }
    // A list picked by fields and labels: by those the cluster picks its kind by, and only by
    // what its file says it reads of its objects.
    const unpickable = pickedRefusal(kind, handed, q.fields, q.labels)
    if (unpickable) return refuse(where, plugin, unpickable)
    const within = namespace === undefined ? {} : { namespace }
    const result: Result<KubeList | KubeObject> =
      q.name === undefined
        ? await kube.list({ context: q.context, kind: resource.kind, ...within, ...selectors(q) })
        : await kube.get({ context: q.context, kind: resource.kind, ...within, name: q.name })
    if (!result.ok) return refuse(where, plugin, refusalOf(result.error.code))
    const list = q.name === undefined ? (result.data as KubeList) : undefined
    // More than Lumovi lists at once: the first of them, as Lumovi's own lists have them, said
    // to be the first (and of how many, where the cluster says). Never as if they were all:
    // Lumovi's own page says so, whatever the plugin does with it.
    const cut =
      list?.truncated === true
        ? { at: list.items.length, ...(list.total === undefined ? {} : { of: list.total }) }
        : undefined
    const items = list ? list.items : [result.data as KubeObject]
    // Usage as Lumovi's own pages read it, as the person: one read for all of them.
    // Where none is, the objects are handed all the same, said to have none and why: nothing
    // measures it here, or the person may read the objects and not their usage (as Lumovi's own
    // pages show them without it).
    let usage: Map<string, UsageSample> | undefined
    let noUsage: NoUsage | undefined
    if (measures) {
      const measured = await kube.metrics({ context: q.context, target: measures, ...within })
      if (!measured.ok && refusalOf(measured.error.code) !== 'not-allowed') {
        return refuse(where, plugin, refusalOf(measured.error.code))
      }
      if (!measured.ok) noUsage = 'not-allowed'
      else if (!measured.data.available) noUsage = 'unmeasured'
      else usage = new Map(measured.data.items.map((sample) => [which(sample), sample]))
    }
    const held = { fields: 0 }
    // The Secrets an object of its own kind names, where its file says where: of its own kinds
    // only, and from the object as it was read, before anything of it was picked.
    const id = `${kind.group}/${kind.kind}`
    const declared = handed.whole
      ? (plugin.grant.secrets ?? []).filter((item) => item.kind === id)
      : []
    const objects = items.map((item): HandedObject => {
      const sample = usage?.get(which(item.metadata))
      return {
        ...(item.metadata.namespace === undefined ? {} : { namespace: item.metadata.namespace }),
        name: item.metadata.name,
        object: handed.whole
          ? handedWhole(item)
          : picked(item, kind, handed.granted, plugin.grant.groups, held),
        ...(sample ? { usage: { cpu: sample.cpu, memory: sample.memory } } : {}),
        ...(declared.length === 0
          ? {}
          : {
              secrets: declared.map(({ path, steps, keys }) => ({
                path,
                keys: [...keys],
                names: secretsNamed(item, steps),
              })),
            }),
      }
    })
    record(audit, q, where, plugin)
    return {
      ok: true,
      answer: {
        kind: resource.kind,
        objects,
        held: held.fields,
        ...(noUsage && { noUsage }),
        ...(cut && { cut }),
      },
    }
  }
}

/** The kinds the cluster measures the usage of, as Lumovi reads it: the metrics API's names. */
const MEASURED: Readonly<Record<string, 'nodes' | 'pods'>> = { '/Node': 'nodes', '/Pod': 'pods' }

/** An object, or its usage, by where it is and its name. */
const which = ({ namespace, name }: { namespace?: string; name: string }) =>
  `${namespace ?? ''}\u0000${name}`

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
  // How a list was picked, as the cluster was asked: in the history as it was asked for.
  const { fieldSelector, labelSelector } = plugin ? selectors(q) : {}
  // A plugin Lumovi has in use: each of its reads apart. One it hasn't (by any name a page cares
  // to send): one entry a while, whatever it was called, so new names can't fill the history.
  const same = plugin
    ? [
        q.context,
        who,
        where.kind,
        namespace ?? '',
        q.name ?? '',
        q.usage ?? false,
        fieldSelector ?? '',
        labelSelector ?? '',
        refused ?? '',
      ]
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
    details: {
      ...who,
      ...(q.usage ? { usage: true } : {}),
      ...(fieldSelector === undefined ? {} : { fieldSelector }),
      ...(labelSelector === undefined ? {} : { labelSelector }),
      ...(refused === undefined ? {} : { refused }),
    },
  })
}

/** What's not allowed, rather than what failed: by the plugin's file, the cluster or Lumovi. */
export const REFUSED: ReadonlySet<ReadRefusal> = new Set<ReadRefusal>([
  'changed',
  'code-off',
  'logs-off',
  'not-granted',
  'not-in-use',
  'not-allowed',
  'too-many',
  'not-pickable',
])

/** What's said when a plugin's page asks for keys of a Secret its file doesn't say it shows. */
export const SECRET_KEYS_UNDECLARED = 'This plugin’s file doesn’t say its pages show these keys.'
/** What's said when the object that named a Secret on a plugin's page doesn't name it. */
export const SECRET_NOT_NAMED =
  'The object this plugin’s page showed it for doesn’t name this Secret.'

/** A namespace's or an object's name, as Kubernetes has them. */
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

/** What named a Secret, as a page says it: Lumovi's name for a kind, an object's name, a path. */
function namedByOf(value: unknown): SecretNamedBy | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { kind, name, path, ...more } = value as Record<string, unknown>
  return Object.keys(more).length === 0 &&
    isResourceKind(kind) &&
    typeof name === 'string' &&
    NAME.test(name) &&
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 253
    ? { kind, name, path }
    : undefined
}

/**
 * Of a read of a Secret's keys (`IPC.secretValues`): whose page asked, where a plugin's did
 * (`forPlugin`, which only Lumovi's own page code fills), as the backend knows that plugin; and
 * the read as it's made, without what was said of the plugin. A name no plugin could have is no
 * read at all; nor is a plugin not in use whose code Lumovi runs. Otherwise the read is held,
 * before anything of the Secret is read, to the one item of the plugin's file that named it
 * (`namedBy`: never taken on the page's word, since on a server the page is the browser's): the
 * item is one its file declares, the keys are that item's, and the object, read as the person,
 * names this Secret by that item's path. A read that fails that is refused, and in the history
 * with the plugin.
 */
/** What a person is told where the organization's policy lets no plugin show what's in a Secret. */
export const SECRETS_OFF = 'Your organization’s policy doesn’t let plugins show what’s in Secrets.'

export async function secretsAskedFor(
  query: unknown,
  known: () => Promise<readonly Readonly<KnownPlugin>[]>,
  kube: Pick<KubeService, 'resource' | 'get'>,
  /** The organization's policy lets no plugin's page show a Secret's keys. */
  secretsOff = false,
): Promise<
  | { query: unknown; plugin?: Readonly<KnownPlugin> }
  | { refused: KubeError; recorded?: { query: SecretValuesQuery; plugin: Readonly<KnownPlugin> } }
> {
  if (typeof query !== 'object' || query === null || !Object.hasOwn(query, 'forPlugin')) {
    return { query }
  }
  const {
    forPlugin: name,
    namedBy: said,
    digest,
    codeDigest,
    ...rest
  } = query as Record<string, unknown>
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) {
    return { refused: { code: 'invalid', message: 'Expected a plugin’s name' } }
  }
  const plugin = (await known()).find((p) => p.name === name)
  if (!plugin || !mayCarryCode(plugin.origin)) {
    return { refused: { code: 'not-allowed', message: READ_REFUSED['not-in-use'] } }
  }
  // (None shows a Secret's keys, by the organization's policy: nothing of it is read.)
  if (secretsOff) return { refused: { code: 'not-allowed', message: SECRETS_OFF } }
  const { context, namespace, name: secret, keys } = rest
  const namedBy = namedByOf(said)
  if (
    !namedBy ||
    typeof context !== 'string' ||
    typeof namespace !== 'string' ||
    !NAME.test(namespace) ||
    typeof secret !== 'string' ||
    !NAME.test(secret) ||
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === 'string')
  ) {
    return {
      refused: { code: 'invalid', message: 'Expected a Secret, its keys and what named it' },
    }
  }
  const asked = rest as unknown as SecretValuesQuery
  const refused = (message: string) => ({
    refused: { code: 'not-allowed' as const, message },
    recorded: { query: asked, plugin },
  })
  // Only for the file and the code its page was handed, as any read of a plugin's: a Secret
  // shown is part of the grant too.
  if (digest !== plugin.digest || codeDigest !== plugin.codeDigest || !plugin.codeDigest) {
    return {
      refused: { code: 'conflict' as const, message: READ_REFUSED.changed },
      recorded: { query: asked, plugin },
    }
  }
  // The item: by the kind as the cluster serves it, and the path as the file wrote it.
  let resource: ResourceDefinition
  try {
    resource = await kube.resource(context, namedBy.kind)
  } catch {
    return refused(SECRET_KEYS_UNDECLARED)
  }
  const item = (plugin.grant.secrets ?? []).find(
    (each) => each.kind === `${resource.group}/${resource.apiKind}` && each.path === namedBy.path,
  )
  if (!item || !resource.namespaced || !keys.every((key) => item.keys.includes(key))) {
    return refused(SECRET_KEYS_UNDECLARED)
  }
  // The object, as the person reads it, in the Secret's own namespace: it names this Secret
  // there, or nothing of the Secret is read.
  const owner = await kube.get({
    context,
    kind: resource.kind,
    namespace,
    name: namedBy.name,
  })
  if (!owner.ok) {
    return isRefusal(owner.error.code) || owner.error.code === 'not-found'
      ? refused(SECRET_NOT_NAMED)
      : { refused: { code: owner.error.code, message: READ_REFUSED[refusalOf(owner.error.code)] } }
  }
  if (!secretsNamed(owner.data, item.steps).includes(secret)) return refused(SECRET_NOT_NAMED)
  return { query: rest, plugin }
}
