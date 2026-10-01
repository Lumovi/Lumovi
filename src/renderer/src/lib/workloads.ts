/**
 * Workloads, whatever their kind: what the Workloads page lists, and which
 * workload each pod belongs to (through its ReplicaSet or Job).
 */
import type { KubeObject, UsageSample } from '@shared/api'
import { kindOf, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { formatRef } from './routes'

/** The kinds of workload with a list of their own, in the order the Workloads tabs show them. */
export const WORKLOAD_TYPES = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
] as const satisfies readonly BuiltinKind[]

export type WorkloadType = (typeof WORKLOAD_TYPES)[number]

export function isWorkloadType(kind: ResourceKind | undefined): kind is WorkloadType {
  return (WORKLOAD_TYPES as readonly ResourceKind[]).includes(kind!)
}

/** The lists a workload can come from. */
export interface WorkloadLists {
  Deployment: KubeObject[]
  StatefulSet: KubeObject[]
  DaemonSet: KubeObject[]
  Job: KubeObject[]
  CronJob: KubeObject[]
  ReplicaSet: KubeObject[]
  Pod: KubeObject[]
}

/** A workload's identity: `Kind/namespace/name`, as the detail panel names objects. */
export function workloadKey(kind: ResourceKind, namespace: string | undefined, name: string) {
  return formatRef({ kind, namespace, name })
}

const keyOf = (object: KubeObject) =>
  workloadKey(kindOf(object), object.metadata.namespace, object.metadata.name)

/** The object that manages this one, if any. */
export function controllerOf(object: KubeObject) {
  return object.metadata.ownerReferences?.find((ref) => ref.controller)
}

/**
 * What the Workloads page lists: every Deployment, StatefulSet, DaemonSet and
 * CronJob, and the Jobs, ReplicaSets and pods nothing manages. The rest are
 * how those run (a Deployment's ReplicaSets, a CronJob's Jobs), or belong to
 * something else (a node's static pods, an operator's).
 */
export function listedWorkloads(lists: WorkloadLists): KubeObject[] {
  const unmanaged = (objects: KubeObject[]) => objects.filter((o) => !controllerOf(o))
  return [
    ...lists.Deployment,
    ...lists.StatefulSet,
    ...lists.DaemonSet,
    ...lists.CronJob,
    ...unmanaged(lists.Job),
    ...unmanaged(lists.ReplicaSet),
    ...unmanaged(lists.Pod),
  ]
}

/**
 * Which workload runs each pod, by `namespace/name`: up its owners (a ReplicaSet
 * to its Deployment, a Job to its CronJob) to the one nothing manages.
 */
export function podWorkloads(lists: WorkloadLists): Map<string, string> {
  const managers = new Map([...lists.ReplicaSet, ...lists.Job].map((o) => [keyOf(o), o]))
  const top = (ref: { kind: string; name: string }, namespace?: string): string => {
    const key = workloadKey(ref.kind, namespace, ref.name)
    const manager = managers.get(key)
    const owner = manager && controllerOf(manager)
    return owner ? top(owner, namespace) : key
  }
  return new Map(
    lists.Pod.map((pod) => {
      const { namespace, name } = pod.metadata
      const owner = controllerOf(pod)
      return [`${namespace}/${name}`, owner ? top(owner, namespace) : keyOf(pod)]
    }),
  )
}

/** Each workload's usage: what its pods use, added up. */
export function workloadUsage(
  samples: UsageSample[],
  owners: Map<string, string>,
): Map<string, UsageSample> {
  const usage = new Map<string, UsageSample>()
  for (const sample of samples) {
    const workload = owners.get(`${sample.namespace}/${sample.name}`)
    if (!workload) continue
    const total = usage.get(workload)
    usage.set(workload, {
      name: workload,
      namespace: sample.namespace,
      cpu: (total?.cpu ?? 0) + sample.cpu,
      memory: (total?.memory ?? 0) + sample.memory,
    })
  }
  return usage
}

/** The autoscaler that scales each workload, by workload key. */
export function autoscalers(hpas: KubeObject[]): Map<string, KubeObject> {
  return new Map(
    hpas.map((hpa) => {
      const target = hpa.spec.scaleTargetRef as { kind: string; name: string }
      return [workloadKey(target.kind, hpa.metadata.namespace, target.name), hpa]
    }),
  )
}

/** The containers a workload runs (from its pod template). */
export function containersOf(object: KubeObject): { name: string; image: string }[] {
  if (object.kind === 'Pod') return object.spec.containers
  const template =
    object.kind === 'CronJob' ? object.spec.jobTemplate.spec.template : object.spec.template
  return template.spec.containers
}
