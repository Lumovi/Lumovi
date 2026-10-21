/**
 * Names and namespaces of one object on a server (tests/e2e/object-names.ts): what Kubernetes
 * wouldn't accept is refused by every call that takes one, in Lumovi's words, before the cluster
 * is asked; the longest and oddest it does accept work as any other. And a read whose answer
 * isn't the one object asked for (a list, say) is refused, and nothing of that answer reaches the
 * page. No value is in a title, an expectation or the output: marks are made as the test runs,
 * and a check says only whether one was found.
 */
import { randomBytes } from 'node:crypto'
import { KubeConfig } from '@kubernetes/client-node'
import { serverUrl } from '../../src/backend/kube/client.ts'
import { podSocket } from '../../src/backend/kube/streams.ts'
import {
  askedOfTheCluster,
  asked,
  NAMESPACE_REFUSED,
  NOBODY,
  NOT_NAMESPACES,
  notNamesFor,
  ODDLY_NAMED,
  oddlyAsked,
  refusedFor,
  SERVER_CALLS,
  TAKES_NAME,
  TAKES_NAMESPACE,
  WHERE,
} from '../e2e/object-names.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { as } from './fleet.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

test('a name or a namespace Kubernetes wouldn’t accept is refused by every call that takes one, in Lumovi’s words, and the cluster isn’t asked', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const before = clusters.demo.requests.length
  const said: string[] = []
  const expected: string[] = []
  for (const call of SERVER_CALLS) {
    if (TAKES_NAME.includes(call)) {
      for (const name of notNamesFor(call)) {
        said.push(`${call} ${JSON.stringify(name)}: ${await asked(page, call, name, WHERE)}`)
        expected.push(`${call} ${JSON.stringify(name)}: ${refusedFor(call)}`)
      }
    }
    if (TAKES_NAMESPACE.includes(call)) {
      for (const namespace of NOT_NAMESPACES) {
        said.push(
          `${call} in ${JSON.stringify(namespace)}: ${await asked(page, call, NOBODY, namespace)}`,
        )
        expected.push(`${call} in ${JSON.stringify(namespace)}: ${NAMESPACE_REFUSED}`)
      }
    }
  }
  expect(said).toEqual(expected)
  expect(askedOfTheCluster(clusters.demo.requests.slice(before))).toEqual([])
})

test('the longest and oddest names Kubernetes takes are read, changed and deleted as any other', async ({
  page,
  serve,
  clusters,
}) => {
  for (const { object } of ODDLY_NAMED) clusters.demo.upsert(object)
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const said: string[] = []
  for (const odd of ODDLY_NAMED) {
    const what = `${odd.kind} ${odd.name.slice(0, 40)}`
    said.push(`${what}: ${await oddlyAsked(page, 'get', odd)}`)
    said.push(`${what}: ${await oddlyAsked(page, 'patch', odd)}`)
    said.push(`${what}: ${await oddlyAsked(page, 'delete', odd)}`)
  }
  expect(said).toEqual(
    ODDLY_NAMED.flatMap((odd) => {
      const what = `${odd.kind} ${odd.name.slice(0, 40)}`
      return [`${what}: named so`, `${what}: named so, labelled`, `${what}: deleted`]
    }),
  )
})

/** Developers are shown only the keys of the shop's Secrets. */
const POLICY = `
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: self, audit: own }
grants:
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [shop] }
limits:
  - { id: shop, name: Card data, namespaces: [shop], caps: { secrets: keys } }
`

const base64 = (text: string) => Buffer.from(text).toString('base64')
const mark = () => `mark-${randomBytes(12).toString('hex')}`

/** A Secret in the shop whose value is a mark of its own. */
function marked(name: string) {
  const value = mark()
  const object = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: 'shop',
      uid: `marked-${name}`,
      creationTimestamp: new Date().toISOString(),
    },
    type: 'Opaque',
    data: { token: base64(value) },
  } as unknown as KubeObject
  return { object, value }
}

