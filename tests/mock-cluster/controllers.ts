/**
 * A few of Kubernetes' controllers, simulated just enough that changes made in
 * the app play out like on a real cluster: scaled workloads gain or lose pods,
 * restarts and new images roll out new pods, deleted pods are replaced, jobs
 * run and finish, and volume claims grow.
 */
import { randomUUID } from 'node:crypto'
import { sha, suffix } from './builders.ts'
import type { Json, KubeObject, PodUsage } from './types.ts'

export interface Store {
  get(kind: string, namespace: string | undefined, name: string): KubeObject | undefined
  all(kind: string, namespace?: string): KubeObject[]
  /** Saves an object, bumping its resourceVersion. */
  put(object: KubeObject): void
  remove(object: KubeObject): void
  podUsage: PodUsage[]
}

/** How long controllers take to react, like a real cluster's short delay. */
export const RECONCILE_DELAY = 250
const JOB_RUNTIME = 2_000
const REVISION = 'deployment.kubernetes.io/revision'
const HASH_LABEL = 'pod-template-hash'
const REVISION_LABEL = 'controller-revision-hash'

const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function ownedBy(object: KubeObject, owner: KubeObject): boolean {
  return (object.metadata.ownerReferences ?? []).some((ref) => ref.uid === owner.metadata.uid)
}

function controllerOf(object: KubeObject): { kind: string; name: string } | undefined {
  return object.metadata.ownerReferences?.find((ref) => ref.controller)
}

function ownerReference(owner: KubeObject) {
  return {
    apiVersion: owner.apiVersion,
    kind: owner.kind,
    name: owner.metadata.name,
    uid: owner.metadata.uid!,
    controller: true,
    blockOwnerDeletion: true,
  }
}

/** A template without what controllers add, to compare what users changed. */
function templateKey(template: Json): string {
  const { $patch: _patch, ...rest } = template
  const { [HASH_LABEL]: _hash, ...labels } = rest.metadata?.labels ?? {}
  return JSON.stringify({ ...rest, metadata: { ...rest.metadata, labels } })
}

function isReady(pod: KubeObject): boolean {
  return (pod.status?.conditions ?? []).some((c: Json) => c.type === 'Ready' && c.status === 'True')
}

function schedulableNodes(store: Store): string[] {
  return store
    .all('Node')
    .filter(
      (node) =>
        !node.spec?.unschedulable &&
        (node.status?.conditions ?? []).some(
          (c: Json) => c.type === 'Ready' && c.status === 'True',
        ),
    )
    .map((node) => node.metadata.name)
}

export class Controllers {
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  #podIp = 100

  readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  /** Cancels pending work (the cluster is being reset). */
  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  /** Runs `task` after a controller's usual delay. */
  schedule(task: () => void, delay = RECONCILE_DELAY): void {
    this.#later(task, delay)
  }

