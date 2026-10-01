import { useQuery } from '@tanstack/react-query'
import { ArrowUpDown, Info } from 'lucide-react'
import { useState } from 'react'
import { isBuiltinKind } from '@shared/resources'
import { Loading } from '@renderer/components/States'
import { Stepper } from '@renderer/components/Stepper'
import { useChange, type ClusterChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { api, unwrap } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { count, kindOf, subjectOf, target, type ActionProps } from './common'

const PRESETS = [0, 1, 2, 3, 5, 10]
/** Beyond this many pods the preview summarises instead of drawing each one. */
const MAX_DOTS = 24

/**
 * Scales a workload: built-in ones through their spec, custom ones through
 * the scale subresource, which knows where their replicas are.
 */
export function ScaleDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const { name, namespace } = object.metadata
  const kind = kindOf(object)
  const builtin = isBuiltinKind(kind)
  const scale = useQuery({
    queryKey: ['object', context, kind, namespace, name, 'scale'],
    queryFn: () => unwrap(api.kube.get({ context, kind, name, namespace, subresource: 'scale' })),
    enabled: !builtin,
    // Read afresh each time the dialog opens: scaling is about how many there are now.
    gcTime: 0,
  })
  // The API server defaults built-in workloads' replicas, so they're always set.
  const current: number | undefined = builtin ? object.spec.replicas : scale.data?.spec.replicas
  const scaleTo = (to: number): ClusterChange => ({
    ...target(object),
    change: {
      action: 'patch',
      patchType: 'merge',
      ...(builtin ? {} : { subresource: 'scale' as const }),
      patch: { spec: { replicas: to } },
    },
  })
  return (
    <ScaleForm
      // Starts over once the replicas are known.
      key={current === undefined ? 'reading' : 'read'}
      object={object}
      current={current}
      readError={scale.error?.message}
      scaleTo={scaleTo}
      onClose={onClose}
    />
  )
}

function ScaleForm({
  object,
  current,
  readError,
  scaleTo,
  onClose,
}: ActionProps & {
  /** Unknown while it's being read. */
  current: number | undefined
  readError?: string
  scaleTo: (to: number) => ClusterChange
}) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const [replicas, setReplicas] = useState(current)
  const { pending, error, submit } = useSubmit(onClose)
  const autoscaler = useList('HorizontalPodAutoscaler', { namespace }).data?.find(
    (hpa) =>
      hpa.spec.scaleTargetRef?.kind === object.kind && hpa.spec.scaleTargetRef?.name === name,
  )

  const command = (to?: number) =>
    kubectl(
      context,
      namespace,
      'scale',
      objectArg(kindOf(object), name),
      ...(to === undefined ? [] : [`--replicas=${to}`]),
    )
  const valid = Number.isInteger(replicas)

  return (
    <ActionDialog
      icon={ArrowUpDown}
      title={`Scale ${name}`}
      subject={subjectOf(object)}
      command={command(valid ? replicas : current)}
      confirmLabel="Scale"
      ready={valid && replicas !== current}
      pending={pending}
      error={error ?? readError}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(scaleTo(replicas!), {
            title: `Scaled ${name} to ${count(replicas!, 'replica')}`,
            command: command(replicas),
            undo: {
              change: scaleTo(current!),
              meta: {
                title: `Scaled ${name} back to ${count(current!, 'replica')}`,
                command: command(current),
              },
            },
          }),
        )
      }
    >
      {current === undefined ? (
        !readError && <Loading label="Reading its replicas…" />
      ) : (
        <>
          <div className="flex flex-col items-center gap-3 py-2">
            <Stepper
              label="Replicas"
              value={replicas!}
              onChange={setReplicas}
              size="lg"
              autoFocus
            />
            <div className="flex gap-1.5" role="group" aria-label="Presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setReplicas(preset)}
                  aria-pressed={replicas === preset}
                  className="h-6 min-w-7 rounded-md border border-line px-1.5 text-xs font-medium text-ink-2 tabular-nums transition-colors hover:bg-surface-3 hover:text-ink-1 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <PodPreview current={current} next={valid ? replicas! : current} />
        </>
      )}

      {autoscaler && (
        <p className="flex gap-2 rounded-lg bg-accent-soft px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          <span>
            The autoscaler{' '}
            <span className="font-medium text-ink-1">{autoscaler.metadata.name}</span> keeps {name}{' '}
            between {autoscaler.spec.minReplicas} and {autoscaler.spec.maxReplicas} replicas, and
            may change this again.
          </span>
        </p>
      )}
    </ActionDialog>
  )
}

/** One dot per pod: kept, added (outlined) and removed (struck through). */
function PodPreview({ current, next }: { current: number; next: number }) {
  const total = Math.max(current, next)
  const summary =
    next === current
      ? `${count(current, 'pod')}, unchanged`
      : next > current
        ? `${current} → ${next} · ${count(next - current, 'pod')} added`
        : `${current} → ${next} · ${count(current - next, 'pod')} removed`
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      {total > 0 && total <= MAX_DOTS && (
        <div aria-hidden className="mb-2 flex flex-wrap gap-1.5">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn(
                'size-3.5 rounded-[5px] transition-all duration-300',
                i < Math.min(current, next) && 'bg-good/80',
                i >= current && 'border-[1.5px] border-dashed border-accent bg-accent-soft',
                i >= next && 'scale-90 bg-critical/25 opacity-60',
              )}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-ink-2 tabular-nums" aria-live="polite">
        {summary}
      </p>
    </div>
  )
}
