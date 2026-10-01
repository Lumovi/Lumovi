import { Zap } from 'lucide-react'
import type { KubeObject } from '@shared/api'
import { VIEW_ICONS } from '@renderer/components/KindIcon'
import { useChange } from '@renderer/hooks/change'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { render, renderPatch, viewFor, type ViewAction } from '@renderer/lib/views'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import type { InstantChange } from './catalog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

/** The change a view's action makes, with its kubectl command and its undo. */
export function viewChange(action: ViewAction, object: KubeObject, context: string): InstantChange {
  const { name, namespace } = object.metadata
  const step = (patch: ViewAction['patch'], title: string) => {
    const body = renderPatch(patch, object)
    return {
      change: {
        ...target(object),
        change: {
          action: 'patch' as const,
          patchType: action.type,
          patch: body,
          ...(action.subresource ? { subresource: action.subresource } : {}),
        },
      },
      meta: {
        title,
        command: kubectl(
          context,
          namespace,
          'patch',
          objectArg(kindOf(object), name),
          `--type=${action.type}`,
          '-p',
          JSON.stringify(body),
          ...(action.subresource ? [`--subresource=${action.subresource}`] : []),
        ),
      },
    }
  }
  const done = step(
    action.patch,
    action.done ? render(action.done, object) : `${action.name}: ${name}`,
  )
  return {
    change: done.change,
    meta: {
      ...done.meta,
      ...(action.undo
        ? { undo: step(action.undo, `Undid ${action.name.toLowerCase()} on ${name}`) }
        : {}),
    },
  }
}

export function viewActionIcon(action: ViewAction) {
  return action.icon ? VIEW_ICONS[action.icon] : Zap
}

/** A view's action that asks first, with the view's own words. */
export function ViewActionDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { pending, error, submit } = useSubmit(onClose)
  const id = useActionsUi((state) => state.active!.id)
  const action = viewFor(kindOf(object))!.actions![Number(id.slice('view:'.length))]!
  const { change: request, meta } = viewChange(action, object, context)
  return (
    <ActionDialog
      icon={viewActionIcon(action)}
      tone={action.danger ? 'danger' : 'default'}
      title={`${action.name} ${object.metadata.name}?`}
      subject={subjectOf(object)}
      command={meta.command}
      confirmLabel={action.name}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit(() => change(request, meta))}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{render(action.confirm!, object)}</p>
    </ActionDialog>
  )
}
