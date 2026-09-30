import { CircleCheck, CircleX, LoaderCircle, Minus, PackageMinus, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { useChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { looksLikeProduction } from '@renderer/lib/production'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog } from './ActionDialog'
import { count, subjectOf, target, type ActionProps } from './common'

/** How many evictions run at once. */
const CONCURRENCY = 4
const MIRROR = 'kubernetes.io/config.mirror'

type Plan =
  | { kind: 'evict' }
  | { kind: 'skip'; reason: string }
  | { kind: 'needs'; option: 'localData' | 'unmanaged'; reason: string }

type Progress = { state: 'evicting' } | { state: 'evicted' } | { state: 'failed'; error: string }

/** What `kubectl drain` would do with a pod. */
function planFor(pod: KubeObject): Plan {
  const owner = pod.metadata.ownerReferences?.find((ref) => ref.controller)
  if (owner?.kind === 'DaemonSet')
    return { kind: 'skip', reason: 'DaemonSet pod, stays on the node' }
  if (pod.metadata.annotations?.[MIRROR])
    return { kind: 'skip', reason: 'Static pod, managed by the kubelet' }
  if (!owner)
    return { kind: 'needs', option: 'unmanaged', reason: 'No controller: it won’t come back' }
  if (pod.spec.volumes?.some((v: { emptyDir?: unknown }) => v.emptyDir)) {
    return { kind: 'needs', option: 'localData', reason: 'Its emptyDir data is lost' }
  }
  return { kind: 'evict' }
}

export function DrainDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const node = object.metadata.name
  const pods = useList('Pod', { namespace: null, fieldSelector: `spec.nodeName=${node}` }).data
  const [options, setOptions] = useState({ localData: false, unmanaged: false })
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [phase, setPhase] = useState<'review' | 'running' | 'done'>('review')
  const [error, setError] = useState<string>()

  // Once the drain starts, the list stays as it was, while evicted pods leave the node.
  const [started, setStarted] = useState<{ pod: KubeObject; plan: Plan }[]>()
  const planned =
    started ??
    (pods ?? [])
      .map((pod) => ({ pod, plan: planFor(pod) }))
      .sort((a, b) => a.pod.metadata.name.localeCompare(b.pod.metadata.name))
  const blocked = planned.filter(({ plan }) => plan.kind === 'needs' && !options[plan.option])
  const toEvict = planned.filter(
    ({ plan }) => plan.kind === 'evict' || (plan.kind === 'needs' && options[plan.option]),
  )
  const command = kubectl(
    context,
    undefined,
    'drain',
    node,
    '--ignore-daemonsets',
    ...(options.localData ? ['--delete-emptydir-data'] : []),
    ...(options.unmanaged ? ['--force'] : []),
  )

  const evict = async (pod: KubeObject) => {
    const key = `${pod.metadata.namespace}/${pod.metadata.name}`
    setProgress((p) => ({ ...p, [key]: { state: 'evicting' } }))
    const result = await change(
      { ...target(pod), change: { action: 'evict' } },
      { title: `Evicted ${pod.metadata.name}`, command, silent: true },
    )
    setProgress((p) => ({
      ...p,
      [key]: result.ok ? { state: 'evicted' } : { state: 'failed', error: result.error.message },
    }))
    return result.ok
  }

  const drain = async () => {
    setStarted(planned)
    setPhase('running')
    setError(undefined)
    if (!object.spec.unschedulable) {
      const cordoned = await change(
        {
          ...target(object),
          change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: true } } },
        },
        {
          title: `Cordoned ${node}`,
          command: kubectl(context, undefined, 'cordon', node),
          silent: true,
        },
      )
      if (!cordoned.ok) {
        setError(cordoned.error.message)
        setStarted(undefined)
        setPhase('review')
        return
      }
    }
    const queue = toEvict.map(({ pod }) => pod)
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let pod = queue.shift(); pod; pod = queue.shift()) await evict(pod)
      }),
    )
    setPhase('done')
  }

  const evicted = Object.values(progress).filter((p) => p.state === 'evicted').length
  const failed = Object.values(progress).filter((p) => p.state === 'failed').length

  return (
    <ActionDialog
      icon={PackageMinus}
      tone="danger"
      title={`Drain ${node}?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Drain"
      wide
      typeToConfirm={looksLikeProduction(context) && phase === 'review' ? node : undefined}
      ready={pods !== undefined && blocked.length === 0}
      pending={phase === 'running'}
      error={error}
      onClose={onClose}
      onSubmit={() => void drain()}
      footer={
        phase === 'done' ? (
          <Button variant="primary" data-confirm onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        {node} is cordoned so nothing new is scheduled on it, then its pods are evicted — their
        controllers start them on other nodes. PodDisruptionBudgets are respected.
      </p>

      {phase === 'review' && (
        <fieldset className="space-y-1.5">
          {(
            [
              [
                'localData',
                'Delete local data',
                'Evict pods that keep data in emptyDir volumes; the data is lost.',
              ],
              ['unmanaged', 'Evict pods without a controller', 'Nothing restarts them elsewhere.'],
            ] as const
          ).map(([option, label, hint]) => (
            <label
              key={option}
              className="flex cursor-default gap-3 rounded-lg border border-line px-3 py-2 has-checked:border-critical/40 has-checked:bg-critical/5"
            >
              <input
                type="checkbox"
                checked={options[option]}
                onChange={(event) => setOptions({ ...options, [option]: event.target.checked })}
                className="mt-0.5 accent-[var(--critical)]"
              />
              <span>
                <span className="block text-[13px] font-medium text-ink-1">{label}</span>
                <span className="block text-xs text-ink-3">{hint}</span>
              </span>
            </label>
          ))}
          {blocked.length > 0 && (
            <p className="text-xs text-warn-text">
              {count(blocked.length, 'pod')} {blocked.length === 1 ? 'needs' : 'need'} one of these
              options before the node can be drained.
            </p>
          )}
        </fieldset>
      )}

      {pods === undefined ? (
        <Loading label="Finding pods on the node…" />
      ) : (
        <>
          {phase === 'done' ? (
            <p
              role="status"
              className={cn(
                'rounded-lg px-3 py-2 text-[13px]',
                failed ? 'bg-warn/10 text-warn-text' : 'bg-good/10 text-good-text',
              )}
            >
              {failed
                ? `${count(failed, 'pod')} couldn’t be evicted. Retry below once the cause is fixed.`
                : `Drained ${node}: ${count(evicted, 'pod')} evicted.`}
            </p>
          ) : (
            <p className="text-xs text-ink-3 tabular-nums" aria-live="polite">
              {phase === 'review'
                ? `${count(toEvict.length, 'pod')} to evict, ${planned.length - toEvict.length} staying`
                : `${evicted} of ${toEvict.length} evicted`}
            </p>
          )}
          <ul
            aria-label="Pods on the node"
            className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line"
          >
            {planned.length === 0 && (
              <li className="px-3 py-3 text-[13px] text-ink-3">No pods run on {node}.</li>
            )}
            {planned.map(({ pod, plan }) => {
              const key = `${pod.metadata.namespace}/${pod.metadata.name}`
              const status = progress[key]
              const allowed =
                plan.kind === 'evict' || (plan.kind === 'needs' && options[plan.option])
              return (
                <li key={key} className="flex items-center gap-3 px-3 py-2">
                  <span className="grid size-4 shrink-0 place-items-center">
                    {status?.state === 'evicting' ? (
                      <LoaderCircle
                        aria-label="Evicting"
                        className="size-4 animate-spin text-accent"
                      />
                    ) : status?.state === 'evicted' ? (
                      <CircleCheck aria-label="Evicted" className="size-4 text-good-text" />
                    ) : status?.state === 'failed' ? (
                      <CircleX aria-label="Failed" className="size-4 text-critical-text" />
                    ) : (
                      <Minus aria-hidden className="size-3.5 text-ink-3" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-ink-1">
                      {pod.metadata.name}
                    </span>
                    <span
                      className={cn(
                        'block truncate text-xs',
                        status?.state === 'failed'
                          ? 'text-critical-text'
                          : plan.kind === 'needs' && !allowed
                            ? 'text-warn-text'
                            : 'text-ink-3',
                      )}
                    >
                      {status?.state === 'failed'
                        ? status.error
                        : plan.kind === 'evict'
                          ? pod.metadata.namespace
                          : `${pod.metadata.namespace} · ${plan.reason}`}
                    </span>
                  </span>
                  {status?.state === 'failed' && (
                    <Button variant="ghost" className="h-7 px-2" onClick={() => void evict(pod)}>
                      <RotateCw /> Retry
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </ActionDialog>
  )
}
