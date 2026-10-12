/**
 * A Secret's values read by key, on a server: only the asked keys' values cross to the page.
 * No value is in a test's title, an expectation or its output: marks are made as the test runs,
 * and a check says only whether one was found.
 */
import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { SecretValues } from '../../src/shared/api.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { as } from './fleet.ts'
import { call, connect } from './assistant-client.ts'
import { audited, expect, PEOPLE, signIn, test } from './fixtures.ts'

/** Developers see Secrets' values in batch, only their keys in shop, and no Secrets in data. */
const POLICY = `
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: self, audit: own }
grants:
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [shop, data, batch] }
limits:
  - { id: data, name: Data stays put, namespaces: [data], caps: { secrets: hidden } }
  - { id: shop, name: Card data, namespaces: [shop], caps: { secrets: keys } }
`

const base64 = (text: string) => Buffer.from(text).toString('base64')
/** A text nothing else holds: what a value is marked with. */
const mark = () => `mark-${randomBytes(12).toString('hex')}`

/** A Secret whose every key, its annotations and its labels carry marks of their own. */
function marked(namespace: string) {
  const marks = {
    token: mark(),
    password: mark(),
    proto: mark(),
    constructed: mark(),
    annotation: mark(),
    label: mark(),
  }
  // (`__proto__` as a key of its own, as a Secret may have it: not the object's prototype.)
  const data = JSON.parse('{}') as Record<string, string>
  Object.defineProperty(data, '__proto__', { value: base64(marks.proto), enumerable: true })
  Object.assign(data, {
    token: base64(marks.token),
    password: base64(marks.password),
    // The same value as another key: which key crossed is told by its name, not its value.
    'password-again': base64(marks.password),
    constructor: base64(marks.constructed),
  })
  const object = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'marked',
      namespace,
      uid: `marked-${namespace}`,
      creationTimestamp: new Date().toISOString(),
      labels: { marked: marks.label },
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ data }),
        note: marks.annotation,
      },
    },
    type: 'Opaque',
    data,
  } as unknown as KubeObject
  return { object, marks }
}

/** Every way a mark could be written where it crossed: as it is, and as the cluster keeps it. */
const written = (text: string) => [text, base64(text)]

type Answer =
  { ok: true; data: SecretValues } | { ok: false; error: { code: string; message: string } }

const read = (page: Page, query: object) =>
  page.evaluate(
    (q) =>
      (
        window as unknown as { lumovi: { kube: { secretValues(q: object): Promise<unknown> } } }
      ).lumovi.kube.secretValues(q),
    query,
  ) as Promise<Answer>

const refused = async (page: Page, query: object) => {
  const answer = await read(page, query)
  return answer.ok ? 'ok' : `${answer.error.code}: ${answer.error.message}`
}

