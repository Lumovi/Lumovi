/**
 * What a change through Lumovi's page is, for the audit log: said from
 * the request itself (never from what the page says it is), with the
 * kubectl or helm command that does the same where there's one that needs
 * nothing but what's said. What's changed is named, never its values.
 */
import { parse } from 'yaml'
import type {
  ChangeRequest,
  HelmDeploy,
  HelmRollback,
  HelmUninstall,
  KubeErrorCode,
  KubeObject,
  Result,
} from '@shared/api'
import type { AiPermissions } from '@shared/ai-permissions'
import type { AuditAction, AuditDetail, AuditOutcome } from '@shared/audit'
import { helm, kubectl, objectArg } from '@shared/kubectl'
import { apiKindOf } from '@shared/resources'
import type { Recorded } from './recorder'

/** Whether an error is the cluster (or Lumovi) not allowing it, rather than it failing. */
export const isRefusal = (code: KubeErrorCode) =>
  code === 'forbidden' || code === 'unauthorized' || code === 'read-only'

/** How a result came out: refused where the cluster, or Lumovi, doesn't allow it. */
export function outcomeOf(result: Result<unknown>): { outcome: AuditOutcome; error?: string } {
  if (result.ok) return { outcome: 'success' }
  return {
    outcome: isRefusal(result.error.code) ? 'refused' : 'failure',
    error: result.error.message,
  }
}

/**
 * Whether Lumovi turned it down as it came (it isn't one at all, or misses what it needs):
 * nothing reached the cluster, so there's nothing to record. The API server's own refusals
 * (an invalid object) have its status, and are recorded.
 */
export const malformed = (result: Result<unknown>) =>
  !result.ok && result.error.code === 'invalid' && result.error.status === undefined

/** A field's path, as people write it: spec.replicas, metadata.labels["app.kubernetes.io/name"]. */
const pathOf = (keys: string[]) =>
  keys
    .map((key, i) => (/^[\w-]+$/.test(key) ? `${i ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`))
    .join('')

const MAX_FIELDS = 50

/** The fields a patch sets (or a JSON patch's operations touch), but not what to. */
export function fieldsOf(patch: unknown): string[] {
  if (Array.isArray(patch)) {
    return patch
      .map((op) =>
        pathOf(
          String((op as { path?: unknown })?.path ?? '')
            .split('/')
            .slice(1)
            .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~')),
        ),
      )
      .filter(Boolean)
      .slice(0, MAX_FIELDS)
  }
  const fields: string[] = []
  const walk = (value: unknown, keys: string[]) => {
    const entries =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.entries(value)
        : []
    if (entries.length === 0) fields.push(pathOf(keys))
    for (const [key, inner] of entries) walk(inner, [...keys, key])
  }
  walk(patch, [])
  return fields.filter(Boolean).slice(0, MAX_FIELDS)
}

const listed = (fields: string[]) =>
  fields.length <= 3
    ? fields.join(', ')
    : `${fields.slice(0, 3).join(', ')} and ${fields.length - 3} more`

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/** A change through the page, as the audit log has it. */
export function describeChange(r: ChangeRequest, result: Result<KubeObject | null>): Recorded {
  const kind = apiKindOf(r.kind)
  const { change } = r
  const object = 'object' in change ? (change.object as Partial<KubeObject> | undefined) : undefined
  const name =
    r.name ??
    object?.metadata?.name ??
    (object?.metadata?.generateName ? `${object.metadata.generateName}…` : '(unnamed)')
  const what = `${kind} ${name}`
  const arg = objectArg(r.kind, name)
  const made = result.ok ? result.data : null
  /** Done, or (refused, failed) what was asked. */
  const said = (past: string, present: string) => (result.ok ? past : present)
  const uid = made?.metadata?.uid ?? (change.action === 'delete' ? change.uid : undefined)
  let action: AuditAction
  let summary: string
  let command: string | undefined
  const details: Record<string, AuditDetail> = {}
  switch (change.action) {
    case 'patch': {
      const patch = change.patch as Record<string, unknown>
      const replicas = (patch?.spec as { replicas?: unknown } | undefined)?.replicas
      const unschedulable = (patch?.spec as { unschedulable?: unknown } | undefined)?.unschedulable
      details.fields = fieldsOf(change.patch)
      details.patchType = change.patchType
      if (change.subresource === 'scale' && typeof replicas === 'number') {
        action = 'resource.scale'
        summary = `${said('Scaled', 'Scale')} ${what} to ${plural(replicas, 'replica')}`
        command = kubectl(r.context, r.namespace, 'scale', arg, `--replicas=${replicas}`)
        details.replicas = replicas
      } else if (JSON.stringify(change.patch).includes('"kubectl.kubernetes.io/restartedAt"')) {
        action = 'resource.restart'
        summary = `${said('Restarted', 'Restart')} ${what}`
        command = kubectl(r.context, r.namespace, 'rollout', 'restart', arg)
      } else if (r.kind === 'Node' && typeof unschedulable === 'boolean') {
        action = 'resource.patch'
        summary = `${unschedulable ? said('Cordoned', 'Cordon') : said('Uncordoned', 'Uncordon')} ${what}`
        command = kubectl(r.context, undefined, unschedulable ? 'cordon' : 'uncordon', name)
      } else {
        action = 'resource.patch'
        const fields = details.fields
        const part = change.subresource === 'status' ? `${what}’s status` : what
        summary = `${said('Changed', 'Change')} ${part}${fields.length ? `: ${listed(fields)}` : ''}`
        if (change.subresource) details.subresource = change.subresource
      }
      break
    }
    case 'replace':
      action = 'resource.replace'
      summary = `${said('Replaced', 'Replace')} ${what} with an edited one`
      break
    case 'create':
      action = 'resource.create'
      summary = `${said('Created', 'Create')} ${what}`
      break
    case 'apply':
      action = 'resource.apply'
      summary = `${said('Applied', 'Apply')} ${what}${change.force ? ', taking over fields other managers had' : ''}`
      details.fieldManager = String(change.fieldManager)
      details.force = change.force === true
      break
    case 'delete':
      action = 'resource.delete'
      summary = `${said('Deleted', 'Delete')} ${what}`
      command = kubectl(r.context, r.namespace, 'delete', arg)
      if (change.propagation) details.propagation = change.propagation
      if (change.gracePeriodSeconds !== undefined) {
        details.gracePeriodSeconds = change.gracePeriodSeconds
      }
      break
    case 'evict':
      action = 'resource.evict'
      summary = `${said('Evicted', 'Evict')} ${what}`
      break
    case 'debug':
      action = 'resource.debug'
      summary = `${said('Added', 'Add')} the debug container ${change.container} (${change.image}) to ${what}`
      command = kubectl(
        r.context,
        r.namespace,
        'debug',
        '-it',
        name,
        `--image=${change.image}`,
        `--container=${change.container}`,
        ...(change.target ? [`--target=${change.target}`] : []),
      )
      details.container = change.container
      details.image = change.image
      if (change.target) details.target = change.target
      break
  }
  return {
    action,
    ...outcomeOf(result),
    cluster: r.context,
    target: {
      kind: r.kind,
      name,
      ...(r.namespace ? { namespace: r.namespace } : {}),
      ...(uid ? { uid } : {}),
    },
    summary,
    ...(command ? { command } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  }
}

/** A release's top-level values' names (never what they're set to): what an upgrade set. */
function valueNames(values: unknown): string[] {
  try {
    const parsed: unknown = parse(String(values))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, MAX_FIELDS)
      : []
  } catch {
    return []
  }
}

