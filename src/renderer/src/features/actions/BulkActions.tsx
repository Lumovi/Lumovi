import {
  Ban,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleX,
  LoaderCircle,
  Minus,
  RotateCw,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { apiKindOf, isBuiltinKind, type ResourceKind } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import { useChange, type ClusterChange } from '@renderer/hooks/change'
import { labelFor } from '@renderer/hooks/resources'
import { useReadOnly } from '@renderer/hooks/settings'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { looksLikeProduction } from '@renderer/lib/production'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { ActionDialog } from './ActionDialog'
import { kindOf, nowTimestamp, target } from './common'

interface BulkAction {
  id: string
  label: string
  /** "Deleted", "Restarted"… */
  done: string
  icon: LucideIcon
  danger?: boolean
  /** Whether it makes sense for this object (a pod without a controller can't be restarted). */
  applies: (object: KubeObject) => boolean
  change: (object: KubeObject) => ClusterChange['change']
  /** kubectl's arguments for doing the same to `names` (one namespace at a time). */
  args: (kind: ResourceKind, names: string[]) => string[]
}

const refs = (kind: ResourceKind, names: string[]) => names.map((name) => objectArg(kind, name))
const suspendArgs = (suspend: boolean) => (kind: ResourceKind, names: string[]) => [
  'patch',
  ...refs(kind, names),
  '--type=merge',
  '-p',
  JSON.stringify({ spec: { suspend } }),
]

const WORKLOADS: readonly ResourceKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']
const spec = (patch: Record<string, unknown>): ClusterChange['change'] => ({
  action: 'patch',
  patchType: 'merge',
  patch: { spec: patch },
})

const BULK: readonly BulkAction[] = [
  {
    id: 'restart',
    label: 'Restart',
    done: 'Restarted',
    icon: RotateCw,
    applies: (o) =>
      WORKLOADS.includes(kindOf(o)) ||
      (o.kind === 'Pod' && (o.metadata.ownerReferences ?? []).some((ref) => ref.controller)),
    change: (o) =>
      o.kind === 'Pod'
        ? { action: 'delete' }
        : {
            action: 'patch',
            patchType: 'strategic',
            patch: {
              spec: {
                template: {
                  metadata: {
                    annotations: { 'kubectl.kubernetes.io/restartedAt': nowTimestamp() },
                  },
                },
              },
            },
          },
    args: (kind, names) =>
      kind === 'Pod'
        ? ['delete', ...refs(kind, names)]
        : ['rollout', 'restart', ...refs(kind, names)],
  },
  {
    id: 'cordon',
    label: 'Cordon',
    done: 'Cordoned',
    icon: Ban,
    applies: (o) => o.kind === 'Node' && !o.spec.unschedulable,
    change: () => spec({ unschedulable: true }),
    args: (_kind, names) => ['cordon', ...names],
  },
  {
    id: 'uncordon',
    label: 'Uncordon',
    done: 'Uncordoned',
    icon: CirclePlay,
    applies: (o) => o.kind === 'Node' && Boolean(o.spec.unschedulable),
    change: () => spec({ unschedulable: null }),
    args: (_kind, names) => ['uncordon', ...names],
  },
  {
    id: 'suspend',
    label: 'Suspend',
    done: 'Suspended',
    icon: CirclePause,
    applies: (o) =>
      (o.kind === 'CronJob' || o.kind === 'Job') && !o.spec.suspend && !o.status?.completionTime,
    change: () => spec({ suspend: true }),
    args: suspendArgs(true),
  },
  {
    id: 'resume',
    label: 'Resume',
    done: 'Resumed',
    icon: CirclePlay,
    applies: (o) => (o.kind === 'CronJob' || o.kind === 'Job') && Boolean(o.spec.suspend),
    change: () => spec({ suspend: false }),
    args: suspendArgs(false),
  },
  {
    id: 'delete',
    label: 'Delete',
    done: 'Deleted',
    icon: Trash2,
    danger: true,
    applies: () => true,
    change: () => ({ action: 'delete' }),
    args: (kind, names) => ['delete', ...refs(kind, names)],
  },
]

/** Kinds that are hard to recover, where bulk deletes ask to type what they'll do. */
const RISKY: readonly ResourceKind[] = [
  'Namespace',
  'Node',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'StorageClass',
  // Deleting a CRD deletes every object of its kind.
  'CustomResourceDefinition.apiextensions.k8s.io',
]

/** "3 pods", "1 volume claim", "2 StatefulSets": a resource's label, counted. */
export function countOf(kind: ResourceKind, n: number): string {
  let label = labelFor(kind)
  if (n === 1) {
    // Other kinds' singular is their kind.
    label = isBuiltinKind(kind)
      ? label
          .replace(/ies$/, 'y')
          .replace(/(ss|sh|ch)es$/, '$1')
          .replace(/s$/, '')
      : apiKindOf(kind)
  }
  // Plain words read better lowercase; CamelCase kinds stay as Kubernetes spells them.
  if (/^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(label)) label = label.toLowerCase()
  return `${n} ${label}`
}

/** The rows picked in a list, and what can be done to all of them at once. */
export function SelectionBar({
  kind,
  objects,
  onClear,
}: {
  kind: ResourceKind
  objects: KubeObject[]
  onClear: () => void
}) {
  const { readOnly } = useReadOnly()
  // What the dialog works on stays put while deleted rows leave the list.
  const [running, setRunning] = useState<{ action: BulkAction; objects: KubeObject[] } | null>(null)
  if (objects.length === 0) return null
  const actions = BULK.filter((action) => objects.some(action.applies))
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected rows"
        className="absolute bottom-14 left-1/2 z-20 flex -translate-x-1/2 animate-toast-in items-center gap-1 rounded-xl border border-line-strong bg-surface-2 py-1.5 pr-1.5 pl-3.5 shadow-pop"
      >
        <span className="mr-2 text-[13px] font-medium whitespace-nowrap text-ink-1 tabular-nums">
          {objects.length} selected
        </span>
        {actions.map((action) => {
          const button = (
            <Button
              key={action.id}
              variant="ghost"
              disabled={readOnly}
              onClick={() => setRunning({ action, objects })}
              className={cn(
                'h-7 px-2.5 text-xs',
                action.danger && 'text-critical-text hover:bg-critical/10',
              )}
            >
              <action.icon className="!size-3.5" />
              {action.label}
            </Button>
          )
          return readOnly ? (
            <Tooltip key={action.id} content="Changes are turned off for this cluster.">
              <span tabIndex={0}>{button}</span>
            </Tooltip>
          ) : (
            button
          )
        })}
        <span className="mx-1 h-5 w-px bg-line" />
        <button
          type="button"
          aria-label="Clear selection"
          onClick={onClear}
          className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink-1"
        >
          <X className="size-4" />
        </button>
      </div>
      {running && (
        <BulkDialog
          kind={kind}
          action={running.action}
          objects={running.objects.filter(running.action.applies)}
          skipped={running.objects.filter((o) => !running.action.applies(o)).length}
          onClose={(finished) => {
            setRunning(null)
            if (finished) onClear()
          }}
        />
      )}
    </>
  )
}

