/**
 * Quotas and limit ranges as Lumovi draws them: a quota's resources, each used against its limit
 * on a meter with its % written (from 90% with its icon too: never by colour alone); a limit
 * range's defaults and bounds; a namespace's of both; a workload a quota stops.
 */
import { ChevronRight, CircleX, Gauge, Info, Lock, TriangleAlert } from 'lucide-react'
import type { KubeObject } from '@shared/api'
import {
  forbids,
  fullest,
  percentText,
  quotaRefusal,
  quotaUses,
  useLevel,
  usedOf,
  wordsFor,
  type QuotaUse,
} from '@shared/quota'
import { Meter } from '@renderer/components/Meter'
import { StatusPill } from '@renderer/components/Status'
import { useList } from '@renderer/hooks/queries'
import { useOpenObject } from '@renderer/hooks/open-object'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { statusOf } from '@renderer/lib/health'
import { Section } from '../details/sections'

const LEVEL_ICON = { nearly: TriangleAlert, full: CircleX } as const
const LEVEL_TEXT = {
  within: 'text-ink-1',
  nearly: 'text-warn-text',
  full: 'text-critical-text',
} as const

/** Its fill: used over hard, full where used is over a limit of 0. */
const ratioOf = (use: QuotaUse) => (use.hard > 0 ? use.used / use.hard : 1)

/** Its icon from 90%: ⚠ nearly full, ⊗ full. */
function LevelIcon({ use }: { use: QuotaUse }) {
  const level = useLevel(use)
  if (level === 'within') return null
  const Icon = LEVEL_ICON[level]
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', LEVEL_TEXT[level])} />
}

/** Its %, in bold, in its level's colour. */
function Share({ use }: { use: QuotaUse }) {
  return (
    <span className={cn('shrink-0 font-semibold tabular-nums', LEVEL_TEXT[useLevel(use)])}>
      {percentText(use)}
    </span>
  )
}

/** Whether none of a quota's resources has been counted yet: a new quota. */
const uncounted = (uses: readonly QuotaUse[]) =>
  uses.length > 0 && uses.every((use) => !use.counted)

/**
 * The Resource Quotas list's Fullest: the resource nearest its limit, its key (cut at its end
 * where it must be, never the %), its % and its meter.
 */
export function QuotaFullest({ quota }: { quota: KubeObject }) {
  const uses = quotaUses(quota)
  if (uncounted(uses)) return <span className="text-ink-3">Not counted yet</span>
  const top = fullest(uses)
  if (!top) return <span className="text-ink-3">—</span>
  return (
    <span className="flex w-full min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <LevelIcon use={top} />
        <span className="min-w-0 truncate font-mono text-ink-2" title={top.resource}>
          {top.resource}
        </span>
        <Share use={top} />
      </span>
      <Meter variant="quota" value={ratioOf(top)} label={`${top.resource} used`} />
    </span>
  )
}

/** What the Fullest column's text and CSV hold: "requests.memory 93%". */
export function fullestText(quota: KubeObject): string {
  const uses = quotaUses(quota)
  if (uncounted(uses)) return 'Not counted yet'
  const top = fullest(uses)
  return top ? `${top.resource} ${percentText(top)}` : ''
}

/** Worst first: a quota's fullest, as Fullest sorts it. */
export function fullestSort(quota: KubeObject): number {
  const top = fullest(quotaUses(quota))
  return top ? -Math.min(top.percent, 1e6) : 1
}

/**
 * One resource of a quota, as a node's usage reads: its name in words with its key quiet beside
 * it (a key without words is its own label), then its % and amounts, then its meter.
 */
