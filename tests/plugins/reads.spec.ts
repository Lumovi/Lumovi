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
  READABLE,
  readable,
  readAsk,
  resolvedAs,
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
  groups: ['karpenter.sh'],
  own: ['karpenter.sh/NodePool'],
  reads: {
    '/Node': says({
      fields: fields('metadata.name', 'metadata.labels', 'status.capacity'),
      status: true,
      usage: true,
    }),
    '/Pod': says({ fields: fields('metadata.name', 'spec.nodeName') }),
    '/Event': says({ events: true }),
    // A kind of Kubernetes' that Lumovi keeps no list for.
    'apps/Deployment': says({ fields: fields('metadata.name'), events: true }),
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

const NODE = resolvedAs('', 'Node')
const POD = resolvedAs('', 'Pod')
const CONFIG_MAP = resolvedAs('', 'ConfigMap')
const SECRET = resolvedAs('', 'Secret')
const NODE_POOL = resolvedAs('karpenter.sh', 'NodePool')

test('what a file doesn’t say is refused: by kind, and by what’s read of it', () => {
  // Its own kinds, whole: everything of them.
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(GRANT, NODE_POOL, what)).toEqual({ whole: true })
  }
  // Of Kubernetes' own, what's named.
  expect(granted(GRANT, NODE, 'objects')).toEqual({ whole: false, granted: GRANT.reads['/Node'] })
  expect(granted(GRANT, NODE, 'status')).toBeTruthy()
  expect(granted(GRANT, NODE, 'usage')).toBeTruthy()
  expect(granted(GRANT, NODE, 'events')).toBeUndefined()
  expect(granted(GRANT, POD, 'status')).toBeUndefined()
  // Events of a kind with none of its fields: there's no such read. Nothing says "you may hear
  // what happened to things you may not see".
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(GRANT, resolvedAs('', 'Event'), what)).toBeUndefined()
  }
  // A kind of Kubernetes' that Lumovi keeps no list for can't be read, whatever a file says.
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(GRANT, resolvedAs('apps', 'Deployment'), what)).toBeUndefined()
  }
  // A kind it doesn't name; another's kind; a name every object answers to.
  for (const kind of [
    CONFIG_MAP,
    resolvedAs('argoproj.io', 'Application'),
    resolvedAs('', 'toString'),
    resolvedAs('', '__proto__'),
    resolvedAs('__proto__', 'constructor'),
  ]) {
    expect(granted(GRANT, kind, 'objects'), JSON.stringify(kind)).toBeUndefined()
  }
  // A Secret, never: not even if a file's grant said so, or a plugin claimed the kind.
  const loose: Grant = {
    groups: [],
    own: ['/Secret', '/ConfigMap', 'apps/Deployment'],
    reads: { '/Secret': says({ fields: fields('data'), events: true }) },
  }
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(granted(loose, SECRET, what)).toBeUndefined()
  }
  // And a kind of Kubernetes' own is never whole, whatever claims it: "its own" is a tool's kinds.
  expect(granted(loose, CONFIG_MAP, 'objects')).toBeUndefined()
  expect(granted(loose, resolvedAs('apps', 'Deployment'), 'objects')).toBeUndefined()
})

const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'cart-7d9f',
    namespace: 'shop',
    uid: 'abc',
    labels: { app: 'cart' },
    annotations: {
      'example.com/owner': 'team-a',
      'kubectl.kubernetes.io/last-applied-configuration':
        '{"spec":{"containers":[{"env":[{"name":"TOKEN","value":"hunter2"}]}]}}',
      'control-plane.alpha.kubernetes.io/leader': '{"holderIdentity":"a"}',
    },
    managedFields: [{ manager: 'kubelet' }],
  },
  spec: {
    nodeName: 'node-1',
    containers: [
      {
        name: 'cart',
        image: 'shop/cart:1.4',
        env: [{ name: 'TOKEN', value: 'hunter2' }],
        ports: [{ containerPort: 80 }],
      },
      { name: 'proxy', image: 'envoy:1.30', env: [{ name: 'KEY', value: 's3cret' }] },
    ],
    initContainers: [
      { name: 'init', image: 'busybox', env: [{ name: 'TOKEN', value: 'hunter2' }] },
    ],
  },
  status: { phase: 'Running', podIP: '10.0.1.9' },
}
/** Another tool's kind, shaped as a Pod: where Lumovi can have no list, the rules alone hold. */
const THING = resolvedAs('example.io', 'Thing')
const handed = (...paths: string[]) => picked(pod, THING, says({ fields: fields(...paths) }), [])
const SECRETS = /hunter2|s3cret|kubelet|holderIdentity/