type Progress = 'running' | 'done' | { error: string }

/** How many changes run at once. */
const CONCURRENCY = 4

function BulkDialog({
  kind,
  action,
  objects,
  skipped,
  onClose,
}: {
  kind: ResourceKind
  action: BulkAction
  objects: KubeObject[]
  skipped: number
  onClose: (finished: boolean) => void
}) {
  const { context } = useCluster()
  const change = useChange()
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [phase, setPhase] = useState<'review' | 'running' | 'done'>('review')
  const key = (o: KubeObject) => `${o.metadata.namespace}/${o.metadata.name}`
  const plural = labelFor(kind).toLowerCase()
  const namespaces = [...new Set(objects.map((o) => o.metadata.namespace))]
  const command = namespaces
    .map((namespace) =>
      kubectl(
        context,
        namespace,
        ...action.args(
          kind,
          objects.filter((o) => o.metadata.namespace === namespace).map((o) => o.metadata.name),
        ),
      ),
    )
    .join('\n')
  const failures = objects.filter((o) => typeof progress[key(o)] === 'object')

  const runOne = async (object: KubeObject) => {
    setProgress((p) => ({ ...p, [key(object)]: 'running' }))
    const result = await change(
      { ...target(object), change: action.change(object) },
      {
        title: `${action.done} ${kindOf(object).toLowerCase()} ${object.metadata.name}`,
        command,
        silent: true,
      },
    )
    setProgress((p) => ({
      ...p,
      [key(object)]: result.ok ? 'done' : { error: result.error.message },
    }))
    return result.ok
  }

  // Runs on everything, or again on what failed; closes when all of it went through.
  const run = async (batch: KubeObject[]) => {
    setPhase('running')
    const queue = [...batch]
    let failed = 0
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let o = queue.shift(); o; o = queue.shift()) if (!(await runOne(o))) failed++
      }),
    )
    if (failed) {
      setPhase('done')
    } else {
      toast({ tone: 'success', title: `${action.done} ${countOf(kind, objects.length)}` })
      onClose(true)
    }
  }

  const risky = action.danger && (RISKY.includes(kind) || looksLikeProduction(context))
  return (
    <ActionDialog
      icon={action.icon}
      tone={action.danger ? 'danger' : 'default'}
      title={`${action.label} ${countOf(kind, objects.length)}?`}
      subject={labelFor(kind)}
      command={command}
      confirmLabel={phase === 'done' ? 'Retry failed' : action.label}
      typeToConfirm={risky && phase === 'review' ? `${action.id} ${plural}` : undefined}
      pending={phase === 'running'}
      wide
      onClose={() => onClose(false)}
      onSubmit={() => void run(phase === 'done' ? failures : objects)}
    >
      {skipped > 0 && (
        <p className="text-xs text-ink-3">
          Left out: {skipped} of the selected, which {action.label.toLowerCase()} doesn’t apply to.
        </p>
      )}
      {phase === 'done' && (
        <p
          role="status"
          className={cn('rounded-lg px-3 py-2 text-[13px]', 'bg-warn/10 text-warn-text')}
        >
          {failures.length} of {objects.length} couldn’t be changed; see why below.
        </p>
      )}
      <ul
        aria-label={`Selected ${plural}`}
        className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line"
      >
        {objects.map((object) => {
          const state = progress[key(object)]
          return (
            <li key={key(object)} className="flex items-center gap-3 px-3 py-2">
              <span className="grid size-4 shrink-0 place-items-center">
                {state === 'running' ? (
                  <LoaderCircle aria-label="Working" className="size-4 animate-spin text-accent" />
                ) : state === 'done' ? (
                  <CircleCheck aria-label="Done" className="size-4 text-good-text" />
                ) : state ? (
                  <CircleX aria-label="Failed" className="size-4 text-critical-text" />
                ) : (
                  <Minus aria-hidden className="size-3.5 text-ink-3" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-ink-1">
                  {object.metadata.name}
                </span>
                {typeof state === 'object' ? (
                  <span className="block text-xs break-words text-critical-text selectable">
                    {state.error}
                  </span>
                ) : (
                  object.metadata.namespace && (
                    <span className="block truncate text-xs text-ink-3">
                      {object.metadata.namespace}
                    </span>
                  )
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </ActionDialog>
  )
}
