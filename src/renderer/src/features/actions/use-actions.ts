import type { AccessCheck, KubeObject } from '@shared/api'
import { useAccess } from '@renderer/hooks/access'
import { useChange } from '@renderer/hooks/change'
import { useOpenObject } from '@renderer/hooks/open-object'
import { labelFor } from '@renderer/hooks/resources'
import { useReadOnly } from '@renderer/hooks/settings'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { useAccessHere, type AccessHere } from '../access/use-access'
import { actionsFor, type Action } from './catalog'
import { kindOf } from './common'

export interface AvailableAction {
  action: Action
  /** Why it can't be used right now, if it can't. */
  disabled?: string
}

/** What a denied check was about, as in "Your account can’t … in shop." */
const DENIED: Record<string, (resource: string) => string> = {
  patch: (resource) => `change ${resource}`,
  update: (resource) => `edit ${resource}`,
  delete: (resource) => `delete ${resource}`,
  create: (resource) => `create ${resource}`,
  'create/eviction': (resource) => `evict ${resource}`,
  'create/exec': () => 'open shells',
  'create/portforward': (resource) => `forward ports to ${resource}`,
  'patch/ephemeralcontainers': (resource) => `debug ${resource}`,
  'patch/status': (resource) => `change ${resource}`,
  'patch/scale': (resource) => `scale ${resource}`,
}

/** "Your account can’t delete pods in shop." */
function forbidden(check: AccessCheck): string {
  const phrase = DENIED[check.subresource ? `${check.verb}/${check.subresource}` : check.verb]!
  const resource = labelFor(check.kind).toLowerCase()
  return `Your account can’t ${phrase(resource)}${check.namespace ? ` in ${check.namespace}` : ''}.`
}

/**
 * Why a server's access doesn't let its person use an action: shells (a node's, a container's,
 * or a debug container's) and changes, where the object is.
 */
function notAllowed(action: Action, check: AccessCheck, object: KubeObject, here: AccessHere) {
  const where = object.kind === 'Namespace' ? object.metadata.name : object.metadata.namespace
  const kind = check.subresource ? `${check.verb}/${check.subresource}` : check.verb
  if (action.id === 'node-shell') return here.whyNot('nodeShells', 'on', undefined)
  // A file out of a container is read as a shell there would read it; one put in changes it.
  if (action.id === 'download-files') {
    return here.whyNot('shells', 'on', where, 'copy files out of containers')
  }
  if (action.id === 'upload-files') {
    return (
      here.whyNot('shells', 'on', where, 'copy files into containers') ??
      here.whyNot('changes', 'write', where, 'copy files into containers')
    )
  }
  if (kind === 'create/exec') return here.whyNot('shells', 'on', where)
  // Forwarding a port changes nothing.
  if (kind === 'create/portforward') return undefined
  // A Secret written whole by someone shown only its keys would lose its values.
  if (object.kind === 'Secret' && action.id === 'edit-yaml') {
    return (
      here.whyNot('changes', 'write', where) ??
      here.whyNot('secrets', 'values', where, 'edit Secrets whole')
    )
  }
  if (kind === 'patch/ephemeralcontainers') {
    return (
      here.whyNot('shells', 'on', where, 'debug pods') ?? here.whyNot('changes', 'write', where)
    )
  }
  return here.whyNot('changes', 'write', where)
}

/**
 * The actions that apply to `object`, each with the reason it is disabled, if
 * it is: the cluster is read-only, a server's access doesn't let its person,
 * or RBAC doesn't allow it.
 */
export function useObjectActions(object: KubeObject): AvailableAction[] {
  const actions = actionsFor(object)
  const checks = actions.map((action) => action.access(object))
  const access = useAccess(checks)
  const { readOnly, why: readOnlyWhy } = useReadOnly()
  const here = useAccessHere()
  return actions.map((action, i) => ({
    action,
    disabled:
      readOnly && !action.safe
        ? readOnlyWhy
        : (notAllowed(action, checks[i]!, object, here) ??
          (access[i] === false ? forbidden(checks[i]!) : undefined)),
  }))
}

/** Starts an action: opens its dialog, runs it at once, or opens the YAML editor. */
export function useRunAction() {
  const { context } = useCluster()
  const change = useChange()
  const openObject = useOpenObject()
  const { start, edit, showTab } = useActionsUi()
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
      // Editors and shells live in the detail panel.
      const { name, namespace } = object.metadata
      const ref = formatRef({ kind: kindOf(object), name, namespace })
      openObject(kindOf(object), name, namespace)
      if (action.tab) showTab(ref, action.tab)
      else edit(ref)
    }
  }
}
