/**
 * A pod's logs a plugin's code reads, as the backend makes the read (`spec.logs: read`): the
 * plugin found among those in use, its file's word and its read of Pods asked, the policy, then
 * the logs read as the person, once, never a follow, and the last of them kept within Lumovi's
 * limits; a refusal as a code. Against a stand-in for the cluster: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import type { PodLogsQuery, Result } from '../../src/shared/api.ts'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import { lastLines, pluginLogs } from '../../src/backend/plugin-logs.ts'
import type { CodeSwitches } from '../../src/shared/plugin-hand-over.ts'
import { READ_LIMITS, READ_REFUSED, type Grant } from '../../src/shared/plugin-reads.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'

const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const PODS: Grant = {
  groups: ['example.com'],
  own: ['example.com/Widget'],
  reads: {
    '/Pod': {
      fields: [{ path: 'metadata.name', steps: [] }],
      status: false,
      events: false,
      usage: false,
    },
  },
}
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'toys',
  version: '1.2.0',
  origin: 'lumovi',
  file: 'toys.yaml',
  digest: FILE,
  code: 'box.then(() => {})',
  codeDigest: CODE,
  grant: PODS,
  label: 'Toys',
  logs: 'read',
  ...also,
})

const ASK = {
  context: 'demo',
  plugin: 'toys',
  digest: FILE,
  codeDigest: CODE,
  namespace: 'shop',
  pod: 'cart-7d9f',
  container: 'app',
}

const STAMP = '2026-10-13T10:00:00.000000001Z'

/** A stand-in cluster: what it answers for a pod's logs, and what it was asked. */
function stage(
  known: KnownPlugin[] = [plugin()],
  answer: (q: PodLogsQuery) => Result<string> = () => ({
    ok: true,
    data: `${STAMP} started\n${STAMP} listening on :8080\n`,
  }),
  switches: CodeSwitches = { chosen: {} },
) {
  const asked: PodLogsQuery[] = []
  const audit: { key: string; input: Recorded }[] = []
  const read = pluginLogs({
    kube: {
      podLogs: async (q) => {
        asked.push(q)
        return answer(q)
      },
    },
    known: async () => known,
    to: () => ({ host: 'desktop', switches }),
    audit: {
      user: 'me',
      record: () => undefined,
      read: (key, input) => void audit.push({ key, input }),
    },
  })
  return { read, asked, audit }
}

test('a plugin whose file says its code reads logs is handed a pod’s last lines, read once as the person', async () => {
  const { read, asked, audit } = stage()
  expect(await read(ASK)).toEqual({
    ok: true,
    lines: [
      { time: STAMP, text: 'started' },
      { time: STAMP, text: 'listening on :8080' },
    ],
  })
  // Never a follow: its last lines, as many as Lumovi hands at most, each with its time.
  expect(asked).toEqual([
    {
      context: 'demo',
      namespace: 'shop',
      pod: 'cart-7d9f',
      container: 'app',
      tailLines: READ_LIMITS.logLines,
      limitBytes: 8 * READ_LIMITS.logBytes,
      timestamps: true,
    },
  ])
  expect(audit.map(({ input }) => input)).toEqual([
    {
      action: 'logs.read',
      outcome: 'success',
      cluster: 'demo',
      target: { kind: 'Pod', name: 'cart-7d9f', namespace: 'shop' },
      summary: 'Read the logs of Pod cart-7d9f (app), for the plugin Toys’ code',
      command: 'kubectl logs cart-7d9f -c app --tail=500 -n shop --context demo',
      details: {
        container: 'app',
        previous: false,
        plugin: 'toys',
        pluginVersion: '1.2.0',
        pluginDigest: FILE,
        codeDigest: CODE,
      },
    },
  ])
  // Its own last lines, those of its last seconds, or its previous instance's: as it asks.
  await read({ ...ASK, tail: 20, since: 600, previous: true })
  expect(asked[1]).toMatchObject({ tailLines: 20, sinceSeconds: 600, previous: true })
  expect(audit[1]?.input).toMatchObject({
    summary:
      'Read the logs of Pod cart-7d9f (app), from before it restarted, for the plugin Toys’ code',
    command:
      'kubectl logs cart-7d9f -c app --tail=20 --since=600s --previous -n shop --context demo',
    details: { previous: true },
  })
})

