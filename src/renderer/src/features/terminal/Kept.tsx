/**
 * An object kept open below: its tab in the bar, and the object itself at the size of the tabs
 * below. It's read in its own cluster, whichever the window shows, and keeps its own tab as it's
 * shown; its first row is its tabs, then its status, its actions and "Open in the panel".
 */
import { AppWindow, ArrowUpRight, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import type { KubeObject } from '@shared/api'
import { apiKindOf, kindOf, type ResourceKind } from '@shared/resources'
import { Button, IconButton } from '@renderer/components/Button'
import { KindIcon } from '@renderer/components/KindIcon'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { ErrorState, Loading } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { Tooltip } from '@renderer/components/Tooltip'
import { useContexts, useObject } from '@renderer/hooks/queries'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useClusterName } from '@renderer/hooks/settings'
import { usePlugins } from '@renderer/hooks/plugins'
import { api, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { statusFor } from '@renderer/lib/health'
import { formatRef, kindPath, type ObjectRef } from '@renderer/lib/routes'
import { controllerOf } from '@renderer/lib/workloads'
import { ClusterContext, useCluster, type ClusterState } from '@renderer/state/cluster'
import { ActionBar } from '../actions/ActionSurfaces'
import { actionsFor } from '../actions/catalog'
import { DetailTabs } from '../details/DetailPanel'
import { menuContent, menuItem } from '../shell/menu-styles'
import { TheirText } from '@renderer/plugins/TheirText'
import { useDock, type KeptTab } from './dock'
import { keptState } from './kept-state'
import { withTime } from '@renderer/lib/time'

/** A detail's tab, as a kept object's tab names it (none for its overview). */
const TAB_NAMES: Record<string, string> = {
  pods: 'Pods',
  logs: 'Logs',
  shell: 'Shell',
  metrics: 'Metrics',
  map: 'Map',
  events: 'Events',
  audit: 'Audit',
  yaml: 'YAML',
}

/** What a kept object's tab is called, for a person and a reader of the screen alike. */
export function keptName(kept: KeptTab): string {
  return `${apiKindOf(kept.object.kind)} ${kept.object.name}`
}

/** A kept object's tab in the bar: its kind, its name, its tab, and its cluster where that's another. */
export function KeptTabButton({ kept, selected }: { kept: KeptTab; selected: boolean }) {
  const dock = useDock.getState()
  const { context } = useCluster()
  const clusterName = useClusterName()
  const tabName = TAB_NAMES[kept.tab]
  const elsewhere = kept.context !== context
  const state = kept.waiting
    ? 'not read yet'
    : kept.deletedAt !== undefined
      ? 'deleted'
      : kept.unreachableSince !== undefined
        ? 'unreachable'
        : undefined
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={cn(
            'group flex h-7 shrink-0 items-center rounded-md text-xs transition-colors',
            selected
              ? 'bg-surface-3 text-ink-1'
              : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
          )}
        >
          <Tooltip
            content={
              <>
                {[
                  `${keptName(kept)}${kept.object.namespace ? ` in ${kept.object.namespace}` : ''}`,
                  `on ${clusterName(kept.context)}`,
                ].join(', ')}
                {' · '}
                {tabName ?? 'Overview'}
                {kept.waiting && (
                  <span className="mt-0.5 block text-ink-3">
                    Not read yet: its cluster signs in through a program, so Lumovi reads it when
                    you show it or open that cluster.
                  </span>
                )}
              </>
            }
          >
            <button
              type="button"
              role="tab"
              aria-label={[
                keptName(kept),
                tabName,
                elsewhere ? `on ${clusterName(kept.context)}` : undefined,
                state,
              ]
                .filter(Boolean)
                .join(', ')}
              id={`terminal-tab-${kept.id}`}
              aria-selected={selected}
              aria-controls={`terminal-${kept.id}`}
              onClick={() => dock.select(kept.id)}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <KindIcon
                kind={kept.object.kind}
                className={cn('size-3.5 shrink-0', selected ? 'text-ink-1' : 'text-ink-2')}
              />
              <MiddleTruncate text={kept.object.name} className="max-w-48 font-medium" />
              {tabName && <span className="shrink-0 text-ink-3">{tabName}</span>}
              {elsewhere && (
                <span className="shrink-0 text-ink-3">{clusterName(kept.context)}</span>
              )}
              {state && <span className="shrink-0 text-ink-3 italic">{state}</span>}
            </button>
          </Tooltip>
          <button
            type="button"
            aria-label={`Close ${keptName(kept)}`}
            onClick={() => dock.close(kept.id)}
            className={cn(
              'mr-1 grid size-5 shrink-0 place-items-center rounded text-ink-3 outline-none hover:bg-line hover:text-ink-1 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContent}>
          <OpenInPanelItem kept={kept} />
          <ContextMenu.Item className={menuItem} onSelect={() => dock.moveOut(kept.id)}>
            <AppWindow className="size-4 text-ink-3" />
            <span className="flex-1">Move to a new window</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item className={menuItem} onSelect={() => dock.close(kept.id)}>
            <X className="size-4 text-ink-3" />
            <span className="flex-1">Close</span>
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => dock.closeOthers(kept.id)}>
            <span className="size-4" />
            <span className="flex-1">Close the others</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** Opens a kept object in the detail panel: of this page where it's this cluster's, else its own. */
function useOpenInPanel(kept: KeptTab): () => void {
  const { context } = useCluster()
  const openObject = useOpenObject()
  const navigate = useNavigate()
  const { kind, name, namespace } = kept.object
  return () =>
    kept.context === context
      ? openObject(kind, name, namespace)
      : void navigate(
          `${kindPath(kept.context, kind)}?open=${encodeURIComponent(formatRef(kept.object))}`,
        )
}

function OpenInPanelItem({ kept }: { kept: KeptTab }) {
  const open = useOpenInPanel(kept)
  return (
    <ContextMenu.Item className={menuItem} onSelect={open}>
      <ArrowUpRight className="size-4 text-ink-3" />
      <span className="flex-1">Open in the panel</span>
    </ContextMenu.Item>
  )
}

/**
 * A kept object, at the size of the tabs below: read in its own cluster. `alone`, in a window of
 * its own: no panel there to open it in.
 */
export function KeptPanel({
  kept,
  shown,
  alone = false,
}: {
  kept: KeptTab
  shown: boolean
  alone?: boolean
}) {
  const open = useOpenInPanel(kept)
  // Waiting (its cluster signs in through a program): read once it's picked (see `dock.select`),
  // asked for here, or its cluster's opened in this window, which asks what the cluster's pages
  // would. Shown as Lumovi opens isn't asking: it says so instead, and waits.
  const { context } = useCluster()
  const waiting = kept.waiting === true
  useEffect(() => {
    if (waiting && kept.context === context) useDock.getState().read(kept.id)
  }, [waiting, context, kept.context, kept.id])
  // (Its own cluster's, whichever the window shows: everything under it reads that one.)
  const scope: ClusterState = {
    context: kept.context,
    namespaces: kept.object.namespace ? [kept.object.namespace] : null,
    namespace: kept.object.namespace ?? null,
    setNamespaces: () => {},
    setNamespace: () => {},
  }
  return (
    <div
      role="tabpanel"
      id={`terminal-${kept.id}`}
      aria-labelledby={`terminal-tab-${kept.id}`}
      hidden={!shown}
      className="absolute inset-0 flex flex-col"
    >
      {waiting ? (
        <NotReadYet kept={kept} />
      ) : (
        <ClusterContext.Provider value={scope}>
          <KeptDetail kept={kept} onOpen={alone ? undefined : open} />
        </ClusterContext.Provider>
      )}
    </div>
  )
}

/**
 * A kept object that waits to be read, its cluster signing in through a program: which, and the
 * press that reads it (and so may sign in). `focused`: where it's all a window has.
 */
export function NotReadYet({ kept, focused = false }: { kept: KeptTab; focused?: boolean }) {
  const clusterName = useClusterName()
  // (The program's name, as the kubeconfig gives it: read, never run.)
  const program = useContexts().data?.contexts.find((c) => c.name === kept.context)?.signsInWith
  return (
    <div className="grid h-full place-items-center p-4">
      <div
        role="status"
        className="max-w-md space-y-1.5 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-[13px] text-ink-2 shadow-pop"
      >
        <p className="font-medium text-ink-1">Not read yet</p>
        <p className="text-pretty">
          {/* (Both a kubeconfig's: spelled, so none can turn the line round or hide in it.) */}
          <TheirText inline text={clusterName(kept.context)} /> signs in through{' '}
          {program ? <TheirText inline text={program} /> : 'a program'}, so Lumovi reads this when
          you ask.
        </p>
        <div className="flex flex-wrap gap-2 pt-1.5">
          <Button
            variant="primary"
            autoFocus={focused}
            onClick={() => useDock.getState().read(kept.id)}
          >
            Read it now
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A moment, as the tabs below say it ("14:32"). */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(
    undefined,
    withTime({ hour: '2-digit', minute: '2-digit', hour12: false }),
  )

function KeptDetail({ kept, onOpen }: { kept: KeptTab; onOpen?: () => void }) {
  const { kind, name, namespace } = kept.object
  const object = useObject(kind, name, namespace)
  const clusterName = useClusterName()
  // Views decide the icon, status and actions of the kinds they cover.
  usePlugins()
  const code = (object.error as KubeApiError | null)?.code
  const read = Boolean(object.data)
  const { deletedAt, unreachableSince } = kept
  useEffect(() => {
    const next = keptState({ deletedAt, unreachableSince }, { read, code }, Date.now())
    if (next.deletedAt !== deletedAt || next.unreachableSince !== unreachableSince) {
      useDock.getState().setKeptState(kept.id, next)
    }
  }, [read, code, deletedAt, unreachableSince, kept.id])
  if (object.isPending) return <Loading label="Loading…" />
  if (!object.data) {
    return <ErrorState error={object.error as KubeApiError} onRetry={() => void object.refetch()} />
  }
  const logs = kept.tab === 'logs'
  return (
    <>
      {unreachableSince !== undefined && (
        <p
          role="status"
          className="shrink-0 border-b border-line bg-surface-3/60 px-4 py-1.5 text-xs text-ink-2"
        >
          Can’t reach {clusterName(kept.context)} since {clock(unreachableSince)}. Lumovi tries
          again on its own
          {logs
            ? ', and the lines go on from the last one here.'
            : `; what’s here is from ${clock(unreachableSince)}.`}
        </p>
      )}
      <div
        className={cn(
          'relative flex min-h-0 flex-1 flex-col',
          deletedAt !== undefined && 'opacity-50',
        )}
        inert={deletedAt !== undefined}
      >
        <DetailTabs
          object={object.data}
          chosen={kept.tab}
          onChoose={(tab) => useDock.getState().setKeptTab(kept.id, tab)}
          aside={<Aside object={object.data} onOpen={onOpen} />}
        />
      </div>
      {deletedAt !== undefined && <Deleted kept={kept} object={object.data} at={deletedAt} />}
    </>
  )
}

/**
 * What a kept object that was deleted says, over its last view: when, that what's here stays
 * until its tab is closed, and the object that ran it where that's still there.
 */
function Deleted({ kept, object, at }: { kept: KeptTab; object: KubeObject; at: number }) {
  const owner = useStillThereOwner(object)
  const dock = useDock.getState()
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
      <div
        role="status"
        className="pointer-events-auto max-w-md space-y-1.5 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-[13px] text-ink-2 shadow-pop"
      >
        <p className="font-medium text-ink-1">
          {apiKindOf(kept.object.kind)} {kept.object.name} was deleted at {clock(at)}.
        </p>
        <p>
          {kept.tab === 'logs'
            ? 'Its lines up to then stay here until you close this tab.'
            : 'Its last state stays here until you close this tab.'}
        </p>
        {owner && (
          <p>
            It belonged to the {apiKindOf(owner.kind)} {owner.name}, which is still there.
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1.5">
          {owner && (
            <Button
              variant="primary"
              onClick={() => {
                dock.keep(kept.context, owner, kept.tab)
                dock.close(kept.id)
              }}
            >
              Keep {owner.name} open instead
            </Button>
          )}
          <Button variant="secondary" onClick={() => dock.close(kept.id)}>
            Close this tab
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * What ran a deleted object, up its controllers to the one nothing runs (a pod's ReplicaSet to
 * its Deployment), where that's still there.
 */
function useStillThereOwner(object: KubeObject): ObjectRef | undefined {
  const { context } = useCluster()
  const namespace = object.metadata.namespace
  const read = (ref: { kind: string; name: string } | undefined) => ({
    queryKey: ['object', context, ref?.kind, namespace, ref?.name],
    queryFn: async () => {
      const got = await api.kube.get({
        context,
        kind: ref!.kind as ResourceKind,
        name: ref!.name,
        namespace,
      })
      if (!got.ok) throw got.error
      return got.data
    },
    enabled: ref !== undefined,
    retry: false,
  })
  const first = controllerOf(object)
  const middle = useQuery<KubeObject>(read(first))
  const top = (middle.data && controllerOf(middle.data)) ?? (middle.isError ? undefined : first)
  const there = useQuery<KubeObject>(read(top))
  return top && there.data
    ? { kind: top.kind as ResourceKind, name: top.name, namespace }
    : undefined
}

/** The row's end: the object's status, what can be done to it, and the way to the panel. */
function Aside({ object, onOpen }: { object: KubeObject; onOpen?: () => void }) {
  const status = statusFor(kindOf(object), object)
  return (
    <>
      {status && (
        <div className="max-w-56 min-w-0">
          <StatusPill status={status} />
        </div>
      )}
      {actionsFor(object).length > 0 && <ActionBar object={object} />}
      {onOpen && (
        <IconButton label="Open in the panel" className="size-7" onClick={onOpen}>
          <ArrowUpRight />
        </IconButton>
      )}
    </>
  )
}
