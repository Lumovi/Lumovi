/**
 * What a plugin's pages read, held to what the audit history lists (`pluginHistory`): a place
 * for each different ask a while, taken before anything is made of it; past them a refusal, and
 * Lumovi's own two entries. With a clock of the test's own: nothing is built or launched, and ten
 * minutes pass in a moment.
 */
import { expect, test } from '@playwright/test'
import type { AuditLog } from '../../src/backend/audit/log.ts'
import { recorder, type Recorded } from '../../src/backend/audit/recorder.ts'
import {
  pluginHistory,
  type HistoryClock,
  type PluginHistory,
} from '../../src/backend/plugin-history.ts'
import { pluginEvents } from '../../src/backend/plugin-events.ts'
import { pluginLogs } from '../../src/backend/plugin-logs.ts'
import { pluginReads } from '../../src/backend/plugin-reads.ts'
import { pluginServer } from '../../src/backend/plugin-server.ts'
import type { KubeObject } from '../../src/shared/api.ts'
import { READ_LIMITS } from '../../src/shared/plugin-reads.ts'
import { tooManyReads } from '../../src/shared/plugin-server.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'
import type { ResourceDefinition } from '../../src/shared/resources.ts'

const MINUTE = 60_000
const { differentAWhile: MOST, whileMs } = READ_LIMITS

const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'toys',
  version: '1.2.0',
  origin: 'lumovi',
  file: 'toys.yaml',
  digest: FILE,
  code: 'box.then(() => {})',
  codeDigest: CODE,
  grant: { groups: [], own: [], reads: {} },
  label: 'Toys',
  ...also,
})
const WHO = { plugin: 'toys', pluginVersion: '1.2.0', pluginDigest: FILE, codeDigest: CODE }

/** A read's entry, with a word of the page's own in it. */
const entry = (word: string, cluster = 'demo', outcome: Recorded['outcome'] = 'success') =>
  ({
    action: 'plugin.read',
    outcome,
    cluster,
    summary: `Read ${word} for the plugin toys`,
  }) satisfies Recorded

/**
 * A history that keeps the newest `capacity` entries, as the one in memory does; the recorder
 * that writes to it as a person; and a clock that moves when the test moves it.
 */
