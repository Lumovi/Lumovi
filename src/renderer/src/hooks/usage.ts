import type { KubeApiError } from '@renderer/lib/api'
import { useList, useMetrics } from './queries'
import { summarizeNodes, type NodeUsage } from '@renderer/lib/usage'

/** Cluster-wide CPU and memory: live usage (if metrics-server runs) against allocatable capacity. */
export function useNodeUsage(): NodeUsage | undefined {
  const nodes = useList('Node', { namespace: null })
  const metrics = useMetrics('nodes')
  if (!nodes.data) return undefined
  if (metrics.data) return summarizeNodes(nodes.data, metrics.data, metrics.dataUpdatedAt)
  // Metrics that can't be read (the account may not, or the read failed) are none: capacity and
  // what's requested still show, and why there's no live usage is said.
  if (!metrics.isError) return undefined
  const code = (metrics.error as KubeApiError | null)?.code
  return {
    ...summarizeNodes(nodes.data, { available: false, items: [] }, metrics.errorUpdatedAt),
    unread: code === 'forbidden' || code === 'not-allowed' ? 'refused' : 'failed',
  }
}
