/**
 * A day of an audit log, for the screenshots: what a team did on the
 * production cluster, and what their AI assistant did as one of them, up to
 * the moment the screenshots are taken (EPOCH). Chained as Lumovi chains
 * them, so checking it finds it holds.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditActor, AuditEvent, AuditInput } from '../../src/shared/audit.ts'
import { AUDIT_ACTIONS } from '../../src/shared/audit.ts'
import { DEMO } from '../../tests/mock-cluster/kubeconfig.ts'
import { CLUSTERS } from './clusters.ts'

const CLUSTER = CLUSTERS.production
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const person = (user: string, groups: string[], forwardedFor: string): AuditActor => ({
  user,
  groups,
  via: 'ui',
  address: '10.42.0.17',
  forwardedFor,
  userAgent: BROWSER,
})
const JANE = person('jane@example.com', ['platform', 'on-call'], '203.0.113.24')
const ANA = person('ana@example.com', ['payments'], '198.51.100.7')
const OPS = person('ops@example.com', ['platform'], '203.0.113.41')
const ASSISTANT: AuditActor = {
  user: 'jane@example.com',
  groups: ['platform', 'on-call'],
  via: 'assistant',
  assistant: 'Claude Code',
  session: '5f0c2a9e41b37d86',
  address: '203.0.113.24',
}
const where = (cmd: string, ns = 'shop') => `${cmd} -n ${ns} --context ${CLUSTER}`
const [storefrontPod] = DEMO.pods.storefront
const [checkoutPod] = DEMO.pods.checkout

/** At what time that day (UTC), and what. */
const DAY: [string, AuditInput][] = [
  [
    '09:02:41',
    {
      action: 'assistant.allowed',
      outcome: 'success',
      actor: JANE,
      summary: 'Allowed Claude Code to use Lumovi as them',
      details: { assistant: 'Claude Code', returnsTo: 'http://127.0.0.1:33418' },
    },
  ],
  [
    '09:14:33',
    {
      action: 'shell.open',
      outcome: 'success',
      actor: ANA,
      cluster: CLUSTER,
      target: { kind: 'Pod', name: storefrontPod!, namespace: 'shop' },
      summary: `Opened a shell in Pod ${storefrontPod} (app)`,
      command: `${where(`kubectl exec -it ${storefrontPod} -c app`)} -- sh`,
      details: { container: 'app' },
    },
  ],
  [
    '09:31:25',
    {
      action: 'shell.close',
      outcome: 'success',
      actor: ANA,
      cluster: CLUSTER,
      target: { kind: 'Pod', name: storefrontPod!, namespace: 'shop' },
      summary: `Closed a shell in Pod ${storefrontPod} (app), after 16m 52s: it exited with 0`,
      command: `${where(`kubectl exec -it ${storefrontPod} -c app`)} -- sh`,
      details: { container: 'app', seconds: 1012 },
    },
  ],
  [
    '10:05:12',
    {
      action: 'helm.upgrade',
      outcome: 'success',
      actor: OPS,
      cluster: CLUSTER,
      target: { kind: 'HelmRelease', name: 'ingress-nginx', namespace: 'ingress-nginx' },
      summary: 'Upgraded ingress-nginx to ingress-nginx 4.11.2',
      command: `helm upgrade ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --version 4.11.2 -f values.yaml --namespace ingress-nginx --kube-context ${CLUSTER}`,
      details: {
        chart: 'ingress-nginx',
        version: '4.11.2',
        repository: 'https://kubernetes.github.io/ingress-nginx',
        values: ['controller'],
      },
    },
  ],
  [
    '11:42:09',
    {
      action: 'resource.scale',
      outcome: 'success',
      actor: JANE,
      cluster: CLUSTER,
      target: { kind: 'Deployment', name: 'cart', namespace: 'shop' },
      summary: 'Scaled Deployment cart to 6 replicas',
      command: where('kubectl scale deployment/cart --replicas=6'),
      details: { fields: ['spec.replicas'], patchType: 'merge', replicas: 6 },
    },
  ],
  [
    '12:10:40',
    {
      action: 'resource.restart',
      outcome: 'success',
      actor: ASSISTANT,
      cluster: CLUSTER,
      target: { kind: 'Deployment', name: 'checkout', namespace: 'shop' },
      summary: 'Restarted Deployment checkout',
      command: where('kubectl rollout restart deployment/checkout'),
      approval: { status: 'approved', by: 'jane@example.com', waitedMs: 18_000 },
      details: {
        fields: ['spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]'],
        patchType: 'strategic',
        reason:
          'Its pods crash-loop: they can’t reach the database since its credentials rotated at 11:58, and only read them as they start.',
      },
    },
  ],
  [
    '12:13:05',
    {
      action: 'resource.delete',
      outcome: 'refused',
      actor: ASSISTANT,
      cluster: CLUSTER,
      target: { kind: 'Pod', name: checkoutPod!, namespace: 'shop' },
      summary: `Delete Pod ${checkoutPod}`,
      command: where(`kubectl delete pod/${checkoutPod}`),
      approval: {
        status: 'rejected',
        by: 'jane@example.com',
        note: 'Not during the sale: the restart’s enough.',
        waitedMs: 41_000,
      },
      details: { reason: 'It’s still crash-looping after the restart.' },
    },
  ],
  [
    '12:47:51',
    {
      action: 'secret.read',
      outcome: 'success',
      actor: ANA,
      cluster: CLUSTER,
      target: { kind: 'Secret', name: DEMO.secrets.postgresCredentials, namespace: 'data' },
      summary: `Read Secret ${DEMO.secrets.postgresCredentials}`,
      details: { keys: ['username', 'password', 'database'] },
    },
  ],
  [
    '13:20:02',
    {
      action: 'resource.scale',
      outcome: 'failure',
      actor: OPS,
      cluster: CLUSTER,
      target: { kind: 'Deployment', name: 'recommendations', namespace: 'shop' },
      summary: 'Scale Deployment recommendations to 12 replicas',
      command: where('kubectl scale deployment/recommendations --replicas=12'),
      details: { fields: ['spec.replicas'], patchType: 'merge', replicas: 12 },
      error:
        'pods "recommendations-7d9f8" is forbidden: exceeded quota: compute-resources, requested: limits.cpu=6, used: limits.cpu=18, limited: limits.cpu=20',
    },
  ],
  [
    '13:55:27',
    {
      action: 'permissions.changed',
      outcome: 'success',
      actor: JANE,
      summary:
        'Changed what AI assistants may do: by default, changes ask, Secrets keys, env sensitive, logs read; 3 rules',
      details: {
        changes: 'ask',
        secrets: 'keys',
        env: 'sensitive',
        logs: 'read',
        rules: ['Production', 'Payments', 'System namespaces'],
      },
    },
  ],
  [
    '14:02:44',
    {
      action: 'read-only.changed',
      outcome: 'success',
      actor: JANE,
      cluster: CLUSTERS.staging,
      summary: `Made ${CLUSTERS.staging} read-only in Lumovi`,
      details: { readOnly: true },
    },
  ],
  [
    '14:12:19',
    {
      action: 'logs.read',
      outcome: 'success',
      actor: ASSISTANT,
      cluster: CLUSTER,
      target: { kind: 'Pod', name: checkoutPod!, namespace: 'shop' },
      summary: `Read the logs of Pod ${checkoutPod} (app)`,
      command: where(`kubectl logs ${checkoutPod} -c app --tail=200`),
      details: { tailLines: 200, previous: false },
    },
  ],
  [
    '14:16:58',
    {
      action: 'node-shell.open',
      outcome: 'success',
      actor: OPS,
      cluster: CLUSTER,
      target: { kind: 'Node', name: DEMO.nodes.worker2 },
      summary: `Opened a shell on Node ${DEMO.nodes.worker2}, as root`,
      details: { mode: 'node', pod: 'kube-system/lumovi-node-shell-x7k2p' },
    },
  ],
]

/** An event's hash, as Lumovi works it out: SHA-256 of its JSON, keys in order. */
function hashOf(event: Omit<AuditEvent, 'hash'>): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return createHash('sha256').update(canonical(event)).digest('hex')
}

/** A folder holding the day's history, for LUMOVI_AUDIT_DIR. */
export function auditHistory(day: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-screenshots-audit-'))
  let prev = ''
  const lines = DAY.map(([time, input], i) => {
    const unhashed = {
      type: 'lumovi.audit' as const,
      version: 1 as const,
      id: `screenshots-${i + 1}`,
      seq: i + 1,
      time: `${day}T${time}.000Z`,
      category: AUDIT_ACTIONS[input.action],
      ...input,
      prev,
    }
    const event = { ...unhashed, hash: hashOf(unhashed) }
    prev = event.hash
    return JSON.stringify(event)
  })
  writeFileSync(join(dir, `audit-${day}.jsonl`), `${lines.join('\n')}\n`)
  return dir
}
