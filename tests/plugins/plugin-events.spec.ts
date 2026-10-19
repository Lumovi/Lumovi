/**
 * An object's warning events a plugin's code reads, as the backend makes the read (`events: true`
 * on its file's read of the kind): the plugin found among those in use, its file's word asked of
 * the kind as written and as the cluster serves it, the object read as the person, then its
 * warning events by its uid, newest first, each handed as a few fields; a refusal as a code.
 * Against a stand-in for the cluster: nothing is built or launched.
 */
import { expect, test } from '../temp-folders.ts'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import { pluginEvents } from '../../src/backend/plugin-events.ts'
import type { GetQuery, KubeObject, ListQuery, Result } from '../../src/shared/api.ts'
import type { CodeSwitches } from '../../src/shared/plugin-hand-over.ts'
import {
  EVENT_MESSAGE_CUTS,
  eventMessage,
  eventsQuery,
  handedEvent,
  READ_LIMITS,
  READ_REFUSED,
  type Grant,
  type Granted,
} from '../../src/shared/plugin-reads.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'
import type { ResourceDefinition } from '../../src/shared/resources.ts'

const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const read = (events: boolean): Granted => ({
  fields: [{ path: 'metadata.name', steps: [{ key: 'metadata' }, { key: 'name' }] }],
  status: false,
  events,
  usage: false,
})
const GRANT: Grant = {
  groups: ['example.com'],
  own: ['example.com/Widget'],
  reads: { '/Pod': read(true), 'apps/ReplicaSet': read(false) },
}
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'toys',
  version: '1.2.0',
  origin: 'lumovi',
  file: 'toys.yaml',
  digest: FILE,
  code: 'box.then(() => {})',
  codeDigest: CODE,
  grant: GRANT,
  label: 'Toys',
  ...also,
})
const WHO = { plugin: 'toys', pluginVersion: '1.2.0', pluginDigest: FILE, codeDigest: CODE }

const ASK = {
  context: 'demo',
  plugin: 'toys',
  digest: FILE,
  codeDigest: CODE,
  kind: '/Pod',
  namespace: 'shop',
  name: 'cart-7d9f',
}

const definition = (kind: string, group: string, namespaced = true): ResourceDefinition => ({
  kind: group && group !== 'apps' ? `${kind}.${group}` : kind,
  apiKind: kind,
  plural: `${kind.toLowerCase()}s`,
  group,
  version: 'v1',
  namespaced,
  label: `${kind}s`,
  category: 'workloads',
})
const SERVED: Record<string, ResourceDefinition> = {
  Pod: definition('Pod', ''),
  ReplicaSet: definition('ReplicaSet', 'apps'),
  'Widget.example.com': definition('Widget', 'example.com'),
}

/** An event as the cluster keeps it: about which object, of what type, said when. */
const event = (uid: string, last: string, also: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { name: `cart-7d9f.${last}`, namespace: 'shop', creationTimestamp: last },
  involvedObject: {
    kind: 'Pod',
    name: 'cart-7d9f',
    namespace: 'shop',
    uid,
    fieldPath: 'spec.containers{app}',
  },
  type: 'Warning',
  reason: 'Unhealthy',
  message: 'Back-off restarting failed container app in pod cart-7d9f_shop(u-1)',
  count: 3,
  firstTimestamp: '2026-10-14T06:00:00Z',
  lastTimestamp: last,
  source: { component: 'kubelet', host: 'node-a' },
  reportingComponent: 'kubelet',
  reportingInstance: 'node-a',
  ...also,
})

/** A stand-in cluster: the object's uid, its events, and what it was asked. */
function stage(
  known: KnownPlugin[] = [plugin()],
  {
    uid = 'u-1',
    events = [event('u-1', '2026-10-14T06:10:00Z')],
    get = undefined as Result<KubeObject> | undefined,
    switches = { chosen: {} } as CodeSwitches,
  } = {},
) {
  const asked = { resource: [] as string[], get: [] as GetQuery[], list: [] as ListQuery[] }
  const audit: { key: string; input: Recorded }[] = []
  const reading = pluginEvents({
    kube: {
      resource: async (_context, kind) => {
        asked.resource.push(kind)
        const served = SERVED[kind]
        if (!served) throw Object.assign(new Error('no such kind'), { code: 'not-found' })
        return served
      },
      get: async (q) => {
        asked.get.push(q as GetQuery)
        return (
          get ?? {
            ok: true,
            data: {
              apiVersion: 'v1',
              kind: 'Pod',
              metadata: { name: (q as GetQuery).name, namespace: 'shop', uid },
            },
          }
        )
      },
      list: async (q) => {
        asked.list.push(q as ListQuery)
        return { ok: true, data: { items: events, truncated: false } }
      },
    },
    known: async () => known,
    to: () => ({ host: 'desktop', switches }),
    // (What it's asked to write, each with what makes it the same entry, and a place for every
    // ask: what a plugin's pages are held to has tests of its own, in plugin-history.)
    audit: {
      take: () => ({ record: (key, input) => void audit.push({ key, input }) }),
      unknown: (key, input) => void audit.push({ key, input }),
      stop: () => undefined,
    },
  })
  return { read: reading, asked, audit }
}

