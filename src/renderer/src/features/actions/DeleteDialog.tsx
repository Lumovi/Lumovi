import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import type { DeletePropagation } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { useChange } from '@renderer/hooks/change'
import { useUpdateParams } from '@renderer/hooks/update-params'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { looksLikeProduction } from '@renderer/lib/production'
import { formatRef } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

/** Kinds whose deletion is hard to recover from: the name must be typed to confirm. */
const TYPE_TO_DELETE: readonly ResourceKind[] = [
  'Namespace',
  'Node',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'StorageClass',
  'CustomResourceDefinition.apiextensions.k8s.io',
]

/** Kinds that own other objects, where the user picks what happens to them. */
const OWNERS: readonly ResourceKind[] = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
]

const PROPAGATION: { value: DeletePropagation; label: string; hint: string }[] = [
  {
    value: 'Background',
    label: 'Delete what it owns too',
    hint: 'Its pods are removed right after it.',
  },
  {
    value: 'Foreground',
    label: 'Delete what it owns first',
    hint: 'It stays, marked for deletion, until its pods are gone.',
  },
  {
    value: 'Orphan',
    label: 'Keep what it owns',
    hint: 'Its pods keep running without a controller.',
  },
]

const CASCADE_FLAG: Record<DeletePropagation, string | undefined> = {
  Background: undefined,
  Foreground: '--cascade=foreground',
  Orphan: '--cascade=orphan',
}

function consequence(object: ActionProps['object']): string | undefined {
  const owner = object.metadata.ownerReferences?.find((ref) => ref.controller)
  switch (kindOf(object)) {
    case 'Pod':
      return owner
        ? `Its ${owner.kind} ${owner.name} will start a new pod to replace it.`
        : 'It has no controller, so nothing replaces it.'
    case 'Namespace':
      return `Everything in ${object.metadata.name} is deleted with it.`
    case 'Node':
      return 'The node leaves the cluster. Its pods keep running until its kubelet registers it again.'
    case 'PersistentVolumeClaim':
      return 'Its volume, and the data on it, may be deleted too, depending on the reclaim policy.'
    case 'PersistentVolume':
      return `Its reclaim policy is ${object.spec.persistentVolumeReclaimPolicy}; the data on it may be lost.`
    case 'CustomResourceDefinition.apiextensions.k8s.io':
      return `Every ${object.spec.names.kind} in the cluster is deleted with it, and the cluster stops serving ${object.spec.names.plural}.`
    default:
      return undefined
  }
}

export function DeleteDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const kind = kindOf(object)
  const { name, namespace } = object.metadata
  const terminating = Boolean(object.metadata.deletionTimestamp)
  const [propagation, setPropagation] = useState<DeletePropagation>('Background')
  const [force, setForce] = useState(terminating)
  const ref = formatRef({ kind, name, namespace })

  const { pending, error, submit } = useSubmit(() => {
    // Don't leave the panel open on something that no longer exists.
    if (params.get('open') === ref) updateParams((next) => next.delete('open'))
    onClose()
  })
  const owner = OWNERS.includes(kind)
  const flags = [
    ...(owner && CASCADE_FLAG[propagation] ? [CASCADE_FLAG[propagation]!] : []),
    ...(kind === 'Pod' && force ? ['--grace-period=0', '--force'] : []),
  ]
  const command = kubectl(context, namespace, 'delete', objectArg(kind, name), ...flags)
  const note = consequence(object)

  return (
    <ActionDialog
      icon={Trash2}
      tone="danger"
      title={`Delete ${name}?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel={kind === 'Pod' && force ? 'Force delete' : 'Delete'}
      typeToConfirm={
        TYPE_TO_DELETE.includes(kind) || looksLikeProduction(context) ? name : undefined
      }
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: {
                action: 'delete',
                propagation: owner ? propagation : undefined,
                gracePeriodSeconds: kind === 'Pod' && force ? 0 : undefined,
              },
            },
            { title: `Deleted ${kind.toLowerCase()} ${name}`, command },
          ),
        )
      }
    >
      {note && <p className="text-[13px] leading-relaxed text-ink-2">{note}</p>}

      {owner && (
        <fieldset className="space-y-1.5">
          <legend className="mb-2 text-xs font-medium text-ink-2">
            What happens to what it owns
          </legend>
          {PROPAGATION.map((option) => (
            <label
              key={option.value}
              className="flex cursor-default gap-3 rounded-lg border border-line px-3 py-2 transition-colors has-checked:border-critical/40 has-checked:bg-critical/5"
            >
              <input
                type="radio"
                name="propagation"
                value={option.value}
                checked={propagation === option.value}
                onChange={() => setPropagation(option.value)}
                className="mt-0.5 accent-[var(--critical)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-ink-1">{option.label}</span>
                <span className="block text-xs text-ink-3">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {kind === 'Pod' && (
        <label className="flex cursor-default gap-3 rounded-lg border border-line px-3 py-2 has-checked:border-critical/40 has-checked:bg-critical/5">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            className="mt-0.5 accent-[var(--critical)]"
          />
          <span>
            <span className="block text-[13px] font-medium text-ink-1">
              Force: skip graceful shutdown
            </span>
            <span className="block text-xs text-ink-3">
              {terminating
                ? 'It has been terminating since it was deleted. Forcing removes it from the API at once; if its node is unreachable, its containers may keep running.'
                : 'Removes it from the API at once, without waiting for its containers to stop.'}
            </span>
          </span>
        </label>
      )}
    </ActionDialog>
  )
}
