import { LinkTab, LinkTabs } from '@renderer/components/LinkTabs'
import { metricsPath, rightsizingPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'

/** Usage history, and what workloads should request from it: one tab apart. */
export function MetricsTabs({ current }: { current: 'usage' | 'rightsizing' }) {
  const { context } = useCluster()
  return (
    <LinkTabs label="Metrics views">
      <LinkTab to={metricsPath(context)} active={current === 'usage'} label="Usage" />
      <LinkTab
        to={rightsizingPath(context)}
        active={current === 'rightsizing'}
        label="Right-sizing"
      />
    </LinkTabs>
  )
}
