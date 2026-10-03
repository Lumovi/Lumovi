import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CircleCheck, LoaderCircle, Scale } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { useChange, type ClusterChange } from '@renderer/hooks/change'
import { api } from '@renderer/lib/api'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import {
  changedContainers,
  containersOf,
  describeAmount,
  quantity,
  RESOURCES,
  type Resource,
  type WorkloadAdvice,
} from '@renderer/lib/rightsizing'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'
import { kindOf, subjectOf, target } from '../actions/common'

/** One request or limit of one container that the advice changes. */
interface Edit {
  id: string
  container: string
  field: 'requests' | 'limits'
  resource: Resource
  /** As the template has it now (absent: not set). */
  before?: string
  after: string
  current?: number
  recommended: number
}

const FIELD = { requests: 'request', limits: 'limit' } as const
const NOUN: Record<Resource, string> = { cpu: 'CPU', memory: 'memory' }

/** Every change the advice makes, in its containers' order. */
function editsOf(workload: KubeObject, advice: WorkloadAdvice): Edit[] {
  const template = new Map(containersOf(workload).map((c) => [c.name, c]))
  return changedContainers(advice).flatMap((c) =>
    (['requests', 'limits'] as const).flatMap((field) =>
      RESOURCES.flatMap((resource) => {
        const plan = (field === 'requests' ? c.requests : c.limits)[resource]
        if (plan.change === 'keep') return []
        return [
          {
            id: `${c.name}/${field}/${resource}`,
            container: c.name,
            field,
            resource,
            before: template.get(c.name)!.resources?.[field]?.[resource],
            after: quantity(resource, plan.recommended!),
            current: plan.current,
            recommended: plan.recommended!,
          },
        ]
      }),
    ),
  )
}

/** A strategic merge patch of the pod template's containers; `null` removes a value. */
function patchOf(edits: Edit[], value: (edit: Edit) => string | null) {
  const containers = new Map<string, Record<string, Record<string, string | null>>>()
  for (const edit of edits) {
    const resources = containers.get(edit.container) ?? {}
    resources[edit.field] = { ...resources[edit.field], [edit.resource]: value(edit) }
    containers.set(edit.container, resources)
  }
  return {
    spec: {
      template: {
        spec: {
          containers: [...containers].map(([name, resources]) => ({ name, resources })),
        },
      },
    },
  }
}

/**
 * Applies a workload's recommendation: the changes it makes (each can be
 * left out), checked with the API server first, so quotas, LimitRanges and
 * admission webhooks have their say before anything changes.
 */
