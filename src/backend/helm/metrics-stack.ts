/**
 * The metrics stack Lumovi installs where a cluster has no usage history: Prometheus and
 * kube-state-metrics, from a chart Lumovi ships (the packaged chart as its repository
 * publishes it, checked against its SHA-256 before every use), with values that are Lumovi's
 * to set and nobody's to change, as one Helm release in a namespace of its own.
 *
 * The namespace is Lumovi's by its label: it's made here (never taken over), and what's
 * removed is only a release in a namespace that carries it. Removing uninstalls the release
 * and deletes the namespace, so nothing stays: the chart has no CRDs and claims no volumes,
 * and its cluster roles and their bindings are the release's own.
 */
// The chart and its values are built in: how their imports read (wherever this is checked from).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./metrics-stack/assets.d.ts" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  AccessCheck,
  HelmDeployed,
  HelmRelease,
  KubeObject,
  MetricsStack,
  MetricsStackRequest,
  Result,
} from '@shared/api'
import { METRICS_STACK } from '@shared/metrics-stack'
import { KubeRequestError, readOnlyRefusal, toKubeError, type ReadOnlyCheck } from '../kube/errors'
import type { KubeService } from '../kube/service'
import { assertQuery, assertString } from '../kube/validate'
import chartUrl from './metrics-stack/prometheus-29.36.1.tgz?inline'
import values from './metrics-stack/values.yaml?raw'
import type { HelmService } from './service'

/** Whether this is a build for the tests (see backend/sponsor/source.ts). */
declare const LUMOVI_TEST_BUILD: boolean

const { namespace: NAMESPACE, release: RELEASE, chart: CHART, label: LABEL } = METRICS_STACK

/** How long a namespace is waited for, as it goes. */
const GONE_TIMEOUT_MS = 120_000
const GONE_POLL_MS = 1_000

/** The images the values pin, by digest, as the pods name them: what the cluster pulls. */
const IMAGES = [
  `quay.io/prometheus/prometheus@${/^ {4}digest: (sha256:[0-9a-f]{64})$/m.exec(values)![1]}`,
  `registry.k8s.io/kube-state-metrics/kube-state-metrics:${METRICS_STACK.kubeStateMetrics}@${/^ {4}sha: (sha256:[0-9a-f]{64})$/m.exec(values)![1]}`,
]

/** Its two Deployments. */
const DEPLOYMENTS = [`${RELEASE}-prometheus-server`, `${RELEASE}-kube-state-metrics`]

/** The release's objects outside its namespace, which deleting the namespace leaves. */
const CLUSTER_WIDE: [kind: AccessCheck['kind'], name: string][] = [
  'ClusterRoleBinding.rbac.authorization.k8s.io',
  'ClusterRole.rbac.authorization.k8s.io',
].flatMap((kind) =>
  [`${RELEASE}-server`, `${RELEASE}-kube-state-metrics`].map((name): [string, string] => [
    kind,
    name,
  ]),
)
/** How Helm's charts mark what a release made. */
const INSTANCE = 'app.kubernetes.io/instance'

/** A pod waiting for these is on its way: not a reason it isn't up. */
const STARTING = ['ContainerCreating', 'PodInitializing']

/** What installing it creates (and removing it deletes), which the cluster must allow. */
const NEEDS: { kind: AccessCheck['kind']; said: string; namespaced: boolean }[] = [
  { kind: 'Namespace', said: 'namespaces', namespaced: false },
  { kind: 'ClusterRole.rbac.authorization.k8s.io', said: 'cluster roles', namespaced: false },
  {
    kind: 'ClusterRoleBinding.rbac.authorization.k8s.io',
    said: 'cluster role bindings',
    namespaced: false,
  },
  { kind: 'Deployment', said: 'deployments', namespaced: true },
  { kind: 'Service', said: 'services', namespaced: true },
  { kind: 'ServiceAccount', said: 'service accounts', namespaced: true },
  { kind: 'ConfigMap', said: 'config maps', namespaced: true },
  // Helm keeps the release's record in one.
  { kind: 'Secret', said: 'secrets', namespaced: true },
]

export interface MetricsStackOptions {
  isReadOnly: ReadOnlyCheck
  /** Why it's off for this person, wherever: a policy, or (a server's) not being an admin. */
  off?: () => MetricsStack['off']
  /** In a test build only: a file to take for the chart, to see one that isn't it refused. */
  chartFile?: string
  /** How long a namespace is waited for, as it goes. */
  goneTimeoutMs?: number
}

