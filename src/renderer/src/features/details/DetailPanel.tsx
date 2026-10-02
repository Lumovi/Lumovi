import { Maximize2, Minimize2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { apiKindOf, isBuiltinKind, kindOf } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { KindIcon } from '@renderer/components/KindIcon'
import { ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { useObject } from '@renderer/hooks/queries'
import { useViews } from '@renderer/hooks/views'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { statusFor } from '@renderer/lib/health'
import { formatRef, parseRef, type ObjectRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { ActionBar } from '../actions/ActionSurfaces'
import { actionsFor } from '../actions/catalog'
import { EventsTab } from './EventsTab'
import { LogsView, PodLogs } from '../logs/LogsView'
import { OverviewTab } from './OverviewTab'
import { PodsTab, podQuery } from './PodsTab'
import { RelatedTab, relatedOf } from './RelatedTab'
import { hasMetrics, MetricsTab } from '../metrics/MetricsTab'
import { ShellTab } from './ShellTab'
import { SidePanel, type PanelFrame } from './SidePanel'
import { YamlTab } from './YamlTab'

/**
 * The object named by the `?open=Kind/namespace/name` search param, in a
 * resizable pane next to the list.
 */
export function DetailPanel() {
  const value = useSearchParams()[0].get('open')
  // An edit in progress belongs to the object it was started on: opening another ends it.
  useEffect(() => {
    const { editing, edit } = useActionsUi.getState()
    if (editing && editing !== value) edit(null)
  }, [value])
  return (
    <SidePanel
      param="open"
      label={(shown) => {
        const target = parseRef(shown)
        return `${apiKindOf(target.kind)} ${target.name}`
      }}
      crashTitle="This object couldn’t be displayed"
      content={ObjectDetail}
    />
  )
}

function ObjectDetail({ value, ...frame }: PanelFrame) {
  return <Detail target={parseRef(value)} {...frame} />
}

function Detail({
  target,
  expanded,
  onExpand,
  onClose,
}: {
  target: ObjectRef
  expanded: boolean
  onExpand: () => void
  onClose: () => void
}) {
  const object = useObject(target.kind, target.name, target.namespace)
  // Views decide the icon, status and actions of the kinds they cover.
  useViews()
  const status = object.data && statusFor(target.kind, object.data)
  const involved = object.data?.involvedObject as { kind: string; name: string } | undefined
  const gone = (object.error as KubeApiError | null)?.code === 'not-found'

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Let open menus and dialogs handle Escape first; closing one marks the event handled.
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
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
    <>
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-2">
          <KindIcon kind={target.kind} className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink-3">
            {apiKindOf(target.kind)}
            {target.namespace && <span> · {target.namespace}</span>}
            {object.data && <span> · {age(object.data.metadata.creationTimestamp!)} old</span>}
          </p>
          <div className="flex min-w-0 items-start gap-1">
            <h2 className="line-clamp-2 text-[17px] leading-snug font-semibold tracking-[-0.01em] break-all selectable">
              {/* Events have hashed names; their reason and subject say more. */}
              {involved
                ? `${object.data!.reason as string} · ${involved.kind}/${involved.name}`
                : target.name}
            </h2>
            <CopyButton text={target.name} label="Copy name" />
          </div>
          {object.data && !gone && actionsFor(object.data).length > 0 && (
            <div className="mt-2.5">
              <ActionBar object={object.data} />
            </div>
          )}
        </div>
        {status && <StatusPill status={status} className="mt-2.5 shrink-0" />}
        <IconButton
          label={expanded ? 'Restore panel' : 'Expand panel'}
          onClick={onExpand}
          className="mt-0.5"
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton label="Close (Esc)" onClick={onClose} className="mt-0.5">
          <X />
        </IconButton>
      </header>
      {object.isPending ? (
        <Loading label="Loading…" />
      ) : gone || !object.data ? (
        <ErrorState error={object.error as KubeApiError} onRetry={() => void object.refetch()} />
      ) : (
        <>
          {object.isError && (
            <StaleNotice
              error={object.error as KubeApiError}
              onRetry={() => void object.refetch()}
            />
          )}
          <DetailTabs object={object.data} />
        </>
      )}
    </>
  )
}

function DetailTabs({ object }: { object: KubeObject }) {
  const kind = kindOf(object)
  // A view's pods are the ones it relates the object to; other related kinds get a tab each.
  const related = relatedOf(object)
  const ownPods = related.find((r) => r.kind === 'Pod')
  const others = related.filter((r) => r !== ownPods)
  const pods = ownPods
    ? { labelSelector: ownPods.labelSelector, fieldSelector: ownPods.fieldSelector }
    : podQuery(object)
  const podsNamespace = ownPods ? ownPods.namespace : (object.metadata.namespace ?? null)
  const ref = formatRef({ kind, name: object.metadata.name, namespace: object.metadata.namespace })
  const editing = useActionsUi((state) => state.editing === ref)
  const requested = useActionsUi((state) => (state.tab?.ref === ref ? state.tab.tab : null))
  const tabShown = useActionsUi((state) => state.tabShown)
  const [tab, setTab] = useState(requested ?? 'overview')
  // Editing happens in the YAML tab, and stays there until it's saved or cancelled.
  if (editing && tab !== 'yaml') setTab('yaml')
  // Actions like "Shell" ask for a tab; the request is done once it shows.
  if (requested && !editing && tab !== requested) setTab(requested)
  useEffect(() => {
    if (requested) tabShown()
  }, [requested, tabShown])
  // Workloads and services have the logs of their pods; a node's would be everything on it.
  const podLogs = pods && kind !== 'Node'
  // Custom kinds' pods have usage history too, found by name.
  const metrics = hasMetrics(kind) || (pods && !isBuiltinKind(kind))
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(pods ? [{ value: 'pods', label: ownPods?.name ?? 'Pods' }] : []),
    ...(podLogs ? [{ value: 'logs', label: 'Logs' }] : []),
    ...(kind === 'Pod'
      ? [
          { value: 'logs', label: 'Logs' },
          { value: 'shell', label: 'Shell' },
        ]
      : []),
    ...(metrics ? [{ value: 'metrics', label: 'Metrics' }] : []),
    ...others.map((r, i) => ({ value: `related:${i}`, label: r.name })),
    ...(kind === 'Event' ? [] : [{ value: 'events', label: 'Events' }]),
    { value: 'yaml', label: 'YAML' },
  ]
  const content = 'min-h-0 flex-1 animate-fade-in outline-none'
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (!editing) setTab(value)
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabList tabs={tabs} />
      <TabContent value="overview" className={cn(content, 'overflow-y-auto')}>
        <OverviewTab object={object} />
      </TabContent>
      {pods && (
        <TabContent value="pods" className={cn(content, 'flex flex-col')}>
          <PodsTab namespace={podsNamespace} query={pods} />
        </TabContent>
      )}
      {kind === 'Pod' && (
        <TabContent value="logs" className={cn(content, 'flex flex-col')}>
          <LogsView pods={[object]} name={object.metadata.name} />
        </TabContent>
      )}
      {podLogs && (
        <TabContent value="logs" className={cn(content, 'flex flex-col')}>
          <PodLogs namespace={podsNamespace} query={pods} name={object.metadata.name} />
        </TabContent>
      )}
      {kind === 'Pod' && (
        <TabContent value="shell" className={cn(content, 'flex flex-col')}>
          <ShellTab pod={object} />
        </TabContent>
      )}
      {metrics && (
        <TabContent value="metrics" className={cn(content, 'flex flex-col')}>
          <MetricsTab
            object={object}
            pods={isBuiltinKind(kind) ? undefined : { query: pods!, namespace: podsNamespace }}
          />
        </TabContent>
      )}
      {others.map((r, i) => (
        <TabContent key={i} value={`related:${i}`} className={cn(content, 'flex flex-col')}>
          <RelatedTab related={r} />
        </TabContent>
      ))}
      {kind !== 'Event' && (
        <TabContent value="events" className={cn(content, 'overflow-y-auto')}>
          <EventsTab object={object} />
        </TabContent>
      )}
      <TabContent value="yaml" className={cn(content, 'flex flex-col')}>
        <YamlTab object={object} />
      </TabContent>
    </Tabs>
  )
}
