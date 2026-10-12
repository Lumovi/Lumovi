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
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'karpenter',
  version: '1.0.0',
  origin: 'lumovi',
  file: 'karpenter.yaml',
  digest: 'sha256:abc',
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
  return { read, asked, audit }
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
      details: { plugin: 'karpenter', pluginVersion: '1.0.0', pluginDigest: 'sha256:abc' },
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

test('a Secret read for a plugin’s page is that plugin’s, as the backend knows it, and of keys its file declares', async () => {
  const showing = plugin({
    grant: {
      ...GRANT,
      secrets: [
        {
          kind: 'karpenter.sh/Widget',
          path: 'spec.secretName',
          steps: parse('.spec.secretName'),
          keys: ['tls.crt', 'ca.crt'],
        },
      ],
    },
  })
  const known = async () => [showing, plugin({ name: 'theirs', origin: 'yours' })]
  const q = { context: 'demo', namespace: 'shop', name: 'shop-tls', keys: ['tls.crt'] }
  // Not a plugin's page: the read as it was asked.
  expect(await secretsAskedFor(q, known)).toEqual({ query: q })
  // A plugin's: the read without the plugin's name, and the plugin as the backend knows it.
  expect(await secretsAskedFor({ ...q, forPlugin: 'karpenter' }, known)).toEqual({
    query: q,
    plugin: showing,
  })
  // A name no plugin could have; a plugin not in use, or whose code Lumovi doesn't run.
  for (const forPlugin of ['Karpenter', 'a‮b', 7, '']) {
    expect(await secretsAskedFor({ ...q, forPlugin }, known), String(forPlugin)).toEqual({
      refused: { code: 'invalid', message: 'Expected a plugin’s name' },
    })
  }
  for (const forPlugin of ['nobody', 'theirs']) {
    expect(await secretsAskedFor({ ...q, forPlugin }, known), forPlugin).toEqual({
      refused: { code: 'not-allowed', message: READ_REFUSED['not-in-use'] },
    })
  }
  // A key its file doesn't say its pages show: refused, and recorded with the plugin...
  expect(
    await secretsAskedFor({ ...q, keys: ['tls.crt', 'tls.key'], forPlugin: 'karpenter' }, known),
  ).toEqual({
    refused: { code: 'not-allowed', message: SECRET_KEYS_UNDECLARED },
    recorded: { query: { ...q, keys: ['tls.crt', 'tls.key'] }, plugin: showing },
  })
  // ...but only where the Secret's name is one a Secret could have.
  expect(
    await secretsAskedFor(
      { ...q, name: 'shop-tls\nforged line', keys: ['tls.key'], forPlugin: 'karpenter' },
      known,
    ),
  ).toEqual({ refused: { code: 'not-allowed', message: SECRET_KEYS_UNDECLARED } })
})
