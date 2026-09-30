import { LogOut, Play, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useChange } from '@renderer/hooks/change'
import { useGo } from '@renderer/hooks/go'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { formatRef, kindPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { kindOf, nowTimestamp, subjectOf, target, type ActionProps } from './common'

const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'

function rolloutNote(object: ActionProps['object']): string {
  if (object.kind === 'StatefulSet') {
    return 'Pods are replaced one at a time, from the highest ordinal down, each once the one before it is ready.'
  }
  if (object.kind === 'DaemonSet') return 'Pods are replaced node by node.'
  if (object.spec.strategy?.type === 'Recreate') {
    return 'This Deployment uses the Recreate strategy: every pod stops before new ones start, so expect downtime.'
  }
  return 'Pods are replaced a few at a time, following the rollout strategy, so a healthy app stays available.'
}

/** `kubectl rollout restart`: new pods with the same spec. */
export function RestartDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const { pending, error, submit } = useSubmit(onClose)
  const command = kubectl(context, namespace, 'rollout', 'restart', objectArg(kindOf(object), name))
  return (
    <ActionDialog
      icon={RotateCw}
      title={`Restart ${name}?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Restart"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: {
                action: 'patch',
                patchType: 'strategic',
                patch: {
                  spec: {
                    template: { metadata: { annotations: { [RESTARTED_AT]: nowTimestamp() } } },
                  },
                },
              },
            },
            { title: `Restarted ${name}`, command },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{rolloutNote(object)}</p>
    </ActionDialog>
  )
}

/** Deletes a pod so its controller starts a fresh one. */
export function RestartPodDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const owner = object.metadata.ownerReferences!.find((ref) => ref.controller)!
  const { pending, error, submit } = useSubmit(onClose)
  const command = kubectl(context, namespace, 'delete', objectArg('Pod', name))
  return (
    <ActionDialog
      icon={RotateCw}
      title={`Restart ${name}?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Restart pod"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            { ...target(object), change: { action: 'delete' } },
            { title: `Restarted pod ${name}`, command },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        The pod shuts down gracefully and its {owner.kind}{' '}
        <span className="font-medium text-ink-1">{owner.name}</span> starts a new one to replace it.
      </p>
    </ActionDialog>
  )
}

/** The Eviction API: like a delete, but PodDisruptionBudgets can refuse it. */
export function EvictDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const managed = (object.metadata.ownerReferences ?? []).some((ref) => ref.controller)
  const { pending, error, submit } = useSubmit(onClose)
  const eviction = JSON.stringify({
    apiVersion: 'policy/v1',
    kind: 'Eviction',
    metadata: { name, namespace },
  })
  const command = `echo '${eviction}' | kubectl create --raw /api/v1/namespaces/${namespace}/pods/${name}/eviction -f - --context ${context}`
  return (
    <ActionDialog
      icon={LogOut}
      title={`Evict ${name}?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Evict"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            { ...target(object), change: { action: 'evict' } },
            { title: `Evicted ${name}`, command },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Evictions respect PodDisruptionBudgets: if this would leave too few pods running, the
        cluster refuses and nothing changes.{' '}
        {managed
          ? 'Its controller starts a replacement, on another node if this one is cordoned.'
          : 'This pod has no controller, so nothing will replace it.'}
      </p>
    </ActionDialog>
  )
}

/** `kubectl create job --from=cronjob/…`: a run outside the schedule. */
export function RunNowDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const go = useGo()
  const { name, namespace, uid } = object.metadata
  // Like kubectl's generated names: short, and still within the 63 characters of a label value.
  const [job] = useState(
    () => `${name.slice(0, 45)}-manual-${Math.random().toString(36).slice(2, 7)}`,
  )
  const { pending, error, submit } = useSubmit(onClose)
  const command = kubectl(context, namespace, 'create', 'job', job, `--from=cronjob/${name}`)
  const template = object.spec.jobTemplate
  return (
    <ActionDialog
      icon={Play}
      title={`Run ${name} now?`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Run now"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              kind: 'Job',
              namespace,
              change: {
                action: 'create',
                object: {
                  apiVersion: 'batch/v1',
                  kind: 'Job',
                  metadata: {
                    name: job,
                    namespace,
                    labels: template.metadata?.labels,
                    annotations: {
                      ...template.metadata?.annotations,
                      'cronjob.kubernetes.io/instantiate': 'manual',
                    },
                    ownerReferences: [
                      {
                        apiVersion: 'batch/v1',
                        kind: 'CronJob',
                        name,
                        uid: uid!,
                        controller: true,
                      },
                    ],
                  },
                  spec: template.spec,
                },
              },
            },
            {
              title: `Started job ${job}`,
              command,
              action: {
                label: 'Open',
                run: () =>
                  go(
                    `${kindPath(context, 'Job')}?open=${encodeURIComponent(formatRef({ kind: 'Job', name: job, namespace }))}`,
                  ),
              },
            },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Starts job <span className="font-mono text-[12px] text-ink-1">{job}</span> from {name}’s
        template right away, outside its schedule
        {object.spec.suspend ? ' (the schedule itself stays suspended)' : ''}.
      </p>
    </ActionDialog>
  )
}
