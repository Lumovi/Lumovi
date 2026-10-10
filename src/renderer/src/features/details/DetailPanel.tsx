import { ArrowLeft, Maximize2, Minimize2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { apiKindOf, isBuiltinKind, kindOf } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { barButton } from '@renderer/components/Sheet'
import { KindIcon } from '@renderer/components/KindIcon'
import { ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { useObject } from '@renderer/hooks/queries'
import { useResource } from '@renderer/hooks/resources'
import { useClusterName } from '@renderer/hooks/settings'
import { useViews } from '@renderer/hooks/views'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { age } from '@renderer/lib/format'
import { statusFor } from '@renderer/lib/health'
import { formatRef, parseRef, type ObjectRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { ActionBar } from '../actions/ActionSurfaces'
import { ObjectAudit } from '../audit/ObjectAudit'
import { actionsFor } from '../actions/catalog'
import { ON_A_PHONE } from '@renderer/web/phone-gate'
import { EventsTab } from './EventsTab'
import { LogsView, PodLogs } from '../logs/LogsView'
import { MapTab } from './MapTab'
import { OverviewTab } from './OverviewTab'
import { PodsTab, podQuery } from './PodsTab'
import { RelatedTab, relatedOf } from './RelatedTab'
import { hasMetrics, MetricsTab } from '../metrics/MetricsTab'
import { NodeShellTab } from './NodeShellTab'
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
  over,
  onExpand,
  onClose,
}: {
  target: ObjectRef
  expanded: boolean
  over: boolean
  onExpand: () => void
  onClose: () => void
}) {
  const object = useObject(target.kind, target.name, target.namespace)
  // Views decide the icon, status and actions of the kinds they cover.
  useViews()
  const status = object.data && statusFor(target.kind, object.data)
  const involved = object.data?.involvedObject as { kind: string; name: string } | undefined
  const gone = (object.error as KubeApiError | null)?.code === 'not-found'
  const phone = useLayout() === 'phone'
  const clusterName = useClusterName()(useCluster().context)
  const listName = useResource(target.kind).resource?.label ?? apiKindOf(target.kind)
  // Whether the object's own header has scrolled out from under the top bar (a phone's page).
  const page = useRef<HTMLDivElement>(null)
  // The tab chosen, kept here: a phone turned on its side is a tablet, whose detail is laid out
  // anew, and it shouldn't go back to the overview for that.
  const [chosen, setChosen] = useState<{ of: string; tab: string }>()
  const header = useRef<HTMLDivElement>(null)
  const [scrolledAway, setScrolledAway] = useState(false)
  useEffect(() => {
    if (!phone || !header.current) return
    const seen = new IntersectionObserver(([entry]) => setScrolledAway(!entry!.isIntersecting), {
      root: page.current,
    })
    seen.observe(header.current)
    return () => seen.disconnect()
  }, [phone])

  const title = involved
    ? `${object.data!.reason as string} · ${involved.kind}/${involved.name}`
    : target.name
  const body = object.isPending ? (
    <Loading label="Loading…" />
  ) : gone || !object.data ? (
    <ErrorState error={object.error as KubeApiError} onRetry={() => void object.refetch()} />
  ) : (
    <>
      {object.isError && (
        <StaleNotice error={object.error as KubeApiError} onRetry={() => void object.refetch()} />
      )}
      <DetailTabs
        object={object.data}
        chosen={chosen?.of === formatRef(target) ? chosen.tab : undefined}
        onChoose={(tab) => setChosen({ of: formatRef(target), tab })}
      />
    </>
  )

  // On a phone it's a page: a top bar with Back, and all of it scrolls under that, its tabs
  // staying. The bar names the list it came from while the object's own header shows, and the
  // object once that has scrolled away.
  if (phone) {
    const acts = object.data && !gone && actionsFor(object.data).some((a) => ON_A_PHONE.has(a.id))
    return (
      <>
        <header className="flex h-[52px] shrink-0 items-center border-b border-line bg-surface px-1">
          <button type="button" aria-label="Back" onClick={onClose} className={barButton}>
            <ArrowLeft />
          </button>
          <p
            aria-hidden={!scrolledAway}
            className="min-w-0 flex-1 px-1 text-[15px] leading-5 font-semibold tracking-[-0.01em]"
          >
            <MiddleTruncate text={scrolledAway ? title : listName} />
          </p>
        </header>
        <div
          ref={page}
          data-detail-page
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        >
          <div ref={header} className="px-4 pt-4 pb-3">
            {/* Which cluster: here is where Restart and Scale are, and no context row is. */}
            <p className="text-xs text-ink-3">
              <MiddleTruncate
                text={[apiKindOf(target.kind), target.namespace, clusterName]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </p>
            <div className="flex min-w-0 items-center gap-1 [&>button]:relative [&>button]:z-1 [&>button]:-my-2.5 [&>button]:-mr-2">
              <h2 className="line-clamp-2 min-w-0 flex-1 text-[17px] leading-snug font-semibold tracking-[-0.01em] wrap-anywhere selectable">
                {title}
              </h2>
              <CopyButton text={target.name} label="Copy name" />
            </div>
            {status && (
              <div className="mt-2.5 flex max-w-full min-w-0">
                <StatusPill status={status} />
              </div>
            )}
            {acts && (
              <div className="mt-3">
                <ActionBar object={object.data!} />
              </div>
            )}
          </div>
          {body}
        </div>
      </>
    )
  }

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
            <h2 className="line-clamp-2 text-[17px] leading-snug font-semibold tracking-[-0.01em] wrap-anywhere selectable">
              {/* Events have hashed names; their reason and subject say more. */}
              {involved
                ? `${object.data!.reason as string} · ${involved.kind}/${involved.name}`
                : target.name}
            </h2>
            <CopyButton text={target.name} label="Copy name" />
          </div>
          {/* Its status, then what can be done: under the name, which has the line to itself. */}
          {(status || (object.data && !gone && actionsFor(object.data).length > 0)) && (
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              {status && (
                <div className="max-w-full min-w-0">
                  <StatusPill status={status} />
                </div>
              )}
              {object.data && !gone && actionsFor(object.data).length > 0 && (
                <ActionBar object={object.data} />
              )}
            </div>
          )}
        </div>
        {!over && (
          <IconButton
            label={expanded ? 'Restore panel' : 'Expand panel'}
            onClick={onExpand}
            className="mt-0.5"
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        )}
        <IconButton label="Close (Esc)" onClick={onClose} className="mt-0.5">
          <X />
        </IconButton>
      </header>
      {body}
    </>
  )
}

/** Kinds that relate to everything in their scope, or to nothing: no map. */
const MAPLESS = new Set(['Event', 'Namespace'])
const NOT_ON_A_PHONE = new Set(['shell', 'map'])

function DetailTabs({
  object,
  chosen,
  onChoose,
}: {
  object: KubeObject
  /** The tab chosen before the detail was laid out anew, if one was. */
  chosen?: string
  onChoose: (tab: string) => void
}) {
  const kind = kindOf(object)
  const { context } = useCluster()
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
  const [tab, setTab] = useState(requested ?? chosen ?? 'overview')
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
  const phone = useLayout() === 'phone'
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(pods ? [{ value: 'pods', label: ownPods?.name ?? 'Pods' }] : []),
    ...(podLogs ? [{ value: 'logs', label: 'Logs' }] : []),
    ...(kind === 'Node' ? [{ value: 'shell', label: 'Shell' }] : []),
    ...(kind === 'Pod'
      ? [
          { value: 'logs', label: 'Logs' },
          { value: 'shell', label: 'Shell' },
        ]
      : []),
    ...(metrics ? [{ value: 'metrics', label: 'Metrics' }] : []),
    ...others.map((r, i) => ({ value: `related:${i}`, label: r.name })),
    ...(MAPLESS.has(kind) ? [] : [{ value: 'map', label: 'Map' }]),
    ...(kind === 'Event' ? [] : [{ value: 'events', label: 'Events' }]),
    { value: 'audit', label: 'Audit' },
    { value: 'yaml', label: 'YAML' },
    // A shell needs a keyboard, and a map more room than a phone has: neither is offered there.
  ].filter((tab) => !phone || !NOT_ON_A_PHONE.has(tab.value))
  const shown = tabs.some((t) => t.value === tab) ? tab : 'overview'
  const content = 'min-h-0 flex-1 animate-fade-in outline-none'
  // On a phone the page scrolls, not the tab: what's as long as it is (facts, events) is just
  // there, and what scrolls by itself (logs, a list) gets what the screen has under the top bar
  // and the tabs.
  const long = cn(content, 'overflow-y-auto phone:flex-none phone:overflow-visible')
  const own = cn(content, 'flex flex-col phone:h-[calc(100dvh-96px)] phone:flex-none')
  return (
    <Tabs
      value={shown}
      onValueChange={(value) => {
        if (editing) return
        setTab(value)
        onChoose(value)
      }}
      className="flex min-h-0 flex-1 flex-col phone:min-h-[calc(100dvh-52px)] phone:flex-none"
    >
      <TabList tabs={tabs} />
      <TabContent value="overview" className={long}>
        <OverviewTab object={object} />
      </TabContent>
      {pods && (
        <TabContent value="pods" className={own}>
          <PodsTab namespace={podsNamespace} query={pods} />
        </TabContent>
      )}
      {kind === 'Pod' && (
        <TabContent value="logs" className={own}>
          <LogsView pods={[object]} name={object.metadata.name} />
        </TabContent>
      )}
      {podLogs && (
        <TabContent value="logs" className={own}>
          <PodLogs namespace={podsNamespace} query={pods} name={object.metadata.name} />
        </TabContent>
      )}
      {kind === 'Pod' && !phone && (
        <TabContent value="shell" className={own}>
          <ShellTab pod={object} />
        </TabContent>
      )}
      {kind === 'Node' && !phone && (
        <TabContent value="shell" className={own}>
          <NodeShellTab node={object} />
        </TabContent>
      )}
      {metrics && (
        <TabContent value="metrics" className={own}>
          <MetricsTab
            object={object}
            pods={isBuiltinKind(kind) ? undefined : { query: pods!, namespace: podsNamespace }}
          />
        </TabContent>
      )}
      {others.map((r, i) => (
        <TabContent key={i} value={`related:${i}`} className={own}>
          <RelatedTab related={r} />
        </TabContent>
      ))}
      {kind !== 'Event' && (
        <TabContent value="events" className={long}>
          <EventsTab object={object} />
        </TabContent>
      )}
      {!MAPLESS.has(kind) && !phone && (
        <TabContent value="map" className={own}>
          <MapTab object={object} />
        </TabContent>
      )}
      <TabContent value="audit" className={long}>
        <ObjectAudit
          context={context}
          kind={kind}
          name={object.metadata.name}
          namespace={object.metadata.namespace}
        />
      </TabContent>
      <TabContent value="yaml" className={own}>
        <YamlTab object={object} />
      </TabContent>
    </Tabs>
  )
}
