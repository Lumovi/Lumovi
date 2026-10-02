import { builtinResource } from '@shared/resources'
import { LinkTab, LinkTabs } from '@renderer/components/LinkTabs'
import { useList } from '@renderer/hooks/queries'
import { kindPath, workloadsPath } from '@renderer/lib/routes'
import { WORKLOAD_TYPES, type WorkloadType } from '@renderer/lib/workloads'
import { useCluster } from '@renderer/state/cluster'

/**
 * Every workload, or one kind of them: the Workloads page and each kind's own
 * list (with that kind's columns and actions), one tab apart.
 */
export function WorkloadTabs({ current }: { current?: WorkloadType }) {
  const { context } = useCluster()
  return (
    <LinkTabs label="Workload types">
      <LinkTab to={workloadsPath(context)} active={!current} label="All" />
      {WORKLOAD_TYPES.map((type) => (
        <TypeTab key={type} type={type} active={type === current} />
      ))}
    </LinkTabs>
  )
}

function TypeTab({ type, active }: { type: WorkloadType; active: boolean }) {
  const { context } = useCluster()
  const count = useList(type).data?.length
  return (
    <LinkTab
      to={kindPath(context, type)}
      active={active}
      label={builtinResource(type)!.label}
      count={count}
    />
  )
}
