/**
 * A plugin's reads as the backend makes them: the plugin found among those in use, the kind
 * looked up in what the cluster serves, the grant asked, the read made, and of it what the
 * plugin may have; a refusal as a code. Against a stand-in for the cluster: nothing is built or
 * launched.
 */
import { expect, test } from '@playwright/test'
import type { GetQuery, KubeList, KubeObject, ListQuery, Result } from '../../src/shared/api.ts'
import { parse } from '../../src/shared/jsonpath.ts'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import { KubeRequestError } from '../../src/backend/kube/errors.ts'
import {
  pluginReads,
  SECRET_KEYS_UNDECLARED,
  SECRET_NOT_NAMED,
  secretsAskedFor,
} from '../../src/backend/plugin-reads.ts'
import { READ_REFUSED, type Grant } from '../../src/shared/plugin-reads.ts'
import { ownKinds, parsePlugin } from '../../src/shared/plugins.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'
import { builtinResource, type ResourceDefinition } from '../../src/shared/resources.ts'

const NODE_POOL: ResourceDefinition = {
  kind: 'NodePool.karpenter.sh',
  apiKind: 'NodePool',
  plural: 'nodepools',
  group: 'karpenter.sh',
  version: 'v1',
  namespaced: false,
  label: 'NodePools',
  category: 'cluster',
}
const NODE_CLAIM: ResourceDefinition = {
  ...NODE_POOL,
  kind: 'NodeClaim.karpenter.sh',
  apiKind: 'NodeClaim',
  plural: 'nodeclaims',
  label: 'NodeClaims',
}
const WIDGET: ResourceDefinition = {
  ...NODE_POOL,
  kind: 'Widget.karpenter.sh',
  apiKind: 'Widget',
  plural: 'widgets',
  namespaced: true,
  label: 'Widgets',
}
const SERVED = [NODE_POOL, NODE_CLAIM, WIDGET]

const pool = (name: string): KubeObject =>
  JSON.parse(`{
    "apiVersion": "karpenter.sh/v1",
    "kind": "NodePool",
    "metadata": {
      "name": "${name}",
      "managedFields": [{ "manager": "kubectl" }],
      "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{}" }
    },
    "spec": { "template": { "spec": { "nodeClassRef": { "name": "default" } } } }
  }`)
const node = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'ip-10-0-1-5', labels: { zone: 'a' }, annotations: { secret: 'x' } },
  spec: { providerID: 'aws:///eu-west-1a/i-0abc', taints: [] },
  status: { addresses: [{ address: '10.0.1.5' }], capacity: { cpu: '4' } },
} as unknown as KubeObject

const GRANT: Grant = {
  groups: ['karpenter.sh'],
  own: ['karpenter.sh/NodePool', 'karpenter.sh/Widget'],
  reads: {},
}
/** The digests a page's code was handed with: its file's, and its code's. */
const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'karpenter',
  version: '1.0.0',
  origin: 'lumovi',
  file: 'karpenter.yaml',
  digest: FILE,
  code: 'box.then(() => {})',
  codeDigest: CODE,
  grant: GRANT,
  ...also,
})

/** A stand-in cluster: what it serves, what it answers, and what it was asked. */
function stage(
  known: KnownPlugin[] = [plugin()],
  answers: {
    list?: (q: ListQuery) => Result<KubeList>
    get?: (q: GetQuery) => Result<KubeObject>
  } = {},
) {
  const asked: { list: ListQuery[]; get: GetQuery[] } = { list: [], get: [] }
  const audit: { key: string; input: Recorded }[] = []
  const read = pluginReads({
    kube: {
      resource: async (context, kind) => {
        if (context === 'gone')
          throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6443'), {
            code: 'ECONNREFUSED',
          })
        const found = builtinResource(kind) ?? SERVED.find((r) => r.kind === kind)
        if (!found)
          throw new KubeRequestError('not-found', `${context} doesn’t serve ${kind} resources.`)
        return found
      },
      list: async (q) => {
        asked.list.push(q as ListQuery)
        return (
          answers.list?.(q as ListQuery) ?? {
            ok: true,
            data: { items: [pool('default'), pool('spot')], truncated: false },
          }
        )
      },
      get: async (q) => {
        asked.get.push(q as GetQuery)
        return answers.get?.(q as GetQuery) ?? { ok: true, data: pool((q as GetQuery).name) }
      },
    },
    known: async () => known,
    audit: {
      user: 'me',
      record: () => undefined,
      read: (key, input) => void audit.push({ key, input }),
    },
  })
  return {
    // (A page's reads name what its code was handed with; one that names nothing else is tried
    // as it comes.)
    read: (query: unknown) =>
      read(
        typeof query === 'object' && query !== null && !Object.hasOwn(query, 'digest')
          ? { digest: FILE, codeDigest: CODE, ...query }
          : query,
      ),
    asked,
    audit,
  }
}

