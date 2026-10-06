/**
 * The tools Lumovi gives AI assistants over MCP: reading clusters, and asking
 * to change them. A change is first tried as a dry run (so the API server
 * checks it, and the person's access), then shown in Lumovi with what it
 * changes and its kubectl command, and made only once the person approves,
 * unless the cluster lets its assistants change it without asking.
 */
import { randomUUID } from 'node:crypto'
import { eventCount, lastSeen } from '@shared/events'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { parseAllDocuments } from 'yaml'
import { z } from 'zod'
import type { ChangeRequest, KubeObject, Result } from '@shared/api'
import type { AiChanges, ChangeProposal, ProposalOutcome } from '@shared/assistants'
import { kubectl, objectArg } from '@shared/kubectl'
import {
  isBuiltinKind,
  kindFor,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import type { KubeService } from '../kube/service'
import { APPROVAL_TIMEOUT_MS, approvalTime, WAIT_SLICE_MS, type Approvals } from './approvals'
import { findProblems } from './problems'
import { age, changesOf, describeStatus, involved, readable, row, statusOf, yaml } from './present'

/** What a tool's call comes with: its signal, and a way to tell its caller how it's going. */
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** What the tools work with, wherever Lumovi runs. */
export interface ToolContext {
  kube: KubeService
  /** The assistant calling, as Lumovi shows it: "Claude Code". */
  client(): string
  /** Whether its changes to a context are asked about, made, or refused. */
  changes(context: string): AiChanges
  /** Where its changes wait for the person's answer. */
  approvals: Pick<Approvals, 'ask' | 'wait'>
  /** What became of a change it asked for, for the activity log. */
  outcome(outcome: ProposalOutcome): void
  /** Where the person answers, for assistants to tell them: a server's address. */
  appUrl?: string
}

/** kubectl's short names for the built-in kinds (discovery has custom resources'). */
const SHORT_NAMES: Record<string, string[]> = {
  Pod: ['po'],
  Service: ['svc'],
  Deployment: ['deploy'],
  ReplicaSet: ['rs'],
  StatefulSet: ['sts'],
  DaemonSet: ['ds'],
  CronJob: ['cj'],
  ConfigMap: ['cm'],
  Namespace: ['ns'],
  Node: ['no'],
  PersistentVolume: ['pv'],
  PersistentVolumeClaim: ['pvc'],
  Ingress: ['ing'],
  Endpoints: ['ep'],
  ServiceAccount: ['sa'],
  HorizontalPodAutoscaler: ['hpa'],
  PodDisruptionBudget: ['pdb'],
  NetworkPolicy: ['netpol'],
  StorageClass: ['sc'],
  CustomResourceDefinition: ['crd', 'crds'],
  Event: ['ev'],
  LimitRange: ['limits'],
  ResourceQuota: ['quota'],
  PriorityClass: ['pc'],
  ReplicationController: ['rc'],
}

/** The field manager Lumovi applies manifests as. */
export const FIELD_MANAGER = 'lumovi'
const MAX_ITEMS = 500
const MAX_LOG_LINES = 2_000
const MAX_LOG_BYTES = 256 * 1024
const WAIT = approvalTime()

const cluster = z
  .string()
  .min(1)
  .describe('The cluster: a context’s name, as list_clusters gives them.')
const kind = z
  .string()
  .min(1)
  .describe(
    'A kind, as kubectl takes it: Deployment, pods, svc, or a custom resource’s (Certificate, certificates.cert-manager.io).',
  )
const reason = z
  .string()
  .min(1)
  .max(1_000)
  .describe(
    'Why: one or two sentences the person reads before approving it, about what’s wrong and how this helps.',
  )

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })
const failed = (message: string): CallToolResult => ({ ...text(message), isError: true })

/** A cluster call's data, or its error, for the assistant to read. */
function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

