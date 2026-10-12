import { useActionsUi } from '@renderer/state/actions'
import { ON_A_PHONE } from '@renderer/web/phone-gate'
import { WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation, useParams, useSearchParams } from 'react-router'
import { Button } from '@renderer/components/Button'
import { Drawer } from '@renderer/components/Drawer'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { useLayout, useShort } from '@renderer/lib/layout'
import {
  isNamespaceName,
  MOST_NAMESPACES,
  NAMESPACES_PARAM,
  namespacesIn,
  namespacesParam,
  sameNamespaces,
} from '@renderer/lib/namespaces'
import { clusterPath } from '@renderer/lib/routes'
import { ClusterContext, useCluster } from '@renderer/state/cluster'
import { useClusterSettings } from '@renderer/hooks/settings'
import { usePrefs } from '@renderer/state/prefs'
import { useSession, useSwitching } from '@renderer/state/session'
import { useUi } from '@renderer/state/ui'
import { ReadOnlyOutsideBanner } from '../session/ReadOnlyOutsideBanner'
import { ServerBanner } from '../session/ServerBanner'
import { TerminalDock } from '../terminal/TerminalDock'
import { ActionHost } from '../actions/ActionSurfaces'
import { CreateDialog } from '../actions/CreateDialog'
import { SourceDialog } from '../metrics/SourceDialog'
import { DetailPanel } from '../details/DetailPanel'
import { ReleasePanel } from '../helm/ReleasePanel'
import { CommandPalette } from './CommandPalette'
import { Commands } from './Commands'
import { ContextRow, Header, usePage } from './Header'
import { ShortcutsDialog } from './ShortcutsDialog'
import { Sidebar } from './Sidebar'
import { UsageSampler } from './UsageSampler'

/** How often the connection to the cluster is checked. */
const HEALTH_CHECK_INTERVAL = 15_000

export function ClusterLayout() {
  const context = useParams().context!
  const session = useSession()
  const contextInfo = useContexts().data?.contexts.find((c) => c.name === context)
  const stored = usePrefs((prefs) => prefs.namespaces[context])
  const setStored = usePrefs((prefs) => prefs.setNamespaces)
  const [search, setSearch] = useSearchParams()
  const touchRecent = usePrefs((prefs) => prefs.touchRecent)
  const opensIn = useClusterSettings(context)?.namespace
  const layout = useLayout()
  // Until the user picks, start in the one set for it in Lumovi, or else the kubeconfig's
  // (useful with namespaced RBAC).
  // (A name kept that isn't a namespace's, from before names were held to the rule, is dropped;
  // a pick that's nothing once they are opens where the cluster opens, as if none were kept.)
  const names =
    stored === undefined || stored === null
      ? stored
      : (Array.isArray(stored) ? stored : [stored])
          .filter(isNamespaceName)
          .slice(0, MOST_NAMESPACES)
  const kept = names?.length === 0 ? undefined : names
  const opening = opensIn ?? contextInfo?.namespace ?? null
  const remembered = kept !== undefined ? kept : opening === null ? null : [opening]
  // What this view shows: what an address picked (a link), until the picker picks; or what was
  // last picked in the picker. A link changes the view, never what's remembered, and the view
  // is the cluster's own: back to the cluster, fresh, is what's remembered.
  const fromAddress = namespacesIn(search)
  const [shown, setShown] = useState<{
    context: string
    namespaces: readonly string[] | null
    /** How many a link named, where it named more than are picked. */
    named?: number
  }>()
  if (shown && shown.context !== context) setShown(undefined)
  // The address is followed when it changes (a link, back and forward), never when it's merely
  // behind a pick the picker made, which it's about to say.
  const said = search.get(NAMESPACES_PARAM)
  const [seen, setSeen] = useState<{ context: string; said: string | null }>()
  if (seen?.context !== context || seen.said !== said) {
    setSeen({ context, said })
    // (An address naming no namespace's name picks nothing: what's remembered shows. One with no
    // namespaces in it at all, a page's own link, leaves the view as it is.)
    if (fromAddress === undefined && said !== null) setShown(undefined)
    else if (
      fromAddress !== undefined &&
      !(shown?.context === context && sameNamespaces(shown.namespaces, fromAddress.namespaces))
    ) {
      setShown({ context, ...fromAddress })
    }
  }
  const namespaces = shown?.context === context ? shown.namespaces : remembered
  // The address always says what's shown (a link from it opens there), whatever page it came to by.
  const meant = namespacesParam(namespaces)
  useEffect(() => {
    if (said === (meant ?? null)) return
    setSearch(
      (current) => {
        const next = new URLSearchParams(current)
        if (meant === undefined) next.delete(NAMESPACES_PARAM)
        else next.set(NAMESPACES_PARAM, meant)
        return next
      },
      { replace: true },
    )
  }, [said, meant, setSearch])
  // The picker's pick is what's shown, and remembered.
  const setNamespaces = (value: readonly string[] | null) => {
    const picked = value?.length ? value.slice(0, MOST_NAMESPACES) : null
    setStored(context, picked)
    setShown({ context, namespaces: picked })
  }

  useEffect(() => touchRecent(context), [context, touchRecent])
  // What was opened with room for it doesn't outlive the room (a tablet turned upright, a
  // window made narrow): on a phone no dialog that changes more than a phone does stays open,
  // and nothing stays in the editor.
  useEffect(() => {
    if (layout !== 'phone') return
    const actions = useActionsUi.getState()
    if (actions.active && !ON_A_PHONE.has(actions.active.id)) actions.close()
    actions.edit(null)
    actions.setMenu(false)
    useUi.setState({ create: false, metricsSource: false, shortcuts: false })
  }, [layout])

  // A server shows one cluster (unless it has a fleet): an address with another (a link from
  // before it was renamed) goes there.
  if (session && !session.fleet && context !== session.cluster) {
    return <Navigate replace to={clusterPath(session.cluster!)} />
  }
  return (
    <ClusterContext.Provider
      value={{
        context,
        namespaces,
        namespace: namespaces?.length === 1 ? namespaces[0]! : null,
        ...(shown?.context === context && shown.named && shown.named > (namespaces?.length ?? 0)
          ? { linkNamed: shown.named }
          : {}),
        setNamespaces,
        setNamespace: (value) => setNamespaces(value === null ? null : [value]),
      }}
    >
      <div className="flex h-full">
        <button
          type="button"
          onClick={() => document.getElementById('content')!.focus()}
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-transform focus:translate-y-0"
        >
          Skip to content
        </button>
        <SidebarOrDrawer />
        <main className="flex min-w-0 flex-1 flex-col py-2 pr-2 drag narrow:p-0">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-panel no-drag narrow:rounded-none narrow:border-0 narrow:shadow-none">
            <Header />
            {api.host === 'server' && <ServerBanner />}
            {api.host === 'server' && <ReadOnlyOutsideBanner />}
            <ConnectionBanner />
            <div className="relative flex min-h-0 flex-1">
              <div
                id="content"
                tabIndex={-1}
                className="min-w-0 flex-1 overflow-y-auto outline-none [view-transition-name:page]"
              >
                <ShortContextRow />
                <Outlet />
              </div>
              <DetailPanel />
              <ReleasePanel />
            </div>
            {api.host === 'desktop' && <TerminalDock />}
          </div>
        </main>
      </div>
      <CommandPalette />
      <Commands />
      <ShortcutsDialog />
      <ActionHost />
      {/* Nothing is written on a phone: not from the header, the palette, or its key. */}
      {layout !== 'phone' && <CreateDialog />}
      <SourceDialog />
      <UsageSampler />
    </ClusterContext.Provider>
  )
}

