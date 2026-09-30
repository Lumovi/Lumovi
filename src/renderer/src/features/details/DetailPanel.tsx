import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { resourceByKind, type ResourceKind } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { ErrorState, Loading } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { useObject } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { age } from '@renderer/lib/format'
import { hasHealth, statusOf } from '@renderer/lib/health'
import { parseRef, type ObjectRef } from '@renderer/lib/routes'
import { EventsTab } from './EventsTab'
import { LogsTab } from './LogsTab'
import { OverviewTab } from './OverviewTab'
import { PodsTab, podQuery } from './PodsTab'
import { YamlTab } from './YamlTab'

/** Shows the object named by the `?open=Kind/namespace/name` search param. */
export function DetailPanel() {
  const [params, setParams] = useSearchParams()
  const value = params.get('open')
  if (!value) return null
  const close = () =>
    setParams((current) => {
      current.delete('open')
      return current
    })
  return <Detail key={value} target={parseRef(value)} onClose={close} />
}

function Detail({ target, onClose }: { target: ObjectRef; onClose: () => void }) {
  const object = useObject(target.kind, target.name, target.namespace)
  const resource = resourceByKind(target.kind)
  const Icon = KIND_ICONS[target.kind]

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Let open menus and dialogs handle Escape first.
      if (
        event.key === 'Escape' &&
        !document.querySelector(
          '[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]',
        )
      ) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <aside
      aria-label={`${target.kind} ${target.name}`}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(760px,64%)] animate-slide-in flex-col border-l border-line-strong bg-surface shadow-pop"
    >
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-2">
          <Icon className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3">
            {resource.kind}
            {target.namespace && <span> · {target.namespace}</span>}
            {object.data && <span> · {age(object.data.metadata.creationTimestamp!)} old</span>}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em] selectable">
              {target.name}
            </h2>
            <CopyButton text={target.name} label="Copy name" />
          </div>
        </div>
        {object.data && hasHealth(target.kind) && (
          <StatusPill status={statusOf(target.kind, object.data)} className="mt-2.5" />
        )}
        <IconButton label="Close" onClick={onClose} className="mt-0.5">
          <X />
        </IconButton>
      </header>
      {object.isPending ? (
        <Loading label="Loading…" />
      ) : object.isError ? (
        <ErrorState error={object.error as KubeApiError} onRetry={() => void object.refetch()} />
      ) : (
        <DetailTabs object={object.data} />
      )}
    </aside>
  )
}

function DetailTabs({ object }: { object: KubeObject }) {
  const kind = object.kind as ResourceKind
  const pods = podQuery(object)
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(pods ? [{ value: 'pods', label: 'Pods' }] : []),
    ...(kind === 'Pod' ? [{ value: 'logs', label: 'Logs' }] : []),
    ...(kind === 'Event' ? [] : [{ value: 'events', label: 'Events' }]),
    { value: 'yaml', label: 'YAML' },
  ]
  return (
    <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
      <TabList tabs={tabs} />
      <TabContent value="overview" className="min-h-0 flex-1 overflow-y-auto outline-none">
        <OverviewTab object={object} />
      </TabContent>
      {pods && (
        <TabContent value="pods" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <PodsTab namespace={object.metadata.namespace} query={pods} />
        </TabContent>
      )}
      <TabContent value="logs" className="flex min-h-0 flex-1 flex-col outline-none">
        <LogsTab pod={object} />
      </TabContent>
      <TabContent value="events" className="min-h-0 flex-1 overflow-y-auto outline-none">
        <EventsTab object={object} />
      </TabContent>
      <TabContent value="yaml" className="flex min-h-0 flex-1 flex-col outline-none">
        <YamlTab object={object} />
      </TabContent>
    </Tabs>
  )
}