function stage(capacity = 10_000) {
  const kept: Recorded[] = []
  const log = {
    // (Who did it is the recorder's to add, and the same throughout: left out of what's compared.)
    record: ({ actor: _, ...input }: Recorded & { actor: unknown }) => {
      kept.push(input)
      if (kept.length > capacity) kept.shift()
    },
  } as unknown as AuditLog
  const audit = recorder(log, () => ({ user: 'me', via: 'ui' }))
  let time = 1_000_000
  let waits: { at: number; run: () => void }[] = []
  const clock: HistoryClock = {
    now: () => time,
    after: (ms, run) => {
      const wait = { at: time + ms, run }
      waits.push(wait)
      return () => {
        waits = waits.filter((each) => each !== wait)
      }
    },
  }
  /** Time passes: every wait that's due by then runs, in its order. */
  const pass = (ms: number) => {
    const until = time + ms
    for (;;) {
      const due = waits.filter((wait) => wait.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      waits = waits.filter((wait) => wait !== due)
      time = due.at
      due.run()
    }
    time = until
  }
  return {
    kept,
    audit,
    history: pluginHistory(audit, clock),
    pass,
    summaries: () => kept.map(({ summary }) => summary),
  }
}

/**
 * An ask of a page's, by a word of its own, and what came of it written (made, unless said):
 * whether it had a place, or how it was refused.
 */
function read(
  history: PluginHistory,
  toys: KnownPlugin,
  word: string,
  { cluster = 'demo', outcome = 'success' as Recorded['outcome'], key = `read:${word}` } = {},
) {
  const place = history.take(toys, cluster, `ask:${word}`)
  if ('refused' in place) return place
  place.record(key, entry(word, cluster, outcome))
  return 'made'
}

test('a plugin’s pages make so many different reads a while, each listed; the same read again is made again; past them a new one is refused, and Lumovi says so, and at the while’s end how many', async () => {
  const { kept, history, pass, summaries } = stage()
  const toys = plugin()
  for (let n = 0; n < MOST; n++) expect(read(history, toys, `thing-${n}`)).toBe('made')
  expect(kept).toHaveLength(MOST)
  // The same reads again, as a page keeps what it shows up to date: made, and nothing more written.
  for (let n = 0; n < MOST; n++) expect(read(history, toys, `thing-${n}`)).toBe('made')
  expect(kept).toHaveLength(MOST)
  // A new one has no place: refused, with how long is left; and Lumovi's own entry, once, with
  // nothing of the ask in it.
  pass(2.5 * MINUTE)
  expect(read(history, toys, 'PAST-0')).toEqual({ refused: 'too-many-reads', minutes: 8 })
  expect(kept).toHaveLength(MOST + 1)
  expect(kept.at(-1)).toEqual({
    action: 'plugin.read',
    outcome: 'refused',
    cluster: 'demo',
    summary:
      'The plugin Toys’ page asked to read more than Lumovi lists in ten minutes: its new reads are refused for the next 8 minutes',
    details: { ...WHO, refused: 'too-many-reads', listed: MOST },
  })
  // Further new asks, and the same refused one again: refused, each one more. One that has its
  // place is made as before.
  for (let n = 1; n < 40; n++) expect(read(history, toys, `PAST-${n}`)).toHaveProperty('refused')
  for (let n = 0; n < 11; n++) expect(read(history, toys, 'PAST-0')).toHaveProperty('refused')
  expect(read(history, toys, 'thing-7')).toBe('made')
  expect(kept).toHaveLength(MOST + 1)
  // The while's end, ten minutes from its first ask: how many were refused.
  pass(7.5 * MINUTE - 1)
  expect(kept).toHaveLength(MOST + 1)
  pass(1)
  expect(kept).toHaveLength(MOST + 2)
  expect(kept.at(-1)).toEqual({
    action: 'plugin.read',
    outcome: 'refused',
    cluster: 'demo',
    summary: 'Refused for the plugin Toys’ page, past what Lumovi lists: 51 reads',
    details: { ...WHO, refused: 'too-many-reads', reads: 51 },
  })
  expect(JSON.stringify(kept.slice(MOST))).not.toContain('PAST')
  // A new while: places again, for what was refused too.
  expect(read(history, toys, 'thing-7')).toBe('made')
  expect(read(history, toys, 'PAST-0')).toBe('made')
  expect(summaries().slice(MOST + 2)).toEqual([
    'Read thing-7 for the plugin toys',
    'Read PAST-0 for the plugin toys',
  ])
  // A while in which nothing was refused ends without a word.
  pass(whileMs)
  expect(kept).toHaveLength(MOST + 4)
})

test('an ask makes one entry, and one more only when a read that first wasn’t made is made; asks that come to the same thing are one entry a while', async () => {
  const { history, summaries, kept } = stage()
  const toys = plugin()
  // Refused, then failed another way, then made, then made again: its refusal and its making.
  for (const outcome of ['refused', 'failure', 'success', 'success', 'failure'] as const) {
    read(history, toys, 'one', { outcome, key: `read:one:${outcome}` })
  }
  expect(kept.map(({ outcome }) => outcome)).toEqual(['refused', 'success'])
  // Made, then failing: the read that was made is what's listed.
  read(history, toys, 'two')
  read(history, toys, 'two', { outcome: 'failure', key: 'read:two:failure' })
  expect(kept.map(({ outcome }) => outcome)).toEqual(['refused', 'success', 'success'])
  // Different asks that come to the same thing (a kind its file doesn't name, say): one entry.
  for (const word of ['a', 'b', 'c']) {
    read(history, toys, word, { outcome: 'refused', key: 'read:the same refusal' })
  }
  expect(summaries().slice(3)).toEqual(['Read a for the plugin toys'])
  // Each of them has its place all the same: they count among the different reads.
  for (let n = 0; n < MOST - 5; n++) expect(read(history, toys, `thing-${n}`)).toBe('made')
  expect(read(history, toys, 'one too many')).toHaveProperty('refused')
})

test('ten reads a second for an hour, each by a name of its own, leave a history that keeps ten thousand entries what a person did', async () => {
  const { kept, audit, history, pass } = stage(10_000)
  const did: Recorded = {
    action: 'resource.delete',
    outcome: 'success',
    cluster: 'demo',
    summary: 'Deleted Pod cart',
  }
  audit.record(did)
  const toys = plugin()
  const hour = 60 * MINUTE
  let made = 0
  for (let n = 0; n < (hour / 1000) * 10; n++) {
    if (read(history, toys, `thing-${n}`) === 'made') made++
    pass(100)
  }
  history.stop()
  // Six whiles: in each the reads that had a place, every one listed, and Lumovi's two entries.
  expect(made).toBe(6 * MOST)
  expect(kept).toHaveLength(1 + 6 * (MOST + 2))
  expect(kept[0]).toEqual(did)
  expect(kept.filter(({ summary }) => summary.startsWith('Read '))).toHaveLength(made)
  expect(
    new Set(
      kept.filter(({ details }) => details?.reads !== undefined).map(({ summary }) => summary),
    ),
  ).toEqual(
    new Set([
      `Refused for the plugin Toys’ page, past what Lumovi lists: ${(6000 - MOST).toLocaleString('en-US')} reads`,
    ]),
  )
  // The same reads made and written as a person's own are, once a while each, with no limit:
  // what the person did is gone within the hour. (What the limit is for.)
  const without = stage(10_000)
  without.audit.record(did)
  for (let n = 0; n < (hour / 1000) * 10; n++) without.audit.read(`read:${n}`, entry(`thing-${n}`))
  expect(without.kept).toHaveLength(10_000)
  expect(without.kept).not.toContainEqual(did)
})

test('each plugin has its own count in each cluster; a plugin Lumovi hasn’t in use is one entry a while, by the recorder’s own count', async () => {
  const { kept, history, summaries } = stage()
  const toys = plugin()
  const board = plugin({ name: 'board', label: undefined })
  for (let n = 0; n < MOST; n++) read(history, toys, `thing-${n}`)
  expect(read(history, toys, 'more')).toHaveProperty('refused')
  expect(kept).toHaveLength(MOST + 1)
  // Another plugin's page, and the same plugin's in another cluster: untouched by that count.
  expect(read(history, board, 'thing-0')).toBe('made')
  expect(read(history, toys, 'thing-0', { cluster: 'other' })).toBe('made')
  expect(kept).toHaveLength(MOST + 3)
  for (let n = 1; n < MOST; n++) read(history, board, `thing-${n}`)
  expect(read(history, board, 'more')).toEqual({ refused: 'too-many-reads', minutes: 10 })
  // (A plugin whose file gives no label goes by its name.)
  expect(summaries().at(-1)).toBe(
    'The plugin board’s page asked to read more than Lumovi lists in ten minutes: its new reads are refused for the next 10 minutes',
  )
  // No plugin: the same key is one entry a while, and there's nothing to count against.
  const before = kept.length
  for (let n = 0; n < 500; n++) history.unknown('unknown', entry('nobody'))
  expect(kept).toHaveLength(before + 1)
})

test('as Lumovi stops, what was refused is said at once; refusals don’t keep a while from ending; and the last minute is a minute', async () => {
  const { kept, history, pass, summaries } = stage()
  const toys = plugin()
  for (let n = 0; n < MOST; n++) read(history, toys, `thing-${n}`)
  pass(whileMs - 20_000)
  expect(read(history, toys, 'past')).toEqual({ refused: 'too-many-reads', minutes: 1 })
  expect(summaries().at(-1)).toBe(
    'The plugin Toys’ page asked to read more than Lumovi lists in ten minutes: its new reads are refused for the next minute',
  )
  expect(tooManyReads(1)).toContain('so it can read nothing new for another minute.')
  expect(tooManyReads(8)).toContain('so it can read nothing new for 8 more minutes.')
  history.stop()
  expect(summaries().at(-1)).toBe(
    'Refused for the plugin Toys’ page, past what Lumovi lists: 1 read',
  )
  // Said once: nothing waits to say it again, and stopping twice says nothing.
  const said = kept.length
  history.stop()
  pass(whileMs)
  expect(kept).toHaveLength(said)
  // Asked for more without a pause, right to the while's end and past it: the while ends when
  // its ten minutes do, and the next ask has a place.
  const pressing = stage()
  for (let n = 0; n < MOST; n++) read(pressing.history, toys, `thing-${n}`)
  for (let n = 0; n < 6000; n++) {
    read(pressing.history, toys, `more-${n}`)
    pressing.pass(100)
  }
  expect(read(pressing.history, toys, 'after')).toBe('made')
  // Nothing refused: stopping says nothing.
  const quiet = stage()
  read(quiet.history, toys, 'thing-0')
  quiet.history.stop()
  expect(quiet.kept).toHaveLength(1)
})

const WIDGET: ResourceDefinition = {
  kind: 'Widget.example.com',
  apiKind: 'Widget',
  plural: 'widgets',
  group: 'example.com',
  version: 'v1',
  namespaced: true,
  label: 'Widgets',
  category: 'cluster',
}
const POD: ResourceDefinition = {
  kind: 'Pod',
  apiKind: 'Pod',
  plural: 'pods',
  group: '',
  version: 'v1',
  namespaced: true,
  label: 'Pods',
  category: 'workloads',
}
const object = (kind: string, name: string, spec: object = {}) =>
  ({ apiVersion: 'v1', kind, metadata: { name, namespace: 'default' }, spec }) as KubeObject

test('past its different reads, a page’s new read of a kind, of a pod’s logs, of an object’s events and of its server are each refused before the cluster is asked; every read that was made is in the history', async () => {
  const { kept, history, summaries } = stage()
  const toys = plugin({
    grant: {
      groups: ['example.com'],
      own: ['example.com/Widget'],
      reads: {
        '/Pod': {
          fields: [{ path: 'metadata.name', steps: [{ key: 'metadata' }, { key: 'name' }] }],
          status: false,
          events: true,
          usage: false,
        },
      },
    },
    logs: 'read',
    server: {
      service: { name: 'toys-api' },
      in: 'Widget.example.com',
      port: 'http',
      paths: ['/api/v1/status'],
    },
  })
  /** What the cluster was asked, by what. */
  const asked = { resource: 0, get: 0, list: 0, logs: 0, proxy: 0, events: 0 }
  const known = async () => [toys]
  const to = () => ({ host: 'desktop' as const, switches: { chosen: {} } })
  const reads = pluginReads({
    kube: {
      resource: async () => (asked.resource++, WIDGET),
      get: async (q) => (
        asked.get++,
        { ok: true, data: object('Widget', (q as { name: string }).name) }
      ),
      list: async () => (asked.list++, { ok: true, data: { items: [], truncated: false } }),
      metrics: async () => ({ ok: true, data: { available: false, items: [] } }),
    },
    known,
    to,
    audit: history,
  })
  const logs = pluginLogs({
    kube: { podLogs: async () => (asked.logs++, { ok: true, data: 'a line\n' }) },
    known,
    to,
    audit: history,
  })
  const events = pluginEvents({
    kube: {
      resource: async () => POD,
      get: async (q) => ({
        ok: true,
        data: {
          ...object('Pod', (q as { name: string }).name),
          metadata: { name: (q as { name: string }).name, namespace: 'default', uid: 'u-1' },
        } as KubeObject,
      }),
      list: async () => (asked.events++, { ok: true, data: { items: [], truncated: false } }),
    },
    known,
    to,
    audit: history,
  })
  const server = pluginServer({
    kube: {
      get: async () => ({
        ok: true,
        data: object('Service', 'toys-api', { ports: [{ name: 'http', port: 8080 }] }),
      }),
      list: async () => ({ ok: true, data: { items: [], truncated: false } }),
      serviceProxy: async () => (
        asked.proxy++,
        { ok: true, data: { status: 200, type: 'application/json', body: '{"healthy":true}' } }
      ),
    },
    known,
    to,
    audit: history,
  })
  const handed = { context: 'demo', plugin: 'toys', digest: FILE, codeDigest: CODE }
  const widget = (name: string) =>
    reads({ ...handed, kind: 'example.com/Widget', namespace: 'default', name })
  const logsOf = (pod: string) => logs({ ...handed, namespace: 'default', pod, container: 'app' })
  const status = { kind: 'Widget.example.com', namespace: 'default', name: 'blue' }
  const ofItsServer = (within: typeof status) =>
    server({ ...handed, in: within, path: '/api/v1/status' })
  const eventsOf = (pod: string) =>
    events({ ...handed, kind: '/Pod', namespace: 'default', name: pod })

  // The four kinds of read share the one count: a pod's logs, an object's events, an ask of its
  // server, and objects by name, to the last place.
  expect(await logsOf('cart')).toMatchObject({ ok: true })
  expect(await eventsOf('cart')).toMatchObject({ ok: true })
  expect(await ofItsServer(status)).toMatchObject({ ok: true })
  for (let n = 0; n < MOST - 3; n++) expect(await widget(`w-${n}`)).toMatchObject({ ok: true })
  const made = { resource: MOST - 3, get: MOST - 3, list: 0, logs: 1, proxy: 1, events: 1 }
  expect(asked).toEqual(made)
  expect(kept).toHaveLength(MOST)

  // Past them: a pod's logs, an object's events, a read by name, a list, an ask of its server,
  // and a kind its file doesn't name. Each refused, with Lumovi's sentence and how long is left.
  const refused = { ok: false, refused: 'too-many-reads', minutes: 10 }
  expect(await logsOf('checkout')).toEqual(refused)
  expect(await eventsOf('checkout')).toEqual(refused)
  expect(await widget('one-more')).toEqual(refused)
  expect(await reads({ ...handed, kind: 'example.com/Widget' })).toEqual(refused)
  expect(await reads({ ...handed, kind: 'apps/Deployment' })).toEqual(refused)
  expect(await ofItsServer({ ...status, name: 'green' })).toEqual({
    ok: false,
    refused: 'too-many-reads',
    said: tooManyReads(10),
  })
  // The cluster was asked for none of them: not what a kind is, not an object, a list, a log,
  // events or its server.
  expect(asked).toEqual(made)
  // In the history: every read that was made, and one entry of Lumovi's for the six.
  expect(kept).toHaveLength(MOST + 1)
  expect(summaries().slice(0, 4)).toEqual([
    'Read the logs of Pod cart (app), for the plugin Toys’ code',
    'Read the warning events of Pod cart, for the plugin Toys’ code',
    'Asked the Service toys-api in default for /api/v1/status, for the plugin Toys’ page',
    'Read Widget w-0 for the plugin toys',
  ])
  expect(JSON.stringify(kept)).not.toMatch(/checkout|one-more|Deployment|green/)

  // What it already reads goes on: made again, the cluster asked again, nothing more written.
  expect(await widget('w-0')).toMatchObject({ ok: true })
  expect(await logsOf('cart')).toMatchObject({ ok: true })
  expect(await ofItsServer(status)).toMatchObject({ ok: true })
  expect(await eventsOf('cart')).toMatchObject({ ok: true })
  expect(asked).toMatchObject({ get: MOST - 2, logs: 2, proxy: 2, events: 2 })
  expect(kept).toHaveLength(MOST + 1)
  history.stop()
  expect(summaries().at(-1)).toBe(
    'Refused for the plugin Toys’ page, past what Lumovi lists: 6 reads',
  )
})