test('of an object, a plugin is handed the fields its file names and nothing else', () => {
  expect(handed('metadata.name', 'metadata.labels', 'spec.nodeName', 'status.phase')).toEqual({
    metadata: { name: 'cart-7d9f', labels: { app: 'cart' } },
    spec: { nodeName: 'node-1' },
    status: { phase: 'Running' },
  })
  // A path that isn't there leaves nothing; what isn't an object gives nothing.
  expect(handed('spec.unschedulable', 'status.nodeInfo.osImage', 'metadata.name.first')).toEqual({})
  for (const value of [null, 'text', 5, [pod]]) {
    expect(picked(value, THING, says({ fields: fields('metadata.name') }), [])).toEqual({})
  }
  // A path and one under it: the shorter has it all, whichever is named first.
  expect(handed('status.phase', 'status')).toEqual({ status: pod.status })
  expect(handed('status', 'status.phase')).toEqual({ status: pod.status })
})

test('a step into a list is taken of each item: its shape kept, and nothing else of an item', () => {
  expect(handed('spec.containers.image', 'spec.containers.name')).toEqual({
    spec: {
      containers: [
        { image: 'shop/cart:1.4', name: 'cart' },
        { image: 'envoy:1.30', name: 'proxy' },
      ],
    },
  })
  expect(handed('spec.containers.ports.containerPort')).toEqual({
    spec: { containers: [{ ports: [{ containerPort: 80 }] }, {}] },
  })
})

test('nothing hands over more than it names: metadata, a spec, a list of containers, a template', () => {
  // (Each of these would carry every annotation, the managed fields, or every container's
  // environment with its values.)
  for (const path of [
    'metadata',
    'metadata.annotations',
    'metadata.managedFields',
    'metadata.managedFields.manager',
    'spec',
    'spec.containers',
    'spec.initContainers',
    'spec.ephemeralContainers',
    'spec.template',
    'spec.jobTemplate',
    'spec.template.spec',
    'spec.template.metadata',
    'spec.template.spec.containers',
  ]) {
    expect(handed(path), path).toEqual({})
  }
  const deployment = {
    spec: {
      template: { metadata: { labels: { app: 'a' } }, spec: { containers: pod.spec.containers } },
    },
  }
  expect(
    picked(
      deployment,
      resolvedAs('example.io', 'Workload'),
      says({
        fields: fields('spec.template.metadata.labels', 'spec.template.spec.containers.image'),
      }),
      [],
    ),
  ).toEqual({
    spec: {
      template: {
        metadata: { labels: { app: 'a' } },
        spec: { containers: [{ image: 'shop/cart:1.4' }, { image: 'envoy:1.30' }] },
      },
    },
  })
})

test('a container’s environment, and a tool’s own annotations, are never handed over, whoever names them', () => {
  // One annotation by its key, yes: but never the object as it was last applied, nor its kin.
  const one = (key: string, groups: string[] = []) =>
    picked(
      pod,
      THING,
      says({
        fields: [
          {
            path: `metadata.annotations["${key}"]`,
            steps: [{ key: 'metadata' }, { key: 'annotations' }, { key }],
          },
        ],
      }),
      groups,
    )
  // On another tool's kind too, an annotation only by a key under one of the plugin's own
  // groups: anyone else's is whatever that tool wrote, often its own copy of the object.
  expect(one('example.com/owner')).toEqual({})
  expect(one('example.com/owner', ['example.com'])).toEqual({
    metadata: { annotations: { 'example.com/owner': 'team-a' } },
  })
  expect(one('kopf.zalando.org/last-handled-configuration')).toEqual({})
  expect(
    one('kubectl.kubernetes.io/last-applied-configuration', ['kubectl.kubernetes.io']),
  ).toEqual({})
  expect(one('kubectl.kubernetes.io/last-applied-configuration')).toEqual({})
  expect(one('control-plane.alpha.kubernetes.io/leader')).toEqual({})
  // The environment: by name, under a name, or inside something handed over whole.
  expect(handed('spec.containers.env')).toEqual({})
  expect(handed('spec.containers.env.value', 'spec.initContainers.env.name')).toEqual({})
  const whole = {
    status: { copied: { env: [{ value: 'hunter2' }], managedFields: ['kubelet'], fine: 1 } },
  }
  expect(picked(whole, THING, says({ fields: fields('status') }), [])).toEqual({
    status: { copied: { fine: 1 } },
  })
  // Every path one could write, together: none of it comes back.
  const everything = handed(
    'metadata',
    'metadata.annotations',
    'metadata.managedFields',
    'spec',
    'spec.containers',
    'spec.containers.env',
    'spec.containers.env.value',
    'spec.initContainers',
    'spec.containers.image',
    'status',
  )
  expect(JSON.stringify(everything)).not.toMatch(SECRETS)
  expect(everything).toEqual({
    spec: { containers: [{ image: 'shop/cart:1.4' }, { image: 'envoy:1.30' }] },
    status: pod.status,
  })
})

