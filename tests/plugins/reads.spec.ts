/**
 * The door, for reading, tried with what a plugin's code might ask, a hostile one's included:
 * what's an ask, what a plugin's file lets it have, what it's handed of an object, and how many
 * reads a page may keep. Plain functions: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import { parse } from '../../src/shared/jsonpath.ts'
import {
  granted,
  PageReads,
  picked,
  READ_LIMITS,
  readAsk,
  type Grant,
  type Granted,
} from '../../src/shared/plugin-reads.ts'

const fields = (...paths: string[]): Granted['fields'] =>
  paths.map((path) => ({ path, steps: parse(`.${path}`) }))
const says = (said: Partial<Granted>): Granted => ({
  fields: [],
  status: false,
  events: false,
  usage: false,
  ...said,
})

const GRANT: Grant = {
  own: ['karpenter.sh/NodePool'],
  reads: {
    '/Node': says({
      fields: fields('metadata.name', 'metadata.labels', 'status.capacity'),
      status: true,
      usage: true,
    }),
    '/Pod': says({ fields: fields('metadata.name', 'spec.nodeName') }),
    '/Event': says({ events: true }),
  },
}

test('an ask is one of five things, each with exactly its own words', () => {
  const asks: unknown[] = [
    { read: 1, what: 'list', kind: '/Node' },
    { read: 2, what: 'list', kind: 'karpenter.sh/NodePool', namespace: 'kube-system' },
    { read: 3, what: 'object', kind: 'apps/Deployment', namespace: 'shop', name: 'cart' },
    { read: 4, what: 'object', kind: '/Node', name: 'ip-10-0-1-5.eu-west-1.compute.internal' },
    { read: 5, what: 'events', of: 'o_17' },
    { read: 6, what: 'usage', of: 'o_17' },
    { stop: 3 },
    { refresh: true },
  ]
  for (const ask of asks)
    expect(readAsk(JSON.parse(JSON.stringify(ask))), JSON.stringify(ask)).toEqual(ask)
})

test('anything else stops the plugin: a word too many, a kind or a name that isn’t one, a path', () => {
  const wrong: unknown[] = [
    null,
    'read',
    [],
    {},
    { read: 1 },
    { read: 0, what: 'list', kind: '/Node' },
    { read: 1.5, what: 'list', kind: '/Node' },
    { read: '1', what: 'list', kind: '/Node' },
    { read: 1, what: 'watch', kind: '/Node' },
    { read: 1, what: 'list' },
    { read: 1, what: 'list', kind: 'Node' },
    { read: 1, what: 'list', kind: '/node' },
    { read: 1, what: 'list', kind: '*/*' },
    { read: 1, what: 'list', kind: '/Node/../Secret' },
    { read: 1, what: 'list', kind: '/Node', namespace: '' },
    { read: 1, what: 'list', kind: '/Node', namespace: '../kube-system' },
    { read: 1, what: 'list', kind: '/Node', namespace: 'A' },
    { read: 1, what: 'list', kind: '/Node', name: 'a' },
    { read: 1, what: 'list', kind: '/Node', fields: ['data'] },
    { read: 1, what: 'list', kind: '/Node', selector: 'a=b' },
    { read: 1, what: 'object', kind: '/Node' },
    { read: 1, what: 'object', kind: '/Node', name: 'a/b' },
    { read: 1, what: 'object', kind: '/Node', name: 'a'.repeat(254) },
    { read: 1, what: 'events', kind: '/Node', name: 'a' },
    { read: 1, what: 'events', of: { kind: 'Secret', name: 'a' } },
    { read: 1, what: 'events', of: '../o_1' },
    { read: 1, what: 'usage', of: 'o_1', kind: '/Node' },
    { stop: 1, read: 2 },
    { stop: '1' },
    { refresh: 1 },
    { refresh: true, read: 1 },
    { read: 1, what: 'toString', kind: '/Node' },
    { read: 1, what: 'constructor' },
  ]
  for (const ask of wrong) {
    expect(readAsk(ask), JSON.stringify(ask)).toMatchObject({ why: 'not-allowed' })
  }
  // The names every object answers to are no ask's words.
  expect(
    readAsk(JSON.parse('{"read":1,"what":"list","kind":"/Node","__proto__":{"a":1}}')),
  ).toMatchObject({
    why: 'not-allowed',
  })
})

