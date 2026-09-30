import { useEffect, useState } from 'react'
import { Outlet, useParams } from 'react-router'
import { useContexts } from '@renderer/hooks/queries'
import { ClusterContext } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { DetailPanel } from '../details/DetailPanel'
import { CommandPalette } from './CommandPalette'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { UsageSampler } from './UsageSampler'

export function ClusterLayout() {
  const context = useParams().context!
  const contextInfo = useContexts().data?.contexts.find((c) => c.name === context)
  const stored = usePrefs((prefs) => prefs.namespaces[context])
  const setStored = usePrefs((prefs) => prefs.setNamespace)
  // Until the user picks one, start in the kubeconfig's namespace (useful with namespaced RBAC).
  const namespace = stored === undefined ? (contextInfo?.namespace ?? null) : stored
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <ClusterContext.Provider
      value={{ context, namespace, setNamespace: (value) => setStored(context, value) }}
    >
      <div className="flex h-full">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col py-2 pr-2 drag">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-panel no-drag">
            <Header onSearch={() => setPaletteOpen(true)} />
            <div className="relative flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto">
                <Outlet />
              </div>
              <DetailPanel />
            </div>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <UsageSampler />
    </ClusterContext.Provider>
  )
}
