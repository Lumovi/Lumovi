/**
 * A plugin's tool's own server (`spec.server`): what its file may list, what its code may ask at
 * the door, and the ask as the backend makes it: the policy, the plugin and its code, its file's
 * server and the objects' kinds, the path as listed, the Service and its port, then the path
 * through the API server's service proxy, and only JSON back. Against a stand-in for the
 * cluster: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import type { GetQuery, KubeObject, ListQuery, Result } from '../../src/shared/api.ts'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import type { ProxyAnswer } from '../../src/backend/kube/client.ts'
import { pluginServer } from '../../src/backend/plugin-server.ts'
import type { CodeSwitches } from '../../src/shared/plugin-hand-over.ts'
import { PageReads, readAsk, type Grant } from '../../src/shared/plugin-reads.ts'
import {
  filled,
  fillsOf,
  pathProblem,
  serverQuery,
  SERVER_LIMITS,
  type PluginServer,
} from '../../src/shared/plugin-server.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'

test('a listed path is asked for as it reads: whole segments, filled ones whole, nothing to step out', () => {
  for (const path of [
    '/api/v1/targets',
    '/api/v1/widgets/{widget}/history',
    '/v1/a:b@c',
    '/x',
    '/api/v1/targets?state=active',
    '/api/v1/widgets/{widget}?a=1&b=two/three',
  ]) {
    expect(pathProblem(path), path).toBeUndefined()
  }
  for (const [path, problem] of [
    ['api/v1', 'should start with /'],
    [`/${'a'.repeat(SERVER_LIMITS.pathLength)}`, 'is longer than 200 characters'],
    ['/api#top', 'takes no fragment: Lumovi asks for the path as listed'],
    ['/api?x=1#top', 'takes no fragment: Lumovi asks for the path as listed'],
    // A fixed query, asked as listed: never filled, never empty, never escaped.
    ['/api?', 'has an empty query'],
    ['/api?x={widget}', 'fills nothing in its query: Lumovi asks for it as listed'],
    ['/api?x=a b', 'has U+0020 in its query, which a query can’t hold as it is'],
    ['/api?x=%41', 'has a %-escape: write it as it reads, and Lumovi encodes what it fills'],
    ['/a/../b?x=1', 'can’t step with . or ..'],
    ['/a%2Fb', 'has a %-escape: write it as it reads, and Lumovi encodes what it fills'],
    ['/a//b', 'has an empty segment'],
    ['/a/', 'has an empty segment'],
    ['/a/../secrets', 'can’t step with . or ..'],
    ['/a/./b', 'can’t step with . or ..'],
    ['/a/v{x}', 'fills only a whole segment, as /a/{name}/b'],
    ['/a/{x}.json', 'fills only a whole segment, as /a/{name}/b'],
    ['/a/{X}', 'fills only a whole segment, as /a/{name}/b'],
    ['/a/{x}/b/{x}', 'fills {x} once'],
    ['/{a}/{b}/{c}/{d}/{e}', 'fills more than 4 segments'],
    ['/a\\b', 'has “\\”, which a path can’t hold as it is'],
    // (One nobody sees, or that turns a line round, as its code point: the line reads as written.)
    ['/a b', 'has U+0020, which a path can’t hold as it is'],
    ['/a\u202eb', 'has U+202E, which a path can’t hold as it is'],
    ['/a\u200bb', 'has U+200B, which a path can’t hold as it is'],
    ['/caf\u00e9', 'has U+00E9, which a path can’t hold as it is'],
    ['/a\u{1f600}', 'has U+1F600, which a path can’t hold as it is'],
  ] as const) {
    expect(pathProblem(path), path).toBe(problem)
  }
  expect(fillsOf('/a/{widget}/b/{part}')).toEqual(['widget', 'part'])
  expect(fillsOf('/a/{widget}?b=c')).toEqual(['widget'])
})

test('a filled path takes objects’ names, encoded, and only names an object could have', () => {
  expect(filled('/w/{widget}/h', { widget: 'blue-widget' })).toBe('/w/blue-widget/h')
  expect(filled('/w/{widget}', { widget: 'a.b' })).toBe('/w/a.b')
  expect(filled('/status', {})).toBe('/status')
  // (A fixed query, as listed.)
  expect(filled('/w/{widget}?state=active', { widget: 'blue-widget' })).toBe(
    '/w/blue-widget?state=active',
  )
  const wrong: Record<string, string>[] = [
    {},
    { widget: '..' },
    { widget: '.' },
    { widget: 'a/b' },
    { widget: '%2e%2e' },
    { widget: 'A' },
    { widget: 'blue', other: 'x' },
    { other: 'blue' },
  ]
  for (const names of wrong) {
    expect(filled('/w/{widget}', names), JSON.stringify(names)).toBeUndefined()
  }
})

/** A plugin with pages, its own Widgets, and what its file says of its server. */
const file = (server: string | undefined, carriesCode = true) =>
  parsePlugin(
    [
      'apiVersion: lumovi.dev/v1beta1',
      'kind: Plugin',
      'metadata: { name: toys }',
      'spec:',
      '  version: 1.2.0',
      '  needs: { lumovi: 1.0.0 }',
      '  groups: [example.com]',
      '  label: Toys',
      '  kinds: [{ group: example.com, kind: Widget }]',
      '  pages: [{ id: overview, title: Overview }]',
      ...(server === undefined ? [] : [`  server: ${server}`]),
    ].join('\n'),
    'toys.yaml',
    { lumovisOwn: [], carriesCode },
  )