export function registerTools(server: McpServer, t: ToolContext): void {
  const { kube } = t

  /** Checks that `context` is one of the kubeconfig's, for a useful error when it isn't. */
  const knownCluster = (context: string) => {
    const names = kube.contexts().contexts.map((c) => c.name)
    if (!names.includes(context)) {
      throw new Error(`There is no cluster called “${context}”. These are: ${names.join(', ')}.`)
    }
  }

  /** A kind as kubectl takes it (Deployment, deploy, deployments, certificates.cert-manager.io…). */
  const resolveKind = async (context: string, given: string): Promise<ResourceDefinition> => {
    knownCluster(context)
    const wanted = given.trim().toLowerCase()
    const definitions = data(await kube.resources(context))
    const names = (d: ResourceDefinition) => [
      d.kind.toLowerCase(),
      d.apiKind.toLowerCase(),
      d.plural,
      d.group ? `${d.plural}.${d.group}` : d.plural,
      ...(d.shortNames ?? SHORT_NAMES[d.kind] ?? []),
    ]
    // Built-in kinds first: "Event" is the core one, not events.k8s.io's.
    const found = [...definitions]
      .sort((a, b) => Number(isBuiltinKind(b.kind)) - Number(isBuiltinKind(a.kind)))
      .find((d) => names(d).includes(wanted))
    if (!found) {
      throw new Error(`${context} has no kind “${given}”. list_kinds lists the ones it has.`)
    }
    return found
  }

  const namespaceFor = (definition: ResourceDefinition, namespace: string | undefined) => {
    if (definition.namespaced && !namespace) {
      throw new Error(`${definition.label} are namespaced: say which namespace.`)
    }
    return definition.namespaced ? namespace : undefined
  }

  // ——— Reading ———

  server.registerTool(
    'list_clusters',
    {
      title: 'List clusters',
      description:
        'The clusters Lumovi can show (the kubeconfig’s contexts), which is the current one, each one’s default namespace, and whether it takes changes: read-only ones take none, and each says whether assistants’ changes are asked about (ask), made without asking (allow), or refused (never).',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const { contexts, currentContext, error } = kube.contexts()
      if (error) return failed(`Lumovi can’t read the kubeconfig: ${error}`)
      return text(
        yaml({
          current: currentContext,
          clusters: contexts.map((c) => ({
            name: c.name,
            server: c.server,
            ...(c.namespace ? { namespace: c.namespace } : {}),
            changes: kube.isReadOnly(c.name) ? 'read-only' : t.changes(c.name),
          })),
        }),
      )
    },
  )

  server.registerTool(
    'list_kinds',
    {
      title: 'List kinds',
      description:
        'The kinds a cluster serves, custom resources’ too: their names as the other tools take them, API versions, and whether they’re namespaced.',
      inputSchema: { cluster },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster }) => {
      knownCluster(cluster)
      const definitions = data(await kube.resources(cluster))
      return text(
        yaml(
          definitions.map((d) => ({
            kind: d.kind,
            apiVersion: d.group ? `${d.group}/${d.version}` : d.version,
            namespaced: d.namespaced,
            ...(d.shortNames?.length ? { shortNames: d.shortNames } : {}),
          })),
        ),
      )
    },
  )

  server.registerTool(
    'list_resources',
    {
      title: 'List resources',
      description:
        'Objects of a kind, in a namespace or all of them: each one’s name, health (with Lumovi’s reason when it isn’t healthy), age, and what its kind’s table shows (a pod’s readiness, restarts and node; a workload’s ready replicas and images…).',
      inputSchema: {
        cluster,
        kind,
        namespace: z
          .string()
          .optional()
          .describe('Only this namespace’s; every namespace’s unless given.'),
        labelSelector: z.string().optional().describe('As kubectl’s -l takes it: app=web,tier!=db'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ITEMS)
          .optional()
          .describe(`At most this many (100 unless given, ${MAX_ITEMS} at most).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster, kind, namespace, labelSelector, limit = 100 }) => {
      const definition = await resolveKind(cluster, kind)
      const list = data(
        await kube.list({
          context: cluster,
          kind: definition.kind,
          namespace: definition.namespaced ? namespace : undefined,
          labelSelector,
        }),
      )
      const now = Date.now()
      return text(
        yaml({
          kind: definition.kind,
          total: list.items.length,
          ...(list.items.length > limit ? { shown: limit } : {}),
          items: list.items.slice(0, limit).map((o) => row(definition.kind, o, now)),
        }),
      )
    },
  )

  server.registerTool(
    'get_resource',
    {
      title: 'Get a resource',
      description:
        'One object as YAML, with its health first. A Secret’s values are never shown, only its keys.',
      inputSchema: {
        cluster,
        kind,
        name: z.string().min(1),
        namespace: z.string().optional().describe('Its namespace, for namespaced kinds.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster, kind, name, namespace }) => {
      const definition = await resolveKind(cluster, kind)
      const object = data(
        await kube.get({
          context: cluster,
          kind: definition.kind,
          name,
          namespace: namespaceFor(definition, namespace),
        }),
      )
      const status = statusOf(definition.kind, object)
      return text(
        `${status ? `# Health: ${describeStatus(status)}\n` : ''}${yaml(readable(object))}`,
      )
    },
  )

  server.registerTool(
    'get_events',
    {
      title: 'Get events',
      description:
        'What Kubernetes reported, the latest first: about one object, or a namespace’s, or the whole cluster’s.',
      inputSchema: {
        cluster,
        namespace: z.string().optional(),
        kind: kind.optional().describe('With name: only events about this object.'),
        name: z.string().optional(),
        warningsOnly: z.boolean().optional().describe('Only warnings.'),
        limit: z.number().int().min(1).max(MAX_ITEMS).optional().describe('50 unless given.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster, namespace, kind, name, warningsOnly, limit = 50 }) => {
      knownCluster(cluster)
      const about = kind && name ? await resolveKind(cluster, kind) : undefined
      const fields = [
        ...(about ? [`involvedObject.kind=${about.apiKind}`, `involvedObject.name=${name}`] : []),
        ...(warningsOnly ? ['type=Warning'] : []),
      ]
      const events = data(
        await kube.list({
          context: cluster,
          kind: 'Event',
          namespace,
          fieldSelector: fields.length ? fields.join(',') : undefined,
        }),
      ).items
      const seen = (e: KubeObject) => Date.parse(lastSeen(e))
      const now = Date.now()
      const latest = [...events].sort((a, b) => seen(b) - seen(a)).slice(0, limit)
      if (latest.length === 0) return text('No events.')
      return text(
        yaml(
          latest.map((e) => ({
            last: `${age(new Date(seen(e)).toISOString(), now)} ago`,
            type: e.type,
            reason: e.reason,
            object: `${involved(e).kind}/${involved(e).name}`,
            ...(involved(e).namespace ? { namespace: involved(e).namespace } : {}),
            message: e.message,
            ...(eventCount(e) > 1 ? { count: eventCount(e) } : {}),
          })),
        ),
      )
    },
  )

  server.registerTool(
    'get_logs',
    {
      title: 'Get logs',
      description:
        'A pod’s container’s latest log lines, as kubectl logs shows them; its run before the last restart with previous (what a crash-looping container said before it died).',
      inputSchema: {
        cluster,
        namespace: z.string().min(1),
        pod: z.string().min(1),
        container: z.string().optional().describe('Needed when the pod has several.'),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_LINES)
          .optional()
          .describe(`The last so many lines: 200 unless given, ${MAX_LOG_LINES} at most.`),
        previous: z.boolean().optional(),
        sinceSeconds: z.number().int().min(1).optional().describe('Only lines this recent.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster, namespace, pod, container, tailLines = 200, previous, sinceSeconds }) => {
      knownCluster(cluster)
      const logs = data(
        await kube.podLogs({
          context: cluster,
          namespace,
          pod,
          container,
          tailLines,
          previous,
          sinceSeconds,
          limitBytes: MAX_LOG_BYTES,
        }),
      )
      return text(logs || '(No log lines.)')
    },
  )

  server.registerTool(
    'find_problems',
    {
      title: 'Find problems',
      description:
        'What’s wrong in a cluster, or one namespace, in one call: nodes, pods, workloads, jobs and volume claims whose health is a warning or critical, with Lumovi’s reasons, and the last hour’s warning events, the most frequent first. The place to start when asked what’s wrong.',
      inputSchema: { cluster, namespace: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cluster, namespace }) => {
      knownCluster(cluster)
      const found = await findProblems(kube, cluster, namespace, Date.now())
      const where = namespace ? `${namespace} in ${cluster}` : cluster
      if (!found.problems.length && !found.warnings.length && !found.unchecked.length) {
        return text(
          `Nothing is wrong in ${where}: no unhealthy objects, and no warnings in the last hour.`,
        )
      }
      return text(
        yaml({
          ...(found.problems.length ? { problems: found.problems } : {}),
          ...(found.warnings.length ? { warningsInTheLastHour: found.warnings } : {}),
          ...(found.unchecked.length ? { couldNotCheck: found.unchecked } : {}),
        }),
      )
    },
  )

  // ——— Changing ———

  interface Change {
    context: string
    action: ChangeProposal['action']
    target: ChangeProposal['target']
    title: string
    done: string
    reason: string
    command: string
    manifest?: string
    /** Who owns the fields it takes over, in the API server's words. */
    takesOver?: string
    before: KubeObject | null
    /** The object as it is now (as `before` was read), for a change that's approved later. */
    reread?: () => Promise<KubeObject | null>
    request: ChangeRequest
  }

  /** What an assistant hears while the person hasn't answered yet. */
  const stillWaiting = (id: string) =>
    text(
      `Still waiting for the person’s answer in Lumovi${t.appUrl ? ` (${t.appUrl})` : ''}: nothing has changed yet. Tell them to look at Lumovi, and call wait_for_change with id “${id}” to keep waiting for it.`,
    )

  /** Waits for what becomes of change `id`, a while at most, saying so meanwhile where asked. */
  const waitFor = async (id: string, extra: Extra): Promise<CallToolResult> => {
    const token = extra._meta?.progressToken
    let ticks = 0
    const progress =
      token === undefined
        ? undefined
        : setInterval(
            () =>
              void extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken: token,
                  progress: ++ticks,
                  message: 'Waiting for the person to approve it in Lumovi',
                },
              }),
            WAIT_SLICE_MS / 5,
          )
    const result = await t.approvals.wait(id, extra.signal)
    clearInterval(progress)
    if (result === undefined) {
      return failed(
        `No change with id “${id}” is waiting: it was answered a while ago, or never asked for.`,
      )
    }
    return result === 'waiting' ? stillWaiting(id) : result
  }

  /**
   * Tries `c`, and asks the person, unless the cluster lets its assistants
   * change it (deletions and changes that take fields over from others ask
   * even then); makes it once approved.
   */
  const propose = async (c: Change, extra: Extra): Promise<CallToolResult> => {
    const policy = t.changes(c.context)
    if (policy === 'never') {
      return failed(
        `Lumovi doesn’t let AI assistants change ${c.context}: its AI assistants settings say “Never”. Nothing was changed.`,
      )
    }
    // The API server checks it, and the person's access, and says what it would come to.
    const dryRun = await kube.change({ ...c.request, dryRun: true })
    if (!dryRun.ok) return failed(`${c.title} wouldn’t work: ${dryRun.error.message}`)
    const proposal: ChangeProposal = {
      id: randomUUID(),
      client: t.client(),
      context: c.context,
      action: c.action,
      target: c.target,
      title: c.title,
      done: c.done,
      reason: c.reason,
      before: c.before && readable(c.before),
      after: c.action === 'delete' ? null : readable(dryRun.data!),
      command: c.command,
      ...(c.manifest ? { manifest: c.manifest } : {}),
      ...(c.takesOver ? { takesOver: c.takesOver } : {}),
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    }

    const shown = changesOf(c.before, dryRun.data!)
    /** Why it can't be made, the outcome told. */
    const fails = (error: string, unasked: boolean, message: string) => {
      t.outcome({ proposal, status: 'failed', error, ...(unasked ? { unasked } : {}) })
      return failed(message)
    }
    const changedSince = (why: string) =>
      `${c.title} wasn’t made: ${c.target.name} changed after it was shown (${why}). Nothing was changed: ask again, to show it as it is now.`

    /** The change, made: what the person saw, or nothing if it has changed since. */
    const make = async (unasked: boolean): Promise<CallToolResult> => {
      // Approved a while after it was shown: the same change, or none (a deletion says which
      // object it's for).
      if (c.reread && !unasked) {
        // Gone since, say: what it would change isn't what was shown.
        const now = await c.reread().catch(() => null)
        const tried = await kube.change({ ...c.request, dryRun: true })
        if (!tried.ok) {
          return fails(tried.error.message, unasked, `${c.title} failed: ${tried.error.message}`)
        }
        if (changesOf(now, tried.data!) !== shown) {
          const why = 'what it would change is different now'
          return fails(why, unasked, changedSince(why))
        }
      }
      const made = await kube.change(c.request)
      if (!made.ok) {
        return fails(
          made.error.message,
          unasked,
          made.error.code === 'conflict'
            ? changedSince(made.error.message)
            : `${c.title} failed: ${made.error.message}`,
        )
      }
      t.outcome({ proposal, status: 'applied', ...(unasked ? { unasked } : {}) })
      return text(
        `${c.done}${unasked ? '' : ', approved in Lumovi'}. The kubectl command that does the same: ${c.command}`,
      )
    }

    if (policy === 'allow' && c.action !== 'delete' && !c.takesOver) return make(true)
    extra.signal.throwIfAborted()
    t.approvals.ask(proposal, async (answer) => {
      if ('withdrawn' in answer) {
        t.outcome({ proposal, status: 'withdrawn' })
        return failed('Withdrawn: nothing was changed.')
      }
      if ('expired' in answer) {
        t.outcome({ proposal, status: 'expired' })
        return failed(
          `Nobody approved it in Lumovi within ${WAIT}: nothing was changed. Ask the person to look at Lumovi, and try again.`,
        )
      }
      if (!answer.approved) {
        t.outcome({ proposal, status: 'rejected', ...(answer.note ? { error: answer.note } : {}) })
        return failed(
          `The person rejected it in Lumovi${answer.note ? `, saying: “${answer.note}”` : ''}. Nothing was changed.`,
        )
      }
      return make(false)
    })
    return waitFor(proposal.id, extra)
  }

  /** The object as it is, or null when there's none (a manifest that creates it). */
  const current = async (context: string, k: ResourceKind, name: string, namespace?: string) => {
    const found = await kube.get({ context, kind: k, name, namespace })
    if (found.ok) return found.data
    if (found.error.code === 'not-found') return null
    throw new Error(found.error.message)
  }

  /** The waiting, said in each change tool's description. */
  const waits = `The person approves it in Lumovi (unless the cluster lets assistants change it): the call waits for their answer up to a minute, then says it’s still waiting; then call wait_for_change, until they answer or ${WAIT} have passed.`

  server.registerTool(
    'apply_manifest',
    {
      title: 'Apply a manifest',
      description: `Creates an object, or changes one, from a manifest, as kubectl apply --server-side --force-conflicts does: the fields it has are set, the others left as they are. The person sees the diff it makes, and whose fields it takes over. ${waits} One object a call; its namespace in its metadata.`,
      inputSchema: {
        cluster,
        manifest: z.string().min(1).describe('One object, as YAML or JSON.'),
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ cluster, manifest, reason }, extra) => {
      knownCluster(cluster)
      const documents = parseAllDocuments(manifest).filter((d) => d.contents !== null)
      if (documents.length !== 1) {
        return failed('Apply one object at a time: this has ' + documents.length + '.')
      }
      const [document] = documents
      if (document!.errors.length) {
        return failed(`The manifest isn’t valid YAML: ${document!.errors[0]!.message}`)
      }
      const object = document!.toJSON() as KubeObject
      if (!object?.apiVersion || !object.kind || !object.metadata?.name) {
        return failed('A manifest needs apiVersion, kind and metadata.name.')
      }
      const definition = await resolveKind(cluster, kindFor(object.apiVersion, object.kind))
      const namespace = namespaceFor(definition, object.metadata.namespace)
      const { name } = object.metadata
      const before = await current(cluster, definition.kind, name, namespace)
      const verb = before ? 'Change' : 'Create'
      const request = (force: boolean): ChangeRequest => ({
        context: cluster,
        kind: definition.kind,
        name,
        namespace,
        change: {
          action: 'apply',
          object,
          fieldManager: FIELD_MANAGER,
          force,
        },
      })
      // Without taking fields over, it fails on other managers' (Helm's, Argo CD's, an HPA's…):
      // the person is told whose, and which.
      const conflicts = await kube.change({ ...request(false), dryRun: true })
      return propose(
        {
          context: cluster,
          action: 'apply',
          target: { kind: definition.kind, name, namespace },
          title: `${verb} ${definition.apiKind} ${name}`,
          done: `${before ? 'Changed' : 'Created'} ${definition.apiKind.toLowerCase()} ${name}`,
          reason,
          command: kubectl(
            cluster,
            namespace,
            'apply',
            '--server-side',
            '--force-conflicts',
            `--field-manager=${FIELD_MANAGER}`,
            '-f',
            `${name}.yaml`,
          ),
          manifest,
          takesOver:
            !conflicts.ok && conflicts.error.code === 'conflict'
              ? conflicts.error.message
              : undefined,
          before,
          reread: () => current(cluster, definition.kind, name, namespace),
          request: request(true),
        },
        extra,
      )
    },
  )

  server.registerTool(
    'scale',
    {
      title: 'Scale',
      description: `Sets how many replicas a Deployment, StatefulSet or ReplicaSet runs (or a custom workload that can be scaled), as kubectl scale does. ${waits}`,
      inputSchema: {
        cluster,
        kind,
        namespace: z.string().min(1),
        name: z.string().min(1),
        replicas: z.number().int().min(0).max(10_000),
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ cluster, kind, namespace, name, replicas, reason }, extra) => {
      const definition = await resolveKind(cluster, kind)
      const builtin = ['Deployment', 'StatefulSet', 'ReplicaSet'].includes(definition.kind)
      if (!builtin && !definition.subresources?.includes('scale')) {
        return failed(`${definition.label} can’t be scaled.`)
      }
      const read = async () =>
        data(
          await kube.get({
            context: cluster,
            kind: definition.kind,
            name,
            namespace,
            ...(builtin ? {} : { subresource: 'scale' as const }),
          }),
        )
      const before = await read()
      const from: number | undefined = before.spec?.replicas
      if (from === replicas)
        return text(`${name} already runs ${count(replicas)}: nothing to change.`)
      return propose(
        {
          context: cluster,
          action: 'scale',
          target: { kind: definition.kind, name, namespace },
          title: `Scale ${definition.apiKind} ${name} to ${count(replicas)}`,
          done: `Scaled ${name} to ${count(replicas)}`,
          reason,
          command: kubectl(
            cluster,
            namespace,
            'scale',
            objectArg(definition.kind, name),
            `--replicas=${replicas}`,
          ),
          before,
          reread: read,
          request: {
            context: cluster,
            kind: definition.kind,
            name,
            namespace,
            change: {
              action: 'patch',
              patchType: 'merge',
              ...(builtin ? {} : { subresource: 'scale' as const }),
              patch: { spec: { replicas } },
            },
          },
        },
        extra,
      )
    },
  )

  server.registerTool(
    'restart',
    {
      title: 'Restart',
      description: `Restarts a Deployment’s, StatefulSet’s or DaemonSet’s pods, one by one as its rollout does, as kubectl rollout restart does. ${waits}`,
      inputSchema: { cluster, kind, namespace: z.string().min(1), name: z.string().min(1), reason },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ cluster, kind, namespace, name, reason }, extra) => {
      const definition = await resolveKind(cluster, kind)
      if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(definition.kind)) {
        return failed(
          `Only Deployments, StatefulSets and DaemonSets restart; ${definition.label} don’t.`,
        )
      }
      const read = async () =>
        data(await kube.get({ context: cluster, kind: definition.kind, name, namespace }))
      const before = await read()
      return propose(
        {
          context: cluster,
          action: 'restart',
          target: { kind: definition.kind, name, namespace },
          title: `Restart ${definition.apiKind} ${name}`,
          done: `Restarted ${name}`,
          reason,
          command: kubectl(
            cluster,
            namespace,
            'rollout',
            'restart',
            objectArg(definition.kind, name),
          ),
          before,
          reread: read,
          request: {
            context: cluster,
            kind: definition.kind,
            name,
            namespace,
            change: {
              action: 'patch',
              patchType: 'strategic',
              patch: {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                      },
                    },
                  },
                },
              },
            },
          },
        },
        extra,
      )
    },
  )

  server.registerTool(
    'delete_resource',
    {
      title: 'Delete a resource',
      description: `Deletes an object, as kubectl delete does (what it owns goes too). The person always approves deletions in Lumovi: the call waits for their answer up to a minute, then says it’s still waiting; then call wait_for_change, until they answer or ${WAIT} have passed.`,
      inputSchema: {
        cluster,
        kind,
        name: z.string().min(1),
        namespace: z.string().optional().describe('Its namespace, for namespaced kinds.'),
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ cluster, kind, name, namespace, reason }, extra) => {
      const definition = await resolveKind(cluster, kind)
      const where = namespaceFor(definition, namespace)
      const before = data(
        await kube.get({ context: cluster, kind: definition.kind, name, namespace: where }),
      )
      return propose(
        {
          context: cluster,
          action: 'delete',
          target: { kind: definition.kind, name, namespace: where },
          title: `Delete ${definition.apiKind} ${name}`,
          done: `Deleted ${definition.apiKind.toLowerCase()} ${name}`,
          reason,
          command: kubectl(cluster, where, 'delete', objectArg(definition.kind, name)),
          before,
          request: {
            context: cluster,
            kind: definition.kind,
            name,
            namespace: where,
            change: {
              action: 'delete',
              propagation: 'Background',
              // This one: not another made since under its name.
              uid: before.metadata.uid!,
            },
          },
        },
        extra,
      )
    },
  )

  server.registerTool(
    'wait_for_change',
    {
      title: 'Wait for a change',
      description: `Waits for the person’s answer to a change you asked for, when the call that asked said it was still waiting: up to a minute a call. Says what became of it: made, rejected (with what the person said), or still waiting (call this again). Changes wait ${WAIT} at most.`,
      inputSchema: { id: z.string().min(1).describe('The id the change’s call gave.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }, extra) => waitFor(id, extra),
  )
}

const count = (n: number) => `${n} ${n === 1 ? 'replica' : 'replicas'}`