test('a plugin whose file says its code reads a kind’s events is handed an object’s warnings, by its uid, newest first, a few fields of each', async () => {
  const { read, asked, audit } = stage(undefined, {
    events: [
      event('u-1', '2026-10-14T06:05:00Z', {
        reason: 'BackOff',
        message: 'Back-off restarting failed container app',
        count: 7,
      }),
      event('u-1', '2026-10-14T06:10:00Z'),
      // (Not its own, or not a warning, though the cluster sent them: left out all the same.)
      event('u-0', '2026-10-14T06:20:00Z', { reason: 'OldPod' }),
      event('u-1', '2026-10-14T06:30:00Z', { type: 'Normal', reason: 'Pulled' }),
    ],
  })
  expect(await read(ASK)).toEqual({
    ok: true,
    events: [
      {
        reason: 'Unhealthy',
        message: 'Back-off restarting failed container app in pod cart-7d9f_shop(u-1)',
        count: 3,
        first: '2026-10-14T06:00:00Z',
        last: '2026-10-14T06:10:00Z',
      },
      {
        reason: 'BackOff',
        message: 'Back-off restarting failed container app',
        count: 7,
        first: '2026-10-14T06:00:00Z',
        last: '2026-10-14T06:05:00Z',
      },
    ],
  })
  // The object read as the person, then its warnings picked by the cluster, by its uid too.
  expect(asked.get).toEqual([
    { context: 'demo', kind: 'Pod', namespace: 'shop', name: 'cart-7d9f' },
  ])
  expect(asked.list).toEqual([
    {
      context: 'demo',
      kind: 'Event',
      namespace: 'shop',
      fieldSelector:
        'involvedObject.kind=Pod,involvedObject.name=cart-7d9f,involvedObject.namespace=shop,involvedObject.uid=u-1,type=Warning',
    },
  ])
  expect(audit).toEqual([
    {
      key: `plugin-events:${JSON.stringify(['demo', WHO, 'Pod', 'shop', 'cart-7d9f'])}`,
      input: {
        action: 'plugin.read',
        outcome: 'success',
        cluster: 'demo',
        target: { kind: 'Pod', name: 'cart-7d9f', namespace: 'shop' },
        summary: 'Read the warning events of Pod cart-7d9f, for the plugin Toys’ code',
        command:
          'kubectl get events --field-selector=involvedObject.kind=Pod,involvedObject.name=cart-7d9f,type=Warning -n shop --context demo',
        details: { ...WHO, events: true },
      },
    },
  ])
})

test('an object made again under the same name is handed only its own warnings: they’re picked by the uid it has now', async () => {
  const { read, asked } = stage(undefined, {
    uid: 'u-2',
    events: [
      event('u-1', '2026-10-14T06:10:00Z'),
      event('u-2', '2026-10-14T06:12:00Z', { reason: 'Failed' }),
    ],
  })
  expect(await read(ASK)).toMatchObject({ ok: true, events: [{ reason: 'Failed' }] })
  expect(asked.list[0]?.fieldSelector).toContain('involvedObject.uid=u-2')
})

test('of an object’s warnings, the newest fifty, and of each message as much as a line of the kit’s, cut with “…”', async () => {
  const many = Array.from({ length: READ_LIMITS.events + 10 }, (_, n) =>
    event('u-1', new Date(Date.UTC(2026, 9, 14, 6, n)).toISOString(), { reason: `R${n}` }),
  )
  const { read } = stage(undefined, { events: many })
  const answer = await read(ASK)
  if (!answer.ok) throw new Error('not read')
  expect(answer.events).toHaveLength(READ_LIMITS.events)
  expect(answer.events[0]?.reason).toBe(`R${READ_LIMITS.events + 9}`)
  expect(answer.events.at(-1)?.reason).toBe('R10')

  const long = 'x'.repeat(READ_LIMITS.eventMessage - 2) + '🙂🙂🙂'
  const cut = handedEvent(event('u-1', '2026-10-14T06:10:00Z', { message: long }))
  expect(Array.from(cut.message)).toHaveLength(READ_LIMITS.eventMessage)
  expect(cut.message).toBe(`${'x'.repeat(READ_LIMITS.eventMessage - 2)}🙂…`)
  // (What isn't text, or a count that's no count, isn't handed as the cluster had it.)
  expect(
    handedEvent(event('u-1', '2026-10-14T06:10:00Z', { reason: 7, message: { a: 1 }, count: -2 })),
  ).toMatchObject({ reason: '', message: '', count: 1 })
})