test('a plugin whose file doesn’t say its code reads logs, or reads no Pods, is handed none', async () => {
  const NODES: Grant = { ...PODS, reads: { '/Node': PODS.reads['/Pod']! } }
  for (const known of [
    plugin({ logs: undefined }),
    plugin({ logs: 'shown' }),
    plugin({ grant: NODES }),
    plugin({ grant: { ...PODS, reads: {} } }),
  ]) {
    const { read, asked, audit } = stage([known])
    expect(await read(ASK), JSON.stringify(known)).toEqual({ ok: false, refused: 'not-granted' })
    expect(asked).toEqual([])
    expect(audit.map(({ input }) => [input.outcome, input.error, input.details?.refused])).toEqual([
      ['refused', READ_REFUSED['not-granted'], 'not-granted'],
    ])
  }
})

test('a plugin not in use, changed since its page was handed its code, or turned off, reads no logs', async () => {
  for (const [known, ask, refused] of [
    [[], ASK, 'not-in-use'],
    [[plugin({ origin: 'yours' })], ASK, 'not-in-use'],
    // (One without code has no page that could ask.)
    [[plugin({ code: undefined, codeDigest: undefined })], ASK, 'not-in-use'],
    [[plugin()], { ...ASK, digest: `sha256:${'b'.repeat(64)}` }, 'changed'],
    [[plugin()], { ...ASK, codeDigest: `sha256:${'d'.repeat(64)}` }, 'changed'],
  ] as const) {
    const { read, asked, audit } = stage([...known])
    expect(await read(ask), refused).toEqual({ ok: false, refused })
    expect(asked).toEqual([])
    expect(audit).toHaveLength(1)
    // (Never a digest it hasn't.)
    expect(Object.values(audit[0]!.input.details ?? {})).not.toContain(undefined)
  }
  // Its code turned off by the person, or by the organization's policy.
  const off: CodeSwitches[] = [{ chosen: { toys: false } }, { policyOff: true, chosen: {} }]
  for (const switches of off) {
    const { read, asked } = stage([plugin()], undefined, switches)
    expect(await read(ASK)).toEqual({ ok: false, refused: 'code-off' })
    expect(asked).toEqual([])
  }
  // The organization's policy lets no plugin show or read logs.
  const { read, asked, audit } = stage([plugin()], undefined, { logsOff: true, chosen: {} })
  expect(await read(ASK)).toEqual({ ok: false, refused: 'logs-off' })
  expect(asked).toEqual([])
  expect(audit[0]?.input).toMatchObject({
    outcome: 'refused',
    error: 'Your organization’s policy doesn’t let plugins show or read containers’ logs.',
    details: { refused: 'logs-off' },
  })
})

test('Lumovi’s page asks with exactly a logs read’s keys: anything else isn’t made, nor recorded', async () => {
  const { read, asked, audit } = stage()
  for (const wrong of [
    null,
    'logs',
    { ...ASK, follow: true },
    { ...ASK, tail: 501 },
    { ...ASK, tail: 0 },
    { ...ASK, since: 3601 },
    { ...ASK, previous: false },
    { ...ASK, pod: '../secrets' },
    { ...ASK, namespace: '' },
    { ...ASK, container: 'App' },
    { ...ASK, plugin: 'Toys' },
    { ...ASK, digest: undefined },
  ]) {
    expect(await read(wrong), JSON.stringify(wrong)).toEqual({ ok: false, refused: 'failed' })
  }
  expect(asked).toEqual([])
  expect(audit).toEqual([])
})