test('of Kubernetes’ own kinds, only what’s on Lumovi’s list: nothing else is handed over, whoever names it', () => {
  const realPod = {
    ...pod,
    metadata: {
      ...pod.metadata,
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: 'cart-7d9f',
          uid: 'u-1',
          controller: true,
        },
      ],
      annotations: {
        ...pod.metadata.annotations,
        'karpenter.sh/do-not-disrupt': 'true',
        'kubernetes.io/change-cause':
          'kubectl create secret generic a --from-literal=password=hunter2',
        'kopf.zalando.org/last-handled-configuration': '{"env":"hunter2"}',
        'nginx.ingress.kubernetes.io/configuration-snippet':
          'proxy_set_header Authorization "Bearer hunter2";',
      },
    },
    spec: {
      ...pod.spec,
      containers: pod.spec.containers.map((container) => ({
        ...container,
        args: ['--token=hunter2'],
        command: ['run', '--token=hunter2'],
        resources: { requests: { cpu: '100m' } },
        livenessProbe: {
          httpGet: { httpHeaders: [{ name: 'Authorization', value: 'Bearer hunter2' }] },
        },
        lifecycle: { preStop: { exec: { command: ['curl', '-H', 'X-Token: hunter2'] } } },
      })),
      volumes: [{ name: 'v', csi: { volumeAttributes: { token: 'hunter2' } } }],
    },
    status: {
      ...pod.status,
      conditions: [
        {
          type: 'Ready',
          status: 'False',
          reason: 'ContainersNotReady',
          message: 'containers with unready status: [cart]',
        },
      ],
      containerStatuses: [
        {
          name: 'cart',
          ready: false,
          restartCount: 3,
          lastState: { terminated: { message: 'password=hunter2' } },
        },
      ],
    },
  }
  const of = (...paths: string[]) =>
    picked(realPod, POD, says({ fields: fields(...paths) }), ['karpenter.sh'])
  // Every line of the list, together: what a page of pods needs, and no credential in it.
  const all = of(...READABLE['/Pod']!)
  expect(all).toEqual({
    metadata: {
      name: 'cart-7d9f',
      namespace: 'shop',
      labels: { app: 'cart' },
      ownerReferences: realPod.metadata.ownerReferences,
    },
    spec: {
      nodeName: 'node-1',
      containers: [
        { name: 'cart', image: 'shop/cart:1.4', resources: { requests: { cpu: '100m' } } },
        { name: 'proxy', image: 'envoy:1.30', resources: { requests: { cpu: '100m' } } },
      ],
    },
    status: {
      phase: 'Running',
      conditions: realPod.status.conditions,
      containerStatuses: [{ name: 'cart', ready: false, restartCount: 3 }],
    },
  })
  expect(JSON.stringify(all)).not.toMatch(/hunter2|s3cret/)
  // What isn't on the list, each a place a credential really sits: nothing, one by one and together.
  const off = [
    'metadata.uid',
    'metadata.annotations',
    'spec.containers.args',
    'spec.containers.command',
    'spec.containers.livenessProbe',
    'spec.containers.livenessProbe.httpGet.httpHeaders',
    'spec.containers.lifecycle',
    'spec.containers.ports',
    'spec.volumes',
    'spec.volumes.csi.volumeAttributes',
    'status',
    'status.podIP',
    'status.containerStatuses',
    'status.containerStatuses.lastState',
    'status.containerStatuses.lastState.terminated.message',
    'spec.containers',
    'spec.containers.resources.requests',
    'metadata.labels.app',
  ]
  for (const path of off) expect(of(path), path).toEqual({})
  expect(of(...off)).toEqual({})
  // An annotation: only by a key under one of the plugin's own groups. Nobody else's.
  const annotation = (key: string, groups: string[]) =>
    picked(
      realPod,
      POD,
      says({
        fields: [{ path: key, steps: [{ key: 'metadata' }, { key: 'annotations' }, { key }] }],
      }),
      groups,
    )
  expect(annotation('karpenter.sh/do-not-disrupt', ['karpenter.sh'])).toEqual({
    metadata: { annotations: { 'karpenter.sh/do-not-disrupt': 'true' } },
  })
  for (const key of [
    'example.com/owner',
    'kubernetes.io/change-cause',
    'kopf.zalando.org/last-handled-configuration',
    'nginx.ingress.kubernetes.io/configuration-snippet',
    'kubectl.kubernetes.io/last-applied-configuration',
  ]) {
    expect(annotation(key, ['karpenter.sh']), key).toEqual({})
  }
  // Not by a group that only looks like its own, nor a key with no group; and never kubectl's,
  // even for a plugin that names that group.
  expect(
    annotation('karpenter.sh/do-not-disrupt', ['sh', 'karpenter', 'karpenter.sh.evil.io']),
  ).toEqual({})
  expect(annotation('karpenter.sh/do-not-disrupt', [])).toEqual({})
  expect(
    annotation('kubectl.kubernetes.io/last-applied-configuration', ['kubectl.kubernetes.io']),
  ).toEqual({})
  // A Node's lines, and a kind with no list at all.
  const node = {
    metadata: { name: 'n', labels: { zone: 'a' }, annotations: { a: 'b' } },
    spec: { taints: [], providerID: 'aws:///i-0' },
    status: { capacity: { cpu: '8' }, addresses: [{ address: '10.0.0.1' }] },
  }
  expect(
    picked(
      node,
      NODE,
      says({ fields: fields(...READABLE['/Node']!, 'spec.providerID', 'status.addresses') }),
      [],
    ),
  ).toEqual({
    metadata: { name: 'n', labels: { zone: 'a' } },
    spec: { taints: [] },
    status: { capacity: { cpu: '8' } },
  })
  expect(
    picked(
      { metadata: { name: 'a' } },
      resolvedAs('apps', 'Deployment'),
      says({ fields: fields('metadata.name') }),
      [],
    ),
  ).toEqual({})
  // And `readable` is the one question, for the file checker too.
  expect(readable(POD, parse('.spec.containers.image'), [])).toBe(true)
  expect(readable(POD, parse('.spec.containers.args'), [])).toBe(false)
  expect(readable(POD, parse('.spec.containers[0].image'), [])).toBe(false)
  expect(readable(resolvedAs('', 'pod'), parse('.metadata.name'), [])).toBe(false)
  expect(readable(SECRET, parse('.metadata.name'), [])).toBe(false)
  expect(readable(THING, parse('.metadata.name'), [])).toBe(false)
})

