import { WifiOff } from 'lucide-react'
import { useEffect } from 'react'
import { Outlet, useParams } from 'react-router'
import { Button } from '@renderer/components/Button'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { ClusterContext, useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { ActionHost } from '../actions/ActionSurfaces'
import { CreateDialog } from '../actions/CreateDialog'
import { SourceDialog } from '../metrics/SourceDialog'
import { DetailPanel } from '../details/DetailPanel'
import { CommandPalette } from './CommandPalette'
import { Commands } from './Commands'
import { Header } from './Header'
import { ShortcutsDialog } from './ShortcutsDialog'
import { Sidebar } from './Sidebar'
import { UsageSampler } from './UsageSampler'

/** How often the connection to the cluster is checked. */
const HEALTH_CHECK_INTERVAL = 15_000

export function ClusterLayout() {
  const context = useParams().context!
  const contextInfo = useContexts().data?.contexts.find((c) => c.name === context)
  const stored = usePrefs((prefs) => prefs.namespaces[context])
  const setStored = usePrefs((prefs) => prefs.setNamespace)
  const touchRecent = usePrefs((prefs) => prefs.touchRecent)
  // Until the user picks one, start in the kubeconfig's namespace (useful with namespaced RBAC).
  const namespace = stored === undefined ? (contextInfo?.namespace ?? null) : stored

  useEffect(() => touchRecent(context), [context, touchRecent])

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
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col py-2 pr-2 drag">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-panel no-drag">
            <Header />
            <ConnectionBanner />
            <div className="relative flex min-h-0 flex-1">
              <div
                id="content"
                tabIndex={-1}
                className="min-w-0 flex-1 overflow-y-auto outline-none [view-transition-name:page]"
              >
                <Outlet />
              </div>
              <DetailPanel />
            </div>
          </div>
        </main>
      </div>
      <CommandPalette />
      <Commands />
      <ShortcutsDialog />
      <ActionHost />
      <CreateDialog />
      <SourceDialog />
      <UsageSampler />
    </ClusterContext.Provider>
  )
}

/** Keeps checking the connection and says so when the cluster stops answering. */
function ConnectionBanner() {
  const { context } = useCluster()
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
      <Button variant="ghost" onClick={() => go('/')}>
        All clusters
      </Button>
    </div>
  )
}
