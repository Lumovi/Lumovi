import type { AccessCheck, KubeObject } from '@shared/api'
import { resourceByKind } from '@shared/resources'
import { useAccess } from '@renderer/hooks/access'
import { useChange } from '@renderer/hooks/change'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useReadOnly } from '@renderer/hooks/settings'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { actionsFor, type Action } from './catalog'
import { kindOf } from './common'

export interface AvailableAction {
  action: Action
  /** Why it can't be used right now, if it can't. */
  disabled?: string
}

const VERB_PHRASE: Record<string, string> = {
  patch: 'change',
  update: 'edit',
  delete: 'delete',
  create: 'create',
  'create/eviction': 'evict',
}

/** "Your account can’t delete pods in shop." */
function forbidden(check: AccessCheck): string {
  const verb = VERB_PHRASE[check.subresource ? `${check.verb}/${check.subresource}` : check.verb]
  const resource = resourceByKind(check.kind).label.toLowerCase()
  return `Your account can’t ${verb} ${resource}${check.namespace ? ` in ${check.namespace}` : ''}.`
}

/**
 * The actions that apply to `object`, each with the reason it is disabled, if
 * it is: the cluster is read-only, or RBAC doesn't allow it.
 */
export function useObjectActions(object: KubeObject): AvailableAction[] {
  const actions = actionsFor(object)
  const checks = actions.map((action) => action.access(object))
  const access = useAccess(checks)
  const { readOnly } = useReadOnly()
  return actions.map((action, i) => ({
    action,
    disabled: readOnly
      ? 'Changes are turned off for this cluster.'
      : access[i] === false
        ? forbidden(checks[i]!)
        : undefined,
  }))
}

/** Starts an action: opens its dialog, runs it at once, or opens the YAML editor. */
export function useRunAction() {
  const { context } = useCluster()
  const change = useChange()
  const openObject = useOpenObject()
  const { start, edit } = useActionsUi()
  return (action: Action, object: KubeObject) => {
    if (action.dialog) {
      start(action.id, object)
    } else if (action.instant) {
      const { change: request, meta } = action.instant(object, context)
      void change(request, meta).then((result) => {
        if (!result.ok) {
          toast({
            tone: 'error',
            title: `Couldn’t ${action.label.toLowerCase()} ${object.metadata.name}`,
            description: result.error.message,
          })
        }
      })
    } else {
      const { name, namespace } = object.metadata
      openObject(kindOf(object), name, namespace)
      edit(formatRef({ kind: kindOf(object), name, namespace }))
    }
  }
}