test('a plugin reads its own kind whole: as the cluster serves it, with nothing kept for others', async () => {
  const { read, asked, audit } = stage()
  // A kind that's in no namespace is read in none, whatever was asked.
  const result = await read({
    context: 'demo',
    plugin: 'karpenter',
    kind: 'karpenter.sh/NodePool',
    namespace: 'shop',
  })
  expect(asked.list).toEqual([{ context: 'demo', kind: 'NodePool.karpenter.sh' }])
  expect(result).toEqual({
    ok: true,
    answer: {
      kind: 'NodePool.karpenter.sh',
      held: 0,
      objects: ['default', 'spot'].map((name) => ({
        name,
        object: {
          apiVersion: 'karpenter.sh/v1',
          kind: 'NodePool',
          metadata: { name, annotations: {} },
          spec: { template: { spec: { nodeClassRef: { name: 'default' } } } },
        },
      })),
    },
  })
  // In the audit history: the plugin by its name, version and digest, as the backend knows it.
  expect(audit.map(({ input }) => input)).toEqual([
    {
      action: 'plugin.read',
      outcome: 'success',
      cluster: 'demo',
      target: { kind: 'NodePool.karpenter.sh' },
      summary: 'Read NodePools for the plugin karpenter',
      details: { plugin: 'karpenter', pluginVersion: '1.0.0', pluginDigest: FILE },
    },
  ])
  // One object, by its name.
  expect(
    await read({
      context: 'demo',
      plugin: 'karpenter',
      kind: 'karpenter.sh/NodePool',
      name: 'spot',
    }),
  ).toMatchObject({ ok: true, answer: { objects: [{ name: 'spot' }] } })
  expect(asked.get).toEqual([{ context: 'demo', kind: 'NodePool.karpenter.sh', name: 'spot' }])
  expect(audit.at(-1)?.input.summary).toBe('Read NodePool spot for the plugin karpenter')
})

