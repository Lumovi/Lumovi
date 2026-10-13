/**
 * Changes through the door, where the page can't change them: in the main process, or on the
 * server. Lumovi's dialog asks here whether a page's proposal may be asked at all, what the
 * cluster would make of it, to make it, or to record that the person cancelled it. Each is made
 * as the person, through the same change every page of Lumovi's makes (the cluster's RBAC,
 * Lumovi's access rules, read-only mode), and recorded with the plugin's name, version and
 * digests: the backend's own reading of them, never anything a page sent.
 *
 * What a plugin may propose is its file's to say (`spec.changes`), of its own kinds only; and on
 * a server only a browser Lumovi hands a plugin's code to proposes anything (`mayHandOver`).
 */
import { stringify } from 'yaml'
import type { Change, ChangeRequest, KubeError, KubeObject, Result } from '@shared/api'
import { kubectl, objectArg } from '@shared/kubectl'
import {
  CHANGE_LIMITS,
  FIELD_KEY,
  mayPropose,
  REPLICAS_MOST,
  sentProblem,
  type ChangeAction,
  type ChangeRefusal,
  type PluginChangeAnswer,
  type PluginChangeRequest,
} from '@shared/plugin-changes'
import { PLUGIN_NAME } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import { kindFor, type ResourceDefinition } from '@shared/resources'
import { fieldsOf } from './audit/describe'
import type { Recorder } from './audit/recorder'
import type { KubeService } from './kube/service'
import { toKubeError } from './kube/errors'
import { mayHandOver, type HandOverTo } from './plugin-code'

export interface PluginChanging {
  kube: Pick<KubeService, 'resource' | 'get' | 'change' | 'isReadOnly'>
  known: () => Promise<readonly Readonly<KnownPlugin>[]>
  to: () => HandOverTo
  audit: Recorder
}

/** The field manager a server-side apply's try is made as: only to learn whose fields it'd take. */
const FIELD_MANAGER = 'lumovi'

/** What each action is called, as the audit and the command say it. */
const DONE: Record<ChangeAction, string> = {
  patch: 'Changed',
  create: 'Created',
  delete: 'Deleted',
  scale: 'Scaled',
}

/** A refusal from the cluster, as the dialog is told it. */
function refusalOf(error: KubeError): PluginChangeAnswer & { ok: false } {
  const refused: ChangeRefusal =
    error.code === 'conflict'
      ? 'conflict'
      : error.code === 'read-only'
        ? 'read-only'
        : error.code === 'not-allowed' || error.code === 'forbidden'
          ? 'not-allowed'
          : error.code === 'not-found'
            ? 'not-found'
            : error.code === 'invalid'
              ? 'invalid'
              : 'failed'
  const field = error.causes?.find((cause) => cause.field)?.field
  return { ok: false, refused, said: error.message, ...(field && { field }) }
}

/** What Lumovi's own page sends, read as what it should be; anything else is no request. */
function requestOf(said: unknown): PluginChangeRequest | undefined {
  if (typeof said !== 'object' || said === null || Array.isArray(said)) return undefined
  const r = said as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string'
  if (
    !['check', 'try', 'make', 'cancelled'].includes(r.step as string) ||
    !text(r.plugin) ||
    !PLUGIN_NAME.test(r.plugin as string) ||
    !text(r.digest) ||
    !text(r.codeDigest) ||
    !text(r.context) ||
    !['patch', 'create', 'delete', 'scale'].includes(r.action as string)
  ) {
    return undefined
  }
  const target = r.target as Record<string, unknown> | undefined
  if (r.action === 'create') {
    if (!text(r.kind)) return undefined
  } else if (
    typeof target !== 'object' ||
    target === null ||
    !text(target.kind) ||
    !text(target.name)
  ) {
    return undefined
  }
  return said as PluginChangeRequest
}