export class MetricsStackService {
  readonly #chart: Buffer
  readonly #goneTimeoutMs: number

  constructor(
    private readonly kube: KubeService,
    private readonly helm: HelmService,
    private readonly options: MetricsStackOptions,
  ) {
    // (A release build knows only the chart built in: the other is left out of it.)
    this.#chart =
      LUMOVI_TEST_BUILD && options.chartFile
        ? readFileSync(options.chartFile)
        : Buffer.from(chartUrl.slice(chartUrl.indexOf(',') + 1), 'base64')
    this.#goneTimeoutMs = options.goneTimeoutMs ?? GONE_TIMEOUT_MS
  }

  status(context: unknown): Promise<Result<MetricsStack>> {
    return run(async () => {
      assertString(context, 'context')
      return this.#status(context)
    })
  }

  /** Installs it, or (a dry run) answers with what it would make: the namespace, and the chart's. */
  install(request: unknown): Promise<Result<HelmDeployed>> {
    return run(async () => {
      const { context, dryRun } = assertQuery<MetricsStackRequest>(request)
      assertString(context, 'context')
      const status = await this.#status(context)
      this.#assertOn(context, status)
      // What Lumovi's own access gives them (a server's), before anything is made.
      await this.helm.mayInstall({ context, namespace: NAMESPACE, name: RELEASE })
      if (status.state === 'installed') {
        throw new KubeRequestError('conflict', `${context} has Lumovi’s metrics stack already.`)
      }
      if (status.state === 'taken') {
        throw new KubeRequestError(
          'conflict',
          `${context} has a namespace named ${NAMESPACE} that Lumovi didn’t make, so it installs nothing there. Delete or rename it to install the metrics stack.`,
        )
      }
      if (status.missing.install.length) {
        throw new KubeRequestError(
          'forbidden',
          `The cluster doesn’t let you create ${list(status.missing.install)}, which installing takes. Nothing was installed.`,
        )
      }
      this.#assertChart()
      const deploy = { context, namespace: NAMESPACE, name: RELEASE, chart: this.#chart, values }
      if (dryRun === true) {
        const reviewed = await this.helm.shipped({ ...deploy, dryRun: true })
        return { ...reviewed, manifest: `${NAMESPACE_MANIFEST}${reviewed.manifest}` }
      }
      // The namespace may be here already, and Lumovi's (an install that was stopped).
      const made = !(await this.#namespace(context))
      if (made) {
        await unwrap(
          this.kube.change({
            context,
            kind: 'Namespace',
            change: { action: 'create', object: NAMESPACE_OBJECT },
          }),
        )
      }
      try {
        return await this.helm.shipped({ ...deploy, dryRun: false })
      } catch (error) {
        // Never half of it: what the release made goes, and the namespace made for it. What
        // couldn't be undone is said with what went wrong.
        const left = await this.#remove(context, made).catch(
          (undoing: Error) =>
            ` Undoing it failed too (${undoing.message}), so some of it may be left: look for ${NAMESPACE} among the namespaces, and ${RELEASE}-server and ${RELEASE}-kube-state-metrics among the cluster roles and their bindings.`,
        )
        const { code, message, status: http } = toKubeError(error)
        throw new KubeRequestError(code, `${message}${left ?? ' Nothing of it is left.'}`, http)
      }
    })
  }

  /**
   * Uninstalls the release and deletes its namespace, with everything in it: only where the
   * namespace is Lumovi's.
   */
  uninstall(request: unknown): Promise<Result<null>> {
    return run(async () => {
      const { context } = assertQuery<MetricsStackRequest>(request)
      assertString(context, 'context')
      const status = await this.#status(context)
      this.#assertOn(context, status)
      await this.helm.mayInstall({ context, namespace: NAMESPACE, name: RELEASE })
      const namespace = await this.#namespace(context)
      if (!namespace || !ours(namespace)) {
        throw new KubeRequestError(
          'not-found',
          `${context} has no metrics stack that Lumovi installed, so there’s none to remove.`,
        )
      }
      if (status.missing.remove.length) {
        throw new KubeRequestError(
          'forbidden',
          `The cluster doesn’t let you delete ${list(status.missing.remove)}, which removing it takes. Nothing was removed.`,
        )
      }
      await this.#remove(context, true)
      return null
    })
  }

  /**
   * Takes it out: the release (where Helm has one), then its cluster roles and bindings should
   * any be left (Helm's record gone, say), and the namespace where it's to go.
   */
  async #remove(context: string, namespace: boolean): Promise<undefined> {
    if (await this.#released(context)) {
      const uninstalled = await this.helm.uninstall({
        context,
        namespace: NAMESPACE,
        name: RELEASE,
        keepHistory: false,
      })
      if (!uninstalled.ok) throw errorOf(uninstalled)
    }
    for (const [kind, name] of CLUSTER_WIDE) {
      const found = await this.kube.get({ context, kind, name })
      // Only the release's own: one of that name that someone else made stays.
      if (!found.ok || found.data.metadata.labels?.[INSTANCE] !== RELEASE) continue
      const deleted = await this.kube.change({
        context,
        kind,
        name,
        change: { action: 'delete', uid: found.data.metadata.uid },
      })
      if (!deleted.ok && deleted.error.code !== 'not-found') throw errorOf(deleted)
    }
    if (namespace) await this.#deleteNamespace(context)
    return undefined
  }