test('what a file doesn’t say is refused: by kind, and by what’s read of it', () => {
  // Its own kinds, whole: everything of them.
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(GRANT, 'karpenter.sh/NodePool', what)).toEqual({ whole: true })
  }
  // Of Kubernetes' own, what's named.
  expect(granted(GRANT, '/Node', 'objects')).toEqual({
    whole: false,
    granted: GRANT.reads['/Node'],
  })
  expect(granted(GRANT, '/Node', 'status')).toBeTruthy()
  expect(granted(GRANT, '/Node', 'usage')).toBeTruthy()
  expect(granted(GRANT, '/Node', 'events')).toBeUndefined()
  expect(granted(GRANT, '/Pod', 'status')).toBeUndefined()
  // Events of a kind, with none of its fields: no list of it.
  expect(granted(GRANT, '/Event', 'events')).toBeTruthy()
  expect(granted(GRANT, '/Event', 'objects')).toBeUndefined()
  // A kind it doesn't name; another's kind; a name every object answers to.
  for (const kind of [
    '/ConfigMap',
    'argoproj.io/Application',
    'toString',
    '__proto__',
    'constructor',
    '',
  ]) {
    expect(granted(GRANT, kind, 'objects'), kind).toBeUndefined()
  }
  // A Secret, never: not even if a file's grant said so, or a plugin claimed the kind.
  const loose: Grant = {
    own: ['/Secret'],
    reads: { '/Secret': says({ fields: fields('data'), events: true }) },
  }
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(loose, '/Secret', what)).toBeUndefined()
  }
})

test('of an object, a plugin is handed the fields its file names and nothing else', () => {
  const node = {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name: 'node-1',
      uid: 'abc',
      labels: { 'topology.kubernetes.io/zone': 'eu-west-1a' },
      annotations: { 'example.com/owner': 'team-a', 'example.com/token': 'hunter2' },
      managedFields: [{ manager: 'kubelet' }],
    },
    spec: { providerID: 'aws:///eu-west-1a/i-0abc', taints: [] },
    status: { capacity: { cpu: '8' }, addresses: [{ address: '10.0.1.5' }] },
  }
  expect(picked(node, '/Node', GRANT.reads['/Node']!)).toEqual({
    metadata: { name: 'node-1', labels: { 'topology.kubernetes.io/zone': 'eu-west-1a' } },
    status: { capacity: { cpu: '8' } },
  })
  // One annotation by its key; never all of them, never the managed fields, whatever a grant says.
  expect(
    picked(
      node,
      '/Node',
      says({
        fields: [
          ...fields(
            'metadata.annotations',
            'metadata.managedFields',
            'metadata.managedFields.manager',
          ),
          {
            path: 'metadata.annotations["example.com/owner"]',
            steps: parse(".metadata.annotations['example.com/owner']"),
          },
        ],
      }),
    ),
  ).toEqual({ metadata: { annotations: { 'example.com/owner': 'team-a' } } })
  // A path that isn't there leaves nothing; a path and one under it: the shorter has it all.
  expect(
    picked(
      node,
      '/Node',
      says({ fields: fields('spec.unschedulable', 'status.nodeInfo.osImage') }),
    ),
  ).toEqual({})
  expect(picked(node, '/Node', says({ fields: fields('status.capacity.cpu', 'status') }))).toEqual({
    status: node.status,
  })
  expect(picked(node, '/Node', says({ fields: fields('status', 'status.capacity.cpu') }))).toEqual({
    status: node.status,
  })
  // Nothing that isn't a field's own name: the object whole, a wildcard, an index, a filter, the
  // names every object answers to.
  const odd = says({
    fields: [
      { path: '', steps: [] },
      { path: 'status.addresses[*]', steps: parse('.status.addresses[*]') },
      { path: 'status.addresses[0]', steps: parse('.status.addresses[0]') },
      { path: 'status.addresses[?(@.address)]', steps: parse('.status.addresses[?(@.address)]') },
      { path: '__proto__', steps: [{ key: '__proto__' }] },
      { path: 'constructor.name', steps: [{ key: 'constructor' }, { key: 'name' }] },
      { path: 'metadata.toString', steps: [{ key: 'metadata' }, { key: 'toString' }] },
    ],
  })
  expect(picked(node, '/Node', odd)).toEqual({})
  // What a ConfigMap holds, and anything of a Secret: never.
  const held = {
    metadata: { name: 'a' },
    data: { password: 'hunter2' },
    binaryData: { key: 'aGk=' },
  }
  const all = says({ fields: fields('metadata.name', 'data', 'data.password', 'binaryData') })
  expect(picked(held, '/ConfigMap', all)).toEqual({ metadata: { name: 'a' } })
  expect(picked(held, '/Secret', all)).toEqual({})
  // And what isn't an object gives nothing.
  for (const value of [null, 'text', 5, [node]])
    expect(picked(value, '/Node', GRANT.reads['/Node']!)).toEqual({})
})