test('a Secret’s values by key: only the asked keys’ cross to the page, under the person’s access', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const batch = marked('batch')
  const shop = marked('shop')
  const data = marked('data')
  for (const { object } of [batch, shop, data]) clusters.demo.upsert(object)
  try {
    const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY } })
    await as(context, 'dave@example.com', 'developers')
    // Everything the server sends the page from here on is kept, to be searched.
    const crossed: string[] = []
    // (What came as a response to a request is kept apart: a browser may store one of those.)
    const responses: string[] = []
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => crossed.push(frame.payload.toString())),
    )
    page.on(
      'response',
      (response) =>
        void response.text().then(
          (text) => {
            crossed.push(text)
            responses.push(text)
          },
          () => {},
        ),
    )
    await page.goto(`${served.url}cluster/demo`)
    await expect(page.getByRole('navigation', { name: 'Resources' })).toBeVisible()
    const found = (texts: string[]) =>
      texts.some((text) =>
        written(text).some((form) => crossed.some((frame) => frame.includes(form))),
      )

    // One key asked for: its value, and nothing else of the Secret, not its other keys' names.
    const one = await read(page, {
      context: 'demo',
      namespace: 'batch',
      name: 'marked',
      keys: ['token'],
    })
    expect(one.ok).toBe(true)
    const answer = (one as { data: SecretValues }).data
    expect(Object.keys(answer).sort()).toEqual(
      ['missing', 'name', 'namespace', 'uid', 'values', 'withheld'].sort(),
    )
    // (Compared here, and said as yes or no: a field that held more than it should would
    // otherwise be printed where this fails.)
    expect([
      answer.namespace === 'batch',
      answer.name === 'marked',
      answer.uid === 'marked-batch',
      answer.withheld,
    ]).toEqual([true, true, true, false])
    expect(answer.values.map(([key]) => key)).toEqual(['token'])
    expect(answer.values[0]![1].length).toBe(base64(batch.marks.token).length)
    expect(answer.missing).toEqual([])
    expect(JSON.stringify(one).includes('password')).toBe(false)
    // The asked key's value crossed; no other key's did, nor an annotation's or a label's.
    expect(found([batch.marks.token])).toBe(true)
    // And it came over the page's own connection to the server, as every call's answer does,
    // never as a response a browser could keep: nothing stores it on its way.
    expect(
      written(batch.marks.token).some((form) => responses.some((text) => text.includes(form))),
    ).toBe(false)
    expect(
      found([
        batch.marks.password,
        batch.marks.proto,
        batch.marks.constructed,
        batch.marks.annotation,
        batch.marks.label,
      ]),
    ).toBe(false)

    // Keys named as an object's own things are keys like any other: present, and absent.
    const odd = await read(page, {
      context: 'demo',
      namespace: 'batch',
      name: 'marked',
      keys: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'],
    })
    const oddAnswer = (odd as { data: SecretValues }).data
    expect(oddAnswer.values.map(([key]) => key)).toEqual(['__proto__', 'constructor'])
    expect(oddAnswer.values.map(([, value]) => value.length)).toEqual([
      base64(batch.marks.proto).length,
      base64(batch.marks.constructed).length,
    ])
    expect(oddAnswer.missing).toEqual(['toString', 'hasOwnProperty'])
    expect(found([batch.marks.password])).toBe(false)
    // Two keys with one value: the one asked for is answered, once.
    const again = await read(page, {
      context: 'demo',
      namespace: 'batch',
      name: 'marked',
      keys: ['password-again', 'no-such-key'],
    })
    const againAnswer = (again as { data: SecretValues }).data
    expect(againAnswer.values.map(([key]) => key)).toEqual(['password-again'])
    expect(againAnswer.missing).toEqual(['no-such-key'])
    const times = crossed.join('\n').split(base64(batch.marks.password)).length - 1
    expect(times).toBe(1)

    // Where the person's access shows only a Secret's keys, no value is answered at all.
    const keysOnly = await read(page, {
      context: 'demo',
      namespace: 'shop',
      name: 'marked',
      keys: ['token'],
    })
    const kept = (keysOnly as { data: SecretValues }).data
    expect([kept.withheld, kept.values.length, kept.missing]).toEqual([true, 0, []])
    expect(found(Object.values(shop.marks))).toBe(false)
    // Where it hides Secrets, the read is refused as a get is, in Lumovi's words.
    expect(
      await refused(page, { context: 'demo', namespace: 'data', name: 'marked', keys: ['token'] }),
    ).toBe(
      'not-allowed: Lumovi doesn’t let you see Secrets in data: the limit “Data stays put” says so.',
    )
    expect(found(Object.values(data.marks))).toBe(false)

    // What isn't a Secret and its keys is refused before the cluster is asked.
    const asked = () =>
      clusters.demo.requests.filter((r) => r.path.endsWith('/secrets/marked')).length
    const before = asked()
    const query = { context: 'demo', namespace: 'batch', name: 'marked' }
    for (const keys of [
      [],
      Array.from({ length: 21 }, (_, i) => `key-${i}`),
      ['token', 'token'],
      ['not a key'],
      [''],
      [7],
      'token',
    ]) {
      expect(await refused(page, { ...query, keys })).toBe(
        'invalid: Expected 1 to 20 of the Secret’s keys, each once and each a key’s name',
      )
    }
    for (const more of [{ forPlugin: 'flux' }, { kind: 'ConfigMap' }, { subresource: 'scale' }]) {
      expect(await refused(page, { ...query, keys: ['token'], ...more })).toBe(
        'invalid: Expected a Secret and its keys',
      )
    }
    // Nor is a name that isn't one: it can't be a Secret's, and can't put a line into the history.
    for (const odd of [
      // (A dot would have made the address the list of every Secret in the namespace.)
      { name: '.' },
      { name: '..' },
      { name: 'Marked' },
      { name: 'marked\nRead Secret other' },
      { name: 'a'.repeat(254) },
      { namespace: '../kube-system' },
      { namespace: 'batch ' },
    ]) {
      expect(await refused(page, { ...query, keys: ['token'], ...odd })).toBe(
        'invalid: Expected a Secret’s name and its namespace',
      )
    }
    expect(asked()).toBe(before)

    // A Secret that isn't there, and a failure nobody foresaw whose own words carry a mark: each
    // comes back as its kind, in Lumovi's words, and the cluster's are never passed on.
    expect(await refused(page, { ...query, name: 'no-such-secret', keys: ['token'] })).toBe(
      'not-found: There’s no such Secret.',
    )
    const told = mark()
    const broken = clusters.demo.fail('/api/v1/namespaces/batch/secrets/marked', {
      status: 500,
      body: JSON.stringify({
        kind: 'Status',
        status: 'Failure',
        message: `it held ${told}`,
        code: 500,
      }),
      contentType: 'application/json',
    })
    expect(await refused(page, { ...query, keys: ['token'] })).toBe(
      'server: Lumovi couldn’t read this Secret.',
    )
    broken()
    // An answer that isn't the Secret asked for (another object, or nonsense) is used for nothing.
    for (const body of [
      JSON.stringify({ kind: 'SecretList', items: [batch.object] }),
      JSON.stringify({ ...batch.object, metadata: { ...batch.object.metadata, name: 'another' } }),
      `not json ${told}`,
    ]) {
      const other = clusters.demo.fail('/api/v1/namespaces/batch/secrets/marked', {
        status: 200,
        body,
        contentType: 'application/json',
      })
      expect(await refused(page, { ...query, keys: ['password'] })).toBe(
        'server: Lumovi couldn’t read this Secret.',
      )
      other()
    }
    // (Its value crossed once before, for the key of the same value that was asked for: still once.)
    expect(crossed.join('\n').split(base64(batch.marks.password)).length - 1).toBe(1)
    expect(found([told])).toBe(false)
    const unanswered = clusters.demo.fail('/api/v1/namespaces/batch/secrets/marked', {
      status: 502,
      body: told,
    })
    const said = await refused(page, { ...query, keys: ['token'] })
    unanswered()
    expect(said.includes(told)).toBe(false)
    expect(found([told])).toBe(false)

    // The history has each read with exactly the keys handed over, and never a value; a read of
    // the whole Secret is counted by itself.
    await page.evaluate(() =>
      (
        window as unknown as { lumovi: { kube: { get(q: object): Promise<unknown> } } }
      ).lumovi.kube.get({ context: 'demo', kind: 'Secret', namespace: 'batch', name: 'marked' }),
    )
    await read(page, { ...query, keys: ['token'] })
    const reads = () =>
      audited(served, 'secret.read').map((event) => [
        event.summary,
        event.outcome,
        (event.details as { keys?: string[] } | undefined)?.keys,
      ])
    await expect.poll(reads).toEqual([
      ['Read 1 key of Secret marked', 'success', ['token']],
      ['Read 2 keys of Secret marked', 'success', ['__proto__', 'constructor']],
      ['Read 1 key of Secret marked', 'success', ['password-again']],
      // (Keys only: no value was handed, and the line says what was.)
      ['Read the keys’ names of Secret marked', 'success', []],
      // (Refused where Secrets are hidden; one that isn't there is no read, as with a get.)
      ['Read 0 keys of Secret marked', 'refused', undefined],
      ['Read Secret marked', 'success', expect.arrayContaining(['token', 'password'])],
    ])
    const log = served.log()
    const everyMark = [batch, shop, data].flatMap(({ marks }) => Object.values(marks)).concat(told)
    expect(everyMark.some((text) => written(text).some((form) => log.includes(form)))).toBe(false)
  } finally {
    for (const namespace of ['batch', 'shop', 'data'])
      clusters.demo.remove('Secret', namespace, 'marked')
  }
})

test('an assistant has no tool for it: a Secret’s values by key is the page’s own call', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  const { tools } = await client.listTools()
  expect(tools.length).toBeGreaterThan(0)
  // By their names and by what each says it takes: none reads a Secret by its keys.
  expect(
    tools.filter(
      (tool) =>
        /secret.?values|by.?key/i.test(tool.name) ||
        Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).includes(
          'keys',
        ),
    ).length,
  ).toBe(0)
  // And the tools an assistant does have still answer.
  expect((await call(client, 'list_clusters')).text).toContain('demo')
})