  #later(task: () => void, delay = RECONCILE_DELAY): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      task()
    }, delay)
    this.#timers.add(timer)
  }

  /** Called after an object was created or changed through the API. */
  changed(object: KubeObject): void {
    const { kind } = object
    const { namespace, name } = object.metadata
    const latest = () => this.store.get(kind, namespace, name)
    this.#later(() => {
      const current = latest()
      if (!current) return
      if (kind === 'Deployment') this.#deployment(current)
      else if (kind === 'ReplicaSet') this.#replicaSet(current)
      else if (kind === 'StatefulSet') this.#statefulSet(current)
      else if (kind === 'DaemonSet') this.#daemonSet(current)
      else if (kind === 'Job') this.#job(current)
      else if (kind === 'PersistentVolumeClaim') this.#volumeClaim(current)
    })
  }

  /** Called after an object was deleted through the API. */
  deleted(object: KubeObject): void {
    const owner = controllerOf(object)
    if (object.kind !== 'Pod' || !owner) return
    const { namespace } = object.metadata
    this.#later(() => {
      const controller = this.store.get(owner.kind, namespace, owner.name)
      if (!controller) return
      if (owner.kind === 'ReplicaSet') this.#replicaSet(controller)
      else if (owner.kind === 'StatefulSet') this.#statefulSet(controller)
      else if (owner.kind === 'DaemonSet') this.#replace(object, controller)
      else if (owner.kind === 'Job') this.#job(controller)
    })
  }

  #deployment(deployment: KubeObject): void {
    const owned = this.store
      .all('ReplicaSet', deployment.metadata.namespace)
      .filter((rs) => ownedBy(rs, deployment))
    const revision = (rs: KubeObject) => Number(rs.metadata.annotations?.[REVISION] ?? 0)
    let current = owned.find(
      (rs) => templateKey(rs.spec.template) === templateKey(deployment.spec.template),
    )
    if (deployment.spec.paused && !current) return
    if (!current) {
      // A new template (restart, new image, rollback): roll out a new ReplicaSet.
      const hash = suffix(`${templateKey(deployment.spec.template)}`, 10)
      const next = Math.max(0, ...owned.map(revision)) + 1
      const labels = { ...deployment.spec.template.metadata?.labels, [HASH_LABEL]: hash }
      current = {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: {
          name: `${deployment.metadata.name}-${hash}`,
          namespace: deployment.metadata.namespace,
          uid: randomUUID(),
          creationTimestamp: timestamp(),
          labels,
          annotations: { [REVISION]: String(next) },
          ownerReferences: [ownerReference(deployment)],
        },
        spec: {
          replicas: 0,
          selector: { matchLabels: labels },
          template: {
            ...deployment.spec.template,
            metadata: { ...deployment.spec.template.metadata, labels },
          },
        },
        status: { replicas: 0 },
      }
    } else if (revision(current) < Math.max(...owned.map(revision))) {
      // Rolling back to an older template moves that ReplicaSet to the newest revision.
      current.metadata.annotations = {
        ...current.metadata.annotations,
        [REVISION]: String(Math.max(...owned.map(revision)) + 1),
      }
    }
    for (const rs of owned) {
      if (rs.metadata.uid !== current.metadata.uid && rs.spec.replicas !== 0) {
        this.store.put({ ...rs, spec: { ...rs.spec, replicas: 0 } })
        this.#replicaSet(this.store.get('ReplicaSet', rs.metadata.namespace, rs.metadata.name)!)
      }
    }
    this.store.put({ ...current, spec: { ...current.spec, replicas: deployment.spec.replicas } })
    const pods = this.#replicaSet(
      this.store.get('ReplicaSet', current.metadata.namespace, current.metadata.name)!,
    )
    const ready = pods.filter(isReady).length
    this.store.put({
      ...deployment,
      metadata: {
        ...deployment.metadata,
        annotations: {
          ...deployment.metadata.annotations,
          [REVISION]: current.metadata.annotations![REVISION]!,
        },
      },
      status: {
        ...deployment.status,
        observedGeneration: deployment.metadata.generation,
        replicas: pods.length,
        updatedReplicas: pods.length,
        readyReplicas: ready,
        availableReplicas: ready,
        unavailableReplicas: pods.length - ready || undefined,
      },
    })
  }

  /** Creates or deletes pods until the ReplicaSet has as many as it wants; returns them. */
  #replicaSet(rs: KubeObject): KubeObject[] {
    const pods = this.store
      .all('Pod', rs.metadata.namespace)
      .filter((pod) => ownedBy(pod, rs))
      .sort((a, b) => a.metadata.creationTimestamp!.localeCompare(b.metadata.creationTimestamp!))
    const wanted = rs.spec.replicas ?? 1
    while (pods.length > wanted) this.store.remove(pods.pop()!)
    while (pods.length < wanted) {
      pods.push(this.#newPod(rs, `${rs.metadata.name}-${suffix(randomUUID())}`, pods[0]))
    }
    const ready = pods.filter(isReady).length
    this.store.put({
      ...rs,
      status: {
        ...rs.status,
        replicas: pods.length,
        fullyLabeledReplicas: pods.length,
        readyReplicas: ready,
        availableReplicas: ready,
        observedGeneration: rs.metadata.generation,
      },
    })
    return pods
  }

  /**
   * The ControllerRevision for a StatefulSet's or DaemonSet's current template,
   * created when the template is new; rolling back to an old one makes it the
   * newest again, like the real controllers do. Returns its name.
   */
  #revision(set: KubeObject): string {
    const revisions = this.store
      .all('ControllerRevision.apps', set.metadata.namespace)
      .filter((revision) => ownedBy(revision, set))
    const newest = Math.max(0, ...revisions.map((revision) => Number(revision.revision)))
    const key = templateKey(set.spec.template)
    const match = revisions.find(
      (revision) => templateKey((revision.data as Json).spec.template) === key,
    )
    if (match) {
      if (Number(match.revision) < newest) this.store.put({ ...match, revision: newest + 1 })
      return match.metadata.name
    }
    const hash = suffix(key, 10)
    const name = `${set.metadata.name}-${hash}`
    this.store.put({
      apiVersion: 'apps/v1',
      kind: 'ControllerRevision',
      metadata: {
        name,
        namespace: set.metadata.namespace,
        uid: randomUUID(),
        creationTimestamp: timestamp(),
        labels: { ...set.spec.template.metadata?.labels, [REVISION_LABEL]: hash },
        ownerReferences: [ownerReference(set)],
      },
      data: { spec: { template: { ...set.spec.template, $patch: 'replace' } } },
      revision: newest + 1,
    })
    return name
  }

  #statefulSet(set: KubeObject): void {
    const revision = this.#revision(set)
    const pods = this.store.all('Pod', set.metadata.namespace).filter((pod) => ownedBy(pod, set))
    const wanted = set.spec.replicas
    const sibling = pods[0]
    for (const pod of pods) {
      const ordinal = Number(pod.metadata.name.slice(set.metadata.name.length + 1))
      // Pods of an older revision are replaced (restart, new image, rollback).
      if (ordinal >= wanted || pod.metadata.labels?.[REVISION_LABEL] !== revision) {
        this.store.remove(pod)
      }
    }
    for (let ordinal = 0; ordinal < wanted; ordinal++) {
      const name = `${set.metadata.name}-${ordinal}`
      if (!this.store.get('Pod', set.metadata.namespace, name)) {
        this.#newPod(set, name, sibling, undefined, {
          [REVISION_LABEL]: revision,
          'apps.kubernetes.io/pod-index': String(ordinal),
          'statefulset.kubernetes.io/pod-name': name,
        })
      }
    }
    const current = this.store.all('Pod', set.metadata.namespace).filter((p) => ownedBy(p, set))
    const ready = current.filter(isReady).length
    this.store.put({
      ...set,
      status: {
        ...set.status,
        observedGeneration: set.metadata.generation,
        replicas: current.length,
        readyReplicas: ready,
        availableReplicas: ready,
        currentReplicas: current.length,
        updatedReplicas: current.length,
        currentRevision: revision,
        updateRevision: revision,
      },
    })
  }

  #daemonSet(set: KubeObject): void {
    const hash = this.#revision(set).slice(set.metadata.name.length + 1)
    for (const pod of this.store.all('Pod', set.metadata.namespace)) {
      if (ownedBy(pod, set) && pod.metadata.labels?.[REVISION_LABEL] !== hash) {
        this.store.remove(pod)
        this.#newPod(set, `${set.metadata.name}-${suffix(randomUUID())}`, pod, pod.spec.nodeName, {
          [REVISION_LABEL]: hash,
        })
      }
    }
    this.store.put({
      ...set,
      status: { ...set.status, observedGeneration: set.metadata.generation },
    })
  }

  /** A daemon pod comes back on the same node. */
  #replace(pod: KubeObject, owner: KubeObject): void {
    this.#newPod(owner, `${owner.metadata.name}-${suffix(randomUUID())}`, pod, pod.spec.nodeName, {
      [REVISION_LABEL]: pod.metadata.labels![REVISION_LABEL]!,
    })
  }

  #job(job: KubeObject): void {
    if (job.spec.suspend || job.status?.completionTime) return
    const pods = this.store.all('Pod', job.metadata.namespace).filter((pod) => ownedBy(pod, job))
    if (pods.length > 0) return
    const pod = this.#newPod(job, `${job.metadata.name}-${suffix(randomUUID())}`, undefined)
    this.store.put({
      ...job,
      status: { ...job.status, active: 1, startTime: timestamp() },
    })
    this.#later(() => {
      const running = this.store.get('Pod', pod.metadata.namespace, pod.metadata.name)
      const current = this.store.get('Job', job.metadata.namespace, job.metadata.name)
      if (!running || !current) return
      const finished = timestamp()
      this.store.put({
        ...running,
        status: {
          ...running.status,
          phase: 'Succeeded',
          conditions: [{ type: 'Ready', status: 'False', reason: 'PodCompleted' }],
          containerStatuses: running.status.containerStatuses.map((c: Json) => ({
            ...c,
            ready: false,
            state: {
              terminated: {
                exitCode: 0,
                reason: 'Completed',
                startedAt: c.state.running.startedAt,
                finishedAt: finished,
              },
            },
          })),
        },
      })
      this.store.put({
        ...current,
        status: {
          ...current.status,
          active: undefined,
          succeeded: 1,
          completionTime: finished,
          conditions: [
            { type: 'SuccessCriteriaMet', status: 'True', lastTransitionTime: finished },
            { type: 'Complete', status: 'True', lastTransitionTime: finished },
          ],
        },
      })
    }, JOB_RUNTIME)
  }

  #volumeClaim(claim: KubeObject): void {
    const requested = claim.spec.resources?.requests?.storage
    if (!requested || claim.status?.capacity?.storage === requested) return
    this.store.put({
      ...claim,
      status: { ...claim.status, capacity: { ...claim.status?.capacity, storage: requested } },
    })
  }

  /**
   * A new pod for `owner`. It looks like `sibling` when there is one (a
   * crash-looping app keeps crashing), and otherwise starts cleanly.
   */
  #newPod(
    owner: KubeObject,
    name: string,
    sibling: KubeObject | undefined,
    node?: string,
    labels: Record<string, string> = {},
  ): KubeObject {
    const now = timestamp()
    const template = owner.spec.template ?? owner.spec.jobTemplate?.spec?.template
    const nodes = schedulableNodes(this.store)
    const nodeName =
      node ??
      (sibling && nodes.includes(sibling.spec.nodeName)
        ? sibling.spec.nodeName
        : nodes[Number.parseInt(sha(name).slice(0, 6), 16) % Math.max(1, nodes.length)])
    const containers: Json[] = template.spec.containers
    const siblingStatus = (container: string) =>
      sibling?.status?.containerStatuses?.find((c: Json) => c.name === container)
    const crashing = containers.some((c) => siblingStatus(c.name)?.state?.waiting !== undefined)
    const ip = `10.244.${(this.#podIp >> 8) % 256}.${this.#podIp++ % 256}`
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: owner.metadata.namespace,
        uid: randomUUID(),
        creationTimestamp: now,
        labels: { ...template.metadata?.labels, ...labels },
        annotations: { ...template.metadata?.annotations },
        ownerReferences: [ownerReference(owner)],
      },
      spec: { ...template.spec, nodeName },
      status: {
        phase: 'Running',
        hostIP: sibling?.status?.hostIP,
        podIP: ip,
        podIPs: [{ ip }],
        startTime: now,
        qosClass: sibling?.status?.qosClass ?? 'BestEffort',
        conditions: [
          { type: 'PodScheduled', status: 'True', lastTransitionTime: now },
          { type: 'Initialized', status: 'True', lastTransitionTime: now },
          { type: 'ContainersReady', status: crashing ? 'False' : 'True', lastTransitionTime: now },
          { type: 'Ready', status: crashing ? 'False' : 'True', lastTransitionTime: now },
        ],
        containerStatuses: containers.map((c) => {
          const waiting = siblingStatus(c.name)?.state?.waiting
          return {
            name: c.name,
            image: c.image,
            imageID: `${c.image}@sha256:${sha(c.image)}`,
            containerID: `containerd://${sha(`${name}/${c.name}`)}`,
            ready: !waiting,
            started: !waiting,
            restartCount: 0,
            state: waiting ? { waiting } : { running: { startedAt: now } },
          }
        }),
      },
    }
    this.store.put(pod)
    const usage = sibling && this.store.podUsage.find((u) => u.name === sibling.metadata.name)
    if (usage) this.store.podUsage.push({ ...usage, name })
    return this.store.get('Pod', pod.metadata.namespace, name)!
  }
}