test('a message is handed up to where it would quote what only a person may read, and said to be cut there; one in a controller’s own words, whole', () => {
  const SECRET = 'hunter2: "a": b, c'
  const left = '(the rest left out by Lumovi)'
  for (const [message, handed] of [
    // The API server's field errors that quote a value: a refused Pod's env, in its
    // ReplicaSet's FailedCreate.
    [
      `Error creating: Pod "cart-7d9f" is invalid: spec.containers[0].env[0].value: Invalid value: "${SECRET}": must be no more than 63 characters`,
      `Error creating: Pod "cart-7d9f" is invalid: spec.containers[0].env[0].value: Invalid value: ${left}`,
    ],
    [
      `spec.containers[0].imagePullPolicy: Unsupported value: "${SECRET}": supported values: "Always"`,
      `spec.containers[0].imagePullPolicy: Unsupported value: ${left}`,
    ],
    [
      `spec.containers[0].env[1].name: Duplicate value: "${SECRET}"`,
      `spec.containers[0].env[1].name: Duplicate value: ${left}`,
    ],
    [
      `spec.volumes[0].secret.secretName: Not found: "${SECRET}"`,
      `spec.volumes[0].secret.secretName: Not found: ${left}`,
    ],
    // A pod's update refused, set out whole.
    [
      `Pod "cart-7d9f" is invalid: spec: Forbidden: pod updates may not change fields other than ... {"env":[{"name":"TOKEN","value":"${SECRET}"}]}`,
      `Pod "cart-7d9f" is invalid: spec: Forbidden: ${left}`,
    ],
    // A probe's output, failed or unable to run: the container's own.
    [`Liveness probe failed: ${SECRET}`, `Liveness probe failed: ${left}`],
    [`Readiness probe failed: cat: ${SECRET}`, `Readiness probe failed: ${left}`],
    [`Startup probe failed: ${SECRET}`, `Startup probe failed: ${left}`],
    [`Liveness probe errored: rpc error: ${SECRET}`, `Liveness probe errored: ${left}`],
    [`Readiness probe errored: ${SECRET}`, `Readiness probe errored: ${left}`],
    [`Startup probe errored: ${SECRET}`, `Startup probe errored: ${left}`],
    // A lifecycle hook's: its command line, from the pod's spec, and its output after.
    [
      `Exec lifecycle hook ([/bin/sh -c echo ${SECRET}]) for Container "app" in Pod "cart-7d9f_shop(u-1)" failed - error: command exited with 1: , message: "${SECRET}"`,
      `Exec lifecycle hook ${left}`,
    ],
    [
      `HTTP lifecycle hook (/hooks/stop?token=${SECRET}) for Container "app" in Pod "cart-7d9f_shop(u-1)" failed - error: Get "http://10.0.0.7:8080/hooks/stop?token=${SECRET}": dial tcp: connection refused, message: ""`,
      `HTTP lifecycle hook ${left}`,
    ],
    // An admission webhook's refusal, which may quote the object back.
    [
      `Error creating: admission webhook "policy.example.com" denied the request: ${SECRET}`,
      `Error creating: admission webhook "policy.example.com" denied the request: ${left}`,
    ],
    // Cut at the first mark, wherever the rest are.
    [`Readiness probe failed: Invalid value: ${SECRET}`, `Readiness probe failed: ${left}`],
  ]) {
    expect(eventMessage(message!)).toBe(handed)
    expect(handedEvent(event('u-1', '2026-10-14T06:10:00Z', { message })).message).toBe(handed)
    expect(handed).not.toContain('hunter2')
  }
  // Every mark the list names is one a message is cut at.
  for (const mark of EVENT_MESSAGE_CUTS) {
    // (Inside a bracket the mark opens: said once, not in a second.)
    expect(eventMessage(`before ${mark}${SECRET}`)).toBe(
      mark.endsWith('(') ? `before ${mark}${left.slice(1)}` : `before ${mark.trimEnd()} ${left}`,
    )
  }
  // A controller's own words, with none of the marks: as written.
  for (const words of [
    'Back-off restarting failed container app in pod cart-7d9f_shop(u-1)',
    '0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available.',
    'Failed to pull image "ghcr.io/acme/cart:v2": not found',
    'Liveness probe failed',
  ]) {
    expect(eventMessage(words)).toBe(words)
  }
  // And the 500-character cut after.
  const long = `${'x'.repeat(READ_LIMITS.eventMessage)} Invalid value: ${SECRET}`
  const handed = handedEvent(event('u-1', '2026-10-14T06:10:00Z', { message: long })).message
  expect(Array.from(handed)).toHaveLength(READ_LIMITS.eventMessage)
  expect(handed).not.toContain('hunter2')
})