function UsageRow({ use }: { use: QuotaUse }) {
  const words = wordsFor(use.resource)
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="flex min-w-0 items-baseline gap-2">
          {words ? (
            <>
              <span className="shrink-0 text-ink-2">{words}</span>
              <span className="min-w-0 truncate font-mono text-xs text-ink-3" title={use.resource}>
                {use.resource}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate font-mono text-xs text-ink-2" title={use.resource}>
              {use.resource}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3 tabular-nums">
          {!use.counted ? (
            'Not counted yet'
          ) : forbids(use) ? (
            `Not allowed · ${usedOf(use)}`
          ) : (
            <>
              <LevelIcon use={use} />
              <Share use={use} /> · {usedOf(use)}
            </>
          )}
        </span>
      </div>
      {use.counted && !forbids(use) && (
        <Meter variant="quota" value={ratioOf(use)} label={`${words ?? use.resource} used`} />
      )}
    </div>
  )
}

/** A quota's Usage, first on its Overview: a meter for each resource, worst first. */
export function QuotaUsage({ quota }: { quota: KubeObject }) {
  const uses = quotaUses(quota)
  const top = fullest(uses)
  return (
    <Section
      title="Usage"
      {...(top && !uncounted(uses) ? { aside: `${top.resource} is ${percentText(top)} used` } : {})}
    >
      {uses.length === 0 ? (
        <p className="text-[13px] text-ink-3">It limits nothing.</p>
      ) : (
        <div className="space-y-3.5">
          {uses.map((use) => (
            <UsageRow key={use.resource} use={use} />
          ))}
        </div>
      )}
    </Section>
  )
}

/** What a quota counts: its scopes and scope selector, or every pod in its namespace. */
export function QuotaAppliesTo({ quota }: { quota: KubeObject }) {
  const scopes: string[] = quota.spec?.scopes ?? []
  const selector: { scopeName: string; operator: string; values?: string[] }[] =
    quota.spec?.scopeSelector?.matchExpressions ?? []
  return (
    <Section title="Applies to">
      {scopes.length === 0 && selector.length === 0 ? (
        <p className="text-[13px] text-ink-1">Every pod in {quota.metadata.namespace}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2 text-[13px] phone:flex phone:flex-col phone:gap-3">
          {scopes.length > 0 && (
            <div className="contents phone:block">
              <dt className="text-ink-3 phone:text-xs">Scopes</dt>
              <dd className="font-mono text-xs text-ink-1">{scopes.join(', ')}</dd>
            </div>
          )}
          {selector.length > 0 && (
            <div className="contents phone:block">
              <dt className="text-ink-3 phone:text-xs">Scope selector</dt>
              <dd className="font-mono text-xs text-ink-1">
                {selector
                  .map((e) =>
                    e.values?.length
                      ? `${e.scopeName} ${e.operator} ${e.values.join(', ')}`
                      : `${e.scopeName} ${e.operator}`,
                  )
                  .join('; ')}
              </dd>
            </div>
          )}
        </dl>
      )}
    </Section>
  )
}

interface Limit {
  type: string
  min?: Record<string, string>
  max?: Record<string, string>
  default?: Record<string, string>
  defaultRequest?: Record<string, string>
  maxLimitRequestRatio?: Record<string, string>
}

const RESOURCE_WORDS: Record<string, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  storage: 'Storage',
  'ephemeral-storage': 'Ephemeral storage',
}
const resourceWords = (resource: string) =>
  Object.hasOwn(RESOURCE_WORDS, resource) ? RESOURCE_WORDS[resource]! : resource

const COLUMNS: [keyof Limit, string][] = [
  ['min', 'Min'],
  ['max', 'Max'],
  ['defaultRequest', 'Default request'],
  ['default', 'Default limit'],
  ['maxLimitRequestRatio', 'Limit ÷ request'],
]