export function ApplyDialog({
  workload,
  advice,
  onClose,
}: {
  workload: KubeObject
  advice: WorkloadAdvice
  onClose: () => void
}) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = workload.metadata
  const edits = editsOf(workload, advice)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const chosen = edits.filter((e) => !skipped.has(e.id))
  const { pending, error, submit } = useSubmit(onClose)

  const request = (list: Edit[], value: (edit: Edit) => string | null): ClusterChange => ({
    ...target(workload),
    change: { action: 'patch', patchType: 'strategic', patch: patchOf(list, value) },
  })
  const apply = request(chosen, (e) => e.after)
  const undo = request(chosen, (e) => e.before ?? null)
  // The same, by kubectl: one `set resources` per container.
  const command = (list: Edit[]) =>
    [...new Set(list.map((e) => e.container))]
      .map((container) => {
        const of = (field: Edit['field']) =>
          list
            .filter((e) => e.container === container && e.field === field)
            .map((e) => `${e.resource}=${e.after}`)
            .join(',')
        return kubectl(
          context,
          namespace,
          'set',
          'resources',
          objectArg(kindOf(workload), name),
          '-c',
          container,
          ...(of('requests') ? [`--requests=${of('requests')}`] : []),
          ...(of('limits') ? [`--limits=${of('limits')}`] : []),
        )
      })
      .join('\n')
  // Asked again whenever the choice changes; nothing is saved.
  const check = useQuery({
    queryKey: ['rightsizing-dry-run', context, kindOf(workload), namespace, name, apply],
    queryFn: () => api.kube.change({ ...apply, context, dryRun: true }),
    enabled: chosen.length > 0,
    staleTime: Infinity,
    gcTime: 0,
  })
  const rejected = check.data && !check.data.ok ? check.data.error.message : undefined
  // What the chosen requests change across its pods: what they free, and what they need more.
  const changes = RESOURCES.map((resource) => ({
    resource,
    by:
      chosen
        .filter((e) => e.field === 'requests' && e.resource === resource)
        .reduce((sum, e) => sum + e.recommended - (e.current ?? 0), 0) * advice.replicas,
  }))
  const amount = ({ resource, by }: (typeof changes)[number]) =>
    describeAmount(resource, Math.abs(by))
  const frees = changes
    .filter((c) => c.by < -1e-9)
    .map((c) => `${amount(c)} of ${NOUN[c.resource]}`)
  const needs = changes
    .filter((c) => c.by > 1e-9)
    .map((c) => `${amount(c)} more ${NOUN[c.resource]}`)
  const effect = [
    frees.length > 0 && `frees ${frees.join(' and ')}`,
    needs.length > 0 && `needs ${needs.join(' and ')}`,
  ]
    .filter(Boolean)
    .join(', and ')
  const rollout =
    workload.spec.updateStrategy?.type === 'OnDelete'
      ? 'Its update strategy is OnDelete: pods keep their resources until they’re deleted.'
      : 'Its pods are replaced with the new resources, following its rollout strategy.'

  return (
    <ActionDialog
      icon={Scale}
      title={`Right-size ${name}`}
      subject={subjectOf(workload)}
      command={command(chosen.length ? chosen : edits)}
      confirmLabel="Apply"
      ready={chosen.length > 0 && check.data?.ok === true}
      pending={pending}
      error={error ?? rejected}
      wide
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(apply, {
            title:
              chosen.length === 1
                ? `Set ${chosen[0]!.container}’s ${NOUN[chosen[0]!.resource]} ${FIELD[chosen[0]!.field]} in ${name} to ${chosen[0]!.after}`
                : `Right-sized ${name}: ${chosen.length} changes`,
            command: command(chosen),
            undo: {
              change: undo,
              meta: {
                title: `Restored the resources of ${name}`,
                command: kubectl(
                  context,
                  namespace,
                  'patch',
                  objectArg(kindOf(workload), name),
                  '-p',
                  JSON.stringify(patchOf(chosen, (e) => e.before ?? null)),
                ),
              },
            },
          }),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{rollout}</p>
      <ul aria-label="Changes" className="divide-y divide-line rounded-lg border border-line">
        {edits.map((edit) => {
          const on = !skipped.has(edit.id)
          return (
            <li key={edit.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = new Set(skipped)
                    if (!next.delete(edit.id)) next.add(edit.id)
                    setSkipped(next)
                  }}
                  className="size-4 accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-ink-1">
                  {edits.some((e) => e.container !== edit.container) && (
                    <span className="font-mono text-xs text-ink-2">{edit.container} · </span>
                  )}
                  {NOUN[edit.resource][0]!.toUpperCase() + NOUN[edit.resource].slice(1)}{' '}
                  {FIELD[edit.field]}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                  <span className="text-ink-3">
                    {edit.current === undefined
                      ? 'none'
                      : describeAmount(edit.resource, edit.current)}
                  </span>
                  <ArrowRight className="size-3 text-ink-3" aria-label="to" />
                  <span className={on ? 'font-medium text-ink-1' : 'text-ink-3 line-through'}>
                    {describeAmount(edit.resource, edit.recommended)}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      {effect && (
        <p className="text-[13px] text-ink-2">
          Across its {advice.replicas === 1 ? 'pod' : `${advice.replicas} pods`}, it {effect}.
        </p>
      )}
      {chosen.length > 0 && !rejected && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-ink-3">
          {check.data?.ok ? (
            <>
              <CircleCheck className="size-3.5 text-good-text" />
              The API server accepts this change (checked without saving it).
            </>
          ) : (
            <>
              <LoaderCircle className="size-3.5 animate-spin" />
              Checking the change with the API server…
            </>
          )}
        </p>
      )}
    </ActionDialog>
  )
}
