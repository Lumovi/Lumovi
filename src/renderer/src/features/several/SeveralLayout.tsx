import { useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  ArrowLeft,
  ArrowRight,
  Box,
  ChevronsUpDown,
  RotateCw,
  Server,
  Activity,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router'
import type { KubeContext } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { OnALargerScreen } from '@renderer/components/LargerScreen'
import { ActionHost } from '@renderer/features/actions/ActionSurfaces'
import { DetailPanel } from '@renderer/features/details/DetailPanel'
import { useContexts, useListsAcross } from '@renderer/hooks/queries'
import { useClusterName, useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { clusterPath } from '@renderer/lib/routes'
import { ClusterContext, type ClusterState } from '@renderer/state/cluster'
import { useActionsUi } from '@renderer/state/actions'
import { usePrefs } from '@renderer/state/prefs'
import { toast } from '@renderer/state/toasts'
import { Commands } from '../shell/Commands'
import { menuItem } from '../shell/menu-styles'
import { ShortcutsDialog } from '../shell/ShortcutsDialog'
import { TerminalDock } from '../terminal/TerminalDock'
import { ClusterDot } from './ClusterDot'
import {
  isSeveralPage,
  OPEN_CLUSTER_PARAM,
  OPENED_PARAM,
  SEVERAL_PAGES,
  setOf,
  severalPath,
  type SeveralPage,
} from './set'

/** What every part of a page of several clusters shares. */
export interface Several {
  page: SeveralPage
  /** The set, in its order. */
  contexts: string[]
  /** What's known of each (its kubeconfig's context, or a fleet's cluster). */
  info: Map<string, KubeContext>
  /** Whether a cluster may be read: one that signs in only once it's opened here. */
  reads: (context: string) => boolean
  /** Opens one that signs in: on the person's press alone. */
  open: (context: string) => void
  /** The namespaces picked, or `null` for all, as one cluster's picker has them. */
  namespaces: readonly string[] | null
  setNamespaces: (namespaces: readonly string[] | null) => void
}

const SeveralContext = createContext<Several | null>(null)

export function useSeveral(): Several {
  return useContext(SeveralContext)!
}

/** One cluster of the set, as a cluster's own page has it: its object read and acted on there. */
export function OnCluster({ context, children }: { context: string; children: ReactNode }) {
  const { namespaces } = useSeveral()
  const value = useMemo<ClusterState>(
    () => ({
      context,
      namespaces,
      namespace: namespaces?.length === 1 ? namespaces[0]! : null,
      setNamespaces: () => {},
      setNamespace: () => {},
      oneOfSeveral: true,
    }),
    [context, namespaces],
  )
  return <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
}

/**
 * A page of several clusters' lists: outside any one cluster, a set of them (in the address, and
 * remembered on this computer), each read with its own access. Nothing that signs in is read
 * until it's opened here, by a press.
 */
export function SeveralLayout() {
  const { page = 'pods' } = useParams()
  const [params, setParams] = useSearchParams()
  const contexts = setOf(params)
  const remembered = usePrefs((prefs) => prefs.severalSet)
  const remember = usePrefs((prefs) => prefs.setSeveralSet)
  const known = useContexts().data?.contexts
  // Those that sign in, opened here by a press: the one that opened the set (once, from its
  // address), or Open on a chip.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(params.getAll(OPENED_PARAM)),
  )
  useEffect(() => {
    if (!params.has(OPENED_PARAM)) return
    setParams(
      (now) => {
        const next = new URLSearchParams(now)
        next.delete(OPENED_PARAM)
        return next
      },
      { replace: true },
    )
  }, [params, setParams])
  const [namespaces, setNamespaces] = useState<readonly string[] | null>(null)
  const key = contexts.join('\u0000')
  useEffect(() => {
    if (contexts.length > 0) remember(contexts)
    // (Remembered as the address says it, whichever page of it.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, remember])
  const info = useMemo(
    () => new Map((known ?? []).filter((c) => contexts.includes(c.name)).map((c) => [c.name, c])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [known, key],
  )
  if (!isSeveralPage(page)) return <Navigate replace to={severalPath('pods', contexts)} />
  if (contexts.length === 0) {
    return remembered.length > 0 ? (
      <Navigate replace to={severalPath(page, remembered)} />
    ) : (
      <Navigate replace to="/" />
    )
  }
  const several: Several = {
    page,
    contexts,
    info,
    reads: (context) => {
      const c = info.get(context)
      return c !== undefined && (!c.signsInWith || c.signedIn === true || opened.has(context))
    },
    open: (context) => setOpened(new Set([...opened, context])),
    namespaces,
    setNamespaces,
  }
  return (
    <OnALargerScreen title="Several clusters" says="Several clusters needs a larger screen.">
      <SeveralContext.Provider value={several}>
        <SeveralFrame />
      </SeveralContext.Provider>
    </OnALargerScreen>
  )
}

function SeveralFrame() {
  const { contexts } = useSeveral()
  const [params] = useSearchParams()
  const openOn = params.get(OPEN_CLUSTER_PARAM)
  // The panel's cluster, if one's open: first in the dock's + menu.
  const inPanel = openOn && contexts.includes(openOn) ? openOn : undefined
  return (
    <div className="flex h-full">
      <SeveralSidebar />
      <main className="flex min-w-0 flex-1 flex-col py-2 pr-2 drag">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-panel no-drag">
          <SeveralHeader />
          <div className="relative flex min-h-0 flex-1">
            <div
              id="content"
              tabIndex={-1}
              className="min-w-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto outline-none"
            >
              <Outlet />
            </div>
            {/* The object open, read from its own cluster alone. */}
            {openOn && contexts.includes(openOn) && (
              // (Drawn anew for another cluster's: nothing of one object's carries to another's.)
              <OnCluster key={openOn} context={openOn}>
                <DetailPanel />
              </OnCluster>
            )}
          </div>
          {api.host === 'desktop' && (
            // (Its own cluster is none of them: + asks which, and each tab names its cluster.)
            <OnCluster context={inPanel ?? contexts[0]!}>
              <TerminalDock
                clusters={(pick) => <TerminalClusters inPanel={inPanel} pick={pick} />}
              />
            </OnCluster>
          )}
        </div>
      </main>
      {/* Each cluster's own dialogs, on it: an action opens on the cluster it was started on. */}
      {contexts.map((context) => (
        <OnCluster key={context} context={context}>
          <ActionHost />
        </OnCluster>
      ))}
      <RefuseUnnamed />
      {/* The menu's commands (a terminal's asks which cluster), and the shortcuts. */}
      <Commands />
      <ShortcutsDialog />
    </div>
  )
}

/**
 * An action that doesn't name its cluster, on a page with several: refused, and said, never
 * opened on one of them (no host here takes it).
 */
function RefuseUnnamed() {
  const active = useActionsUi((state) => state.active)
  const close = useActionsUi((state) => state.close)
  useEffect(() => {
    if (!active || active.context !== undefined) return
    close()
    toast({
      tone: 'error',
      title: 'That didn’t start: it didn’t say which cluster it’s for, and this page has several.',
    })
  }, [active, close])
  return null
}

/** The dock's + menu: which of the set a new terminal points at, the panel's first. */
function TerminalClusters({
  inPanel,
  pick,
}: {
  inPanel?: string
  pick: (context: string) => void
}) {
  const { contexts } = useSeveral()
  const rest = contexts.filter((context) => context !== inPanel)
  return (
    <>
      {inPanel && (
        <>
          <TerminalCluster context={inPanel} note="In the panel" pick={pick} />
          {rest.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
        </>
      )}
      {rest.map((context) => (
        <TerminalCluster key={context} context={context} pick={pick} />
      ))}
    </>
  )
}

function TerminalCluster({
  context,
  note,
  pick,
}: {
  context: string
  note?: string
  pick: (context: string) => void
}) {
  const { info, reads, open } = useSeveral()
  const name = useClusterName()(context)
  const production = useProduction(context)
  // (Picked, it signs in, as opening it alone does: then its list is read here too.)
  const signsIn = Boolean(info.get(context)?.signsInWith) && !reads(context)
  return (
    <DropdownMenu.Item
      className={menuItem}
      onSelect={() => {
        if (signsIn) open(context)
        pick(context)
      }}
    >
      <ClusterDot context={context} className="size-2" />
      <span className="min-w-0 truncate">{name}</span>
      {production && (
        <span className="shrink-0 rounded bg-critical/10 px-1 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
          Production
        </span>
      )}
      {(note ?? (signsIn ? 'Signs in when opened' : undefined)) && (
        <span className="ml-auto shrink-0 pl-2 text-xs text-ink-3">
          {note ?? 'Signs in when opened'}
        </span>
      )}
    </DropdownMenu.Item>
  )
}

const PAGE_ICONS = { workloads: Boxes, pods: Box, nodes: Server, events: Activity } as const

function SeveralSidebar() {
  const { contexts, page } = useSeveral()
  const nameOf = useClusterName()
  return (
    <nav
      aria-label="Resources"
      className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto px-3 pt-10 pb-3 drag"
    >
      <Link
        to="/"
        aria-label="Change the clusters"
        className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 no-drag"
      >
        <span className="flex shrink-0 gap-0.5">
          {contexts.map((context) => (
            <ClusterDot key={context} context={context} />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink-1">Several clusters</span>
          <span className="block truncate text-xs text-ink-3">
            {contexts.map((context) => nameOf(context)).join(', ')}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
      </Link>
      <section className="no-drag">
        <h2 className="mb-1 px-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Several clusters
        </h2>
        {(Object.keys(SEVERAL_PAGES) as SeveralPage[]).map((each) => {
          const Icon = PAGE_ICONS[each]
          return (
            <NavLink
              key={each}
              to={severalPath(each, contexts)}
              aria-current={each === page ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink-2 hover:bg-surface-3',
                each === page && 'bg-surface-3 font-medium text-ink-1',
              )}
            >
              <Icon className="size-4 text-ink-3" />
              {SEVERAL_PAGES[each].title}
            </NavLink>
          )
        })}
      </section>
      <section className="no-drag">
        <h2 className="mb-1 px-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          One cluster
        </h2>
        {contexts.map((context) => (
          <Link
            key={context}
            to={clusterPath(context)}
            className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink-2 hover:bg-surface-3"
          >
            <ClusterDot context={context} />
            <span className="truncate">{nameOf(context)}</span>
          </Link>
        ))}
      </section>
    </nav>
  )
}

function SeveralHeader() {
  const { page, contexts } = useSeveral()
  const navigate = useNavigate()
  const client = useQueryClient()
  const title = `${SEVERAL_PAGES[page].title} · ${contexts.length} clusters`
  useEffect(() => {
    document.title = `${title} — Lumovi`
  }, [title])
  const Icon = PAGE_ICONS[page]
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 drag">
      <IconButton label="Back" onClick={() => void navigate(-1)} className="no-drag">
        <ArrowLeft />
      </IconButton>
      <IconButton label="Forward" onClick={() => void navigate(1)} className="no-drag">
        <ArrowRight />
      </IconButton>
      <Icon className="ml-1 size-4 text-ink-2" aria-hidden />
      <h1 className="flex-1 truncate text-[15px] font-semibold text-ink-1">{title}</h1>
      <SeveralNamespaces />
      <IconButton
        label="Refresh"
        className="no-drag"
        onClick={() =>
          void Promise.all(
            contexts.map((context) => client.invalidateQueries({ queryKey: ['list', context] })),
          )
        }
      >
        <RotateCw />
      </IconButton>
    </header>
  )
}

/** The namespaces any cluster of the set has, to pick one: one a cluster lacks matches nothing there. */
function SeveralNamespaces() {
  const { contexts, reads, namespaces, setNamespaces, page } = useSeveral()
  const lists = useNamespacesAcross(contexts, reads)
  if (page === 'nodes') return null
  return (
    <select
      aria-label="Namespace"
      value={namespaces?.[0] ?? ''}
      onChange={(event) => setNamespaces(event.target.value ? [event.target.value] : null)}
      className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink-1 no-drag"
    >
      <option value="">All namespaces</option>
      {lists.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  )
}

function useNamespacesAcross(contexts: string[], reads: (context: string) => boolean): string[] {
  const lists = useListsAcross(contexts, null, 'Namespace', { namespace: null }, reads)
  return [
    ...new Set(lists.flatMap((list) => list.data?.items.map((ns) => ns.metadata.name) ?? [])),
  ].sort()
}
