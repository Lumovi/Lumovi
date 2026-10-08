import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { REPO_URL } from '@shared/app'
import { Button, IconButton } from '@renderer/components/Button'
import { GithubMark } from '@renderer/components/GithubMark'
import { LogoLockup } from '@renderer/components/LogoLockup'
import { Loading } from '@renderer/components/States'
import { useGo } from '@renderer/hooks/go'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { clusterPath } from '@renderer/lib/routes'
import { Commands } from '../shell/Commands'
import { ShortcutsDialog } from '../shell/ShortcutsDialog'
import { AssistantsButton } from '../assistants/DesktopConnect'
import { ThemeMenu } from '../shell/ThemeMenu'
import { AddClusterDialog } from './AddClusterDialog'
import { ClusterPicker, useClusters } from './ClusterPicker'
import { KubeconfigFilesButton, useKubeconfigFiles } from './KubeconfigFiles'
import { NothingToShow } from './NothingToShow'
import { useClusterActions } from './useClusterActions'

export { REPO_URL } from '@shared/app'

export function WelcomePage() {
  const contexts = useContexts()
  const files = useKubeconfigFiles()
  const queryClient = useQueryClient()
  const go = useGo()
  const clusters = useClusters(contexts.data?.contexts ?? [], files.data)
  // Adding a cluster, or editing one added in Lumovi; then the one just added, shown.
  const [adding, setAdding] = useState<{ editing?: { path: string; context: string } }>()
  const [justAdded, setJustAdded] = useState<string>()
  const { handlers, dialogs } = useClusterActions({
    clusters,
    files: files.data,
    onEditConnection: (cluster) =>
      setAdding({ editing: { path: cluster.context.file!, context: cluster.context.name } }),
  })
  // Lumovi adds clusters on the desktop, unless an organization's policy keeps it from it.
  const canAdd = !!api.addedClusters && !!files.data && !files.data.locked
  const add = canAdd ? () => setAdding({}) : undefined
  const groups = [
    ...new Set(clusters.map((cluster) => cluster.group).filter((g): g is string => !!g)),
  ].sort((a, b) => a.localeCompare(b))

  // ⌘N adds one: the menu's New, which makes objects in a cluster, adds a cluster here (the
  // menu takes the key before the page does).
  useEffect(() => {
    if (!canAdd) return
    return api.desktop?.onCommand((command) => {
      if (command === 'create') setAdding({})
    })
  }, [canAdd])
  // And where the page gets the key itself (no menu takes it).
  useEffect(() => {
    if (!canAdd) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setAdding({})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canAdd])

  useEffect(() => {
    document.title = 'Lumovi'
  }, [])

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['contexts'] })
    void queryClient.invalidateQueries({ queryKey: ['version'] })
  }

  // On the desktop, the files read come with the clusters: both, or neither yet.
  const pending = contexts.isPending || (!!api.kubeconfigFiles && files.isPending)
  return (
    <div className="vt-page relative flex h-full flex-col overflow-hidden">
      <div className="titlebar-leading titlebar-trailing h-[52px] shrink-0 drag" />
      <main className="relative flex min-h-0 flex-1 flex-col items-center px-8 pb-6">
        <div className="flex min-h-0 w-full max-w-[720px] flex-1 flex-col">
          <header className="mt-6 mb-8 flex shrink-0 animate-rise flex-col items-center text-center [@media(max-height:800px)]:mt-0 [@media(max-height:800px)]:mb-5">
            <h1>
              <LogoLockup className="h-9 [@media(max-height:800px)]:h-7" />
            </h1>
            <p className="mt-5 text-[14px] text-ink-2 [@media(max-height:800px)]:mt-4">
              Choose a cluster to explore.
            </p>
          </header>

          {pending ? (
            <Loading label="Reading kubeconfig…" />
          ) : contexts.data!.contexts.length === 0 ? (
            <NothingToShow
              contexts={contexts.data!}
              files={files.data}
              onReload={reload}
              onAdd={add}
            />
          ) : (
            <ClusterPicker
              contexts={contexts.data!.contexts}
              current={contexts.data!.currentContext}
              files={files.data}
              onAdd={add}
              actions={handlers}
              justAdded={justAdded}
            />
          )}

          <footer className="mt-5 flex shrink-0 items-center gap-2 text-xs text-ink-3">
            {files.data ? (
              <span className="flex min-w-0 flex-1 items-center">
                <KubeconfigFilesButton files={files.data} />
              </span>
            ) : (
              contexts.data && (
                <span
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  title={contexts.data.source}
                >
                  <span className="shrink-0">Loaded from</span>
                  {/* Truncate from the start so the file name stays visible. */}
                  <span className="min-w-0 truncate font-mono [direction:rtl] selectable">
                    <bdi>{contexts.data.source}</bdi>
                  </span>
                </span>
              )
            )}
            <Button variant="ghost" onClick={reload}>
              <RotateCw /> Reload
            </Button>
            <ThemeMenu />
            {api.assistants && <AssistantsButton assistants={api.assistants} />}
            <IconButton label="Lumovi on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
              <GithubMark />
            </IconButton>
          </footer>
        </div>
      </main>
      {dialogs}
      {adding && (
        <AddClusterDialog
          editing={adding.editing}
          groups={groups}
          onDone={(context, open) => {
            setAdding(undefined)
            if (open) go(clusterPath(context))
            else setJustAdded(context)
          }}
          onClose={() => setAdding(undefined)}
        />
      )}
      <Commands />
      <ShortcutsDialog />
    </div>
  )
}
