import { HardDrive, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { parseQuantity } from '@shared/quantity'
import { Stepper } from '@renderer/components/Stepper'
import { useChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { count, subjectOf, target, type ActionProps } from './common'

/** Min and max replicas of a HorizontalPodAutoscaler. */
export function AutoscalerDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const before = { min: object.spec.minReplicas as number, max: object.spec.maxReplicas as number }
  const [min, setMin] = useState(before.min)
  const [max, setMax] = useState(before.max)
  const { pending, error, submit } = useSubmit(onClose)
  const valid = Number.isInteger(min) && Number.isInteger(max) && min <= max
  const patch = (range: { min: number; max: number }) => ({
    spec: { minReplicas: range.min, maxReplicas: range.max },
  })
  const command = (range: { min: number; max: number }) =>
    kubectl(
      context,
      namespace,
      'patch',
      objectArg('HorizontalPodAutoscaler', name),
      '--type=merge',
      '-p',
      JSON.stringify(patch(range)),
    )
  const range = valid ? { min, max } : before
  const unchanged = min === before.min && max === before.max
  const running: number = object.status.currentReplicas

  return (
    <ActionDialog
      icon={SlidersHorizontal}
      title={`Replica range of ${name}`}
      subject={subjectOf(object)}
      command={command(range)}
      confirmLabel="Save"
      ready={valid && !unchanged}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: { action: 'patch', patchType: 'merge', patch: patch(range) },
            },
            {
              title: `${name} now scales between ${min} and ${max} replicas`,
              command: command(range),
              undo: {
                change: {
                  ...target(object),
                  change: { action: 'patch', patchType: 'merge', patch: patch(before) },
                },
                meta: {
                  title: `${name} scales between ${before.min} and ${before.max} replicas again`,
                  command: command(before),
                },
              },
            },
          ),
        )
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Minimum</p>
          <Stepper label="Minimum replicas" value={min} onChange={setMin} min={1} autoFocus />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Maximum</p>
          <Stepper label="Maximum replicas" value={max} onChange={setMax} min={1} />
        </div>
      </div>
      <p className="text-xs text-ink-3" aria-live="polite">
        {min > max
          ? 'The minimum can’t be above the maximum.'
          : `Running ${count(running, 'replica')} now. ${
              running < min
                ? 'It scales up to the new minimum.'
                : running > max
                  ? 'It scales down to the new maximum.'
                  : 'That is within the new range.'
            }`}
      </p>
    </ActionDialog>
  )
}

const UNITS = { Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 } as const
type Unit = keyof typeof UNITS

/** Grows a PersistentVolumeClaim; volumes can't shrink. */
export function ExpandVolumeDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const requested: string = object.spec.resources.requests.storage
  const bytes = parseQuantity(requested)
  const [amount, setAmount] = useState(() => Math.ceil(bytes / UNITS.Gi) * 2)
  const [unit, setUnit] = useState<Unit>('Gi')
  const { pending, error, submit } = useSubmit(onClose)
  const storageClass = useList('StorageClass', { namespace: null }).data?.find(
    (c) => c.metadata.name === object.spec.storageClassName,
  )
  // Unknown classes are left to the API server to judge.
  const fixed = storageClass?.allowVolumeExpansion === false
  const size = `${amount}${unit}`
  const bigger = Number.isInteger(amount) && amount * UNITS[unit] > bytes
  const patch = { spec: { resources: { requests: { storage: size } } } }
  const command = kubectl(
    context,
    namespace,
    'patch',
    objectArg('PersistentVolumeClaim', name),
    '-p',
    JSON.stringify(patch),
  )

  return (
    <ActionDialog
      icon={HardDrive}
      title={`Expand ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Expand"
      ready={bigger && !fixed}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            { ...target(object), change: { action: 'patch', patchType: 'merge', patch } },
            { title: `Expanded ${name} to ${size}`, command },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        It has {requested} now. The storage provider grows the volume; some filesystems only finish
        growing once a pod mounts it again. Volumes can’t be made smaller afterwards.
      </p>
      <div className="flex items-center gap-2">
        <Stepper
          label="New size"
          value={amount}
          onChange={setAmount}
          min={1}
          max={100_000}
          autoFocus
        />
        <select
          aria-label="Unit"
          value={unit}
          onChange={(event) => setUnit(event.target.value as Unit)}
          className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink-1"
        >
          {Object.keys(UNITS).map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
      {fixed ? (
        <p className="text-xs text-critical-text">
          Its storage class, {object.spec.storageClassName}, doesn’t allow volumes to grow.
        </p>
      ) : (
        !bigger &&
        Number.isInteger(amount) && (
          <p className="text-xs text-critical-text">
            The new size has to be larger than {requested}.
          </p>
        )
      )}
    </ActionDialog>
  )
}
