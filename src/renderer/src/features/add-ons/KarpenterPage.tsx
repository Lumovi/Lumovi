import { useQueryClient } from '@tanstack/react-query'
import { CircleCheck, RefreshCw, Rocket } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import { Card } from '@renderer/components/Card'
import { KIND_ICONS, kindIcon } from '@renderer/components/KindIcon'
import { Meter } from '@renderer/components/Meter'
import { EmptyState, StaleNotice } from '@renderer/components/States'
import { HEALTH_STYLE, StatusDot, StatusPill } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useList, useMetrics } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age, formatBytes, formatCpu, pluralize } from '@renderer/lib/format'
import { nodeStatus, statusOf, type Status } from '@renderer/lib/health'
import { allocatable } from '@renderer/lib/usage'
import { Body, MiniMeter, Tile } from '../overview/OverviewPage'

const NODE_POOL = 'NodePool.karpenter.sh'
const NODE_CLAIM = 'NodeClaim.karpenter.sh'

/** The labels Karpenter puts on the nodes it launches (and their claims). */
const LABELS = {
  pool: 'karpenter.sh/nodepool',
  capacity: 'karpenter.sh/capacity-type',
  type: 'node.kubernetes.io/instance-type',
  zone: 'topology.kubernetes.io/zone',
}

/** Requirements that say what a node pool's nodes can be, in the order they're described. */
const FAMILIES = [
  'karpenter.k8s.aws/instance-family',
  'karpenter.k8s.aws/instance-category',
  'karpenter.azure.com/sku-family',
  LABELS.type,
]

const UNHEALTHY = 'health=critical,warning'

/** Rows in a list before "Show all", so a big cluster's page stays one screen or so. */
const ROWS = 6