test('what’s handed over is the object’s own: nothing a path names can change what was read', () => {
  const pod = {
    metadata: { name: 'a' },
    spec: { nodeName: 'node-1', containers: [{ image: 'x' }] },
  }
  const before = JSON.stringify(pod)
  const handed = picked(
    pod,
    '/Pod',
    says({ fields: fields('spec', 'spec.nodeName', 'metadata.name') }),
  )
  expect(handed).toEqual({ metadata: { name: 'a' }, spec: pod.spec })
  expect(JSON.stringify(pod)).toBe(before)
  expect(handed.metadata).not.toBe(pod.metadata)
})

test('a page’s reads are counted: lists kept, asks in a second, asks waiting, and a number is new once', () => {
  const clock = { now: 0 }
  const plugin = { lists: 0 }
  const reads = () => new PageReads(plugin, () => clock.now)
  const list = (read: number) => ({ read, what: 'list', kind: '/Node' }) as const
  // Eight lists a page; the ninth stops it. Ending one makes room.
  const page = reads()
  for (let i = 1; i <= READ_LIMITS.listsAPage; i++) expect(page.take(list(i))).toBeUndefined()
  clock.now += 1000
  expect(page.take({ stop: 3 })).toBeUndefined()
  expect(page.take(list(9))).toBeUndefined()
  expect(page.take(list(10))).toEqual({ why: 'too-much', what: 'lists a page keeps: more than 8' })
  // Sixteen a plugin, across its pages; a page that's gone gives its lists back.
  const second = reads()
  clock.now += 1000
  for (let i = 1; i <= READ_LIMITS.listsAPage; i++) expect(second.take(list(i))).toBeUndefined()
  expect(plugin.lists).toBe(READ_LIMITS.listsAPlugin)
  const third = reads()
  clock.now += 1000
  expect(third.take(list(1))).toEqual({
    why: 'too-much',
    what: 'lists a plugin keeps: more than 16',
  })
  second.close()
  expect(plugin.lists).toBe(READ_LIMITS.listsAPage)
  expect(reads().take(list(1))).toBeUndefined()

  // A number is new once, and only a greater one after it; a read that isn't going can't be ended.
  const numbered = new PageReads({ lists: 0 }, () => clock.now)
  clock.now += 1000
  expect(numbered.take({ read: 5, what: 'usage', of: 'o_1' })).toBeUndefined()
  expect(numbered.take({ read: 5, what: 'usage', of: 'o_1' })).toMatchObject({ why: 'not-allowed' })
  expect(new PageReads({ lists: 0 }, () => clock.now).take({ stop: 1 })).toEqual({
    why: 'not-allowed',
    what: 'ends a read that isn’t going',
  })

  // Ten asks a second, by Lumovi's clock; a clock set back starts the second again.
  const fast = new PageReads({ lists: 0 }, () => clock.now)
  clock.now += 1000
  for (let i = 1; i <= READ_LIMITS.asksASecond; i++) {
    expect(fast.take({ read: i, what: 'usage', of: 'o_1' })).toBeUndefined()
    fast.answered(i)
  }
  clock.now -= 5000
  expect(fast.take({ read: 11, what: 'usage', of: 'o_1' })).toBeUndefined()
  for (let i = 12; i <= 20; i++) fast.take({ read: i, what: 'usage', of: 'o_1' })
  expect(fast.take({ read: 21, what: 'usage', of: 'o_1' })).toEqual({
    why: 'too-much',
    what: 'asks in a second: more than 10',
  })

  // Twenty waiting at once; one answered, or refused, makes room.
  const slow = new PageReads({ lists: 0 }, () => clock.now)
  let read = 0
  for (let second = 0; second < 2; second++) {
    clock.now += 1000
    for (let i = 0; i < 10; i++)
      expect(slow.take({ read: ++read, what: 'usage', of: 'o_1' })).toBeUndefined()
  }
  clock.now += 1000
  slow.answered(1)
  slow.refused(2)
  expect(slow.take({ read: ++read, what: 'usage', of: 'o_1' })).toBeUndefined()
  expect(slow.take({ read: ++read, what: 'usage', of: 'o_1' })).toBeUndefined()
  expect(slow.take({ read: read + 1, what: 'usage', of: 'o_1' })).toEqual({
    why: 'too-much',
    what: 'asks not yet answered: more than 20',
  })
})

test('a refresh too soon isn’t made, and doesn’t stop the plugin', () => {
  const clock = { now: 50_000 }
  const page = new PageReads({ lists: 0 }, () => clock.now)
  expect(page.take({ refresh: true })).toBeUndefined()
  clock.now += READ_LIMITS.refreshEveryMs - 1
  expect(page.take({ refresh: true })).toBe('too-soon')
  clock.now += 1
  expect(page.take({ refresh: true })).toBeUndefined()
})