/** A merge patch's object, with nothing in it that would be null in an apply's. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, withoutNulls(item)]),
  )
}

/** Lumovi's page's calls of a plugin's proposals: one function, by its request's step. */
export function pluginChanges({ kube, known, to, audit }: PluginChanging) {
  return async function change(said: unknown): Promise<PluginChangeAnswer> {
    const r = requestOf(said)
    if (!r) return { ok: false, refused: 'failed' }
    // What's to be sent, asked again here, by the door's own rule: never what no plugin may
    // write, whatever filled it in; and of the fields the person changed, only their keys.
    const sends =
      (r.step === 'try' || r.step === 'make') && (r.action === 'patch' || r.action === 'create')
    if (r.body !== undefined || sends) {
      const wrong = sentProblem(r.body, r.action)
      if (wrong) return { ok: false, refused: 'not-granted', said: wrong }
    }
    if (
      r.fields !== undefined &&
      (!Array.isArray(r.fields) ||
        r.fields.length > CHANGE_LIMITS.fields ||
        !r.fields.every((key) => typeof key === 'string' && FIELD_KEY.test(key)))
    ) {
      return { ok: false, refused: 'failed' }
    }
    const plugin = (await known()).find((p) => p.name === r.plugin)
    const may = mayHandOver(plugin, to())
    if (!plugin || may === 'not-in-use' || may === 'no-code')
      return { ok: false, refused: 'not-in-use' }
    if (may !== true) return { ok: false, refused: 'not-held' }
    if (r.digest !== plugin.digest || r.codeDigest !== plugin.codeDigest) {
      return { ok: false, refused: 'changed' }
    }
    // The kind as the cluster serves it: a create's as the page wrote it, the rest as its token stood for.
    let resource: ResourceDefinition
    try {
      const asked = r.action === 'create' ? r.kind! : undefined
      const kind = asked
        ? kindFor(
            asked.startsWith('/') ? 'v1' : `${asked.slice(0, asked.indexOf('/'))}/v1`,
            asked.slice(asked.indexOf('/') + 1),
          )
        : r.target!.kind
      resource = await kube.resource(r.context, kind)
    } catch (error) {
      return refusalOf(toKubeError(error))
    }
    if (!mayPropose(`${resource.group}/${resource.apiKind}`, r.action, plugin.changes ?? [])) {
      return { ok: false, refused: 'not-granted' }
    }
    if (r.action === 'scale' && !(resource.subresources ?? []).includes('scale')) {
      return { ok: false, refused: 'no-scale' }
    }
    const namespace = resource.namespaced
      ? r.action === 'create'
        ? r.namespace
        : r.target!.namespace
      : undefined
    // A create in a namespace is made in the one the page named, or the one in view: never a default.
    if (resource.namespaced && namespace === undefined)
      return { ok: false, refused: 'no-namespace' }
    const name = r.action === 'create' ? undefined : r.target!.name
    const where = { context: r.context, kind: resource.kind, ...(namespace && { namespace }) }
    const target = {
      kind: resource.kind,
      name: name ?? (r.body as KubeObject | undefined)?.metadata?.name ?? '',
      ...(namespace && { namespace }),
    }
    const command = commandOf(r, resource, namespace, name)

    /** A scale's count, where the request has one. */
    const scaledTo = r.action === 'scale' && typeof r.replicas === 'number' ? r.replicas : undefined
    /** The audit's entry: Lumovi's words, never the plugin's verb, and no value the person set. */
    const recorded = (
      outcome: 'success' | 'failure' | 'refused' | 'cancelled',
      why?: string,
      error?: string,
      made?: KubeObject | null,
    ) => {
      const what = `the ${resource.apiKind} ${namespace ? `${namespace}/` : ''}${made?.metadata?.name ?? target.name}`
      const by = `the plugin ${plugin.label ?? plugin.name} ${plugin.version}`
      audit.record({
        action: 'plugin.change',
        outcome,
        cluster: r.context,
        target: { ...target, ...(made?.metadata?.name && { name: made.metadata.name }) },
        summary:
          outcome === 'success'
            ? `${DONE[r.action]} ${what}, as ${by} proposed`
            : `Didn’t ${r.action === 'patch' ? 'change' : r.action} ${what} that ${by} proposed: ${why}`,
        // (A patch's or a create's command would carry what the person set: its paths instead. A
        // scale's count is a number, said as Lumovi's own scale says it: its command and count,
        // where it has one (a cancel has none, and says none).)
        ...(r.action === 'delete' || scaledTo !== undefined ? { command } : {}),
        details: {
          plugin: plugin.name,
          pluginVersion: plugin.version,
          pluginDigest: plugin.digest,
          codeDigest: plugin.codeDigest!,
          action: r.action,
          fields: r.fields ?? [],
          ...((r.action === 'patch' || r.action === 'create') && { paths: fieldsOf(r.body) }),
          ...(scaledTo !== undefined && { replicas: scaledTo }),
        },
        ...(error && { error }),
      })
    }

    if (r.step === 'cancelled') {
      recorded('cancelled', 'cancelled')
      return { ok: true }
    }
    // Asked before anything's shown, as Lumovi's own actions ask: a cluster that's read-only in
    // Lumovi, or where the person may not make this change (their access, the cluster's RBAC for
    // this very action), opens no dialog. The action itself is tried, changing nothing: a delete
    // is a delete, a scale an empty patch of its scale, a patch an empty patch. (A create has no
    // object to ask of yet: its first try asks.)
    if (r.step === 'check') {
      if (kube.isReadOnly(r.context)) return { ok: false, refused: 'read-only' }
      if (r.action === 'create') return { ok: true }
      const change: Change =
        r.action === 'delete'
          ? { action: 'delete', propagation: 'Background' }
          : {
              action: 'patch',
              patchType: 'merge',
              ...(r.action === 'scale' && { subresource: 'scale' as const }),
              patch: {},
            }
      const asked = await kube.change({ ...where, name, dryRun: true, change })
      return asked.ok ? { ok: true } : refusalOf(asked.error)
    }

    // The object as it is, for all but a create: what a patch, a scale or a deletion is made to.
    let before: KubeObject | null = null
    if (r.action !== 'create') {
      const got = await kube.get({ ...where, name })
      if (!got.ok) return refusalOf(got.error)
      before = got.data
    }
    const seen =
      r.step === 'make'
        ? r.seen
        : {
            ...(before?.metadata.resourceVersion && {
              resourceVersion: before.metadata.resourceVersion,
            }),
            ...(before?.metadata.uid && { uid: before.metadata.uid }),
          }
    const request = changeOf(r, resource, where, name, seen)
    if (typeof request === 'string') return { ok: false, refused: 'failed', said: request }

    if (r.step === 'try') {
      // (What the cluster waits for before an object it deletes is gone.)
      const finalizers = (before?.metadata as { finalizers?: string[] } | undefined)?.finalizers
      const tried = await kube.change({ ...request, dryRun: true })
      if (!tried.ok) return refusalOf(tried.error)
      return {
        ok: true,
        before,
        after: tried.data,
        ...(r.action === 'create' && request.change.action === 'create'
          ? { sent: request.change.object }
          : {}),
        command,
        ...(r.action === 'patch' && (await takesOver(r, resource, where, name))),
        ...(r.action === 'delete' && finalizers?.length ? { finalizers: [...finalizers] } : {}),
        seen,
      }
    }

    // Made: as tried, never onto an object that moved since (the cluster refuses a stale one).
    const made: Result<KubeObject | null> = await kube.change(request)
    if (!made.ok) {
      const refusal = refusalOf(made.error)
      recorded(
        refusal.refused === 'failed' ? 'failure' : 'refused',
        refusal.refused === 'conflict'
          ? 'it changed since it was shown'
          : refusal.refused === 'invalid' || refusal.refused === 'not-found'
            ? 'refused by the cluster'
            : refusal.refused === 'read-only' || refusal.refused === 'not-allowed'
              ? 'refused by Lumovi’s rules'
              : 'it failed',
        made.error.message,
      )
      return refusal
    }
    recorded('success', undefined, undefined, made.data)
    return { ok: true, after: made.data }
  }

  /** Whose fields a patch would take: the cluster's words of a server-side apply's try, read. */
  async function takesOver(
    r: PluginChangeRequest,
    resource: ResourceDefinition,
    where: { context: string; kind: string; namespace?: string },
    name: string | undefined,
  ): Promise<{ takesOver?: { field: string; manager: string }[] }> {
    const { metadata, ...rest } = (withoutNulls(r.body) ?? {}) as Partial<KubeObject>
    const object = {
      ...rest,
      apiVersion: resource.group ? `${resource.group}/${resource.version}` : resource.version,
      kind: resource.apiKind,
      metadata: {
        name: name!,
        ...(where.namespace && { namespace: where.namespace }),
        ...(metadata?.labels && { labels: metadata.labels }),
        ...(metadata?.annotations && { annotations: metadata.annotations }),
      },
    } as KubeObject
    const tried = await kube.change({
      ...where,
      name,
      dryRun: true,
      change: { action: 'apply', object, fieldManager: FIELD_MANAGER, force: false },
    })
    if (tried.ok || tried.error.code !== 'conflict') return {}
    const taken = takenFrom(tried.error.message)
    return taken.length > 0 ? { takesOver: taken } : {}
  }
}

