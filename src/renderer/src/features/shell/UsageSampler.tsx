import { useEffect } from 'react'
import { useNodeUsage } from '@renderer/hooks/usage'
import { useCluster } from '@renderer/state/cluster'
import { useUsageHistory } from '@renderer/state/usage-history'

/** Records cluster usage on every metrics refresh, so the overview can draw trends. */
export function UsageSampler() {
  const { context } = useCluster()
  const usage = useNodeUsage()
  const record = useUsageHistory((state) => state.record)
  const sampledAt = usage?.sampledAt

  useEffect(() => {
    if (!usage?.metricsAvailable) return
    record(context, {
      at: usage.sampledAt,
      cpu: usage.cpu.used / usage.cpu.total,
      memory: usage.memory.used / usage.memory.total,
    })
    // Record once per metrics sample, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, sampledAt])

  return null
}
