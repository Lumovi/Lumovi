/**
 * What a cluster's actions do on the clusters page, and the dialogs they open: its settings, and
 * removing one added in Lumovi (asked first: its file is deleted). The desktop app's.
 */
import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { KubeconfigFiles } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { toast } from '@renderer/state/toasts'
import type { ClusterActionHandlers } from './ClusterActions'
import type { Cluster } from './ClusterPicker'
import { ClusterSettingsDialog } from './ClusterSettingsDialog'
import { tilde } from './clusters'
import { PageDialog } from './PageDialog'

export function useClusterActions({
  clusters,
  files,
  onEditConnection,
}: {
  clusters: Cluster[]
  files?: KubeconfigFiles
  /** One added in Lumovi: its connection edited (the add dialog, with its kubeconfig). */
  onEditConnection: (cluster: Cluster) => void
}): { handlers?: ClusterActionHandlers; dialogs: React.ReactNode } {
  const settings = useSettings().data
  const queryClient = useQueryClient()
  const [settingsFor, setSettingsFor] = useState<string>()
  const [removing, setRemoving] = useState<Cluster>()

  if (!api.app.setCluster) return { dialogs: null }

  const copyForKubectl = async (cluster: Cluster) => {
    const line = await api.addedClusters?.forKubectl(cluster.context.file)
    if (!line?.ok) return
    await navigator.clipboard.writeText(line.data)
    toast({ tone: 'success', title: 'Copied for kubectl', description: line.data })
  }

  const handlers: ClusterActionHandlers = {
    settings: (cluster) => setSettingsFor(cluster.context.name),
    setHidden: async (cluster, hidden) => {
      const current = settings?.clusters?.[cluster.context.name] ?? {}
      const result = await api.app.setCluster!(cluster.context.name, { ...current, hidden })
      if (result.ok) queryClient.setQueryData(['settings'], result.data)
    },
    show: (cluster) => void api.kubeconfigFiles?.show(cluster.context.file!),
    copyForKubectl: (cluster) => void copyForKubectl(cluster),
    remove: (cluster) => setRemoving(cluster),
  }

  const editing = clusters.find((cluster) => cluster.context.name === settingsFor)
  const groups = [
    ...new Set(clusters.map((cluster) => cluster.group).filter((g): g is string => !!g)),
  ].sort((a, b) => a.localeCompare(b))
  const dialogs = (
    <>
      {editing && (
        <ClusterSettingsDialog
          cluster={editing}
          groups={groups}
          files={files}
          onEditConnection={() => {
            setSettingsFor(undefined)
            onEditConnection(editing)
          }}
          onCopyForKubectl={() => void copyForKubectl(editing)}
          onRemove={() => {
            setSettingsFor(undefined)
            setRemoving(editing)
          }}
          onClose={() => setSettingsFor(undefined)}
        />
      )}
      {removing && (
        <RemoveDialog
          cluster={removing}
          others={clusters.filter(
            (cluster) => cluster !== removing && cluster.context.file === removing.context.file,
          )}
          files={files}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </>
  )
  return { handlers, dialogs }
}

/** Removing a cluster added in Lumovi: its file deleted (and every cluster in it), asked first. */
function RemoveDialog({
  cluster,
  others,
  files,
  onClose,
}: {
  cluster: Cluster
  /** The other clusters added with it, in the same file. */
  others: Cluster[]
  files?: KubeconfigFiles
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const remove = async () => {
    setPending(true)
    const result = await api.addedClusters!.remove(cluster.context.file!)
    if (!result.ok) {
      setPending(false)
      setError(result.error.message)
      return
    }
    await queryClient.invalidateQueries({ queryKey: ['contexts'] })
    onClose()
  }
  return (
    <PageDialog
      leading={
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-critical/10 text-critical-text">
          <Trash2 className="size-[18px]" />
        </div>
      }
      title={`Remove ${cluster.name} from Lumovi?`}
      error={error}
      onSubmit={() => void remove()}
      onClose={onClose}
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" data-autofocus onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            aria-disabled={pending || undefined}
            className="min-w-20 aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            {pending && <LoaderCircle className="animate-spin" />}
            Remove
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Lumovi deletes its kubeconfig from its own folder
        {files && cluster.context.file && (
          <>
            {' '}
            (<span className="font-mono text-xs">{tilde(cluster.context.file, files.home)}</span>)
          </>
        )}
        {others.length > 0 && (
          <>, and with it {others.map((other) => other.name).join(', ')}, added with it</>
        )}
        . Your own kubeconfig files aren’t touched.
      </p>
    </PageDialog>
  )
}