test('a read named "." is refused, and one whose answer isn’t the object asked for is too, and nothing of it reaches the page', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const one = marked('marked-one')
  const two = marked('marked-two')
  for (const { object } of [one, two]) clusters.demo.upsert(object)
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY } })
  await as(context, 'dave@example.com', 'developers')
  // Everything the server sends the page from here on is kept, to be searched.
  const crossed: string[] = []
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => crossed.push(frame.payload.toString())),
  )
  page.on(
    'response',
    (response) =>
      void response.text().then(
        (text) => crossed.push(text),
        () => {},
      ),
  )
  await page.goto(`${served.url}cluster/demo`)
  await expect(page.getByRole('navigation', { name: 'Resources' })).toBeVisible()
  /** A call of the page's (a read, or a change), and what it answers. */
  const ask = (call: 'get' | 'change', query: object) =>
    page.evaluate(
      async ([call, query]) => {
        const answer = (await (
          window as unknown as { lumovi: { kube: Record<string, (q: object) => Promise<unknown>> } }
        ).lumovi.kube[call]!({ context: 'demo', kind: 'Secret', ...query })) as {
          ok: boolean
          data?: { kind?: string; data?: Record<string, string> }
          error?: { code: string; message: string }
        }
        // (Its keys, and whether their values are empty: never a value itself.)
        return answer.ok
          ? `${answer.data?.kind}: ${Object.entries(answer.data?.data ?? {})
              .map(([key, value]) => `${key}${value === '' ? '' : ' with a value'}`)
              .join(', ')}`
          : `${answer.error?.code}: ${answer.error?.message}`
      },
      [call, query] as const,
    )
  const read = (name: string) => ask('get', { namespace: 'shop', name })
  /** A label put on a Secret: a change someone shown only its keys may make. */
  const label = (name: string) =>
    ask('change', {
      namespace: 'shop',
      name,
      change: {
        action: 'patch',
        patchType: 'merge',
        patch: { metadata: { labels: { checked: 'yes' } } },
      },
    })
  const found = () =>
    [one.value, two.value].some((value) =>
      [value, base64(value)].some((form) => crossed.some((text) => text.includes(form))),
    )

  // Its own name: the Secret, its key, no value.
  expect(await read('marked-one')).toBe('Secret: token')
  // Named ".", which would be the shop's list of Secrets: refused before the cluster is asked.
  expect(await read('.')).toBe('invalid: That isn’t a name Kubernetes allows.')
  // In no namespace, which would be read as if it were in all of them: refused too.
  expect(await ask('get', { name: 'marked-one' })).toBe(
    'invalid: That isn’t a namespace Kubernetes allows.',
  )
  // A cluster (or what's between) that answers one Secret's path with a list: refused, all of it.
  const list = {
    apiVersion: 'v1',
    kind: 'SecretList',
    metadata: { resourceVersion: '1' },
    items: [one.object, two.object],
  }
  const stop = clusters.demo.fail('/api/v1/namespaces/shop/secrets/marked-one', {
    status: 200,
    body: JSON.stringify(list),
    contentType: 'application/json',
  })
  try {
    expect(await read('marked-one')).toBe(
      'server: The cluster answered with something other than the object asked for.',
    )
    // And a change, whose answer is the object changed.
    expect(await label('marked-one')).toBe(
      'server: The cluster answered with something other than the object asked for.',
    )
  } finally {
    stop()
  }
  expect(await label('marked-one')).toBe('Secret: token')
  expect(found()).toBe(false)
})

test('no request is sent with a part of its path that’s "." or "..", written plainly or escaped', () => {
  const kc = new KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'demo', server: 'https://cluster.example/k8s/clusters/c-1' }],
    users: [{ name: 'someone' }],
    contexts: [{ name: 'demo', cluster: 'demo', user: 'someone' }],
    currentContext: 'demo',
  })
  const refused = 'That isn’t a name Kubernetes allows.'
  for (const part of ['.', '..', '%2e', '%2E%2e', '.%2E']) {
    expect(() => serverUrl(kc, `/api/v1/namespaces/shop/secrets/${part}`)).toThrow(refused)
    expect(() => serverUrl(kc, `/api/v1/namespaces/${part}/secrets`)).toThrow(refused)
  }
  // What a URL reads as something else than it says: a backslash (a slash, to it), a tab or a
  // line break (dropped), a `#` (the path ends there). Built unescaped, by whatever caller.
  for (const part of ['x\\..\\..\\prod\\pods\\db', 'x\\db', 'a\tb', 'a\nb', 'v#x']) {
    expect(() => serverUrl(kc, `/api/v1/namespaces/shop/pods/${part}/exec`)).toThrow(refused)
  }
  // A pod's path, as the WebSocket client makes it: its parts held to Kubernetes' rules first,
  // as a port forward's pod is the cluster's answer.
  for (const pod of [
    '.',
    '..',
    '%2e',
    'a/../b',
    'x\\..\\..\\prod\\pods\\db',
    'v?container=x',
    'v#x',
    'with space',
  ]) {
    expect(() => podSocket(kc, 'shop', pod, 'exec')).toThrow(
      'That isn’t a pod’s name Kubernetes allows.',
    )
  }
  for (const namespace of ['..', 'dev\\..\\prod']) {
    expect(() => podSocket(kc, namespace, 'db', 'portforward')).toThrow(
      'That isn’t a namespace Kubernetes allows.',
    )
  }
  expect(podSocket(kc, 'shop', 'storefront-7d9c-x2x9q', 'exec')).toBeUndefined()
  // A dot in a name, a stray percent sign in a proxied path, and dots after the path: as asked.
  expect(serverUrl(kc, '/api/v1/namespaces/shop/configmaps/kube-root-ca.crt').pathname).toBe(
    '/k8s/clusters/c-1/api/v1/namespaces/shop/configmaps/kube-root-ca.crt',
  )
  expect(serverUrl(kc, '/api/v1/namespaces/shop/services/web:80/proxy/100%').pathname).toBe(
    '/k8s/clusters/c-1/api/v1/namespaces/shop/services/web:80/proxy/100%',
  )
  expect(serverUrl(kc, '/api/v1/namespaces/shop/pods?labelSelector=a..b').search).toBe(
    '?labelSelector=a..b',
  )
})
