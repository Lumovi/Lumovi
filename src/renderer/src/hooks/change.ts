import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ChangeRequest, KubeObject, Result } from '@shared/api'
import { changeProblem } from '@shared/plugins'
import { api } from '@renderer/lib/api'
import { objectChanged } from '@renderer/plugins/reads'
import { useActivity } from '@renderer/state/activity'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'

/** Controllers take a moment to act on a change; look again once they have. */
const SETTLE_DELAY = 1_500

export type ClusterChange = Omit<ChangeRequest, 'context'>

/** Looks at a cluster again after a change, and once more when its controllers have acted. */
export function refreshAfterChange(queryClient: QueryClient, context: string, kind: string): void {
  const refresh = () => {
    // A new or removed CRD changes the kinds the cluster serves.
    const keys = ['list', 'object', 'metrics', 'history']
    if (kind === 'CustomResourceDefinition.apiextensions.k8s.io') keys.push('resources')
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: [key, context] })
    }
  }
  refresh()
  setTimeout(refresh, SETTLE_DELAY)
}

/** A plugin's action's change: one that can't be made without saying whose it is. */
export type PluginChangeMeta = ChangeMeta & {
  plugin: true
  undo?: { change: ClusterChange; meta: Omit<ChangeMeta, 'undo' | 'action'> & { plugin: true } }
  /**
   * The object's version the change was judged on: Lumovi's own condition, sent with it once the
   * plugin's change has passed its check, so the cluster refuses it if the object changed since.
   */
  atVersion?: string
}

/**
 * A patch that applies only to the object's version it was judged on: the cluster refuses it,
 * and nothing changes, if the object has changed since. (Lumovi's own line in the patch, never
 * a plugin's: a merge patch's metadata, or a JSON patch's first test.)
 */
export function atVersion<T>(patch: T, version: string): T {
  if (Array.isArray(patch)) {
    return [{ op: 'test', path: '/metadata/resourceVersion', value: version }, ...patch] as T
  }
  const body = patch as Record<string, unknown>
  const metadata = (body.metadata ?? {}) as Record<string, unknown>
  return { ...body, metadata: { ...metadata, resourceVersion: version } } as T
}

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
  /** It's a plugin's action's: held, as it's sent, to what a plugin may change. */
  plugin?: true
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

  const change = async (
    request: ClusterChange,
    meta: ChangeMeta,
  ): Promise<Result<KubeObject | null>> => {
    // A plugin's change is checked as it is now, filled in: its file was checked when it was
    // read, and nothing a file's check missed is sent on the strength of it. (An undo is sent
    // from here too, with its own step's meta: below.)
    const refused = meta.plugin ? changeProblem(request.change) : undefined
    const id = start({
      context,
      title: meta.title,
      command: meta.command,
      target: request.name
        ? { kind: request.kind, name: request.name, namespace: request.namespace }
        : undefined,
    })
    if (refused) {
      // (What to do about it is for whoever wrote the plugin: a person using it is told what, not how.)
      const message = `Lumovi didn’t send this: it ${refused.split(':')[0]}.`
      // It got past the check of the plugin's file by a way nobody knew: worth its line in the log.
      finish(id, 'failed', message)
      return { ok: false, error: { code: 'invalid', message } }
    }
    // (Checked as the plugin's, then sent with Lumovi's condition where it was judged on a version.)
    const judged = (meta as Partial<PluginChangeMeta>).atVersion
    const sent =
      judged !== undefined && request.change.action === 'patch'
        ? {
            ...request,
            change: { ...request.change, patch: atVersion(request.change.patch, judged) },
          }
        : request
    const result = await api.kube.change({ ...sent, context })
    if (!result.ok) {
      // About a Secret, what the cluster said isn't kept in the activity log, as it isn't in
      // the audit log: it can quote the Secret's values. (Lumovi's own refusals quote nothing.)
      const { code, message } = result.error
      const kept = request.kind !== 'Secret' || code === 'read-only' || code === 'not-allowed'
      finish(
        id,
        'failed',
        kept
          ? message
          : `It failed (${code}). What the cluster said of the Secret isn’t kept here: it can quote its values.`,
      )
      return result
    }
    finish(id, 'done')
    refreshAfterChange(queryClient, context, request.kind)
    // (A plugin's page that reads it reads it again now, so what it draws catches up at once.)
    if (request.name) {
      objectChanged(context, {
        kind: request.kind,
        name: request.name,
        ...(request.namespace === undefined ? {} : { namespace: request.namespace }),
      })
    }
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
