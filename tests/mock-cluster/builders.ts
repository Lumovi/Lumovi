/**
 * Helpers for building realistic, deterministic Kubernetes objects.
 *
 * Names, UIDs and hashes only depend on their inputs, never on the clock, so
 * tests can reference them. Timestamps are relative to the `now` passed to
 * `clusterBuilder`, so ages always look plausible.
 */
import { createHash } from 'node:crypto'
import type {
  ClusterFixture,
  ContainerUsage,
  Json,
  KubeObject,
  NodeUsage,
  ObjectMeta,
  OwnerReference,
  PodUsage,
} from './types.ts'

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const Ki = 1024
export const Mi = 1024 * Ki
export const Gi = 1024 * Mi

const SAFE_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789'

export function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function uidFor(seed: string): string {
  const h = sha(seed)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** A Kubernetes-style random suffix (like `x2x9k`), derived from `seed`. */
export function suffix(seed: string, length = 5): string {
  const bytes = createHash('sha256').update(seed).digest()
  let out = ''
  for (let i = 0; i < length; i++) out += SAFE_ALPHABET[bytes[i]! % SAFE_ALPHABET.length]
  return out
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function random(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function replicaSetName(namespace: string, deployment: string, revision: number): string {
  return `${deployment}-${suffix(`${namespace}/${deployment}@${revision}`, 10)}`
}

export function generatedPodName(owner: string, index: number): string {
  return `${owner}-${suffix(`${owner}#${index}`)}`
}

export function ownerRef(owner: KubeObject): OwnerReference {
  return {
    apiVersion: owner.apiVersion,
    kind: owner.kind,
    name: owner.metadata.name,
    uid: owner.metadata.uid!,
    controller: true,
    blockOwnerDeletion: true,
  }
}

/** Normalises an image reference the way the container runtime reports it. */
export function fullImageName(image: string): string {
  if (!image.includes('/')) return `docker.io/library/${image}`
  const registry = image.split('/')[0]!
  return /[.:]/.test(registry) || registry === 'localhost' ? image : `docker.io/${image}`
}

export function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

export type ContainerState =
  | { running: { sinceAgo?: number } }
  | { waiting: { reason: string; message?: string } }
  | {
      terminated: {
        exitCode: number
        reason: string
        startedAgo: number
        finishedAgo: number
        message?: string
      }
    }

export interface ContainerInput {
  name: string
  image: string
  /** [request, limit] */
  cpu?: [string, string?]
  /** [request, limit] */
  memory?: [string, string?]
  ports?: { name?: string; containerPort: number; protocol?: string }[]
  command?: string[]
  args?: string[]
  env?: { name: string; value: string }[]
  probe?: { path: string; port: number }
  mounts?: { name: string; mountPath: string; readOnly?: boolean }[]
  /** Runtime state; defaults to running since the pod started. */
  state?: ContainerState
  ready?: boolean
  restarts?: number
  lastTerminated?: {
    exitCode: number
    reason: string
    startedAgo: number
    finishedAgo: number
    message?: string
  }
  /** Live usage as [cores, bytes]; only reported while the container runs. */
  usage?: [number, number]
}

export interface PodTemplate {
  labels: Record<string, string>
  annotations?: Record<string, string>
  containers: ContainerInput[]
  initContainers?: ContainerInput[]
  serviceAccount?: string
  volumes?: Json[]
  restartPolicy?: 'Always' | 'OnFailure' | 'Never'
  hostNetwork?: boolean
  priorityClassName?: string
  tolerations?: Json[]
  nodeSelector?: Record<string, string>
}

export interface PodInput extends PodTemplate {
  namespace: string
  name: string
  age: number
  node?: string
  owner?: KubeObject
  phase?: 'Running' | 'Pending' | 'Succeeded' | 'Failed'
  deletingAgo?: number
  /** Scheduler message for a pod that could not be placed. */
  unschedulable?: string
  generateName?: string
}

export interface NodeInput {
  name: string
  age: number
  ip: string
  zone: string
  instanceType: string
  role?: 'control-plane'
  cpu: number
  memoryGi: number
  ready?: 'True' | 'Unknown'
  memoryPressure?: boolean
  unschedulable?: boolean
  /** Usage as a fraction of allocatable. */
  usage?: { cpu: number; memory: number }
  /** How long ago the kubelet last reported (for NotReady nodes). */
  lastHeartbeatAgo?: number
  /** More labels, like those of the autoscaler that launched it. */
  labels?: Record<string, string>
}

/** Overrides container runtime state by container name, keeping the template's spec. */
export function withState(
  containers: ContainerInput[],
  overrides: Record<string, Partial<ContainerInput>>,
): ContainerInput[] {
  return containers.map((c) => ({ ...c, ...overrides[c.name] }))
}

function containerSpec(c: ContainerInput): Json {
  const requests: Record<string, string> = {}
  const limits: Record<string, string> = {}
  if (c.cpu?.[0]) requests.cpu = c.cpu[0]
  if (c.cpu?.[1]) limits.cpu = c.cpu[1]
  if (c.memory?.[0]) requests.memory = c.memory[0]
  if (c.memory?.[1]) limits.memory = c.memory[1]
  const probe = c.probe
    ? {
        httpGet: { path: c.probe.path, port: c.probe.port, scheme: 'HTTP' },
        initialDelaySeconds: 5,
        periodSeconds: 10,
        timeoutSeconds: 1,
        successThreshold: 1,
        failureThreshold: 3,
      }
    : undefined
  return {
    name: c.name,
    image: c.image,
    imagePullPolicy: c.image.endsWith(':latest') ? 'Always' : 'IfNotPresent',
    ...(c.command ? { command: c.command } : {}),
    ...(c.args ? { args: c.args } : {}),
    ...(c.env ? { env: c.env } : {}),
    ...(c.ports ? { ports: c.ports.map((p) => ({ protocol: 'TCP', ...p })) } : {}),
    resources: {
      ...(Object.keys(requests).length ? { requests } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
    },
    ...(probe
      ? { readinessProbe: probe, livenessProbe: { ...probe, initialDelaySeconds: 15 } }
      : {}),
    ...(c.mounts ? { volumeMounts: c.mounts } : {}),
    terminationMessagePath: '/dev/termination-log',
    terminationMessagePolicy: 'File',
  }
}

function qosClass(containers: ContainerInput[]): string {
  const all = containers.flatMap((c) => [c.cpu, c.memory])
  if (all.every((r) => !r)) return 'BestEffort'
  const guaranteed = containers.every(
    (c) => c.cpu?.[0] && c.cpu[0] === c.cpu[1] && c.memory?.[0] && c.memory[0] === c.memory[1],
  )
  return guaranteed ? 'Guaranteed' : 'Burstable'
}

function podSpec(t: PodTemplate, node?: string): Json {
  const serviceAccount = t.serviceAccount ?? 'default'
  return {
    ...(t.initContainers ? { initContainers: t.initContainers.map(containerSpec) } : {}),
    containers: t.containers.map(containerSpec),
    volumes: [
      ...(t.volumes ?? []),
      {
        name: `kube-api-access-${suffix(t.containers[0]!.name + serviceAccount)}`,
        projected: {
          defaultMode: 420,
          sources: [
            { serviceAccountToken: { expirationSeconds: 3607, path: 'token' } },
            { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
          ],
        },
      },
    ],
    restartPolicy: t.restartPolicy ?? 'Always',
    terminationGracePeriodSeconds: 30,
    dnsPolicy: t.hostNetwork ? 'ClusterFirstWithHostNet' : 'ClusterFirst',
    serviceAccountName: serviceAccount,
    serviceAccount,
    ...(node ? { nodeName: node } : {}),
    ...(t.hostNetwork ? { hostNetwork: true } : {}),
    ...(t.nodeSelector ? { nodeSelector: t.nodeSelector } : {}),
    ...(t.priorityClassName ? { priorityClassName: t.priorityClassName } : {}),
    securityContext: {},
    schedulerName: 'default-scheduler',
    tolerations: t.tolerations ?? [
      {
        key: 'node.kubernetes.io/not-ready',
        operator: 'Exists',
        effect: 'NoExecute',
        tolerationSeconds: 300,
      },
      {
        key: 'node.kubernetes.io/unreachable',
        operator: 'Exists',
        effect: 'NoExecute',
        tolerationSeconds: 300,
      },
    ],
    priority: t.priorityClassName?.startsWith('system-') ? 2000000000 : 0,
    enableServiceLinks: true,
    preemptionPolicy: 'PreemptLowerPriority',
  }
}

export function podTemplateSpec(t: PodTemplate): Json {
  return {
    metadata: { labels: t.labels, ...(t.annotations ? { annotations: t.annotations } : {}) },
    spec: podSpec(t),
  }
}

export type ClusterBuilder = ReturnType<typeof clusterBuilder>

export function clusterBuilder(now: number) {
  const objects: KubeObject[] = []
  const nodeUsage: NodeUsage[] = []
  const podUsage: PodUsage[] = []
  const nodes = new Map<string, { ip: string; index: number }>()
  let resourceVersion = 4100
  let podIpCounter = 4

  /** RFC 3339 timestamp `ago` milliseconds before now, at second precision like the API server. */
  const time = (ago: number) => new Date(now - ago).toISOString().replace(/\.\d{3}Z$/, 'Z')

  function meta(
    kind: string,
    name: string,
    namespace: string | undefined,
    age: number,
    extra: Partial<ObjectMeta> = {},
  ): ObjectMeta {
    resourceVersion += 7 + (objects.length % 11)
    return {
      name,
      ...(namespace ? { namespace } : {}),
      uid: uidFor(`${kind}/${namespace ?? ''}/${name}`),
      resourceVersion: String(resourceVersion),
      creationTimestamp: time(age),
      ...extra,
    }
  }

  function add<T extends KubeObject>(object: T): T {
    objects.push(object)
    return object
  }

  function node(n: NodeInput): KubeObject {
    const index = nodes.size
    nodes.set(n.name, { ip: n.ip, index })
    const ready = n.ready ?? 'True'
    const heartbeat = n.lastHeartbeatAgo ?? 12 * SECOND
    const allocatableMillis = n.cpu * 1000 - (n.role ? 200 : 90)
    const allocatableKi = Math.round((n.memoryGi - 0.6) * 1024 * 1024)
    const condition = (
      type: string,
      status: string,
      reason: string,
      message: string,
      since: number,
    ) => ({
      type,
      status,
      lastHeartbeatTime: time(heartbeat),
      lastTransitionTime: time(since),
      reason,
      message,
    })
    const conditions =
      ready === 'Unknown'
        ? ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].map((type) =>
            condition(
              type,
              'Unknown',
              'NodeStatusUnknown',
              'Kubelet stopped posting node status.',
              heartbeat - 40 * SECOND,
            ),
          )
        : [
            n.memoryPressure
              ? condition(
                  'MemoryPressure',
                  'True',
                  'KubeletHasInsufficientMemory',
                  'kubelet has insufficient memory available',
                  23 * MINUTE,
                )
              : condition(
                  'MemoryPressure',
                  'False',
                  'KubeletHasSufficientMemory',
                  'kubelet has sufficient memory available',
                  n.age,
                ),
            condition(
              'DiskPressure',
              'False',
              'KubeletHasNoDiskPressure',
              'kubelet has no disk pressure',
              n.age,
            ),
            condition(
              'PIDPressure',
              'False',
              'KubeletHasSufficientPID',
              'kubelet has sufficient PID available',
              n.age,
            ),
            condition(
              'Ready',
              'True',
              'KubeletReady',
              'kubelet is posting ready status',
              n.age - 40 * SECOND,
            ),
          ]
    const taints: Json[] = []
    if (n.role) taints.push({ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' })
    if (n.memoryPressure) {
      taints.push({
        key: 'node.kubernetes.io/memory-pressure',
        effect: 'NoSchedule',
        timeAdded: time(23 * MINUTE),
      })
    }
    if (ready === 'Unknown') {
      taints.push(
        {
          key: 'node.kubernetes.io/unreachable',
          effect: 'NoSchedule',
          timeAdded: time(heartbeat - 40 * SECOND),
        },
        {
          key: 'node.kubernetes.io/unreachable',
          effect: 'NoExecute',
          timeAdded: time(heartbeat - 45 * SECOND),
        },
      )
    }
    if (n.unschedulable) {
      taints.push({
        key: 'node.kubernetes.io/unschedulable',
        effect: 'NoSchedule',
        timeAdded: time(heartbeat),
      })
    }
    if (n.usage) {
      nodeUsage.push({
        name: n.name,
        cpu: (allocatableMillis / 1000) * n.usage.cpu,
        memory: allocatableKi * 1024 * n.usage.memory,
      })
    }
    return add({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: meta('Node', n.name, undefined, n.age, {
        labels: {
          'beta.kubernetes.io/arch': 'amd64',
          'beta.kubernetes.io/os': 'linux',
          'kubernetes.io/arch': 'amd64',
          'kubernetes.io/hostname': n.name,
          'kubernetes.io/os': 'linux',
          'node.kubernetes.io/instance-type': n.instanceType,
          'topology.kubernetes.io/region': 'eu-west-1',
          'topology.kubernetes.io/zone': n.zone,
          ...(n.role ? { 'node-role.kubernetes.io/control-plane': '' } : {}),
          ...n.labels,
        },
        annotations: {
          'node.alpha.kubernetes.io/ttl': '0',
          'volumes.kubernetes.io/controller-managed-attach-detach': 'true',
        },
      }),
      spec: {
        podCIDR: `10.244.${index}.0/24`,
        podCIDRs: [`10.244.${index}.0/24`],
        providerID: `kubestacks://eu-west-1/${n.name}`,
        ...(taints.length ? { taints } : {}),
        ...(n.unschedulable ? { unschedulable: true } : {}),
      },
      status: {
        capacity: {
          cpu: String(n.cpu),
          'ephemeral-storage': '102687672Ki',
          'hugepages-1Gi': '0',
          'hugepages-2Mi': '0',
          memory: `${n.memoryGi * 1024 * 1024}Ki`,
          pods: '110',
        },
        allocatable: {
          cpu: `${allocatableMillis}m`,
          'ephemeral-storage': '94635300875',
          'hugepages-1Gi': '0',
          'hugepages-2Mi': '0',
          memory: `${allocatableKi}Ki`,
          pods: '110',
        },
        conditions,
        addresses: [
          { type: 'InternalIP', address: n.ip },
          { type: 'Hostname', address: n.name },
        ],
        daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
        nodeInfo: {
          machineID: sha(`machine/${n.name}`).slice(0, 32),
          systemUUID: uidFor(`system/${n.name}`),
          bootID: uidFor(`boot/${n.name}`),
          kernelVersion: '6.8.0-85-generic',
          osImage: 'Ubuntu 24.04.3 LTS',
          containerRuntimeVersion: 'containerd://2.1.4',
          kubeletVersion: 'v1.34.1',
          kubeProxyVersion: 'v1.34.1',
          operatingSystem: 'linux',
          architecture: 'amd64',
        },
      },
    })
  }

  function namespace(name: string, age: number, terminatingAgo?: number): KubeObject {
    return add({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: meta('Namespace', name, undefined, age, {
        labels: { 'kubernetes.io/metadata.name': name },
        ...(terminatingAgo === undefined ? {} : { deletionTimestamp: time(terminatingAgo) }),
      }),
      spec: { finalizers: ['kubernetes'] },
      status:
        terminatingAgo === undefined
          ? { phase: 'Active' }
          : {
              phase: 'Terminating',
              conditions: [
                {
                  type: 'NamespaceContentRemaining',
                  status: 'True',
                  reason: 'SomeResourcesRemain',
                  message: 'Some resources are remaining: configmaps. has 1 resource instances',
                  lastTransitionTime: time(terminatingAgo - 5 * SECOND),
                },
                {
                  type: 'NamespaceFinalizersRemaining',
                  status: 'False',
                  reason: 'ContentHasNoFinalizers',
                  message: 'All content-preserving finalizers finished',
                  lastTransitionTime: time(terminatingAgo - 5 * SECOND),
                },
              ],
            },
    })
  }

  function stateJson(state: ContainerState, containerId: string): Json {
    if ('running' in state) return { running: { startedAt: time(state.running.sinceAgo ?? 0) } }
    if ('waiting' in state) return { waiting: state.waiting }
    const t = state.terminated
    return {
      terminated: {
        exitCode: t.exitCode,
        reason: t.reason,
        ...(t.message ? { message: t.message } : {}),
        startedAt: time(t.startedAgo),
        finishedAt: time(t.finishedAgo),
        containerID: containerId,
      },
    }
  }

  function containerStatus(
    c: ContainerInput,
    podName: string,
    startedAgo: number,
    init: boolean,
  ): Json {
    const state: ContainerState =
      c.state ??
      (init
        ? {
            terminated: {
              exitCode: 0,
              reason: 'Completed',
              startedAgo: startedAgo - 2 * SECOND,
              finishedAgo: startedAgo - 9 * SECOND,
            },
          }
        : { running: { sinceAgo: startedAgo - 11 * SECOND } })
    const pulled = !('waiting' in state && /Image/.test(state.waiting.reason))
    const containerId = `containerd://${sha(`${podName}/${c.name}/${c.restarts ?? 0}`)}`
    const [repository] = fullImageName(c.image).split(':')
    const running = 'running' in state
    return {
      name: c.name,
      image: fullImageName(c.image),
      imageID: pulled ? `${repository}@sha256:${sha(c.image)}` : '',
      ...(pulled && !('waiting' in state && !c.lastTerminated) ? { containerID: containerId } : {}),
      ready: c.ready ?? (init ? true : running),
      restartCount: c.restarts ?? 0,
      started: running,
      state: stateJson(state, containerId),
      lastState: c.lastTerminated
        ? {
            terminated: {
              exitCode: c.lastTerminated.exitCode,
              reason: c.lastTerminated.reason,
              ...(c.lastTerminated.message ? { message: c.lastTerminated.message } : {}),
              startedAt: time(c.lastTerminated.startedAgo),
              finishedAt: time(c.lastTerminated.finishedAgo),
              containerID: `containerd://${sha(`${podName}/${c.name}/previous`)}`,
            },
          }
        : {},
      ...(init ? {} : { volumeMounts: [] }),
    }
  }

  function pod(p: PodInput): KubeObject {
    const phase = p.phase ?? (p.node ? 'Running' : 'Pending')
    const placement = p.node ? nodes.get(p.node) : undefined
    const startedAgo = p.age - 2 * SECOND
    const statuses = p.node
      ? p.containers.map((c) => containerStatus(c, p.name, startedAgo, false))
      : []
    const allReady = statuses.length > 0 && statuses.every((s: Json) => s.ready)
    const notReady = statuses.filter((s: Json) => !s.ready).map((s: Json) => s.name)
    const podIp = p.hostNetwork
      ? placement?.ip
      : `10.244.${placement?.index ?? 0}.${podIpCounter++}`
    const readyCondition = (type: string) =>
      allReady
        ? {
            type,
            status: 'True',
            lastProbeTime: null,
            lastTransitionTime: time(startedAgo - 14 * SECOND),
          }
        : {
            type,
            status: 'False',
            lastProbeTime: null,
            lastTransitionTime: time(Math.min(startedAgo, 20 * MINUTE)),
            reason:
              phase === 'Succeeded' || phase === 'Failed' ? 'PodCompleted' : 'ContainersNotReady',
            ...(phase === 'Succeeded' || phase === 'Failed'
              ? {}
              : { message: `containers with unready status: [${notReady.join(' ')}]` }),
          }

    if (p.node && phase === 'Running') {
      const containers: ContainerUsage[] = p.containers
        .filter((c) => c.usage && (!c.state || 'running' in c.state))
        .map((c) => ({ name: c.name, cpu: c.usage![0], memory: c.usage![1] }))
      if (containers.length) podUsage.push({ namespace: p.namespace, name: p.name, containers })
    }

    return add({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: meta('Pod', p.name, p.namespace, p.age, {
        ...(p.generateName ? { generateName: p.generateName } : {}),
        labels: p.labels,
        ...(p.annotations ? { annotations: p.annotations } : {}),
        ...(p.owner ? { ownerReferences: [ownerRef(p.owner)] } : {}),
        ...(p.deletingAgo === undefined
          ? {}
          : { deletionTimestamp: time(p.deletingAgo), deletionGracePeriodSeconds: 30 }),
      }),
      spec: podSpec(p, p.node),
      status: p.node
        ? {
            phase,
            conditions: [
              {
                type: 'PodReadyToStartContainers',
                status: phase === 'Running' ? 'True' : 'False',
                lastProbeTime: null,
                lastTransitionTime: time(startedAgo - 3 * SECOND),
              },
              {
                type: 'Initialized',
                status: 'True',
                lastProbeTime: null,
                lastTransitionTime: time(startedAgo - 10 * SECOND),
              },
              readyCondition('Ready'),
              readyCondition('ContainersReady'),
              {
                type: 'PodScheduled',
                status: 'True',
                lastProbeTime: null,
                lastTransitionTime: time(p.age),
              },
            ],
            hostIP: placement?.ip,
            hostIPs: [{ ip: placement?.ip }],
            podIP: podIp,
            podIPs: [{ ip: podIp }],
            startTime: time(startedAgo),
            ...(p.initContainers
              ? {
                  initContainerStatuses: p.initContainers.map((c) =>
                    containerStatus(c, p.name, startedAgo, true),
                  ),
                }
              : {}),
            containerStatuses: statuses,
            qosClass: qosClass(p.containers),
          }
        : {
            phase: 'Pending',
            conditions: [
              {
                type: 'PodScheduled',
                status: 'False',
                lastProbeTime: null,
                lastTransitionTime: time(p.age - SECOND),
                reason: 'Unschedulable',
                message: p.unschedulable ?? '0/1 nodes are available.',
              },
            ],
            qosClass: qosClass(p.containers),
          },
    })
  }

  interface DeploymentInput {
    namespace: string
    name: string
    age: number
    replicas: number
    ready: number
    template: PodTemplate
    revision?: number
    /** Age of the previous rollout; creates an old ReplicaSet scaled to zero. */
    previousRevisionAge?: number
    /** Container images of the previous rollout, by container name, where they differed. */
    previousImages?: Record<string, string>
    progressDeadlineExceeded?: boolean
    labels?: Record<string, string>
  }

  function deployment(d: DeploymentInput) {
    const revision = d.revision ?? 1
    const rsName = replicaSetName(d.namespace, d.name, revision)
    const hash = rsName.slice(d.name.length + 1)
    const podLabels = { ...d.template.labels, 'pod-template-hash': hash }
    const unavailable = d.replicas - d.ready
    const counts = (n: number) => (n > 0 ? n : undefined)
    const obj = add({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta('Deployment', d.name, d.namespace, d.age, {
        generation: revision,
        labels: d.labels ?? d.template.labels,
        annotations: { 'deployment.kubernetes.io/revision': String(revision) },
      }),
      spec: {
        replicas: d.replicas,
        selector: { matchLabels: d.template.labels },
        template: podTemplateSpec(d.template),
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: '25%', maxSurge: '25%' },
        },
        revisionHistoryLimit: 10,
        progressDeadlineSeconds: 600,
      },
      status: {
        observedGeneration: revision,
        replicas: d.replicas,
        updatedReplicas: counts(d.replicas),
        readyReplicas: counts(d.ready),
        availableReplicas: counts(d.ready),
        unavailableReplicas: counts(unavailable),
        conditions: [
          unavailable === 0
            ? {
                type: 'Available',
                status: 'True',
                lastUpdateTime: time(d.age - MINUTE),
                lastTransitionTime: time(d.age - MINUTE),
                reason: 'MinimumReplicasAvailable',
                message: 'Deployment has minimum availability.',
              }
            : {
                type: 'Available',
                status: 'False',
                lastUpdateTime: time(18 * MINUTE),
                lastTransitionTime: time(18 * MINUTE),
                reason: 'MinimumReplicasUnavailable',
                message: 'Deployment does not have minimum availability.',
              },
          d.progressDeadlineExceeded
            ? {
                type: 'Progressing',
                status: 'False',
                lastUpdateTime: time(8 * MINUTE),
                lastTransitionTime: time(8 * MINUTE),
                reason: 'ProgressDeadlineExceeded',
                message: `ReplicaSet "${rsName}" has timed out progressing.`,
              }
            : {
                type: 'Progressing',
                status: 'True',
                lastUpdateTime: time(d.age - 2 * MINUTE),
                lastTransitionTime: time(d.age),
                reason: 'NewReplicaSetAvailable',
                message: `ReplicaSet "${rsName}" has successfully progressed.`,
              },
        ],
      },
    })

    const replicaSet = (
      name: string,
      revisionNumber: number,
      replicas: number,
      ready: number,
      age: number,
      template: PodTemplate = d.template,
    ) => {
      const rsHash = name.slice(d.name.length + 1)
      const labels = { ...template.labels, 'pod-template-hash': rsHash }
      return add({
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: meta('ReplicaSet', name, d.namespace, age, {
          generation: 1,
          labels,
          annotations: {
            'deployment.kubernetes.io/desired-replicas': String(d.replicas),
            'deployment.kubernetes.io/max-replicas': String(Math.ceil(d.replicas * 1.25)),
            'deployment.kubernetes.io/revision': String(revisionNumber),
          },
          ownerReferences: [ownerRef(obj)],
        }),
        spec: {
          replicas,
          selector: { matchLabels: labels },
          template: podTemplateSpec({ ...template, labels }),
        },
        status: {
          replicas,
          fullyLabeledReplicas: counts(replicas),
          readyReplicas: counts(ready),
          availableReplicas: counts(ready),
          observedGeneration: 1,
        },
      })
    }

    if (d.previousRevisionAge !== undefined) {
      replicaSet(
        replicaSetName(d.namespace, d.name, revision - 1),
        revision - 1,
        0,
        0,
        d.previousRevisionAge,
        {
          ...d.template,
          containers: d.template.containers.map((c) => ({
            ...c,
            image: d.previousImages?.[c.name] ?? c.image,
          })),
        },
      )
    }
    const rs = replicaSet(
      rsName,
      revision,
      d.replicas,
      d.ready,
      revision > 1 ? Math.min(d.age, 6 * DAY) : d.age,
    )
    return {
      deployment: obj,
      replicaSet: rs,
      podLabels,
      template: d.template,
      podName: (i: number) => generatedPodName(rsName, i),
      generateName: `${rsName}-`,
    }
  }

  /**
   * The ControllerRevisions a StatefulSet or DaemonSet keeps of its pod
   * templates: the current one, and an older one when `previousImages` says
   * how it differed. Returns the current revision's name.
   */
  function controllerRevisions(
    owner: KubeObject,
    template: PodTemplate,
    age: number,
    previousImages?: Record<string, string>,
  ): string {
    const { name, namespace } = owner.metadata
    const revision = (id: string, number: number, t: PodTemplate, revisionAge: number) => {
      const revisionName = `${name}-${suffix(`${namespace}/${name}/${id}`, 10)}`
      add({
        apiVersion: 'apps/v1',
        kind: 'ControllerRevision',
        metadata: meta('ControllerRevision', revisionName, namespace, revisionAge, {
          labels: { ...t.labels, 'controller-revision-hash': revisionName.slice(name.length + 1) },
          ownerReferences: [ownerRef(owner)],
        }),
        data: { spec: { template: { ...podTemplateSpec(t), $patch: 'replace' } } },
        revision: number,
      })
      return revisionName
    }
    if (!previousImages) return revision('rev', 1, template, age)
    revision(
      'rev-previous',
      1,
      {
        ...template,
        containers: template.containers.map((c) => ({
          ...c,
          image: previousImages[c.name] ?? c.image,
        })),
      },
      age,
    )
    return revision('rev', 2, template, Math.min(age, 9 * DAY))
  }

  interface StatefulSetInput {
    namespace: string
    name: string
    age: number
    replicas: number
    ready: number
    serviceName: string
    template: PodTemplate
    storage?: { size: string; storageClass: string }
    /** Images of an earlier rollout, by container name, where they differed. */
    previousImages?: Record<string, string>
  }

  function statefulSet(s: StatefulSetInput) {
    const revision = `${s.name}-${suffix(`${s.namespace}/${s.name}/rev`, 10)}`
    const obj: KubeObject = add({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: meta('StatefulSet', s.name, s.namespace, s.age, {
        generation: 1,
        labels: s.template.labels,
      }),
      spec: {
        replicas: s.replicas,
        selector: { matchLabels: s.template.labels },
        serviceName: s.serviceName,
        template: podTemplateSpec(s.template),
        podManagementPolicy: 'OrderedReady',
        updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
        revisionHistoryLimit: 10,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
        ...(s.storage
          ? {
              volumeClaimTemplates: [
                {
                  apiVersion: 'v1',
                  kind: 'PersistentVolumeClaim',
                  metadata: { name: 'data' },
                  spec: {
                    accessModes: ['ReadWriteOnce'],
                    storageClassName: s.storage.storageClass,
                    resources: { requests: { storage: s.storage.size } },
                    volumeMode: 'Filesystem',
                  },
                },
              ],
            }
          : {}),
      },
      status: {
        observedGeneration: 1,
        replicas: s.replicas,
        readyReplicas: s.ready > 0 ? s.ready : undefined,
        currentReplicas: s.replicas,
        updatedReplicas: s.replicas,
        availableReplicas: s.ready,
        currentRevision: revision,
        updateRevision: revision,
        collisionCount: 0,
      },
    })
    controllerRevisions(obj, s.template, s.age, s.previousImages)
    return {
      statefulSet: obj,
      template: s.template,
      podName: (i: number) => `${s.name}-${i}`,
      podLabels: (i: number) => ({
        ...s.template.labels,
        'apps.kubernetes.io/pod-index': String(i),
        'controller-revision-hash': revision,
        'statefulset.kubernetes.io/pod-name': `${s.name}-${i}`,
      }),
    }
  }

  interface DaemonSetInput {
    namespace: string
    name: string
    age: number
    desired: number
    ready: number
    template: PodTemplate
    /** Images of an earlier rollout, by container name, where they differed. */
    previousImages?: Record<string, string>
  }

  function daemonSet(d: DaemonSetInput) {
    const revision = suffix(`${d.namespace}/${d.name}/rev`, 10)
    const obj: KubeObject = add({
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: meta('DaemonSet', d.name, d.namespace, d.age, {
        generation: 1,
        labels: d.template.labels,
        annotations: { 'deprecated.daemonset.template.generation': '1' },
      }),
      spec: {
        selector: { matchLabels: d.template.labels },
        template: podTemplateSpec(d.template),
        updateStrategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        revisionHistoryLimit: 10,
      },
      status: {
        currentNumberScheduled: d.desired,
        desiredNumberScheduled: d.desired,
        numberAvailable: d.ready,
        numberMisscheduled: 0,
        numberReady: d.ready,
        ...(d.desired > d.ready ? { numberUnavailable: d.desired - d.ready } : {}),
        observedGeneration: 1,
        updatedNumberScheduled: d.desired,
      },
    })
    controllerRevisions(obj, d.template, d.age, d.previousImages)
    return {
      daemonSet: obj,
      template: d.template,
      podName: (i: number) => generatedPodName(d.name, i),
      generateName: `${d.name}-`,
      podLabels: {
        ...d.template.labels,
        'controller-revision-hash': revision,
        'pod-template-generation': '1',
      },
    }
  }

  interface JobInput {
    namespace: string
    name: string
    age: number
    template: PodTemplate
    owner?: KubeObject
    outcome: 'complete' | 'failed' | 'running'
    durationMs?: number
    failed?: number
    backoffLimit?: number
  }

  function job(j: JobInput) {
    const uid = uidFor(`Job/${j.namespace}/${j.name}`)
    const jobLabels = {
      'batch.kubernetes.io/controller-uid': uid,
      'batch.kubernetes.io/job-name': j.name,
      'controller-uid': uid,
      'job-name': j.name,
    }
    const startedAgo = j.age - SECOND
    const finishedAgo = startedAgo - (j.durationMs ?? 47 * SECOND)
    const condition = (type: string, reason?: string, message?: string) => ({
      type,
      status: 'True',
      lastProbeTime: time(finishedAgo),
      lastTransitionTime: time(finishedAgo),
      ...(reason ? { reason, message } : {}),
    })
    const status =
      j.outcome === 'complete'
        ? {
            conditions: [
              condition(
                'SuccessCriteriaMet',
                'CompletionsReached',
                'Reached expected number of succeeded pods',
              ),
              condition(
                'Complete',
                'CompletionsReached',
                'Reached expected number of succeeded pods',
              ),
            ],
            startTime: time(startedAgo),
            completionTime: time(finishedAgo),
            succeeded: 1,
            ready: 0,
            terminating: 0,
            uncountedTerminatedPods: {},
          }
        : j.outcome === 'failed'
          ? {
              conditions: [
                condition(
                  'FailureTarget',
                  'BackoffLimitExceeded',
                  'Job has reached the specified backoff limit',
                ),
                condition(
                  'Failed',
                  'BackoffLimitExceeded',
                  'Job has reached the specified backoff limit',
                ),
              ],
              startTime: time(startedAgo),
              failed: j.failed ?? 1,
              ready: 0,
              terminating: 0,
              uncountedTerminatedPods: {},
            }
          : {
              startTime: time(startedAgo),
              active: 1,
              ready: 1,
              terminating: 0,
              uncountedTerminatedPods: {},
            }
    const obj = add({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: meta('Job', j.name, j.namespace, j.age, {
        generation: 1,
        labels: { ...jobLabels, ...j.template.labels },
        ...(j.owner ? { ownerReferences: [ownerRef(j.owner)] } : {}),
      }),
      spec: {
        parallelism: 1,
        completions: 1,
        backoffLimit: j.backoffLimit ?? 6,
        completionMode: 'NonIndexed',
        suspend: false,
        manualSelector: false,
        podReplacementPolicy: 'TerminatingOrFailed',
        selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } },
        template: podTemplateSpec({
          ...j.template,
          labels: { ...jobLabels, ...j.template.labels },
        }),
      },
      status,
    })
    return {
      job: obj,
      template: j.template,
      podLabels: { ...jobLabels, ...j.template.labels },
      podName: (i: number) => generatedPodName(j.name, i),
      generateName: `${j.name}-`,
      startedAgo,
      finishedAgo,
    }
  }

  function cronJob(c: {
    namespace: string
    name: string
    age: number
    schedule: string
    suspend?: boolean
    template: PodTemplate
    lastScheduleAgo?: number
    lastSuccessAgo?: number
  }): KubeObject {
    return add({
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: meta('CronJob', c.name, c.namespace, c.age, {
        generation: 1,
        labels: c.template.labels,
      }),
      spec: {
        schedule: c.schedule,
        timeZone: 'Etc/UTC',
        concurrencyPolicy: 'Forbid',
        suspend: c.suspend ?? false,
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        jobTemplate: {
          metadata: { labels: c.template.labels },
          spec: { backoffLimit: 2, template: podTemplateSpec(c.template) },
        },
      },
      status: {
        ...(c.lastScheduleAgo === undefined ? {} : { lastScheduleTime: time(c.lastScheduleAgo) }),
        ...(c.lastSuccessAgo === undefined ? {} : { lastSuccessfulTime: time(c.lastSuccessAgo) }),
      },
    })
  }

  function service(s: {
    namespace: string
    name: string
    age: number
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer'
    clusterIP: string
    ports: {
      name?: string
      port: number
      targetPort?: number | string
      protocol?: string
      nodePort?: number
    }[]
    selector?: Record<string, string>
    labels?: Record<string, string>
    loadBalancerIP?: string
  }): KubeObject {
    const type = s.type ?? 'ClusterIP'
    const external = type !== 'ClusterIP'
    return add({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('Service', s.name, s.namespace, s.age, {
        ...(s.labels ? { labels: s.labels } : {}),
      }),
      spec: {
        type,
        clusterIP: s.clusterIP,
        clusterIPs: [s.clusterIP],
        ports: s.ports.map((p, i) => ({
          protocol: p.protocol ?? 'TCP',
          ...p,
          targetPort: p.targetPort ?? p.port,
          ...(external && p.nodePort === undefined
            ? { nodePort: 30000 + ((i * 7919 + s.name.length * 131) % 2700) }
            : {}),
        })),
        ...(s.selector ? { selector: s.selector } : {}),
        sessionAffinity: 'None',
        ipFamilies: ['IPv4'],
        ipFamilyPolicy: 'SingleStack',
        internalTrafficPolicy: 'Cluster',
        ...(external ? { externalTrafficPolicy: 'Cluster' } : {}),
        ...(type === 'LoadBalancer' ? { allocateLoadBalancerNodePorts: true } : {}),
      },
      status: {
        loadBalancer: s.loadBalancerIP
          ? { ingress: [{ ip: s.loadBalancerIP, ipMode: 'VIP' }] }
          : {},
      },
    })
  }

  function event(
    target: KubeObject,
    e: {
      type: 'Normal' | 'Warning'
      reason: string
      message: string
      firstAgo: number
      lastAgo?: number
      count?: number
      component: string
      host?: string
      fieldPath?: string
    },
  ): KubeObject {
    const namespace = target.metadata.namespace ?? 'default'
    const name = `${target.metadata.name}.${sha(`${target.metadata.uid}/${e.reason}/${e.message}`).slice(0, 16)}`
    return add({
      apiVersion: 'v1',
      kind: 'Event',
      metadata: meta('Event', name, namespace, e.firstAgo),
      involvedObject: {
        kind: target.kind,
        namespace: target.metadata.namespace,
        name: target.metadata.name,
        uid: target.metadata.uid,
        apiVersion: target.apiVersion,
        resourceVersion: target.metadata.resourceVersion,
        ...(e.fieldPath ? { fieldPath: e.fieldPath } : {}),
      },
      reason: e.reason,
      message: e.message,
      source: { component: e.component, ...(e.host ? { host: e.host } : {}) },
      firstTimestamp: time(e.firstAgo),
      lastTimestamp: time(e.lastAgo ?? e.firstAgo),
      count: e.count ?? 1,
      type: e.type,
      eventTime: null,
      reportingComponent: e.component,
      reportingInstance: e.host ?? '',
    })
  }

  function simple(
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string | undefined,
    age: number,
    body: Json,
    extra: Partial<ObjectMeta> = {},
  ): KubeObject {
    return add({ apiVersion, kind, metadata: meta(kind, name, namespace, age, extra), ...body })
  }

  function build(logs?: ClusterFixture['logs']): ClusterFixture {
    return { objects, metrics: { nodes: nodeUsage, pods: podUsage }, ...(logs ? { logs } : {}) }
  }

  return {
    now,
    time,
    meta,
    add,
    node,
    namespace,
    pod,
    deployment,
    statefulSet,
    daemonSet,
    job,
    cronJob,
    service,
    event,
    simple,
    build,
    objects,
  }
}