/**
 * The sidebar: beside the page where there's room, and a drawer behind the header's menu button
 * where there isn't (a narrow browser window, a phone), which going anywhere closes.
 */
function SidebarOrDrawer() {
  const layout = useLayout()
  const open = useUi((ui) => ui.sidebar)
  const setOpen = useUi((ui) => ui.setSidebar)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname, layout, setOpen])
  if (layout === 'wide') return <Sidebar />
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      label="Sidebar"
      opener={() => document.querySelector<HTMLElement>('[data-opens="sidebar"]')}
    >
      <Sidebar />
    </Drawer>
  )
}

/**
 * Where a narrow page's screen is short (a phone on its side), which cluster and namespace it
 * shows is the first thing in the page, and scrolls away with it: the top bar alone stays.
 */
function ShortContextRow() {
  const narrow = useLayout() !== 'wide'
  const short = useShort()
  const { clusterScoped } = usePage()
  return narrow && short ? <ContextRow clusterScoped={clusterScoped} /> : null
}

/** Keeps checking the connection and says so when the cluster stops answering. */
function ConnectionBanner() {
  const { context } = useCluster()
  const switching = useSwitching()
  const go = useGo()
  const version = useVersion(context, HEALTH_CHECK_INTERVAL)
  if (!version.isError) return null
  return (
    <div
      role="status"
      className="flex shrink-0 animate-fade-in items-center gap-3 border-b border-critical/20 bg-critical/8 px-5 py-2 text-[13px]"
    >
      <WifiOff className="size-4 shrink-0 text-critical-text" />
      <span className="min-w-0 flex-1 truncate text-ink-1">
        <span className="font-medium">Can’t reach {context}.</span>{' '}
        <span className="text-ink-2">Checking again every 15 seconds.</span>
      </span>
      <Button variant="ghost" onClick={() => void version.refetch()}>
        Retry now
      </Button>
      {switching && (
        <Button variant="ghost" onClick={() => go('/')}>
          All clusters
        </Button>
      )}
    </div>
  )
}