test('what a ConfigMap holds, anything of a Secret, and what isn’t a field’s own name: never', () => {
  const held = {
    metadata: { name: 'a' },
    data: { password: 'hunter2' },
    binaryData: { key: 'aGk=' },
  }
  const all = says({ fields: fields('metadata.name', 'data', 'data.password', 'binaryData') })
  // (A ConfigMap is a kind Lumovi keeps no list for: nothing of it, its name included. And
  // were it another tool's kind of that shape, its data still wouldn't be handed over by name.)
  expect(picked(held, CONFIG_MAP, all, [])).toEqual({})
  expect(picked(held, SECRET, all, [])).toEqual({})
  const odd = says({
    fields: [
      { path: '', steps: [] },
      { path: 'spec.containers[*]', steps: parse('.spec.containers[*]') },
      { path: 'spec.containers[0].image', steps: parse('.spec.containers[0].image') },
      {
        path: 'spec.containers[?(@.name)].image',
        steps: parse('.spec.containers[?(@.name)].image'),
      },
      { path: '__proto__', steps: [{ key: '__proto__' }] },
      { path: 'constructor.name', steps: [{ key: 'constructor' }, { key: 'name' }] },
      { path: 'metadata.toString', steps: [{ key: 'metadata' }, { key: 'toString' }] },
    ],
  })
  expect(picked(pod, THING, odd, [])).toEqual({})
})

test('what’s handed over is a copy: nothing that holds it holds, or can change, what was read', () => {
  const before = JSON.stringify(pod)
  const given = handed('status', 'metadata.labels', 'spec.containers.ports') as {
    status: { phase: string }
    metadata: { labels: Record<string, string> }
  }
  expect(given.status).toEqual(pod.status)
  expect(given.status).not.toBe(pod.status)
  expect(given.metadata.labels).not.toBe(pod.metadata.labels)
  given.status.phase = 'Changed'
  given.metadata.labels.app = 'changed'
  expect(JSON.stringify(pod)).toBe(before)
})