/** A LimitRange's limits: a table per type it sets, a row per resource; what it doesn't set, a dash. */
export function LimitRangeLimits({ range }: { range: KubeObject }) {
  const limits: Limit[] = range.spec?.limits ?? []
  return (
    <Section title="Limits">
      {limits.length === 0 ? (
        <p className="text-[13px] text-ink-3">It sets nothing.</p>
      ) : (
        <div className="space-y-4">
          {limits.map((limit, i) => {
            const resources = [
              ...new Set(
                COLUMNS.flatMap(([key]) => Object.keys((limit[key] as object | undefined) ?? {})),
              ),
            ]
            return (
              <div key={`${limit.type}-${i}`}>
                <h4 className="mb-2 text-[13px] font-medium text-ink-1">{limit.type}</h4>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table aria-label={`${limit.type} limits`} className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-2xs tracking-wider text-ink-3 uppercase">
                        <th className="px-3 py-2 font-medium">Resource</th>
                        {COLUMNS.map(([key, label]) => (
                          <th key={key} className="px-3 py-2 font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {resources.map((resource) => (
                        <tr key={resource} className="border-b border-line last:border-0">
                          <td className="px-3 py-2 text-ink-1">{resourceWords(resource)}</td>
                          {COLUMNS.map(([key]) => {
                            const value = (limit[key] as Record<string, string> | undefined)?.[
                              resource
                            ]
                            return (
                              <td key={key} className="px-3 py-2 font-mono text-xs">
                                {value ?? <span className="text-ink-4">—</span>}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

/** A LimitRange's types, as its limits name them: "Container, Pod". */
export const limitTypes = (range: KubeObject): string =>
  [...new Set(((range.spec?.limits ?? []) as Limit[]).map((limit) => limit.type))].join(', ')

const THING: Record<string, string> = {
  Container: 'A container',
  Pod: 'A pod',
  PersistentVolumeClaim: 'A volume claim',
}

/** "100m CPU, 128Mi memory" (`named`), or "500m, 512Mi". */
/**
 * "100m CPU, 128Mi memory" (`named`: a line's first amounts say what they're of), or "500m,
 * 512Mi" (later ones in the line). A volume claim's storage needs no name.
 */
const amounts = (values: Record<string, string> | undefined, named: boolean) =>
  Object.entries(values ?? {})
    .map(([resource, value]) =>
      named && resource !== 'storage' ? `${value} ${resource === 'cpu' ? 'CPU' : resource}` : value,
    )
    .join(', ')

/**
 * A limit in a line: a container's defaults ("A container's default request 100m CPU, 128Mi
 * memory; its default limit 500m, 512Mi"), else its bounds ("A volume claim from 1Gi to 100Gi").
 */
export function limitLine(limit: Limit): string {
  const thing = THING[limit.type] ?? `A ${limit.type}`
  if (limit.defaultRequest || limit.default) {
    const parts = [
      ...(limit.defaultRequest
        ? [`${thing}’s default request ${amounts(limit.defaultRequest, true)}`]
        : []),
      ...(limit.default
        ? [
            limit.defaultRequest
              ? `its default limit ${amounts(limit.default, false)}`
              : `${thing}’s default limit ${amounts(limit.default, true)}`,
          ]
        : []),
    ]
    return parts.join('; ')
  }
  const min = amounts(limit.min, true)
  if (min && limit.max) return `${thing} from ${min} to ${amounts(limit.max, false)}`
  if (limit.max) return `${thing} up to ${amounts(limit.max, true)}`
  if (min) return `${thing} from ${min}`
  return `${thing}: nothing set`
}

/** Whether a list failed for the person's access, which asking again doesn't change. */
const refused = (error: unknown) =>
  ['forbidden', 'not-allowed'].includes((error as KubeApiError | null)?.code ?? '')

/** A section's line: none there, or not listed for the person's access. */
function Said({ icon: Icon, children }: { icon: typeof Info; children: string }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-ink-3">
      <Icon aria-hidden className="size-4 shrink-0" />
      {children}
    </p>
  )
}

/** A namespace's quotas, a card each: its status, its resources from 90%, the rest counted. */
function NamespaceQuotas({ namespace }: { namespace: string }) {
  const quotas = useList('ResourceQuota', { namespace })
  const open = useOpenObject()
  const items = quotas.data ?? []
  return (
    <Section title="Quotas" {...(items.length ? { aside: String(items.length) } : {})}>
      {quotas.isError && !quotas.data ? (
        refused(quotas.error) ? (
          <Said icon={Lock}>{`Your access doesn’t list ResourceQuotas in ${namespace}.`}</Said>
        ) : (
          <Said icon={Info}>{`Couldn’t read the quotas in ${namespace}.`}</Said>
        )
      ) : quotas.isPending ? null : items.length === 0 ? (
        <Said icon={Info}>{`No quotas in ${namespace}.`}</Said>
      ) : (
        <div className="space-y-3">
          {items.map((quota) => (
            <QuotaCard
              key={quota.metadata.name}
              quota={quota}
              onOpen={() => open('ResourceQuota', quota.metadata.name, namespace)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function QuotaCard({ quota, onOpen }: { quota: KubeObject; onOpen: () => void }) {
  const uses = quotaUses(quota)
  // Its resources from 90%, as meters; then what it forbids, each its line; then how many more
  // are under 90%. One not counted yet says that alone.
  const full = uses.filter((use) => use.counted && !forbids(use) && use.percent >= 90)
  const forbidden = uses.filter((use) => use.counted && forbids(use))
  const under = uses.filter((use) => use.counted && !forbids(use) && use.percent < 90).length
  const above = full.length + forbidden.length
  return (
    // (A click anywhere on it opens it; its title is the button the keyboard and a screen reader
    // have, which reads its name and status, its meters each their own.)
    <div
      onClick={onOpen}
      className="cursor-pointer space-y-3 rounded-xl border border-line bg-surface p-3.5 hover:border-line-strong"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Gauge aria-hidden className="size-4 shrink-0 text-ink-2" />
        <span className="truncate text-[13px] font-medium text-ink-1">{quota.metadata.name}</span>
        <StatusPill status={statusOf('ResourceQuota', quota)} />
        <ChevronRight aria-hidden className="ml-auto size-4 shrink-0 text-ink-3" />
      </button>
      {uncounted(uses) ? (
        <p className="text-xs text-ink-3">Not counted yet</p>
      ) : (
        <>
          {[...full, ...forbidden].map((use) => (
            <UsageRow key={use.resource} use={use} />
          ))}
          {under > 0 && (
            <p className="text-xs text-ink-3">
              {above > 0
                ? `and ${under} more under 90%`
                : `${under} ${under === 1 ? 'resource' : 'resources'} under 90%`}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** A namespace's limit ranges, each in a line of what it sets. */
function NamespaceLimitRanges({ namespace }: { namespace: string }) {
  const ranges = useList('LimitRange', { namespace })
  const items = ranges.data ?? []
  return (
    <Section title="Limit ranges" {...(items.length ? { aside: String(items.length) } : {})}>
      {ranges.isError && !ranges.data ? (
        refused(ranges.error) ? (
          <Said icon={Lock}>{`Your access doesn’t list LimitRanges in ${namespace}.`}</Said>
        ) : (
          <Said icon={Info}>{`Couldn’t read the limit ranges in ${namespace}.`}</Said>
        )
      ) : ranges.isPending ? null : items.length === 0 ? (
        <Said icon={Info}>{`No limit ranges in ${namespace}.`}</Said>
      ) : (
        <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2 text-[13px] phone:flex phone:flex-col phone:gap-3">
          {items.map((range) => (
            <div key={range.metadata.name} className="contents phone:block">
              <dt className="text-ink-3 phone:text-xs">{range.metadata.name}</dt>
              <dd className="text-ink-1">
                {((range.spec?.limits ?? []) as Limit[]).map((limit) => (
                  <span key={limit.type} className="block">
                    {limitLine(limit)}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  )
}

/** A namespace's Quotas and Limit ranges, after its Details. Neither hides the other. */
export function NamespaceLimits({ namespace }: { namespace: KubeObject }) {
  return (
    <>
      <NamespaceQuotas namespace={namespace.metadata.name} />
      <NamespaceLimitRanges namespace={namespace.metadata.name} />
    </>
  )
}

/**
 * A Deployment or ReplicaSet a quota stops: how many of its pods can't be made and why, in
 * Lumovi's words, then the API's own, and its quota to open.
 */
export function QuotaRefusalNotice({ object }: { object: KubeObject }) {
  const refusal = quotaRefusal(object)
  const open = useOpenObject()
  if (!refusal) return null
  const desired: number = object.spec?.replicas ?? 0
  const there: number = object.status?.replicas ?? 0
  const missing = Math.max(0, desired - there)
  const what = refusal.resources.map(resourceAsked)
  return (
    <div className="px-5 pt-1 pb-4 phone:px-4">
      <div
        role="note"
        className="space-y-1.5 rounded-xl border border-critical/20 bg-critical/5 p-3.5 text-[13px] text-ink-1"
      >
        <p className="flex gap-2">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-critical-text" />
          <span>
            {missing > 0
              ? `${missing} of its ${desired} pods can’t be made`
              : 'Its pods can’t be made'}
            : the namespace’s quota{' '}
            {refusal.quota ? <strong className="font-semibold">{refusal.quota}</strong> : null} has
            no room for its {what.length ? listed(what) : 'request'}.
          </span>
        </p>
        <p className="pl-6 font-mono text-xs break-words text-ink-2">{refusal.message}</p>
        {refusal.quota && (
          <button
            type="button"
            onClick={() => open('ResourceQuota', refusal.quota!, object.metadata.namespace)}
            className="pl-6 text-[13px] font-medium text-accent-strong hover:underline"
          >
            Open quota {refusal.quota}
          </button>
        )}
      </div>
    </div>
  )
}

/** A quota's resource as what a pod asked for: "memory request", "CPU limit", "pods". */
function resourceAsked(resource: string): string {
  const match = /^(requests|limits)\.(.+)$/.exec(resource)
  if (match) {
    const what = resourceWords(match[2]!)
    return `${what === 'CPU' ? 'CPU' : what.toLowerCase()} ${match[1] === 'requests' ? 'request' : 'limit'}`
  }
  if (resource === 'cpu' || resource === 'memory') {
    return `${resource === 'cpu' ? 'CPU' : 'memory'} request`
  }
  return resource
}

/** "A, B and C". */
const listed = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
