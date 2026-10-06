/**
 * How Lumovi shows clusters to AI assistants: what tells them most for the
 * fewest words, and never a Secret's values.
 */
import { stringify } from 'yaml'
import type { KubeObject } from '@shared/api'
import {
  containerStatuses,
  conventionalStatus,
  replicaCounts,
  STATUS_BY_KIND,
  type Status,
} from '@shared/health'
import type { AiAccess } from '@shared/ai-permissions'
import { isBuiltinKind, type ResourceKind } from '@shared/resources'

type EnvAccess = AiAccess['env']

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

export const yaml = (value: unknown) =>
  stringify(value, { lineWidth: 0, aliasDuplicateObjects: false })

/**
 * An object as an assistant reads it: without what's large and says little
 * (managed fields, the last applied configuration), with a Secret's values
 * hidden, keeping their keys (unless its rules show them), and env values as
 * its rules say. As the person sees it in a change they approve, too.
 */
export function readable(
  object: KubeObject,
  { secrets = 'keys', env = 'show' }: { secrets?: 'values' | 'keys'; env?: EnvAccess } = {},
): KubeObject {
  const copy = structuredClone(object)
  delete copy.metadata.managedFields
  const annotations = copy.metadata.annotations
  if (annotations) {
    delete annotations[LAST_APPLIED]
    if (Object.keys(annotations).length === 0) delete copy.metadata.annotations
  }
  hideEnv(copy, env)
  if (copy.kind === 'Secret' && secrets === 'keys') {
    for (const field of ['data', 'stringData'] as const) {
      const values = copy[field] as Record<string, string> | undefined
      if (values) copy[field] = Object.fromEntries(Object.keys(values).map((k) => [k, HIDDEN]))
    }
  }
  return copy
}

/** What an event is about. */
export const involved = (event: KubeObject) =>
  event.involvedObject as { kind: string; name: string; namespace?: string }

/** In place of what an assistant may not read: a Secret's values, env values. */
export const HIDDEN = '(hidden by Lumovi)'

/** Env names that usually hold what shouldn't be read: passwords, tokens, keys… */
const SENSITIVE_NAME =
  /pass|secret|token|key|cred|auth|private|cert|dsn|conn|session|cookie|salt|sig/i
/** A URL that carries its credentials: postgres://user:password@db. */
const CREDENTIALS_IN_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/

/**
 * Hides env values, wherever an object has containers (pods, workloads'
 * templates, custom resources' too): sensitive ones (by their name, or a URL
 * with credentials), or all.
 */
export function hideEnv(object: KubeObject, which: EnvAccess): void {
  if (which === 'show') return
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'env' && Array.isArray(inner)) inner.forEach((variable) => hide(variable))
        else walk(inner)
      }
    }
  }
  const hide = (variable: unknown) => {
    const { name, value } = Object(variable) as { name?: unknown; value?: unknown }
    if (typeof name !== 'string' || typeof value !== 'string') return
    if (which === 'all' || SENSITIVE_NAME.test(name) || CREDENTIALS_IN_URL.test(value)) {
      ;(variable as { value: string }).value = HIDDEN
    }
  }
  walk(object)
}

/** An object's health, by Lumovi's rules for its kind, or the conventions controllers follow. */
export function statusOf(kind: ResourceKind, object: KubeObject): Status | null {
  return isBuiltinKind(kind) ? (STATUS_BY_KIND[kind]?.(object) ?? null) : conventionalStatus(object)
}

/** A status in words: "CrashLoopBackOff (critical): back-off restarting failed container". */
export const describeStatus = ({ label, health, detail }: Status) =>
  `${label} (${health})${detail ? `: ${detail}` : ''}`

/** How long ago, as kubectl shows ages: 45s, 12m, 5h, 3d. */
export function age(timestamp: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 120) return `${seconds}s`
  if (seconds < 7_200) return `${Math.floor(seconds / 60)}m`
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** One object in a list: its name, health and age, and what its kind's table shows. */
export function row(kind: ResourceKind, object: KubeObject, now: number): Record<string, unknown> {
  const status = statusOf(kind, object)
  return {
    name: object.metadata.name,
    ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
    ...(status ? { status: describeStatus(status) } : {}),
    age: age(object.metadata.creationTimestamp!, now),
    ...columns(kind, object),
  }
}

function columns(kind: ResourceKind, o: KubeObject): Record<string, unknown> {
  switch (kind) {
    case 'Pod': {
      const statuses = containerStatuses(o)
      return {
        ready: `${statuses.filter((c) => c.ready).length}/${o.spec.containers.length}`,
        restarts: statuses.reduce((sum, c) => sum + c.restartCount, 0),
        node: o.spec.nodeName,
      }
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'DaemonSet': {
      const { ready, desired } = replicaCounts(o)
      return {
        ready: `${ready}/${desired}`,
        images: o.spec.template.spec.containers.map((c: { image: string }) => c.image),
      }
    }
    case 'Service':
      return {
        type: o.spec.type,
        clusterIP: o.spec.clusterIP,
        ports: (o.spec.ports ?? []).map(
          (p: { port: number; protocol: string }) => `${p.port}/${p.protocol}`,
        ),
      }
    case 'Node':
      return {
        roles: Object.keys(o.metadata.labels!)
          .filter((label) => label.startsWith('node-role.kubernetes.io/'))
          .map((label) => label.slice('node-role.kubernetes.io/'.length)),
        version: o.status?.nodeInfo?.kubeletVersion,
      }
    default:
      return {}
  }
}

/** What the API server keeps for itself: not what a change sets. */
const SERVER_KEPT = ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields']

/** Every field an object sets, by its path ("spec.replicas"), as JSON; not its status. */
function fields(object: KubeObject | null): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (value: unknown, path: string) => {
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`)
    } else found.set(path, JSON.stringify(value))
  }
  if (object) {
    const { status: _status, metadata, ...rest } = object
    walk(
      {
        ...rest,
        metadata: Object.fromEntries(
          Object.entries(metadata).filter(([key]) => !SERVER_KEPT.includes(key)),
        ),
      },
      '',
    )
  }
  return found
}

/**
 * What a change does, as text to compare: each field it sets, changes or
 * removes, from what to what. The same change to an object that has changed
 * elsewhere (its status, other fields) does the same.
 */
export function changesOf(before: KubeObject | null, after: KubeObject | null): string {
  const was = fields(before)
  const is = fields(after)
  return [...new Set([...was.keys(), ...is.keys()])]
    .filter((path) => was.get(path) !== is.get(path))
    .sort()
    .map((path) => `${path}: ${was.get(path)} → ${is.get(path)}`)
    .join('\n')
}