/** The first few of `items`, and a button for the rest. */
function Capped<T>({ items, children }: { items: T[]; children: (shown: T[]) => ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      {children(expanded ? items : items.slice(0, ROWS))}
      {items.length > ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 self-start rounded-md px-2 py-1 text-xs font-medium text-accent-strong hover:bg-accent-soft"
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}

const labelOf = (object: KubeObject, label: string) => object.metadata.labels?.[label]

interface Condition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime: string
}

/** One of an object's conditions, if it has it. */
function conditionOf(object: KubeObject, type: string): Condition | undefined {
  return (object.status?.conditions as Condition[] | undefined)?.find((c) => c.type === type)
}

/** A node claim on its way to being a node: launched, but not registered yet. */
const launching = (claim: KubeObject) =>
  conditionOf(claim, 'Registered')?.status !== 'True' &&
  conditionOf(claim, 'Launched')?.status !== 'False' &&
  !claim.metadata.deletionTimestamp

/** A pod the scheduler couldn't place anywhere: what Karpenter launches nodes for. */
const waiting = (pod: KubeObject) => conditionOf(pod, 'PodScheduled')?.reason === 'Unschedulable'

/**
 * Why a node claim's node is going away, or could: being replaced, drifted
 * from its node pool or node class, or cheaper to do without.
 */
function disruption(
  claim: KubeObject,
  node: KubeObject | undefined,
): { status: Status; since: string } | undefined {
  const drifted = conditionOf(claim, 'Drifted')
  const consolidatable = conditionOf(claim, 'Consolidatable')
  const disrupted = (node?.spec?.taints as { key: string; timeAdded: string }[] | undefined)?.find(
    (taint) => taint.key === 'karpenter.sh/disrupted',
  )
  if (claim.metadata.deletionTimestamp) {
    return {
      status: { health: 'progressing', label: 'Terminating' },
      since: claim.metadata.deletionTimestamp,
    }
  }
  if (disrupted) {
    return {
      status: { health: 'progressing', label: 'Being replaced' },
      since: disrupted.timeAdded,
    }
  }
  if (drifted?.status === 'True') {
    return {
      status: {
        health: 'warning',
        label: 'Drifted',
        detail: drifted.message,
      },
      since: drifted.lastTransitionTime,
    }
  }
  if (consolidatable?.status === 'True') {
    return {
      status: {
        health: 'neutral',
        label: 'Consolidatable',
        detail: 'Its pods fit elsewhere, or on a cheaper node.',
      },
      since: consolidatable.lastTransitionTime,
    }
  }
  return undefined
}

/** "Spot, on-demand · m6i, c6i": what a node pool's nodes can be. */
function poolKinds(pool: KubeObject): string {
  // Every node pool has requirements (its CRD says so).
  const requirements = pool.spec.template.spec.requirements as {
    key: string
    operator: string
    values?: string[]
  }[]
  const values = (key: string) =>
    requirements.find((r) => r.key === key && r.operator === 'In')?.values ?? []
  const capacity = values(LABELS.capacity)
  const families = FAMILIES.map(values).find((found) => found.length > 0) ?? []
  const types = (capacity.length ? capacity : ['on-demand']).join(', ')
  return [types.charAt(0).toUpperCase() + types.slice(1), families.join(', ')]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Karpenter's page: its node pools against their limits, the nodes they
 * launched, what's on its way, what's being replaced, and the pods waiting
 * for a node.
 */
export function KarpenterPage() {
  const pools = useList(NODE_POOL, { namespace: null })
  const claims = useList(NODE_CLAIM, { namespace: null })
  const nodes = useList('Node', { namespace: null })
  const pods = useList('Pod', { namespace: null })
  const queryClient = useQueryClient()
  // Keep showing what loaded before, but say when part of it couldn't be refreshed.
  const stale = [pools, claims, nodes, pods].find((query) => query.isError && query.data)
  const own = (nodes.data ?? []).filter((node) => labelOf(node, LABELS.pool))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="@container space-y-4 px-6 py-5">
        {stale && (
          <div className="overflow-hidden rounded-xl border border-warn/25">
            <StaleNotice
              error={stale.error as KubeApiError}
              onRetry={() => void queryClient.invalidateQueries()}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 @4xl:grid-cols-4">
          <PoolsTile pools={pools.data} />
          <NodesTile nodes={nodes.data && own} />
          <LaunchingTile claims={claims.data} pods={pods.data} />
          <ReplacingTile claims={claims.data} nodes={nodes.data} />
        </div>

        <Card title="Node pools" className="animate-rise [animation-delay:60ms]">
          <Body query={pools}>{(data) => <NodePools pools={data} nodes={own} />}</Body>
        </Card>

        <div className="grid animate-rise gap-4 [animation-delay:120ms] @4xl:grid-cols-12">
          <Card title="Nodes" className="@4xl:col-span-7">
            <Body query={claims}>{(data) => <Nodes claims={data} nodes={own} />}</Body>
          </Card>
          <Card title="Node mix" className="@4xl:col-span-5">
            <Body query={nodes}>{() => <NodeMix nodes={own} />}</Body>
          </Card>
        </div>

        <div className="grid animate-rise gap-4 [animation-delay:180ms] @4xl:grid-cols-12">
          <Card title="Disruption" className="@4xl:col-span-7">
            <Body query={claims}>{(data) => <Replacing claims={data} nodes={own} />}</Body>
          </Card>
          <Card title="Waiting for a node" className="@4xl:col-span-5">
            <Body query={pods}>{(data) => <Waiting pods={data} />}</Body>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ——— Tiles ———

function PoolsTile({ pools }: { pools?: KubeObject[] }) {
  const Icon = kindIcon(NODE_POOL)
  const to = `r/${NODE_POOL}`
  if (!pools) return <Tile icon={Icon} label="Node pools ready" to={to} />
  const failing = pools.filter((pool) => statusOf(NODE_POOL, pool).health === 'critical').length
  return (
    <Tile
      icon={Icon}
      label="Node pools ready"
      value={`${pools.length - failing}/${pools.length}`}
      status={failing ? 'critical' : 'healthy'}
      detail={failing ? `${failing} not ready` : 'All ready'}
      to={failing ? `${to}?${UNHEALTHY}` : to}
    />
  )
}

function NodesTile({ nodes }: { nodes?: KubeObject[] }) {
  const to = `nodes?labels=${LABELS.pool}`
  if (!nodes) return <Tile icon={KIND_ICONS.Node} label="Nodes ready" to={to} />
  const notReady = nodes.filter((node) => nodeStatus(node).health === 'critical').length
  const spot = nodes.filter((node) => labelOf(node, LABELS.capacity) === 'spot').length
  return (
    <Tile
      icon={KIND_ICONS.Node}
      label="Nodes ready"
      value={`${nodes.length - notReady}/${nodes.length}`}
      status={notReady ? 'critical' : 'healthy'}
      detail={notReady ? `${notReady} not ready` : `${spot} of ${nodes.length} on spot`}
      to={notReady ? `${to}&${UNHEALTHY}` : to}
    />
  )
}

function LaunchingTile({ claims, pods }: { claims?: KubeObject[]; pods?: KubeObject[] }) {
  const to = `r/${NODE_CLAIM}`
  if (!claims || !pods) return <Tile icon={Rocket} label="Launching" to={to} />
  const count = claims.filter(launching).length
  const pending = pods.filter(waiting).length
  return (
    <Tile
      icon={Rocket}
      label="Launching"
      value={count}
      status={count ? 'progressing' : pending ? 'warning' : 'healthy'}
      detail={pending ? `${pluralize(pending, 'pod')} waiting` : 'No pods waiting'}
      to={count ? `${to}?health=progressing` : to}
    />
  )
}

function ReplacingTile({ claims, nodes }: { claims?: KubeObject[]; nodes?: KubeObject[] }) {
  const to = `r/${NODE_CLAIM}`
  if (!claims || !nodes) return <Tile icon={RefreshCw} label="Being replaced" to={to} />
  const byName = new Map(nodes.map((node) => [node.metadata.name, node]))
  const replacing = claims.filter((claim) => {
    const found = disruption(claim, byName.get(claim.status?.nodeName))
    return found && found.status.health !== 'neutral'
  }).length
  return (
    <Tile
      icon={RefreshCw}
      label="Being replaced"
      value={replacing}
      status={replacing ? 'warning' : 'healthy'}
      detail={replacing ? 'Drifted or terminating' : 'Nothing to replace'}
      to={to}
    />
  )
}

// ——— Node pools ———

/** How much of a limit a node pool's nodes take up; a dashed track when it has none. */
function LimitMeter({
  label,
  used,
  limit,
  format,
  pool,
}: {
  label: string
  used: number
  limit: number
  /** An amount, and its unit when it isn't part of it ("cores"). */
  format: (value: number) => [string, string?]
  pool: string
}) {
  const shown = (value: number) => format(value).join(' ')
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex justify-between gap-2 text-2xs text-ink-3">
        {label}
        <span className="truncate text-ink-2 tabular-nums">
          {limit ? `${format(used)[0]} of ${shown(limit)}` : `${shown(used)} · no limit`}
        </span>
      </span>
      {limit ? (
        <Meter value={used / limit} label={`${pool} ${label} of its limit`} />
      ) : (
        <span
          title="No limit"
          className="h-1.5 rounded-full border border-dashed border-line-strong"
        />
      )}
    </span>
  )
}

function NodePools({ pools, nodes }: { pools: KubeObject[]; nodes: KubeObject[] }) {
  const open = useOpenObject()
  if (pools.length === 0) {
    return (
      <EmptyState icon={kindIcon(NODE_POOL)} title="No node pools" className="py-6">
        Karpenter launches nodes for the node pools you create.
      </EmptyState>
    )
  }
  const cores = (value: number): [string, string] => [formatCpu(value), 'cores']
  const bytes = (value: number): [string] => [formatBytes(value)]
  return (
    <ul aria-label="Node pools" className="-mx-2 space-y-0.5">
      {[...pools]
        .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
        .map((pool) => {
          const { name } = pool.metadata
          const status = statusOf(NODE_POOL, pool)
          const count = nodes.filter((node) => labelOf(node, LABELS.pool) === name).length
          const resources = pool.status?.resources ?? {}
          const limits = pool.spec?.limits ?? {}
          return (
            <li key={name}>
              <button
                type="button"
                onClick={() => open(NODE_POOL, name)}
                className="grid w-full grid-cols-[minmax(0,1.4fr)_72px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-5 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <StatusDot health={status.health} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{name}</span>
                    <span
                      className={cn(
                        'block truncate text-xs',
                        status.detail ? HEALTH_STYLE[status.health].text : 'text-ink-3',
                      )}
                    >
                      {status.detail ? `${status.label} · ${status.detail}` : poolKinds(pool)}
                    </span>
                  </span>
                </span>
                <span className="text-xs text-ink-2 tabular-nums">{pluralize(count, 'node')}</span>
                <LimitMeter
                  label="CPU"
                  used={parseQuantity(resources.cpu)}
                  limit={parseQuantity(limits.cpu)}
                  format={cores}
                  pool={name}
                />
                <LimitMeter
                  label="Memory"
                  used={parseQuantity(resources.memory)}
                  limit={parseQuantity(limits.memory)}
                  format={bytes}
                  pool={name}
                />
              </button>
            </li>
          )
        })}
    </ul>
  )
}

// ——— Nodes ———

/** "m6i.2xlarge · spot · eu-west-1b" */
const describe = (object: KubeObject) =>
  [LABELS.type, LABELS.capacity, LABELS.zone]
    .map((label) => labelOf(object, label))
    .filter(Boolean)
    .join(' · ')

/** Karpenter's nodes by node pool, with their usage, and the ones still launching. */
function Nodes({ claims, nodes }: { claims: KubeObject[]; nodes: KubeObject[] }) {
  const metrics = useMetrics('nodes')
  const samples = new Map(metrics.data?.items.map((s) => [s.name, s]))
  const coming = claims.filter(launching)
  if (nodes.length === 0 && coming.length === 0) {
    return (
      <EmptyState icon={KIND_ICONS.Node} title="No nodes yet" className="py-6">
        Karpenter launches nodes when pods need them.
      </EmptyState>
    )
  }
  const all = [...nodes, ...coming]
  const pools = [...new Set(all.map((object) => labelOf(object, LABELS.pool)!))].sort()
  return (
    <div className="-mt-1 space-y-3">
      {pools.map((pool) => (
        <section key={pool} aria-label={`Nodes of ${pool}`} className="flex flex-col">
          <h3 className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">{pool}</h3>
          <Capped items={all.filter((object) => labelOf(object, LABELS.pool) === pool)}>
            {(shown) => (
              <ul className="-mx-2 space-y-0.5">
                {shown.map((object) =>
                  object.kind === 'Node' ? (
                    <NodeRow
                      key={object.metadata.name}
                      node={object}
                      sample={samples.get(object.metadata.name)}
                    />
                  ) : (
                    <LaunchingRow key={object.metadata.name} claim={object} />
                  ),
                )}
              </ul>
            )}
          </Capped>
        </section>
      ))}
    </div>
  )
}

/** A node, with its live usage when metrics-server knows it. */
function NodeRow({ node, sample }: { node: KubeObject; sample?: { cpu: number; memory: number } }) {
  const open = useOpenObject()
  const status = nodeStatus(node)
  const alloc = allocatable(node)
  const { name } = node.metadata
  return (
    <li>
      <button
        type="button"
        onClick={() => open('Node', name)}
        className="grid w-full grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-4 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot health={status.health} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{name}</span>
            <span className="block truncate text-xs text-ink-3">{describe(node)}</span>
          </span>
        </span>
        {sample ? (
          <>
            <MiniMeter label="CPU" value={sample.cpu / alloc.cpu} node={name} />
            <MiniMeter label="Mem" value={sample.memory / alloc.memory} node={name} />
          </>
        ) : (
          <span className="col-span-2 text-right text-xs text-ink-3">
            {status.label} · {formatCpu(alloc.cpu)} cores
          </span>
        )}
      </button>
    </li>
  )
}

/** A node claim on its way to being a node. */
function LaunchingRow({ claim }: { claim: KubeObject }) {
  const open = useOpenObject()
  return (
    <li>
      <button
        type="button"
        onClick={() => open(NODE_CLAIM, claim.metadata.name)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot health="progressing" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{claim.metadata.name}</span>
            <span className="block truncate text-xs text-ink-3">{describe(claim)}</span>
          </span>
        </span>
        <span className="text-xs text-accent-strong">
          Launching · {age(claim.metadata.creationTimestamp!)}
        </span>
      </button>
    </li>
  )
}

// ——— Node mix ———

/** How many of `nodes` have each value of `label`, the most first (ties in the nodes' order). */
function countsOf(nodes: KubeObject[], label: string): [string, number][] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const value = labelOf(node, label)!
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

/** What the nodes are: instance types, capacity types and zones, and how many of each. */
function NodeMix({ nodes }: { nodes: KubeObject[] }) {
  if (nodes.length === 0) {
    return <p className="flex flex-1 items-center justify-center py-8 text-ink-3">No nodes yet.</p>
  }
  return (
    <div className="-mt-1 space-y-3">
      {(
        [
          ['Instance types', LABELS.type, true],
          ['Capacity types', LABELS.capacity, false],
          ['Zones', LABELS.zone, false],
        ] as const
      ).map(([title, label, mono]) => (
        <section key={label} aria-label={title}>
          <h3 className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">{title}</h3>
          <ul className="-mx-2">
            {countsOf(nodes, label).map(([value, count]) => (
              <li
                key={value}
                className="grid grid-cols-[minmax(0,1fr)_minmax(80px,45%)_24px] items-center gap-3 px-2 py-1.5"
              >
                <span className={cn('truncate', mono ? 'font-mono text-xs' : 'text-[13px]')}>
                  {value}
                </span>
                <span className="h-1.5 rounded-full bg-accent-track">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${(count / nodes.length) * 100}%` }}
                  />
                </span>
                <span className="text-right text-xs text-ink-2 tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ——— Disruption ———

/** Node claims being replaced, and ones Karpenter could replace or do without. */
function Replacing({ claims, nodes }: { claims: KubeObject[]; nodes: KubeObject[] }) {
  const open = useOpenObject()
  const byName = new Map(nodes.map((node) => [node.metadata.name, node]))
  const items = claims.flatMap((claim) => {
    const found = disruption(claim, byName.get(claim.status?.nodeName))
    return found ? [{ claim, ...found }] : []
  })
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-ink-3">
        <CircleCheck className="size-6 text-good" />
        Nothing is being disrupted.
      </div>
    )
  }
  return (
    <Capped items={items}>
      {(shown) => (
        <ul aria-label="Disruption" className="-mx-2 space-y-0.5">
          {shown.map(({ claim, status, since }) => (
            <li key={claim.metadata.name}>
              <button
                type="button"
                onClick={() => open(NODE_CLAIM, claim.metadata.name)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
              >
                <span className="w-36 shrink-0">
                  <StatusPill status={status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {claim.status?.nodeName ?? claim.metadata.name}
                  </span>
                  <span className="block truncate text-xs text-ink-3">
                    {[labelOf(claim, LABELS.pool), status.detail].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-ink-3">{age(since)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Capped>
  )
}

/** Pods the scheduler couldn't place, and why: Karpenter launches nodes for them. */
function Waiting({ pods }: { pods: KubeObject[] }) {
  const open = useOpenObject()
  const unplaced = pods.filter(waiting)
  if (unplaced.length === 0) {
    return (
      <p className="flex flex-1 items-center justify-center py-8 text-ink-3">
        No pods are waiting for a node.
      </p>
    )
  }
  return (
    <Capped items={unplaced}>
      {(shown) => (
        <ul aria-label="Waiting for a node" className="-mx-2 space-y-0.5">
          {shown.map((pod) => {
            return (
              <li key={`${pod.metadata.namespace}/${pod.metadata.name}`}>
                <button
                  type="button"
                  onClick={() => open('Pod', pod.metadata.name, pod.metadata.namespace)}
                  className="flex w-full gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
                >
                  <span
                    aria-hidden
                    className={cn('mt-1.5 size-2 shrink-0 rounded-full', HEALTH_STYLE.warning.dot)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-medium">{pod.metadata.name}</span>
                      <span className="truncate text-xs text-ink-3">{pod.metadata.namespace}</span>
                      <span className="flex-1" />
                      <span className="shrink-0 text-xs text-ink-3">
                        {age(pod.metadata.creationTimestamp!)}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-xs leading-relaxed text-ink-2">
                      {conditionOf(pod, 'PodScheduled')!.message}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Capped>
  )
}