test('a failure is a code: never what the cluster said', async () => {
  for (const [code, refused] of [
    ['forbidden', 'not-allowed'],
    ['not-found', 'not-found'],
    ['timeout', 'unreachable'],
    ['server', 'failed'],
  ] as const) {
    const { read, audit } = stage([plugin()], () => ({
      ok: false,
      error: {
        code,
        message: 'pods "cart-7d9f" is forbidden: User "alice@example.com" at https://10.0.0.1:6443',
      },
    }))
    expect(await read(ASK), code).toEqual({ ok: false, refused })
    expect(JSON.stringify(audit)).not.toMatch(/alice|10\.0\.0\.1/)
  }
})

test('of what the cluster sent, the last lines within Lumovi’s limits: the oldest cut, and said so', () => {
  // Within them: every line, with its time where it has one.
  expect(lastLines(`${STAMP} a\nno time here\n${STAMP} \n`)).toEqual({
    lines: [{ time: STAMP, text: 'a' }, { text: 'no time here' }, { time: STAMP, text: '' }],
    cut: false,
  })
  expect(lastLines('')).toEqual({ lines: [], cut: false })
  // More lines than it hands: the last of them.
  const many = Array.from({ length: READ_LIMITS.logLines + 3 }, (_, i) => `${STAMP} line ${i}`)
  const kept = lastLines(many.join('\n'))
  expect(kept.cut).toBe(true)
  expect(kept.lines).toHaveLength(READ_LIMITS.logLines)
  expect(kept.lines[0]?.text).toBe('line 3')
  expect(kept.lines.at(-1)?.text).toBe(`line ${READ_LIMITS.logLines + 2}`)
  // More bytes than it hands: the newest lines that fit, and no part of a line.
  const long = 'x'.repeat(1000)
  const big = lastLines(Array.from({ length: 100 }, (_, i) => `${STAMP} ${i} ${long}`).join('\n'))
  expect(big.cut).toBe(true)
  const bytes = big.lines.reduce((sum, line) => sum + Buffer.byteLength(line.text) + 1, 0)
  expect(bytes).toBeLessThanOrEqual(READ_LIMITS.logBytes)
  expect(big.lines.at(-1)?.text).toBe(`99 ${long}`)
  expect(big.lines.every((line) => line.text.endsWith(long))).toBe(true)
})

test('lines too long for one read: asked again for fewer, so the newest are the ones handed', async () => {
  const long = 'x'.repeat(4000)
  /** A container that wrote 500 lines of 4 KB: the cluster sends its oldest, up to the bytes. */
  const { read, asked, audit } = stage([plugin()], (q) => {
    const all = Array.from({ length: 500 }, (_, i) => `${STAMP} ${i} ${long}\n`).slice(
      -q.tailLines!,
    )
    return { ok: true, data: all.join('').slice(0, q.limitBytes) }
  })
  const answer = await read(ASK)
  expect(answer).toMatchObject({ ok: true, cut: true })
  if (!answer.ok) return
  expect(answer.lines.at(-1)?.text).toBe(`499 ${long}`)
  expect(answer.lines.every(({ text }) => text.endsWith(long))).toBe(true)
  // 500 lines, then as many as came whole (no more than half), which fit; one entry.
  expect(asked.map((q) => q.tailLines)).toEqual([500, 129])
  expect(audit).toHaveLength(1)
})

test('logs read for plugins are recorded once a while for the same container, and unknown plugins’ as one', async () => {
  const { read, audit } = stage()
  await read(ASK)
  await read(ASK)
  await read({ ...ASK, container: 'envoy' })
  // (The recorder keeps one entry a key a while: what it was asked to keep is what's counted.)
  expect(new Set(audit.map(({ key }) => key)).size).toBe(2)
  const none = stage([])
  for (let n = 0; n < 50; n++) await none.read({ ...ASK, plugin: `p${n}` })
  expect(new Set(none.audit.map(({ key }) => key)).size).toBe(1)
})
