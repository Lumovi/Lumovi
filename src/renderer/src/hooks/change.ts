import { useQueryClient } from '@tanstack/react-query'
import type { ChangeRequest, KubeObject, Result } from '@shared/api'
import { api } from '@renderer/lib/api'
import { useActivity } from '@renderer/state/activity'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'

/** Controllers take a moment to act on a change; look again once they have. */
const SETTLE_DELAY = 1_500

export type ClusterChange = Omit<ChangeRequest, 'context'>

export interface ChangeMeta {
  /** What happened, in the past tense: "Scaled storefront to 5 replicas". */
  title: string
  /** The kubectl command that does the same. */
  command: string
  /** How to take the change back; offered as "Undo" in the toast. */
  undo?: { change: ClusterChange; meta: Omit<ChangeMeta, 'undo' | 'action'> }
  /** Another toast action, e.g. to open the job that was created. */
  action?: { label: string; run: () => void }
  /** Only log the change; the caller reports it (e.g. a drain's many evictions). */
  silent?: boolean
}

/**
 * Makes a change to the current cluster: logs it in the activity log, shows
 * the outcome, and refreshes what's on screen. Resolves with the result so
 * dialogs can show errors next to what caused them.
 */
export function useChange() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  const { start, finish } = useActivity()

  const refresh = (request: ClusterChange) => {
    // A new or removed CRD changes the kinds the cluster serves.
    const keys = ['list', 'object', 'metrics', 'history']
    if (request.kind === 'CustomResourceDefinition.apiextensions.k8s.io') keys.push('resources')
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: [key, context] })
    }
  }

  const change = async (
    request: ClusterChange,
    meta: ChangeMeta,
  ): Promise<Result<KubeObject | null>> => {
    const id = start({
      context,
      title: meta.title,
      command: meta.command,
      target: request.name
        ? { kind: request.kind, name: request.name, namespace: request.namespace }
        : undefined,
    })
    const result = await api.kube.change({ ...request, context })
    if (!result.ok) {
      finish(id, 'failed', result.error.message)
      return result
    }
    finish(id, 'done')
    refresh(request)
    setTimeout(() => refresh(request), SETTLE_DELAY)
    if (!meta.silent) {
      const { undo } = meta
      toast({
        tone: 'success',
        title: meta.title,
        action: undo
          ? {
              label: 'Undo',
              run: () =>
                void change(undo.change, undo.meta).then((reverted) => {
                  if (!reverted.ok)
                    toast({
                      tone: 'error',
                      title: 'Couldn’t undo',
                      description: reverted.error.message,
                    })
                }),
            }
          : meta.action,
      })
    }
    return result
  }
  return change
}
