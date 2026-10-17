/**
 * How full a ResourceQuota is: each resource it limits, used against its hard limit, and the
 * fullest of them. Its % is floored, never rounded up past a level (99.6% is 99%, still nearly
 * full), so the number, the colour and the word agree. A limit of 0 forbids a thing: it doesn't
 * count toward how full the quota is, unless something uses it anyway.
 */
import type { KubeObject } from './api'
import { parseQuantity } from './quantity'

/** At this % of its limit a quota's resource is nearly full; at 100, full. */
export const NEARLY_FULL = 90

export interface QuotaUse {
  /** The resource, as the quota names it (`requests.cpu`, `count/deployments.apps`). */
  resource: string
  used: number
  hard: number
  /** Whether the controller has counted it yet (a new quota's status has no `used`). */
  counted: boolean
  /** Used over hard, as a whole % floored; Infinity where the limit is 0 and something uses it. */
  percent: number
}

/** A quota's resources, worst first: as its status has them, or its spec before it's counted. */
export function quotaUses(quota: KubeObject): QuotaUse[] {
  const hard: Record<string, string> = quota.status?.hard ?? quota.spec?.hard ?? {}
  const used: Record<string, string> | undefined = quota.status?.used
  return Object.keys(hard)
    .map((resource) => {
      const limit = parseQuantity(hard[resource])
      const now = parseQuantity(used?.[resource] ?? '0')
      return {
        resource,
        used: now,
        hard: limit,
        counted: used?.[resource] !== undefined,
        percent: limit > 0 ? Math.floor((now / limit) * 100 + 1e-9) : now > 0 ? Infinity : 0,
      }
    })
    .sort(
      (a, b) =>
        Number(b.counted) - Number(a.counted) ||
        Number(forbids(a)) - Number(forbids(b)) ||
        b.percent - a.percent ||
        a.resource.localeCompare(b.resource),
    )
}

/** A limit of 0 that nothing uses: a thing the quota doesn't allow, which never fills it. */
export const forbids = (use: QuotaUse) => use.hard === 0 && use.used === 0

/** The resource nearest its limit, among those counted and allowed at all. */
export function fullest(uses: readonly QuotaUse[]): QuotaUse | undefined {
  return uses.find((use) => use.counted && !forbids(use))
}

/** Its level: nearly full from 90%, full at 100%. */
export function useLevel(use: QuotaUse): 'within' | 'nearly' | 'full' {
  return use.percent >= 100 ? 'full' : use.percent >= NEARLY_FULL ? 'nearly' : 'within'
}

const CPU = /(^|\.)cpu$/
const BYTES = /(^|\.)(memory|storage|ephemeral-storage)$|^(requests\.)?hugepages-/

/** How a resource's amounts are written: cores, bytes, or a plain count. */
function unitOf(resource: string): 'cores' | 'bytes' | 'count' {
  if (CPU.test(resource)) return 'cores'
  return BYTES.test(resource) ? 'bytes' : 'count'
}

const trimmed = (n: number) => String(Math.round(n * 100) / 100)

/** An amount of a resource, in its own unit: "1 core", "1.8 cores", "500m", "3.75 Gi", "9". */
export function amount(resource: string, value: number): string {
  switch (unitOf(resource)) {
    case 'cores':
      if (value > 0 && value < 1) return `${Math.round(value * 1000)}m`
      return value === 1 ? '1 core' : `${trimmed(value)} cores`
    case 'bytes': {
      const gi = value / 2 ** 30
      if (gi >= 1) return `${trimmed(gi)} Gi`
      return `${trimmed(value / 2 ** 20)} Mi`
    }
    case 'count':
      return trimmed(value)
  }
}

/** "3.75 Gi of 4 Gi", "9 of 20", "1.8 cores of 2 cores". */
export const usedOf = (use: QuotaUse) =>
  `${amount(use.resource, use.used)} of ${amount(use.resource, use.hard)}`

/** The % as written: the real one, past 100 where used is over hard. */
export const percentText = (use: QuotaUse) =>
  Number.isFinite(use.percent) ? `${use.percent}%` : 'over'

const WORDS: Record<string, string> = {
  cpu: 'CPU requests',
  memory: 'Memory requests',
  'requests.cpu': 'CPU requests',
  'requests.memory': 'Memory requests',
  'limits.cpu': 'CPU limits',
  'limits.memory': 'Memory limits',
  'requests.storage': 'Storage requests',
  'ephemeral-storage': 'Ephemeral storage requests',
  'requests.ephemeral-storage': 'Ephemeral storage requests',
  'limits.ephemeral-storage': 'Ephemeral storage limits',
  pods: 'Pods',
  services: 'Services',
  'services.loadbalancers': 'Load balancers',
  'services.nodeports': 'Node ports',
  persistentvolumeclaims: 'Volume claims',
  configmaps: 'ConfigMaps',
  secrets: 'Secrets',
  replicationcontrollers: 'ReplicationControllers',
  resourcequotas: 'ResourceQuotas',
}

/** A resource in words, where it has them ("Memory requests"); else none: its key is its label. */
export const wordsFor = (resource: string): string | undefined =>
  Object.hasOwn(WORDS, resource) ? WORDS[resource] : undefined

/**
 * The line Needs attention gives a quota: its fullest resource, "requests.memory 93% · 3.75 Gi
 * of 4 Gi", or "persistentvolumeclaims 10 of 10" where that says it's full.
 */
export function fullestLine(use: QuotaUse): string {
  const of = usedOf(use)
  return use.used === use.hard
    ? `${use.resource} ${of}`
    : `${use.resource} ${percentText(use)} · ${of}`
}

/** What a quota refused a workload's pods, as the API said it: its quota and the resources. */
export interface QuotaRefusal {
  /** The API's own words. */
  message: string
  quota?: string
  /** The resources it had no room for (`requests.memory`). */
  resources: string[]
}

/** Whether a Deployment's or ReplicaSet's pods can't be made for a quota, and what it said. */
export function quotaRefusal(object: KubeObject): QuotaRefusal | undefined {
  const failure = (
    object.status?.conditions as { type: string; status: string; message?: string }[] | undefined
  )?.find((c) => c.type === 'ReplicaFailure' && c.status === 'True')
  const message = failure?.message
  if (!message || !/exceeded quota/i.test(message)) return undefined
  const quota = /exceeded quota: ([^,\s]+)/i.exec(message)?.[1]
  const requested = /requested: (.*?)(?:, used:|$)/i.exec(message)?.[1] ?? ''
  const resources = [...requested.matchAll(/([a-z0-9./-]+)=/gi)].map((m) => m[1]!)
  return { message, ...(quota ? { quota } : {}), resources }
}