/**
 * Whose fields, and which, a server-side apply's conflict names, in the cluster's words:
 * `conflict with "argocd-application-controller" using argoproj.io/v1alpha1: .operation`.
 */
export function takenFrom(message: string): { field: string; manager: string }[] {
  const taken: { field: string; manager: string }[] = []
  for (const found of message.matchAll(/conflicts? with "([^"]+)"[^:\n]*:\s*\.?([^\s,\n]+)/g)) {
    taken.push({ manager: found[1]!, field: found[2]! })
  }
  return taken.slice(0, 10)
}

/** The change as Lumovi's own page would ask it: or what's wrong with it. */
function changeOf(
  r: PluginChangeRequest,
  resource: ResourceDefinition,
  where: { context: string; kind: string; namespace?: string },
  name: string | undefined,
  seen: { resourceVersion?: string; uid?: string } | undefined,
): ChangeRequest | string {
  const at = { ...where, ...(name !== undefined && { name }) }
  // (A patch and a scale say which object they were made to: a stale one, the cluster refuses.)
  const version = seen?.resourceVersion ? { resourceVersion: seen.resourceVersion } : {}
  let change: Change
  switch (r.action) {
    case 'patch': {
      const body = (r.body ?? {}) as Record<string, unknown>
      const metadata = (body.metadata ?? {}) as Record<string, unknown>
      change = {
        action: 'patch',
        patchType: 'merge',
        patch: { ...body, metadata: { ...metadata, ...version } },
      }
      break
    }
    case 'scale':
      if (!Number.isInteger(r.replicas) || r.replicas! < 0 || r.replicas! > REPLICAS_MOST) {
        return `A scale’s count is a whole number from 0 to ${REPLICAS_MOST}`
      }
      change = {
        action: 'patch',
        patchType: 'merge',
        subresource: 'scale',
        patch: { metadata: version, spec: { replicas: r.replicas } },
      }
      break
    case 'delete':
      change = { action: 'delete', propagation: 'Background', ...(seen?.uid && { uid: seen.uid }) }
      break
    case 'create':
      change = { action: 'create', object: createdObject(r, resource, where.namespace) }
      break
  }
  return { ...at, change }
}