test('a file says which Service, where, which port and which paths; anything else is refused', () => {
  const byName =
    '{ service: { name: toys-api }, in: { group: example.com, kind: Widget }, port: http, paths: [/api/v1/status, "/api/v1/widgets/{widget}/history"] }'
  expect(file(byName).problems).toEqual([])
  expect(file(byName).plugin!.server).toEqual({
    service: { name: 'toys-api' },
    in: 'Widget.example.com',
    port: 'http',
    paths: ['/api/v1/status', '/api/v1/widgets/{widget}/history'],
  } satisfies PluginServer)
  const byLabels =
    '{ service: { labels: { app.kubernetes.io/name: toys-api } }, in: { group: example.com, kind: Widget }, port: 8080, paths: [/x] }'
  expect(file(byLabels).problems).toEqual([])
  expect(file(byLabels).plugin!.server!.service).toEqual({
    labels: { 'app.kubernetes.io/name': 'toys-api' },
  })
  // Only a plugin that comes with Lumovi: a folder's file has no code.
  expect(file(byName, false).problems).toContain(
    'toys.yaml: spec.server: a plugin of yours draws pages only from a folder of its own, for Developer mode: toys/plugin.yaml, with its plugin.js',
  )
  const IN = 'in: { group: example.com, kind: Widget }'
  for (const [server, problem] of [
    ['toys', 'spec.server: should be a map of service, in, port and paths, not a string'],
    [
      `{ service: { name: toys-api }, ${IN}, port: http, paths: [/x], url: "http://x" }`,
      'spec.server.url: isn’t something a server has',
    ],
    [
      `{ ${IN}, port: http, paths: [/x] }`,
      'spec.server.service: is needed: the Service, by its name or by its labels',
    ],
    [
      `{ service: { name: a, labels: { a: b } }, ${IN}, port: http, paths: [/x] }`,
      'spec.server.service: should have a name or labels, one of the two',
    ],
    [
      `{ service: { name: Toys_API }, ${IN}, port: http, paths: [/x] }`,
      'spec.server.service.name: should be a Service’s name, not a string',
    ],
    [
      `{ service: { labels: {} }, ${IN}, port: http, paths: [/x] }`,
      'spec.server.service.labels: should name at least one label',
    ],
    [
      `{ service: { labels: { "a b": c } }, ${IN}, port: http, paths: [/x] }`,
      'spec.server.service.labels: a b isn’t a label’s key',
    ],
    [
      '{ service: { name: toys-api }, port: http, paths: [/x] }',
      'spec.server.in: is needed: the kind of the objects whose namespace the Service is in',
    ],
    [
      '{ service: { name: toys-api }, in: { group: "", kind: Pod }, port: http, paths: [/x] }',
      'spec.server.in: should be one of its own kinds, and Pod isn’t',
    ],
    [
      '{ service: { name: toys-api }, in: { group: example.com, kind: "*" }, port: http, paths: [/x] }',
      'spec.server.in: should be one of its own kinds, and *.example.com isn’t',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, paths: [/x] }`,
      'spec.server.port: is needed: a port the Service declares, by its name or number',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: 70000, paths: [/x] }`,
      'spec.server.port: should be a port’s name or number, not a number',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: HTTP, paths: [/x] }`,
      'spec.server.port: should be a port’s name or number, not a string',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: http }`,
      'spec.server.paths: is needed: the paths its code may ask for',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: http, paths: [] }`,
      'spec.server.paths: should be a list of paths, not a list',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: http, paths: [/x, /x] }`,
      'spec.server.paths[1]: is listed once',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: http, paths: [/x, "/../y"] }`,
      'spec.server.paths[1]: can’t step with . or ..',
    ],
    [
      `{ service: { name: toys-api }, ${IN}, port: http, paths: [${Array.from({ length: 21 }, (_, i) => `/p${i}`).join(', ')}] }`,
      'spec.server.paths: should be at most 20 paths',
    ],
  ] as const) {
    expect(file(server).problems, server).toEqual([`toys.yaml: ${problem}`])
  }
})

test('an ask of its server names objects by token and a path; anything else stops the plugin', () => {
  for (const ask of [
    { read: 1, what: 'server', in: 'o_1', path: '/api/v1/status' },
    { read: 2, what: 'server', in: 'o_1', path: '/w/{widget}', with: { widget: 'o_2' } },
  ]) {
    expect(readAsk(JSON.parse(JSON.stringify(ask))), JSON.stringify(ask)).toEqual(ask)
  }
  for (const ask of [
    { read: 1, what: 'server', path: '/x' },
    { read: 1, what: 'server', in: { kind: 'Widget', name: 'a' }, path: '/x' },
    { read: 1, what: 'server', in: 'o_1' },
    { read: 1, what: 'server', in: 'o_1', path: 'x' },
    { read: 1, what: 'server', in: 'o_1', path: `/${'a'.repeat(200)}` },
    { read: 1, what: 'server', in: 'o_1', path: '/x', url: 'http://evil' },
    { read: 1, what: 'server', in: 'o_1', path: '/x', with: {} },
    { read: 1, what: 'server', in: 'o_1', path: '/x', with: { w: 'blue-widget/../x' } },
    { read: 1, what: 'server', in: 'o_1', path: '/x', with: { W: 'o_2' } },
    {
      read: 1,
      what: 'server',
      in: 'o_1',
      path: '/x',
      with: { a: 'o_1', b: 'o_1', c: 'o_1', d: 'o_1', e: 'o_1' },
    },
  ]) {
    expect(readAsk(ask), JSON.stringify(ask)).toMatchObject({ why: 'not-allowed' })
  }
})

test('a page asks its server two at a time; a third stops it, and an answered one makes room', () => {
  const counted = { lists: 0, kept: 0 }
  const page = new PageReads(counted, () => 0)
  const ask = (read: number) => ({ read, what: 'server' as const, in: 'o_1', path: '/x' })
  expect(page.take(ask(1))).toBeUndefined()
  expect(page.take(ask(2))).toBeUndefined()
  expect(page.take(ask(3))).toEqual({
    why: 'too-much',
    what: 'asks of its server not yet answered: more than 2',
  })
  const again = new PageReads({ lists: 0, kept: 0 }, () => 0)
  again.take(ask(1))
  again.take(ask(2))
  again.over(1)
  expect(again.take(ask(3))).toBeUndefined()
})

test('Lumovi’s page asks the backend with exactly an ask’s keys: anything else isn’t one', () => {
  const ask = {
    context: 'demo',
    plugin: 'toys',
    digest: 'sha256:a',
    codeDigest: 'sha256:c',
    in: { kind: 'Widget.example.com', namespace: 'default', name: 'blue-widget' },
    path: '/x',
  }
  expect(serverQuery(ask)).toEqual(ask)
  for (const wrong of [
    null,
    { ...ask, url: 'http://x' },
    { ...ask, path: '' },
    { ...ask, in: { ...ask.in, name: '../x' } },
    { ...ask, in: { ...ask.in, extra: 1 } },
    { ...ask, with: { w: { kind: 'Widget.example.com', name: 'A' } } },
    { ...ask, with: [] },
    { ...ask, digest: undefined },
  ]) {
    expect(serverQuery(wrong), JSON.stringify(wrong)).toBeUndefined()
  }
})

const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const GRANT: Grant = { groups: ['example.com'], own: ['example.com/Widget'], reads: {} }
const SERVER: PluginServer = {
  service: { name: 'toys-api' },
  in: 'Widget.example.com',
  port: 'http',
  paths: ['/api/v1/status', '/api/v1/widgets/{widget}/history'],
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
  server: SERVER,
  ...also,
})
const WIDGET = { kind: 'Widget.example.com', namespace: 'default', name: 'blue-widget' }
const ASK = {
  context: 'demo',
  plugin: 'toys',
  digest: FILE,
  codeDigest: CODE,
  in: WIDGET,
  path: '/api/v1/status',
}
const service = (name: string, ports = [{ name: 'http', port: 8080 }]): KubeObject =>
  ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: 'default' },
    spec: { ports },
  }) as KubeObject

/** A stand-in cluster: its Services, what the server answers, and what it was asked. */
function stage(
  known: KnownPlugin[] = [plugin()],
  answer: () => Result<ProxyAnswer> = () => ({
    ok: true,
    data: { status: 200, type: 'application/json', body: '{"healthy":true}' },
  }),
  options: { services?: KubeObject[]; switches?: CodeSwitches } = {},
) {
  const services = options.services ?? [service('toys-api')]
  const asked: { get: GetQuery[]; list: ListQuery[]; proxy: unknown[] } = {
    get: [],
    list: [],
    proxy: [],
  }
  const audit: Recorded[] = []
  /** How each entry was kept: by a key, once a while; or with none, every time. */
  const keys: string[] = []
  const kept = (key: string, input: Recorded) => {
    keys.push(key)
    audit.push(input)
  }
  const ask = pluginServer({
    kube: {
      get: async (q) => {
        asked.get.push(q as GetQuery)
        const found = services.find((s) => s.metadata.name === (q as GetQuery).name)
        return found
          ? { ok: true, data: found }
          : { ok: false, error: { code: 'not-found', message: 'services "x" not found' } }
      },
      list: async (q) => {
        asked.list.push(q as ListQuery)
        return { ok: true, data: { items: services, truncated: false } }
      },
      serviceProxy: async (q) => {
        asked.proxy.push(q)
        return answer()
      },
    },
    known: async () => known,
    to: () => ({ host: 'desktop', switches: options.switches ?? { chosen: {} } }),
    // (What it's asked to write, each with what makes it the same entry, and a place for every
    // ask: what a plugin's pages are held to has tests of its own, in plugin-history.)
    audit: {
      take: () => ({ record: kept }),
      unknown: kept,
      stop: () => undefined,
    },
  })
  return { ask, asked, audit, keys }
}

test('a listed path of its Service, in the namespace of its own kind’s object: asked through the API server, and the JSON handed back', async () => {
  const { ask, asked, audit } = stage()
  expect(await ask(ASK)).toEqual({ ok: true, json: { healthy: true } })
  expect(asked.get).toEqual([
    { context: 'demo', kind: 'Service', namespace: 'default', name: 'toys-api' },
  ])
  expect(asked.proxy).toEqual([
    {
      context: 'demo',
      namespace: 'default',
      service: 'toys-api',
      port: 'http',
      path: '/api/v1/status',
    },
  ])
  expect(audit).toEqual([
    {
      action: 'plugin.server',
      outcome: 'success',
      cluster: 'demo',
      target: { kind: 'Service', name: 'toys-api', namespace: 'default' },
      summary:
        'Asked the Service toys-api in default for /api/v1/status, for the plugin Toys’ page',
      command:
        'kubectl get --raw /api/v1/namespaces/default/services/toys-api:http/proxy/api/v1/status --context demo',
      details: {
        plugin: 'toys',
        pluginVersion: '1.2.0',
        pluginDigest: FILE,
        codeDigest: CODE,
        path: '/api/v1/status',
        listed: '/api/v1/status',
        port: 'http',
        status: 200,
        bytes: 16,
      },
    },
  ])
  // A segment it fills: with the name of an object of its own kind, encoded; the history's
  // summary names the path as listed, and its details both.
  await ask({ ...ASK, path: '/api/v1/widgets/{widget}/history', with: { widget: WIDGET } })
  expect(asked.proxy[1]).toMatchObject({ path: '/api/v1/widgets/blue-widget/history' })
  expect(audit[1]).toMatchObject({
    summary:
      'Asked the Service toys-api in default for /api/v1/widgets/{widget}/history, for the plugin Toys’ page',
    details: {
      path: '/api/v1/widgets/blue-widget/history',
      listed: '/api/v1/widgets/{widget}/history',
    },
  })
})

test('refused in turn, before anything is asked of the cluster: the policy, the plugin, its code, its file', async () => {
  const pod = { kind: 'Pod', namespace: 'default', name: 'a' }
  for (const [known, ask, refused, switches] of [
    [[plugin()], ASK, 'servers-off', { serversOff: true, chosen: {} }],
    [[], ASK, 'not-in-use'],
    [[plugin({ origin: 'yours' })], ASK, 'not-in-use'],
    [[plugin({ code: undefined, codeDigest: undefined })], ASK, 'not-in-use'],
    [[plugin()], { ...ASK, digest: `sha256:${'b'.repeat(64)}` }, 'changed'],
    [[plugin()], ASK, 'code-off', { chosen: { toys: false } }],
    [[plugin({ server: undefined })], ASK, 'not-granted'],
    [[plugin()], { ...ASK, in: pod }, 'not-granted'],
    [[plugin()], { ...ASK, in: { ...WIDGET, namespace: undefined } }, 'not-granted'],
    [[plugin()], { ...ASK, path: '/api/v1/secrets' }, 'not-listed'],
    [[plugin()], { ...ASK, path: '/api/v1/widgets/{widget}/history' }, 'not-granted'],
    [
      [plugin()],
      { ...ASK, path: '/api/v1/widgets/{widget}/history', with: { widget: pod } },
      'not-granted',
    ],
  ] as const) {
    const {
      ask: asking,
      asked,
      audit,
    } = stage([...known], undefined, {
      ...(switches ? { switches } : {}),
    })
    const answer = await asking(ask)
    expect(answer, refused).toMatchObject({ ok: false, refused })
    expect(asked, refused).toEqual({ get: [], list: [], proxy: [] })
    expect(audit.map((entry) => entry.details?.refused)).toEqual([refused])
  }
  // The policy's sentence, the same everywhere.
  const { ask } = stage([plugin()], undefined, { switches: { serversOff: true, chosen: {} } })
  expect(await ask(ASK)).toEqual({
    ok: false,
    refused: 'servers-off',
    said: 'Your organization’s policy doesn’t let plugins talk to servers in the cluster.',
  })
})

test('a path as a page wrote it is in no entry until its file lists it, and refusals are one entry a while whatever is asked for', async () => {
  const pod = { kind: 'Pod', namespace: 'default', name: 'a' }
  const written = `/WRITTEN-BY-THE-PAGE ${'x'.repeat(150)}`
  // Refused before its path is known to be one its file lists: no server in its file, a path
  // that isn't listed, an object that isn't its own kind's.
  for (const [known, ask, refused] of [
    [[plugin({ server: undefined })], { ...ASK, path: written }, 'not-granted'],
    [[plugin()], { ...ASK, path: written }, 'not-listed'],
    [[plugin()], { ...ASK, in: pod, path: written }, 'not-granted'],
  ] as const) {
    const { ask: asking, audit, keys } = stage([...known])
    expect(await asking(ask), refused).toMatchObject({ ok: false, refused })
    expect(audit, refused).toHaveLength(1)
    // Lumovi's own words for it, and nothing the page wrote: not in its summary, not anywhere.
    expect(audit[0]!.summary, refused).toContain('for a path its file doesn’t list, for the plugin')
    expect(audit[0]!.details?.listed, refused).toBeUndefined()
    expect(JSON.stringify(audit), refused).not.toContain('WRITTEN-BY-THE-PAGE')
    // Kept once a while, by the cluster, the plugin and the refusal: the same key whatever the
    // page asks for.
    expect(keys, refused).toEqual([`plugin-server:${JSON.stringify(['demo', 'toys', refused])}`])
  }
  const refusing = stage([plugin({ server: undefined })])
  for (const path of ['/one', '/two', `/${'three '.repeat(20)}`]) {
    await refusing.ask({ ...ASK, path })
  }
  expect(new Set(refusing.keys).size).toBe(1)
  // A path its file lists that then fails (no such Service): its listed path is in the entry,
  // and it's still one entry a while.
  const failing = stage([plugin()], undefined, { services: [] })
  expect(await failing.ask(ASK)).toMatchObject({ ok: false, refused: 'no-service' })
  expect(failing.audit[0]!.details?.listed).toBe(ASK.path)
  expect(failing.keys).toEqual([`plugin-server:${JSON.stringify(['demo', 'toys', 'no-service'])}`])
  // An ask that's made is one entry a while for the same Service and path, as a page asks again
  // to keep what it shows up to date; with the path as its file lists it.
  const made = stage()
  expect(await made.ask(ASK)).toMatchObject({ ok: true })
  expect(await made.ask(ASK)).toMatchObject({ ok: true })
  const same = `plugin-server:${JSON.stringify(['demo', 'toys', 'default', 'toys-api', ASK.path])}`
  expect(made.keys).toEqual([same, same])
  expect(made.audit.map((entry) => entry.details?.listed)).toEqual([ASK.path, ASK.path])
  expect(made.audit[0]!.summary).toContain(`for ${ASK.path}, for the plugin`)
  // Another path of its Service, or the same path filled with another object's name: its own.
  const filled = { ...ASK, path: '/api/v1/widgets/{widget}/history' }
  for (const name of ['w1', 'w2', 'w1']) {
    expect(await made.ask({ ...filled, with: { widget: { ...WIDGET, name } } })).toMatchObject({
      ok: true,
    })
  }
  expect(new Set(made.keys).size).toBe(3)
})

test('the Service by its name, or the one with its labels, and a port it declares: or Lumovi’s sentence why not', async () => {
  const labels: PluginServer = { ...SERVER, service: { labels: { app: 'toys' } } }
  for (const [server, services, said] of [
    [SERVER, [], 'There’s no Service toys-api in default.'],
    [labels, [], 'No Service in default has those labels.'],
    [
      labels,
      [service('a'), service('b')],
      'More than one Service in default has those labels, so Lumovi asked none.',
    ],
    [
      SERVER,
      [service('toys-api', [{ name: 'web', port: 9090 }])],
      'The Service toys-api has no port http.',
    ],
  ] as const) {
    const { ask, asked } = stage([plugin({ server })], undefined, { services: [...services] })
    expect(await ask(ASK), said).toMatchObject({ ok: false, said })
    expect(asked.proxy).toEqual([])
  }
  // By labels: the one there is, by its name; a port by its number does too.
  const { ask, asked } = stage([plugin({ server: { ...labels, port: 8080 } })], undefined, {
    services: [service('toys-api-7')],
  })
  expect(await ask(ASK)).toMatchObject({ ok: true })
  expect(asked.list).toEqual([
    { context: 'demo', kind: 'Service', namespace: 'default', labelSelector: 'app=toys' },
  ])
  expect(asked.proxy[0]).toMatchObject({ service: 'toys-api-7', port: 8080 })
})

test('only JSON comes back: never its words, an error’s text, a redirect, a web page, or too much', async () => {
  const answered = (data: ProxyAnswer) => () => ({ ok: true as const, data })
  for (const [answer, refused, said] of [
    [
      answered({
        status: 403,
        type: 'application/json',
        body: '{"kind":"Status","reason":"Forbidden","message":"User \\"alice\\" cannot get services/proxy"}',
      }),
      'not-allowed',
      'You may not reach toys-api in default: it takes get on services/proxy.',
    ],
    [
      answered({ status: 403, type: 'application/json', body: '{"error":"go away"}' }),
      'error',
      'toys-api answered 403.',
    ],
    [
      answered({ status: 418, type: 'application/json', body: '{"error":"teapot, token=abc"}' }),
      'error',
      'toys-api answered 418.',
    ],
    [answered({ status: 302, type: 'text/html', body: '' }), 'error', 'toys-api answered 302.'],
    [
      answered({ status: 200, type: 'text/html', body: '<html>' }),
      'not-json',
      'toys-api answered with something other than JSON.',
    ],
    [
      answered({ status: 200, type: 'application/json', body: '{"a":' }),
      'not-json',
      'toys-api answered with something other than JSON.',
    ],
    [
      answered({
        status: 200,
        type: 'application/json',
        body: `${'['.repeat(80)}${']'.repeat(80)}`,
      }),
      'not-json',
      'toys-api answered with something other than JSON.',
    ],
    [answered({ tooBig: true }), 'too-big', 'toys-api answered with more than 1 MiB.'],
    [
      () => ({
        ok: false as const,
        error: { code: 'timeout' as const, message: 'It didn’t answer within 5s' },
      }),
      'timeout',
      'toys-api didn’t answer in 5 seconds.',
    ],
  ] as const) {
    const { ask, audit } = stage([plugin()], answer)
    expect(await ask(ASK), refused).toEqual({ ok: false, refused, said })
    expect(JSON.stringify(audit), refused).not.toMatch(/alice|teapot|token=abc|go away/)
  }
  // JSON by any of its names.
  const { ask } = stage(
    [plugin()],
    answered({ status: 200, type: 'application/problem+json', body: '[]' }),
  )
  expect(await ask(ASK)).toEqual({ ok: true, json: [] })
})

test('in the tests’ build alone, a test can lengthen Lumovi’s wait for a tool’s server: never shorten it, never past two minutes', async () => {
  const tests = globalThis as { LUMOVI_TEST_BUILD?: boolean }
  tests.LUMOVI_TEST_BUILD = true
  const { serverWaitMs } = await import('../../src/backend/kube/service.ts')
  const wait = (set?: string) =>
    serverWaitMs(set === undefined ? {} : { LUMOVI_TEST_PLUGIN_SERVER_WAIT_MS: set })
  expect(wait()).toBe(SERVER_LIMITS.timeoutMs)
  expect(wait('60000')).toBe(60_000)
  // Never shorter than Lumovi's own limit, never past two minutes, and nothing else is a wait.
  for (const set of [
    '1',
    '0',
    '-1',
    String(SERVER_LIMITS.timeoutMs),
    '',
    'soon',
    'Infinity',
    'NaN',
  ]) {
    expect(wait(set), set).toBe(SERVER_LIMITS.timeoutMs)
  }
  expect(wait('120001')).toBe(120_000)
  expect(wait('9999999999')).toBe(120_000)
  // In a release there's no such switch.
  tests.LUMOVI_TEST_BUILD = false
  expect(wait('60000')).toBe(SERVER_LIMITS.timeoutMs)
})