  async #status(context: string): Promise<MetricsStack> {
    const readOnly = this.options.isReadOnly(context)
    const off: MetricsStack['off'] =
      this.options.off?.() ??
      (readOnly
        ? { reason: 'read-only', message: readOnlyRefusal(context, readOnly).message }
        : undefined)
    const namespace = await this.#namespace(context)
    const release = namespace && ours(namespace) ? await this.#release(context) : undefined
    const state = !namespace
      ? 'absent'
      : !ours(namespace)
        ? 'taken'
        : release
          ? 'installed'
          : 'absent'
    // What only matters to someone who may install it isn't asked for anyone else: neither what
    // the cluster would let them do, nor how large it is (which their access may not show them).
    const [install, remove, running, large] = await Promise.all([
      off ? [] : this.#missing(context, 'create'),
      off ? [] : this.#missing(context, 'delete'),
      state === 'installed' ? this.#running(context) : undefined,
      state === 'absent' && !off ? this.#large(context) : undefined,
    ])
    return {
      state,
      namespace: NAMESPACE,
      release: RELEASE,
      chart: CHART,
      values,
      images: IMAGES,
      ...(running ?? {}),
      ...(release?.updated ? { installedAt: release.updated } : {}),
      ...(off ? { off } : {}),
      missing: { install, remove },
      ...(large ? { large } : {}),
    }
  }

  #assertOn(context: string, status: MetricsStack): void {
    if (!status.off) return
    throw status.off.reason === 'read-only'
      ? readOnlyRefusal(context, this.options.isReadOnly(context))
      : new KubeRequestError('not-allowed', status.off.message)
  }

  /** The chart is the one its repository published, or nothing is done with it. */
  #assertChart(): void {
    const sha256 = createHash('sha256').update(this.#chart).digest('hex')
    if (sha256 !== CHART.sha256) {
      throw new KubeRequestError(
        // (Helm's: recorded as an install that failed, which one Lumovi turned down as it came isn't.)
        'helm',
        `The chart Lumovi ships isn’t ${CHART.name} ${CHART.version} as it was published (its SHA-256 is ${sha256}, not ${CHART.sha256}), so Lumovi installs nothing from it. Install Lumovi again.`,
      )
    }
  }

  async #namespace(context: string): Promise<KubeObject | undefined> {
    const found = await this.kube.get({ context, kind: 'Namespace', name: NAMESPACE })
    if (found.ok) return found.data
    if (found.error.code === 'not-found') return undefined
    throw errorOf(found)
  }

  /** The release, as Helm records it, if it's there. */
  async #release(context: string): Promise<HelmRelease | undefined> {
    const releases = await unwrap(this.helm.releases(context, NAMESPACE))
    return releases.find((release) => release.name === RELEASE)
  }

  async #released(context: string): Promise<boolean> {
    const namespace = await this.#namespace(context)
    return namespace !== undefined && ours(namespace) && Boolean(await this.#release(context))
  }

  /**
   * Whether both its Deployments are up; and if not, why, as they and their pods say: pods the
   * cluster refused (its Pod Security, a quota), none it could schedule, images it can't pull,
   * containers that stop.
   */
  async #running(context: string): Promise<{ ready: boolean; problems?: string[] }> {
    const problems: string[] = []
    let ready = true
    for (const name of DEPLOYMENTS) {
      const found = await this.kube.get({ context, kind: 'Deployment', namespace: NAMESPACE, name })
      if (found.ok && Number(found.data.status?.availableReplicas ?? 0) > 0) continue
      ready = false
      if (!found.ok) {
        problems.push(`${name}: ${found.error.message}`)
        continue
      }
      const conditions: { type: string; status: string; message?: string }[] =
        found.data.status?.conditions ?? []
      const refused = conditions.find((c) => c.type === 'ReplicaFailure' && c.status === 'True')
      if (refused?.message) problems.push(`${name}: ${refused.message}`)
    }
    if (ready) return { ready }
    const pods = await this.kube.list({ context, kind: 'Pod', namespace: NAMESPACE })
    for (const pod of pods.ok ? pods.data.items : []) {
      const status = (pod.status ?? {}) as {
        conditions?: { type: string; status: string; message?: string }[]
        containerStatuses?: {
          state?: {
            waiting?: { reason?: string; message?: string }
            terminated?: { reason?: string; exitCode?: number }
          }
        }[]
      }
      const unscheduled = status.conditions?.find(
        (c) => c.type === 'PodScheduled' && c.status === 'False',
      )
      if (unscheduled?.message) problems.push(`${pod.metadata.name}: ${unscheduled.message}`)
      for (const { state } of status.containerStatuses ?? []) {
        const waiting = state?.waiting
        if (waiting?.reason && !STARTING.includes(waiting.reason)) {
          problems.push(
            `${pod.metadata.name}: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ''}`,
          )
        }
      }
    }
    return { ready, ...(problems.length ? { problems: [...new Set(problems)] } : {}) }
  }

  /** What the cluster wouldn't let this person create (or delete), of what it's made of. */
  async #missing(context: string, verb: 'create' | 'delete'): Promise<string[]> {
    const allowed = await unwrap(
      this.kube.can(
        context,
        NEEDS.map(({ kind, namespaced }) => ({
          verb,
          kind,
          ...(namespaced ? { namespace: NAMESPACE } : {}),
        })),
      ),
    )
    return NEEDS.filter((_, i) => !allowed[i]).map((need) => need.said)
  }

  /** The cluster's size where it's past what the stack is sized for; unknown, it isn't said. */
  async #large(context: string): Promise<MetricsStack['large']> {
    try {
      const [nodes, pods] = await Promise.all(
        ['nodes', 'pods'].map(async (plural) => {
          const page = JSON.parse(
            await this.kube.fetchText(context, `/api/v1/${plural}?limit=1`),
          ) as { items: unknown[]; metadata?: { remainingItemCount?: number } }
          return page.items.length + (page.metadata?.remainingItemCount ?? 0)
        }),
      )
      const { large } = METRICS_STACK
      return nodes! > large.nodes || pods! > large.pods ? { nodes: nodes!, pods: pods! } : undefined
    } catch {
      return undefined
    }
  }

  /** Deletes the namespace, and waits until it's gone: what was in it goes with it. */
  async #deleteNamespace(context: string): Promise<void> {
    const deleted = await this.kube.change({
      context,
      kind: 'Namespace',
      name: NAMESPACE,
      change: { action: 'delete' },
    })
    if (!deleted.ok && deleted.error.code !== 'not-found') throw errorOf(deleted)
    const until = Date.now() + this.#goneTimeoutMs
    while (await this.#namespace(context)) {
      if (Date.now() > until) {
        throw new KubeRequestError(
          'timeout',
          `The release is uninstalled, and ${NAMESPACE} is being deleted, but it isn’t gone yet: something in it is slow to stop. Look at it among the namespaces.`,
        )
      }
      await new Promise((done) => setTimeout(done, GONE_POLL_MS))
    }
  }
}

const NAMESPACE_OBJECT: KubeObject = {
  apiVersion: 'v1',
  kind: 'Namespace',
  metadata: { name: NAMESPACE, labels: { [LABEL.key]: LABEL.value } },
}

/** The namespace as the review shows it, before what the chart makes. */
const NAMESPACE_MANIFEST = `---
# Lumovi makes the namespace, and marks it as its own
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
  labels:
    ${LABEL.key}: ${LABEL.value}
`

const ours = (namespace: KubeObject) => namespace.metadata.labels?.[LABEL.key] === LABEL.value

/** "namespaces, cluster roles and secrets". */
const list = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

const errorOf = (result: {
  ok: false
  error: { code: string; message: string; status?: number }
}) =>
  new KubeRequestError(
    result.error.code as KubeRequestError['code'],
    result.error.message,
    result.error.status,
  )

async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const got = await result
  if (!got.ok) throw errorOf(got)
  return got.data
}

async function run<T>(task: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await task() }
  } catch (error) {
    return { ok: false, error: toKubeError(error) }
  }
}