const release = (r: { context: string; namespace: string; name: string }) => ({
  cluster: r.context,
  target: { kind: 'HelmRelease', name: r.name, namespace: r.namespace },
})

export function describeDeploy(r: HelmDeploy, result: Result<unknown>): Recorded {
  const stored = r.source === 'stored'
  const source = stored ? undefined : (r.source as HelmDeploy['source'] & object)
  const chart = source ? `${source.chart}${source.version ? ` ${source.version}` : ''}` : ''
  const values = valueNames(r.values)
  const said = (past: string, present: string) => (result.ok ? past : present)
  return {
    action: r.install === true ? 'helm.install' : 'helm.upgrade',
    ...outcomeOf(result),
    ...release(r),
    summary:
      r.install === true
        ? `${said('Installed', 'Install')} ${chart} as ${r.name}`
        : `${said('Upgraded', 'Upgrade')} ${r.name} ${stored ? 'with new values' : `to ${chart}`}`,
    ...(source
      ? {
          command: helm(
            r.context,
            r.namespace,
            r.install === true ? 'install' : 'upgrade',
            r.name,
            source.chart,
            ...(source.repository ? ['--repo', source.repository] : []),
            ...(source.version ? ['--version', source.version] : []),
            ...(values.length ? ['-f', 'values.yaml'] : []),
            ...(r.createNamespace === true ? ['--create-namespace'] : []),
          ),
        }
      : {}),
    details: {
      ...(source ? { chart: source.chart } : {}),
      ...(source?.version ? { version: source.version } : {}),
      ...(source?.repository ? { repository: source.repository } : {}),
      values,
    },
  }
}

export const describeRollback = (r: HelmRollback, result: Result<unknown>): Recorded => ({
  action: 'helm.rollback',
  ...outcomeOf(result),
  ...release(r),
  summary: `${result.ok ? 'Rolled' : 'Roll'} ${r.name} back to revision ${r.revision}`,
  command: helm(r.context, r.namespace, 'rollback', r.name, String(r.revision)),
  details: { revision: r.revision },
})

export const describeUninstall = (r: HelmUninstall, result: Result<unknown>): Recorded => ({
  action: 'helm.uninstall',
  ...outcomeOf(result),
  ...release(r),
  summary: `${result.ok ? 'Uninstalled' : 'Uninstall'} ${r.name}${r.keepHistory ? ', keeping its history' : ''}`,
  command: helm(
    r.context,
    r.namespace,
    'uninstall',
    r.name,
    ...(r.keepHistory ? ['--keep-history'] : []),
  ),
  details: { keepHistory: r.keepHistory },
})

/** What AI assistants may do, as someone set it: their defaults, and their rules' names. */
export function describePermissions({ defaults, rules }: AiPermissions): Recorded {
  return {
    action: 'permissions.changed',
    outcome: 'success',
    summary: `Changed what AI assistants may do: by default, changes ${defaults.changes}, Secrets ${defaults.secrets}, env ${defaults.env}, logs ${defaults.logs}; ${plural(rules.length, 'rule')}`,
    details: { ...defaults, rules: rules.map((rule) => rule.name) },
  }
}
