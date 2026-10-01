import { Maximize2, Minimize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { apiKindOf, kindOf } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { KindIcon } from '@renderer/components/KindIcon'
import { ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { useObject } from '@renderer/hooks/queries'
import { useViews } from '@renderer/hooks/views'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { statusFor } from '@renderer/lib/health'
import { formatRef, parseRef, type ObjectRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { usePrefs } from '@renderer/state/prefs'
import { ActionBar } from '../actions/ActionSurfaces'
import { actionsFor } from '../actions/catalog'
import { CrashView } from '../errors/CrashView'
import { ErrorBoundary } from '../errors/ErrorBoundary'
import { EventsTab } from './EventsTab'
import { LogsTab } from './LogsTab'
import { OverviewTab } from './OverviewTab'
import { PodsTab, podQuery } from './PodsTab'
import { hasMetrics, MetricsTab } from '../metrics/MetricsTab'
import { ShellTab } from './ShellTab'
import { YamlTab } from './YamlTab'

const DEFAULT_WIDTH = 600
const MIN_WIDTH = 400
/** Arrow keys on the resize handle move it by this much. */
const RESIZE_STEP = 32

/**
 * The object named by the `?open=Kind/namespace/name` search param, in a
 * resizable pane next to the list. It animates in and out, and returns focus
 * to where it was when it closes.
 */
export function DetailPanel() {
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const value = params.get('open')
  // Keep showing the last object while the panel animates out.
  const [shown, setShown] = useState(value)
  if (value && value !== shown) setShown(value)
  const closing = !value && shown !== null
  const returnFocus = useRef<Element | null>(null)
  const [expanded, setExpanded] = useState(false)
  const storedWidth = usePrefs((prefs) => prefs.panelWidth)
  const setStoredWidth = usePrefs((prefs) => prefs.setPanelWidth)
  const [width, setWidth] = useState(storedWidth ?? DEFAULT_WIDTH)

  useEffect(() => {
    if (value) returnFocus.current ??= document.activeElement
  }, [value])

  // An edit in progress belongs to the object it was started on: opening another ends it.
  useEffect(() => {
    const { editing, edit } = useActionsUi.getState()
    if (editing && editing !== value) edit(null)
  }, [value])

  if (!shown) return null

  const close = () => {
    updateParams((current) => current.delete('open'))
    ;(returnFocus.current as HTMLElement | null)?.focus()
    returnFocus.current = null
  }

  const resizeTo = (next: number) => {
    const clamped = Math.round(Math.max(MIN_WIDTH, next))
    setWidth(clamped)
    setStoredWidth(clamped)
  }

  const startResize = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = width
    const onMove = (move: globalThis.PointerEvent) => resizeTo(startWidth + startX - move.clientX)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), {
      once: true,
    })
  }

  const onHandleKey = (event: KeyboardEvent) => {
    const delta = ({ ArrowLeft: RESIZE_STEP, ArrowRight: -RESIZE_STEP } as Record<string, number>)[
      event.key
    ]
    if (delta) resizeTo(width + delta)
  }

  const target = parseRef(shown)
  return (
    <aside
      aria-label={`${apiKindOf(target.kind)} ${target.name}`}
      onAnimationEnd={() => {
        if (closing) setShown(null)
      }}
      style={{ width: expanded ? undefined : width }}
      className={cn(
        'flex min-w-0 shrink-0 flex-col bg-surface',
        // Expanded, it covers the list; otherwise it sits beside it.
        expanded
          ? 'absolute inset-0 z-20'
          : 'relative max-w-[calc(100%-280px)] border-l border-line',
        closing ? 'animate-slide-out' : 'animate-slide-in',
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onHandleKey}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100"
      />
      <ErrorBoundary
        key={shown}
        fallback={(error) => <CrashView error={error} title="This object couldn’t be displayed" />}
      >
        <Detail
          target={target}
          expanded={expanded}
          onExpand={() => setExpanded(!expanded)}
          onClose={close}
        />
      </ErrorBoundary>
    </aside>
  )
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
  const pods = podQuery(object)
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
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(pods ? [{ value: 'pods', label: 'Pods' }] : []),
    ...(kind === 'Pod'
      ? [
          { value: 'logs', label: 'Logs' },
          { value: 'shell', label: 'Shell' },
        ]
      : []),
    ...(hasMetrics(kind) ? [{ value: 'metrics', label: 'Metrics' }] : []),
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
          <PodsTab namespace={object.metadata.namespace} query={pods} />
        </TabContent>
      )}
      {kind === 'Pod' && (
        <TabContent value="logs" className={cn(content, 'flex flex-col')}>
          <LogsTab pod={object} />
        </TabContent>
      )}
      {kind === 'Pod' && (
        <TabContent value="shell" className={cn(content, 'flex flex-col')}>
          <ShellTab pod={object} />
        </TabContent>
      )}
      {hasMetrics(kind) && (
        <TabContent value="metrics" className={cn(content, 'flex flex-col')}>
          <MetricsTab object={object} />
        </TabContent>
      )}
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
