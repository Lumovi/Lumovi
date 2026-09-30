import { useList, useMetrics } from './queries'
import { summarizeNodes, type NodeUsage } from '@renderer/lib/usage'

/** Cluster-wide CPU and memory: live usage (if metrics-server runs) against allocatable capacity. */
export function useNodeUsage(): NodeUsage | undefined {
  const nodes = useList('Node', { namespace: null })
  const metrics = useMetrics('nodes')
  if (!nodes.data || !metrics.data) return undefined
  return summarizeNodes(nodes.data, metrics.data, metrics.dataUpdatedAt)
}