test('a kind whose read doesn’t say events, or a kind its file doesn’t name, is refused before the object is read; one its file doesn’t name before the cluster is asked anything', async () => {
  const { read, asked, audit } = stage()
  const refused = { ok: false, refused: 'not-granted' }
  expect(await read({ ...ASK, kind: 'apps/ReplicaSet', name: 'cart-7d9f' })).toEqual(refused)
  expect(asked.resource).toEqual(['ReplicaSet'])
  expect(await read({ ...ASK, kind: 'apps/Deployment', name: 'cart' })).toEqual(refused)
  expect(asked.resource).toEqual(['ReplicaSet'])
  expect(asked.get).toEqual([])
  expect(asked.list).toEqual([])
  // In the history: no object the page named, and nothing of a kind its file doesn't name.
  expect(JSON.stringify(audit)).not.toMatch(/cart|Deployment|ReplicaSet/)
  expect(audit.map(({ input }) => input.summary)).toEqual([
    'Asked to read an object’s warning events, for the plugin Toys’ code',
    'Asked to read an object’s warning events, for the plugin Toys’ code',
  ])
})

test('an object of its own kind: its events too, as everything of it is its plugin’s', async () => {
  const { read, asked } = stage(undefined, {
    events: [event('u-1', '2026-10-14T06:10:00Z', { reason: 'SyncFailed' })],
  })
  expect(await read({ ...ASK, kind: 'example.com/Widget', name: 'blue' })).toMatchObject({
    ok: true,
    events: [{ reason: 'SyncFailed' }],
  })
  expect(asked.list[0]?.fieldSelector).toContain(
    'involvedObject.kind=Widget,involvedObject.name=blue',
  )
})

test('refused as any read is: a plugin not in use, its file or code changed, its code off, an object gone; each a code, never what the cluster said', async () => {
  for (const [known, ask, refused] of [
    [[], ASK, 'not-in-use'],
    [[plugin({ codeDigest: undefined })], ASK, 'not-in-use'],
    [[plugin()], { ...ASK, digest: `sha256:${'b'.repeat(64)}` }, 'changed'],
    [[plugin()], { ...ASK, codeDigest: `sha256:${'d'.repeat(64)}` }, 'changed'],
  ] as const) {
    const { read, asked } = stage([...known])
    expect(await read(ask)).toEqual({ ok: false, refused })
    expect(asked).toEqual({ resource: [], get: [], list: [] })
  }
  const off = stage(undefined, { switches: { chosen: { toys: false } } })
  expect(await off.read(ASK)).toEqual({ ok: false, refused: 'code-off' })
  expect(off.asked.resource).toEqual([])

  const gone = stage(undefined, {
    get: {
      ok: false,
      error: { code: 'not-found', message: 'pods "cart-7d9f" not found in shop on 10.0.0.1' },
    },
  })
  expect(await gone.read(ASK)).toEqual({ ok: false, refused: 'not-found' })
  expect(gone.asked.list).toEqual([])
  expect(JSON.stringify(gone.audit)).not.toMatch(/10\.0\.0\.1|cart-7d9f/)
  expect(gone.audit[0]?.input).toMatchObject({
    outcome: 'failure',
    error: READ_REFUSED['not-found'],
    target: { kind: 'Pod' },
    summary: 'Read the warning events of a Pod, for the plugin Toys’ code',
  })

  const without = stage()
  expect(await without.read({ ...ASK, namespace: undefined })).toEqual({
    ok: false,
    refused: 'needs-namespace',
  })
  expect(await without.read({ ...ASK, kind: '/Gadget' })).toEqual({
    ok: false,
    refused: 'not-granted',
  })
})

test('Lumovi’s page asks with exactly an events read’s keys: anything else is no plugin’s, and isn’t made', async () => {
  expect(eventsQuery(ASK)).toEqual(ASK)
  for (const wrong of [
    { ...ASK, labels: ['a'] },
    { ...ASK, name: 'Not a name' },
    { ...ASK, kind: 'Pod' },
    { ...ASK, digest: 'sha256:short' },
    { ...ASK, namespace: 7 },
    (({ name: _, ...rest }) => rest)(ASK),
    [ASK],
    'ASK',
  ]) {
    expect(eventsQuery(wrong)).toBeUndefined()
  }
  const { read, audit } = stage()
  expect(await read({ ...ASK, also: true })).toEqual({ ok: false, refused: 'failed' })
  expect(audit).toEqual([])
})