/**
 * The object a create sends, as Kubernetes orders one: its apiVersion and kind, its metadata (its
 * name, or the generateName it asks for, and the namespace it goes to), then the rest as written.
 */
export function createdObject(
  r: PluginChangeRequest,
  resource: ResourceDefinition,
  namespace: string | undefined,
): KubeObject {
  const { metadata, apiVersion: _version, kind: _kind, ...rest } = (r.body ?? {}) as KubeObject
  return {
    apiVersion: resource.group ? `${resource.group}/${resource.version}` : resource.version,
    kind: resource.apiKind,
    metadata: { ...metadata, ...(namespace && { namespace }) },
    ...rest,
  } as KubeObject
}

/** A heredoc's last line: `LUMOVI_EOF`, with a number after it while a line of `text` is it. */
export function heredocEnd(text: string): string {
  const lines = new Set(text.split('\n'))
  let end = 'LUMOVI_EOF'
  for (let n = 2; lines.has(end); n++) end = `LUMOVI_EOF_${n}`
  return end
}

/** The kubectl command that makes the same change. */
/**
 * A patch that sets only an object's annotations, or only its labels, as kubectl says it: its
 * verb (`annotate` or `label`) and each key as `key=value`, or `key-` where the patch takes it
 * away. Exactly what the patch does, or nothing: anything else in it, or a value that isn't text,
 * is said as the patch itself.
 */
export function annotatedAs(
  body: unknown,
): { verb: 'annotate' | 'label'; pairs: string[] } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { metadata, ...rest } = body as { metadata?: unknown }
  if (Object.keys(rest).length > 0 || typeof metadata !== 'object' || metadata === null)
    return undefined
  const names = Object.keys(metadata)
  if (names.length !== 1 || (names[0] !== 'annotations' && names[0] !== 'labels')) return undefined
  const map = (metadata as Record<string, unknown>)[names[0]!]
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return undefined
  // (A key kubectl's form would read otherwise, one with an `=` in it, is said as the patch.)
  const pairs = Object.entries(map).map(([key, value]) =>
    key.includes('=')
      ? undefined
      : value === null
        ? `${key}-`
        : typeof value === 'string'
          ? `${key}=${value}`
          : undefined,
  )
  if (pairs.length === 0 || pairs.some((pair) => pair === undefined)) return undefined
  return { verb: names[0] === 'annotations' ? 'annotate' : 'label', pairs: pairs as string[] }
}

export function commandOf(
  r: PluginChangeRequest,
  resource: ResourceDefinition,
  namespace: string | undefined,
  name: string | undefined,
): string {
  const object = objectArg(resource.kind, name ?? '')
  switch (r.action) {
    case 'patch': {
      const annotated = annotatedAs(r.body)
      if (annotated) {
        return kubectl(
          r.context,
          namespace,
          annotated.verb,
          object,
          ...annotated.pairs,
          '--overwrite',
        )
      }
      return kubectl(
        r.context,
        namespace,
        'patch',
        object,
        '--type',
        'merge',
        '-p',
        JSON.stringify(r.body ?? {}),
      )
    }
    case 'scale':
      return kubectl(r.context, namespace, 'scale', object, `--replicas=${r.replicas ?? 0}`)
    case 'delete':
      return kubectl(r.context, namespace, 'delete', object)
    case 'create': {
      // (The very object shown, read from the command's own input: nothing it would need a file
      // for.)
      const yaml = stringify(createdObject(r, resource, namespace)).trimEnd()
      const end = heredocEnd(yaml)
      return `${kubectl(r.context, namespace, 'create', '-f', '-')} <<'${end}'\n${yaml}\n${end}`
    }
  }
}