test('a page’s reads are counted: lists kept, everything kept, asks in a second, asks waiting', () => {
  const clock = { now: 0 }
  const plugin = { lists: 0, kept: 0 }
  const reads = () => new PageReads(plugin, () => clock.now)
  const list = (read: number) => ({ read, what: 'list', kind: '/Node' }) as const
  const one = (read: number) => ({ read, what: 'object', kind: '/Node', name: 'a' }) as const
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
  second.close()
  page.close()
  third.close()
  expect(plugin).toEqual({ lists: 0, kept: 0 })

  // Everything kept going, lists or not, answered or not: fifty a page, a hundred a plugin.
  const keeps = [reads(), reads(), reads()]
  let read = 0
  const fill = (page: PageReads, count: number) => {
    for (let i = 0; i < count; i++) {
      if (i % READ_LIMITS.asksASecond === 0) clock.now += 1000
      expect(page.take(one(++read))).toBeUndefined()
      page.answered(read)
    }
  }
  fill(keeps[0]!, READ_LIMITS.keptAPage)
  clock.now += 1000
  expect(keeps[0]!.take(one(++read))).toEqual({
    why: 'too-much',
    what: 'reads a page keeps going: more than 50',
  })
  fill(keeps[1]!, READ_LIMITS.keptAPage)
  clock.now += 1000
  expect(keeps[2]!.take(one(++read))).toEqual({
    why: 'too-much',
    what: 'reads a plugin keeps going: more than 100',
  })
  for (const page of keeps) page.close()
  expect(plugin).toEqual({ lists: 0, kept: 0 })

  // Ten asks a second, by Lumovi's clock; a clock set back starts the second again.
  const fast = new PageReads({ lists: 0, kept: 0 }, () => clock.now)
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
  const slow = new PageReads({ lists: 0, kept: 0 }, () => clock.now)
  let asked = 0
  for (let second = 0; second < 2; second++) {
    clock.now += 1000
    for (let i = 0; i < 10; i++) {
      expect(slow.take({ read: ++asked, what: 'usage', of: 'o_1' })).toBeUndefined()
    }
  }
  clock.now += 1000
  slow.answered(1)
  slow.refused(2)
  expect(slow.take({ read: ++asked, what: 'usage', of: 'o_1' })).toBeUndefined()
  expect(slow.take({ read: ++asked, what: 'usage', of: 'o_1' })).toBeUndefined()
  expect(slow.take({ read: asked + 1, what: 'usage', of: 'o_1' })).toEqual({
    why: 'too-much',
    what: 'asks not yet answered: more than 20',
  })
})

test('a number is new once; and ending a read that’s already ended does nothing, since messages cross', () => {
  const clock = { now: 0 }
  const plugin = { lists: 0, kept: 0 }
  const page = new PageReads(plugin, () => clock.now)
  expect(page.take({ read: 5, what: 'list', kind: '/Node' })).toBeUndefined()
  expect(page.take({ read: 5, what: 'usage', of: 'o_1' })).toMatchObject({ why: 'not-allowed' })
  expect(
    new PageReads(plugin, () => clock.now).take({ read: 7, what: 'usage', of: 'o_1' }),
  ).toBeUndefined()
  // Lumovi refused it; the plugin's own tidying ends it before it has heard: nothing to do.
  const tidy = new PageReads({ lists: 0, kept: 0 }, () => clock.now)
  expect(tidy.take({ read: 1, what: 'list', kind: '/Node' })).toBeUndefined()
  tidy.refused(1)
  expect(tidy.take({ stop: 1 })).toBeUndefined()
  // Ended twice: the same.
  expect(tidy.take({ read: 2, what: 'list', kind: '/Node' })).toBeUndefined()
  expect(tidy.take({ stop: 2 })).toBeUndefined()
  expect(tidy.take({ stop: 2 })).toBeUndefined()
  // Only a read never asked for can't be ended.
  expect(tidy.take({ stop: 3 })).toEqual({
    why: 'not-allowed',
    what: 'ends a read it never asked for',
  })
})

test('a refresh too soon isn’t made, and doesn’t stop the plugin; but it’s one of its second’s asks', () => {
  const clock = { now: 50_000 }
  const page = new PageReads({ lists: 0, kept: 0 }, () => clock.now)
  expect(page.take({ refresh: true })).toBeUndefined()
  clock.now += READ_LIMITS.refreshEveryMs - 1
  expect(page.take({ refresh: true })).toBe('too-soon')
  clock.now += 1
  expect(page.take({ refresh: true })).toBeUndefined()
  // Held down: the eleventh in a second stops the page as any eleventh ask does.
  clock.now += 1000
  for (let i = 0; i < READ_LIMITS.asksASecond; i++)
    expect(page.take({ refresh: true })).toBe('too-soon')
  expect(page.take({ refresh: true })).toMatchObject({ why: 'too-much' })
})
