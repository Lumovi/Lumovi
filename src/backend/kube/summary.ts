/**
 * A cluster summed up for a fleet: what its overview's tiles say, counted here
 * rather than in the page, so a page of many clusters doesn't load all their
 * pods. It's asked as whoever is signed in, so it shows what they may see.
 */
import type { ClusterSummary, KubeList, KubeObject, Result } from '@shared/api'
import { nodeStatus, podStatus, replicaCounts, replicaStatus } from '@shared/health'
import { parseQuantity } from '@shared/quantity'
import type { KubeService } from './service'

const HOUR = 3_600_000

/** What's counted of a list, or why it couldn't be listed. */
function count<T>(list: Result<KubeList>, counted: (items: KubeObject[], list: KubeList) => T) {
  return list.ok ? { ok: true as const, data: counted(list.data.items, list.data) } : list
}

/** When an event last happened, as its list orders them. */
const lastSeen = (event: KubeObject) =>
  Date.parse((event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp) as string)

export async function clusterSummary(
  kube: KubeService,
  context: string,
  now = Date.now(),
): Promise<ClusterSummary> {
  const version = await kube.version(context)
  if (!version.ok) return { at: now, version }
  const list = (kind: string) => kube.list({ context, kind })
  const [nodes, pods, deployments, statefulSets, daemonSets, events, metrics] = await Promise.all([
    list('Node'),
    list('Pod'),
    list('Deployment'),
    list('StatefulSet'),
    list('DaemonSet'),
    list('Event'),
    kube.metrics({ context, target: 'nodes' }),
  ])
  return {
    at: now,
    version,
    nodes: count(nodes, (items) => ({
      ready: items.filter((n) => nodeStatus(n).health !== 'critical').length,
      total: items.length,
    })),
    pods: count(pods, (items, { truncated }) => {
      const statuses = items.map(podStatus)
      return {
        running: statuses.filter((s) => s.label === 'Running').length,
        unhealthy: statuses.filter((s) => s.health === 'critical' || s.health === 'warning').length,
        total: items.length,
        truncated,
      }
    }),
    workloads: workloadsOf([deployments, statefulSets, daemonSets]),
    warnings: count(events, (items) => ({
      lastHour: items.filter((e) => lastSeen(e) > now - HOUR && e.type === 'Warning').length,
    })),
    // What's in use is weighed against what the nodes can allocate: without them, it can't be.
    usage: !metrics.ok
      ? metrics
      : !nodes.ok
        ? nodes
        : !metrics.data.available
          ? { ok: true, data: null }
          : {
              ok: true,
              data: {
                cpu: {
                  used: sum(metrics.data.items.map((m) => m.cpu)),
                  total: sum(nodes.data.items.map((n) => parseQuantity(n.status.allocatable.cpu))),
                },
                memory: {
                  used: sum(metrics.data.items.map((m) => m.memory)),
                  total: sum(
                    nodes.data.items.map((n) => parseQuantity(n.status.allocatable.memory)),
                  ),
                },
              },
            },
  }
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** Deployments, StatefulSets and DaemonSets: how many are healthy, or why they couldn't be listed. */
function workloadsOf(lists: Result<KubeList>[]): ClusterSummary['workloads'] {
  const items: KubeObject[] = []
  for (const list of lists) {
    if (!list.ok) return list
    items.push(...list.data.items)
  }
  const health = items.map((w) => {
    const { ready, desired } = replicaCounts(w)
    return replicaStatus(ready, desired).health
  })
  return {
    ok: true,
    data: {
      healthy: health.filter((h) => h === 'healthy' || h === 'neutral').length,
      total: items.length,
    },
  }
}
