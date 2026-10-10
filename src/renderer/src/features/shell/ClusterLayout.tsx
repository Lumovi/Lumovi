import { useActionsUi } from '@renderer/state/actions'
import { ON_A_PHONE } from '@renderer/web/phone-gate'
import { WifiOff } from 'lucide-react'
import { useEffect } from 'react'
import { Navigate, Outlet, useLocation, useParams } from 'react-router'
import { Button } from '@renderer/components/Button'
import { Drawer } from '@renderer/components/Drawer'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { useLayout, useShort } from '@renderer/lib/layout'
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
  const setStored = usePrefs((prefs) => prefs.setNamespace)
  const touchRecent = usePrefs((prefs) => prefs.touchRecent)
  const opensIn = useClusterSettings(context)?.namespace
  const layout = useLayout()
  // Until the user picks one, start in the one set for it in Lumovi, or else the kubeconfig's
  // (useful with namespaced RBAC).
  const namespace = stored === undefined ? (opensIn ?? contextInfo?.namespace ?? null) : stored

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
      value={{ context, namespace, setNamespace: (value) => setStored(context, value) }}
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
    <Drawer open={open} onOpenChange={setOpen} label="Sidebar">
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