test('one object of a kind that’s in a namespace is asked for in one; a list may be of all it may see', async () => {
  const { read, asked } = stage()
  const widget = { context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/Widget' }
  expect(await read({ ...widget, name: 'w' })).toEqual({ ok: false, refused: 'needs-namespace' })
  expect(asked.get).toEqual([])
  await read({ ...widget, namespace: 'shop', name: 'w' })
  expect(asked.get).toEqual([
    { context: 'demo', kind: 'Widget.karpenter.sh', namespace: 'shop', name: 'w' },
  ])
  await read(widget)
  await read({ ...widget, namespace: 'shop' })
  expect(asked.list).toEqual([
    { context: 'demo', kind: 'Widget.karpenter.sh' },
    { context: 'demo', kind: 'Widget.karpenter.sh', namespace: 'shop' },
  ])
})

test('what its file doesn’t grant isn’t read, however the kind is spelled', async () => {
  const { read, asked, audit } = stage()
  const asking = (kind: string, name?: string) =>
    read({
      context: 'demo',
      plugin: 'karpenter',
      kind,
      ...(name ? { namespace: 'shop', name } : {}),
    })
  // Kubernetes' own: nothing until its file names fields. A Secret: never.
  expect(await asking('/Node')).toEqual({ ok: false, refused: 'not-granted' })
  expect(await asking('/Secret')).toEqual({ ok: false, refused: 'not-granted' })
  expect(await asking('/Secret', 'db')).toEqual({ ok: false, refused: 'not-granted' })
  // A kind of its group it doesn't claim.
  expect(await asking('karpenter.sh/NodeClaim')).toEqual({ ok: false, refused: 'not-granted' })
  // Spellings that name no kind the cluster serves.
  for (const kind of ['core/Secret', 'v1/Secret', 'karpenter.sh/Nodepool', 'apps/Pod']) {
    expect(await asking(kind), kind).toEqual({ ok: false, refused: 'no-such-kind' })
  }
  expect(asked).toEqual({ list: [], get: [] })
  // Each refused, in the audit history.
  expect(
    audit.slice(0, 4).map(({ input }) => [input.outcome, input.error, input.details?.refused]),
  ).toEqual(Array(4).fill(['refused', READ_REFUSED['not-granted'], 'not-granted']))
})

test('a plugin that isn’t in use, or whose code Lumovi doesn’t run, reads nothing', async () => {
  for (const known of [
    [],
    [plugin({ name: 'other' })],
    [plugin({ origin: 'yours' })],
    [plugin({ origin: 'server' })],
  ]) {
    const { read, asked, audit } = stage(known)
    expect(
      await read({ context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool' }),
      JSON.stringify(known),
    ).toEqual({ ok: false, refused: 'not-in-use' })
    expect(asked).toEqual({ list: [], get: [] })
    expect(audit.map(({ input }) => [input.outcome, input.details])).toEqual([
      ['refused', { plugin: 'karpenter', refused: 'not-in-use' }],
    ])
  }
})

test('a name no plugin could have is no read, and nothing of it is recorded', async () => {
  const { read, asked, audit } = stage()
  for (const plugin of ['a\u202Eb', 'x\ny', 'k'.repeat(300), 'Karpenter', '-x', 'karpenter ', '']) {
    expect(
      await read({ context: 'demo', plugin, kind: 'karpenter.sh/NodePool' }),
      JSON.stringify(plugin),
    ).toEqual({ ok: false, refused: 'failed' })
  }
  expect(asked).toEqual({ list: [], get: [] })
  expect(audit).toEqual([])
})

test('plugins not in use, by however many names, are one entry a while in the history', async () => {
  const { read, audit } = stage()
  for (let n = 0; n < 1000; n++) {
    expect(await read({ context: 'demo', plugin: `p${n}`, kind: 'karpenter.sh/NodePool' })).toEqual(
      {
        ok: false,
        refused: 'not-in-use',
      },
    )
  }
  // (The recorder keeps one entry a key a while: what it was asked to keep is what's counted.)
  expect(new Set(audit.map(({ key }) => key)).size).toBe(1)
  expect(audit[0]?.input).toMatchObject({
    outcome: 'refused',
    summary: 'Read NodePool.karpenter.sh for the plugin p0',
    details: { plugin: 'p0', refused: 'not-in-use' },
  })
  // In another cluster, an entry of its own.
  await read({ context: 'other', plugin: 'p0', kind: 'karpenter.sh/NodePool' })
  expect(new Set(audit.map(({ key }) => key)).size).toBe(2)
})

test('a read is made only for the code and the file its page was handed: anything since is changed', async () => {
  const { read, asked, audit } = stage()
  const ask = { context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool' }
  for (const handed of [
    { digest: `sha256:${'b'.repeat(64)}`, codeDigest: CODE },
    { digest: FILE, codeDigest: `sha256:${'d'.repeat(64)}` },
  ]) {
    expect(await read({ ...ask, ...handed }), JSON.stringify(handed)).toEqual({
      ok: false,
      refused: 'changed',
    })
  }
  expect(asked).toEqual({ list: [], get: [] })
  expect(audit.map(({ input }) => [input.outcome, input.details?.refused])).toEqual([
    ['refused', 'changed'],
    ['refused', 'changed'],
  ])
  // A plugin with no code reads nothing, whatever a page says it was handed.
  const { read: none } = stage([plugin({ code: undefined, codeDigest: undefined })])
  expect(await none(ask)).toEqual({ ok: false, refused: 'changed' })
  // And a read that doesn't name both is no read at all.
  for (const missing of [
    { digest: FILE },
    { codeDigest: CODE },
    { digest: 'sha256:abc', codeDigest: CODE },
  ]) {
    expect(
      await read({ ...ask, ...missing, ...('digest' in missing ? {} : { digest: undefined }) }),
      JSON.stringify(missing),
    ).toEqual({
      ok: false,
      refused: 'failed',
    })
  }
})

test('a failure is a code: never what the cluster said', async () => {
  const failing = (code: 'forbidden' | 'not-found' | 'timeout' | 'server' | 'not-allowed') =>
    stage([plugin()], {
      list: () => ({
        ok: false,
        error: {
          code,
          message:
            'nodepools is forbidden: User "alice@example.com" cannot list at https://10.0.0.1:6443',
        },
      }),
      get: () => ({ ok: false, error: { code, message: 'secret value: hunter2' } }),
    })
  const ask = { context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool' }
  for (const [code, refused] of [
    ['forbidden', 'not-allowed'],
    ['not-allowed', 'not-allowed'],
    ['not-found', 'not-found'],
    ['timeout', 'unreachable'],
    ['server', 'failed'],
  ] as const) {
    const { read, audit } = failing(code)
    for (const result of [await read(ask), await read({ ...ask, name: 'default' })]) {
      expect(result, code).toEqual({ ok: false, refused })
    }
    expect(JSON.stringify(audit)).not.toMatch(/alice|10\.0\.0\.1|hunter2/)
  }
  // A cluster that doesn't answer while the kind is looked up.
  const { read } = stage()
  expect(await read({ ...ask, context: 'gone' })).toEqual({ ok: false, refused: 'unreachable' })
})

test('more objects than Lumovi lists at once: none of them, never the first as if they were all', async () => {
  const { read } = stage([plugin()], {
    list: () => ({ ok: true, data: { items: [pool('a')], truncated: true, total: 9000 } }),
  })
  expect(
    await read({ context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool' }),
  ).toEqual({
    ok: false,
    refused: 'too-many',
  })
})

test('of Kubernetes’ own kinds, the fields its file names and no other, picked here', async () => {
  const fields = (...paths: string[]) => paths.map((path) => ({ path, steps: parse(`.${path}`) }))
  const reading: Grant = {
    ...GRANT,
    reads: {
      '/Node': {
        // (The last isn't on Lumovi's list: held back, and counted.)
        fields: fields('metadata.name', 'metadata.labels', 'status.capacity', 'status.addresses'),
        status: false,
        events: false,
        usage: false,
      },
    },
  }
  const { read } = stage([plugin({ grant: reading })], {
    list: () => ({ ok: true, data: { items: [node], truncated: false } }),
  })
  expect(await read({ context: 'demo', plugin: 'karpenter', kind: '/Node' })).toEqual({
    ok: true,
    answer: {
      kind: 'Node',
      held: 1,
      objects: [
        {
          name: 'ip-10-0-1-5',
          object: {
            metadata: { name: 'ip-10-0-1-5', labels: { zone: 'a' } },
            status: { capacity: { cpu: '4' } },
          },
        },
      ],
    },
  })
})

test('Lumovi’s page asks with exactly a read’s keys: anything else is no plugin’s, and isn’t made', async () => {
  const { read, asked, audit } = stage()
  for (const query of [
    undefined,
    { context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool', fieldSelector: 'x' },
    { context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool', name: '../x' },
  ]) {
    expect(await read(query), JSON.stringify(query)).toEqual({ ok: false, refused: 'failed' })
  }
  expect(asked).toEqual({ list: [], get: [] })
  expect(audit).toEqual([])
})

test('a plugin’s own kinds are the ones it claims, in a tool’s group: never one of Kubernetes’', () => {
  const { plugin: parsed, problems } = parsePlugin(
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: karpenter }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [karpenter.sh, karpenter.k8s.aws]
  label: Karpenter
  icon: server
  kinds:
    - { group: karpenter.sh, kind: NodePool }
    - { group: karpenter.sh, kind: NodeClaim }
  views:
    - kinds: [{ group: karpenter.k8s.aws, kind: '*' }]
    - kinds: [{ group: karpenter.sh, kind: NodePool }]
`,
    'karpenter.yaml',
  )
  expect(problems).toEqual([])
  expect(ownKinds(parsed!)).toEqual([
    'karpenter.sh/NodePool',
    'karpenter.sh/NodeClaim',
    'karpenter.k8s.aws/*',
  ])
})

test('the Secrets an object of its own kind names are read from the object as read, not from what’s handed', async () => {
  const showing: Grant = {
    ...GRANT,
    secrets: [
      {
        kind: 'karpenter.sh/Widget',
        path: 'spec.secretName',
        steps: parse('.spec.secretName'),
        keys: ['tls.crt'],
      },
      {
        kind: 'karpenter.sh/NodePool',
        path: 'spec.secretName',
        steps: parse('.spec.secretName'),
        keys: ['x'],
      },
    ],
  }
  const widget = (name: string, spec: object) =>
    ({
      apiVersion: 'karpenter.sh/v1',
      kind: 'Widget',
      metadata: { name, namespace: 'shop' },
      spec,
    }) as KubeObject
  const { read } = stage([plugin({ grant: showing })], {
    list: (q) => ({
      ok: true,
      data: {
        items:
          q.kind !== 'Widget.karpenter.sh'
            ? [pool('default')]
            : [
                widget('a', { secretName: 'shop-tls' }),
                widget('b', {}),
                // Not a Secret's name: none, rather than a name Lumovi would have made up.
                widget('c', { secretName: '../kube-system/admin' }),
              ],
        truncated: false,
      },
    }),
  })
  const result = await read({
    context: 'demo',
    plugin: 'karpenter',
    kind: 'karpenter.sh/Widget',
    namespace: 'shop',
  })
  expect(result.ok && result.answer.objects.map(({ name, secrets }) => [name, secrets])).toEqual([
    ['a', [{ path: 'spec.secretName', keys: ['tls.crt'], names: ['shop-tls'] }]],
    ['b', [{ path: 'spec.secretName', keys: ['tls.crt'], names: [] }]],
    ['c', [{ path: 'spec.secretName', keys: ['tls.crt'], names: [] }]],
  ])
  // Only for the kind the file says it for: none for a NodePool's read here, which has no such field.
  const pools = await read({ context: 'demo', plugin: 'karpenter', kind: 'karpenter.sh/NodePool' })
  expect(pools.ok && pools.answer.objects[0]?.secrets).toEqual([
    { path: 'spec.secretName', keys: ['x'], names: [] },
  ])
})

test('a Secret read for a plugin’s page is that plugin’s, held to the one item, and the object, that named it', async () => {
  const declared = (path: string, keys: string[]) => ({
    kind: 'karpenter.sh/Widget',
    path,
    steps: parse(`.${path}`),
    keys,
  })
  const showing = plugin({
    grant: {
      ...GRANT,
      secrets: [
        declared('spec.secretName', ['tls.crt']),
        declared('spec.caSecretName', ['ca.crt']),
      ],
    },
  })
  const known = async () => [showing, plugin({ name: 'theirs', origin: 'yours' })]
  const asked: GetQuery[] = []
  const kube = {
    resource: async (_: string, kind: string) => {
      const found = SERVED.find((r) => r.kind === kind)
      if (!found) throw new KubeRequestError('not-found', 'no such kind')
      return found
    },
    get: async (q: unknown): Promise<Result<KubeObject>> => {
      asked.push(q as GetQuery)
      return (q as GetQuery).name === 'w1'
        ? {
            ok: true,
            data: {
              apiVersion: 'karpenter.sh/v1',
              kind: 'Widget',
              metadata: { name: 'w1', namespace: 'shop' },
              spec: { secretName: 'shop-tls', caSecretName: 'shop-ca' },
            } as KubeObject,
          }
        : { ok: false, error: { code: 'not-found', message: 'widgets.karpenter.sh "x" not found' } }
    },
  }
  const q = { context: 'demo', namespace: 'shop', name: 'shop-tls', keys: ['tls.crt'] }
  const by = { kind: 'Widget.karpenter.sh', name: 'w1', path: 'spec.secretName' }
  const press = (more: object) =>
    secretsAskedFor({ ...q, forPlugin: 'karpenter', namedBy: by, ...more }, known, kube)
  // Not a plugin's page: the read as it was asked, and nothing else looked at.
  expect(await secretsAskedFor(q, known, kube)).toEqual({ query: q })
  expect(asked).toEqual([])
  // A plugin's: its item's keys, of a Secret the object names there; the read without what was
  // said of the plugin, and the plugin as the backend knows it. The object was read as asked.
  expect(await press({})).toEqual({ query: q, plugin: showing })
  expect(asked).toEqual([
    { context: 'demo', kind: 'Widget.karpenter.sh', namespace: 'shop', name: 'w1' },
  ])
  expect(
    await press({
      name: 'shop-ca',
      keys: ['ca.crt'],
      namedBy: { ...by, path: 'spec.caSecretName' },
    }),
  ).toEqual({ query: { ...q, name: 'shop-ca', keys: ['ca.crt'] }, plugin: showing })
  const refused = (message: string, query: object = q) => ({
    refused: { code: 'not-allowed', message },
    recorded: { query: { ...q, ...query }, plugin: showing },
  })
  // A key another item declares, of the Secret this item named: refused, before it's read.
  expect(await press({ keys: ['ca.crt'] })).toEqual(
    refused(SECRET_KEYS_UNDECLARED, { keys: ['ca.crt'] }),
  )
  expect(await press({ keys: ['tls.crt', 'ca.crt'] })).toEqual(
    refused(SECRET_KEYS_UNDECLARED, { keys: ['tls.crt', 'ca.crt'] }),
  )
  // A path, or a kind, its file doesn't declare.
  expect(await press({ namedBy: { ...by, path: 'spec.other' } })).toEqual(
    refused(SECRET_KEYS_UNDECLARED),
  )
  expect(await press({ namedBy: { ...by, kind: 'NodePool.karpenter.sh' } })).toEqual(
    refused(SECRET_KEYS_UNDECLARED),
  )
  // A Secret the object doesn't name there (another item's, or none), or an object not there.
  for (const [more, query] of [
    [{ name: 'shop-ca' }, { name: 'shop-ca' }],
    [{ name: 'someone-else' }, { name: 'someone-else' }],
    [{ namedBy: { ...by, name: 'gone' } }, {}],
  ] as const) {
    expect(await press(more), JSON.stringify(more)).toEqual(refused(SECRET_NOT_NAMED, query))
  }
  // What named it isn't said, or isn't what one could be: no read at all.
  for (const namedBy of [
    undefined,
    'w1',
    { ...by, name: '../w1' },
    { ...by, kind: '../Widget' },
    { ...by, more: 1 },
  ]) {
    expect(await press({ namedBy }), JSON.stringify(namedBy)).toEqual({
      refused: { code: 'invalid', message: 'Expected a Secret, its keys and what named it' },
    })
  }
  // A name no plugin could have; a plugin not in use, or whose code Lumovi doesn't run.
  for (const forPlugin of ['Karpenter', 'a\u202Eb', 7, '']) {
    expect(await press({ forPlugin }), String(forPlugin)).toEqual({
      refused: { code: 'invalid', message: 'Expected a plugin’s name' },
    })
  }
  for (const forPlugin of ['nobody', 'theirs']) {
    expect(await press({ forPlugin }), forPlugin).toEqual({
      refused: { code: 'not-allowed', message: READ_REFUSED['not-in-use'] },
    })
  }
})
