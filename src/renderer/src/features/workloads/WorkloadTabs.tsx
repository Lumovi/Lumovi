import { builtinResource } from '@shared/resources'
import { useGo } from '@renderer/hooks/go'
import { useList } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
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
    <nav aria-label="Workload types" className="flex shrink-0 gap-1 border-b border-line px-5">
      <Tab to={workloadsPath(context)} active={!current} label="All" />
      {WORKLOAD_TYPES.map((type) => (
        <TypeTab key={type} type={type} active={type === current} />
      ))}
    </nav>
  )
}

function TypeTab({ type, active }: { type: WorkloadType; active: boolean }) {
  const { context } = useCluster()
  const count = useList(type).data?.length
  return (
    <Tab
      to={kindPath(context, type)}
      active={active}
      label={builtinResource(type)!.label}
      count={count}
    />
  )
}

function Tab({
  to,
  active,
  label,
  count,
}: {
  to: string
  active: boolean
  label: string
  count?: number
}) {
  const go = useGo()
  return (
    <a
      href={`#${to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault()
        go(to)
      }}
      className={cn(
        'relative flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3',
        active &&
          'text-ink-1 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
      )}
    >
      {label}
      {count !== undefined && (
        <span className="text-xs font-normal text-ink-3 tabular-nums">{count}</span>
      )}
    </a>
  )
}
