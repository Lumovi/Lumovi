import type { KubeObject, MetricsSnapshot } from '@shared/api'
import { parseQuantity } from '@shared/quantity'

export interface Capacity {
  /** Live usage from metrics-server, when available. */
  used: number
  /** What the scheduler can hand out across all nodes. */
  total: number
}

export interface NodeUsage {
  metricsAvailable: boolean
  cpu: Capacity
  memory: Capacity
  sampledAt: number
}

export function allocatable(node: KubeObject): { cpu: number; memory: number; pods: number } {
  const alloc = node.status.allocatable
  return {
    cpu: parseQuantity(alloc.cpu),
    memory: parseQuantity(alloc.memory),
    pods: parseQuantity(alloc.pods),
  }
}

export function summarizeNodes(
  nodes: KubeObject[],
  metrics: MetricsSnapshot,
  sampledAt: number,
): NodeUsage {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const capacity = nodes.map(allocatable)
  return {
    metricsAvailable: metrics.available,
    sampledAt,
    cpu: { used: sum(metrics.items.map((m) => m.cpu)), total: sum(capacity.map((c) => c.cpu)) },
    memory: {
      used: sum(metrics.items.map((m) => m.memory)),
      total: sum(capacity.map((c) => c.memory)),
    },
  }
}

export interface Reservations {
  requests: number
  limits: number
}

/** Requests and limits of pods that still hold resources (not Succeeded/Failed). */
export function podReservations(pods: KubeObject[]): { cpu: Reservations; memory: Reservations } {
  const result = { cpu: { requests: 0, limits: 0 }, memory: { requests: 0, limits: 0 } }
  for (const pod of pods) {
    if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') continue
    for (const container of pod.spec.containers as {
      resources: { requests?: Record<string, string>; limits?: Record<string, string> }
    }[]) {
      const { requests = {}, limits = {} } = container.resources
      result.cpu.requests += parseQuantity(requests.cpu)
      result.cpu.limits += parseQuantity(limits.cpu)
      result.memory.requests += parseQuantity(requests.memory)
      result.memory.limits += parseQuantity(limits.memory)
    }
  }
  return result
}
