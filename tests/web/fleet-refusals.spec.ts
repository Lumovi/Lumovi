/**
 * What a server says to a request about its fleet that it can't act on: a cluster to add or to
 * connect with no name, a name that isn't one, nothing to add it from, a kubeconfig that names
 * what it doesn't have. Each is refused before anything is kept, in a sentence a person can use.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { expect, inCluster, test } from './fixtures.ts'
import { FLEET } from '../mock-cluster/fleet.ts'
import { as, fleetEnv } from './fleet.ts'

/** What a fleet call from the page gives, or its error's message. */
const call = (
  page: Page,
  method:
    'check' | 'add' | 'remove' | 'connect' | 'cancelJoin' | 'joins' | 'settings' | 'saveSettings',
  ...args: unknown[]
): Promise<{ value?: unknown; error?: string }> =>
  page.evaluate(
    ([method, args]) =>
      (window.lumovi!.fleet![method] as (...args: unknown[]) => Promise<unknown>)(...args).then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      ),
    [method, args] as const,
  )

const NAME_RULE =
  'Its name: Up to 63 lowercase letters, digits or “-”, starting and ending with a letter or digit.'

/** A kubeconfig of the demo cluster with these contexts, each naming a cluster and a user. */
function kubeconfig(
  clusters: TestClusters,
  contexts: { name: string; cluster: string; user: string }[],
  user: Record<string, unknown> = { token: 'lumovi-demo-token' },
) {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'demo',
        cluster: {
          server: clusters.demo.url,
          'certificate-authority-data': Buffer.from(clusters.demo.caPem!).toString('base64'),
        },
      },
    ],
    users: [{ name: 'hub', user }],
    contexts: contexts.map(({ name, cluster, user }) => ({ name, context: { cluster, user } })),
    ...(contexts[0] ? { 'current-context': contexts[0].name } : {}),
  })
}

test('a cluster to add is refused before anything is kept: no name, a name that isn’t one, nothing to add it from', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: {
      ...inCluster(clusters).env,
      KUBECONFIG: undefined,
      LUMOVI_CONTEXT: undefined,
      LUMOVI_AUTH: 'proxy',
      LUMOVI_FLEET_LOCAL: 'false',
      LUMOVI_ADMINS: 'user:admin@example.com',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-refusals-')),
      LUMOVI_FLEET_ADD_FROM_PAGE: 'true',
    },
  })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'lumovi-clusters' },
  } as KubeObject)
  /** What the cluster was asked to make where added clusters are kept: each Secret's name. */
  const made = () =>
    clusters.demo.requests
      .filter(
        ({ method, path }) =>
          method === 'POST' && path.startsWith('/api/v1/namespaces/lumovi-clusters/secrets'),
      )
      .map(({ body }) => (body as { metadata?: { name?: string } } | undefined)?.metadata?.name)

  // No request at all, and a name that isn't text: what's missing is said.
  expect(await call(page, 'add')).toEqual({ error: 'Give the cluster a name.' })
  expect(await call(page, 'add', { name: 5 })).toEqual({ error: 'Give the cluster a name.' })
  // A name that isn't one, by the rule a person is shown.
  expect(await call(page, 'add', { name: '' })).toEqual({ error: 'Its name: Enter a name.' })
  for (const name of ['Bad Name', '-edge', 'edge-', 'a'.repeat(64), '../lumovi', 'ümlaut']) {
    expect(await call(page, 'add', { name }), name).toEqual({ error: NAME_RULE })
  }
  // A good name with nothing to add it from; and a check of nothing.
  const nothing = { error: 'Give a kubeconfig, or a server, a token and its CA.' }
  expect(await call(page, 'add', { name: 'lab' })).toEqual(nothing)
  expect(await call(page, 'add', { name: 'lab', source: {} })).toEqual(nothing)
  expect(await call(page, 'add', { name: 'lab', source: { server: clusters.demo.url } })).toEqual(
    nothing,
  )
  expect(await call(page, 'check')).toEqual(nothing)

  const failed = async (source: object) => {
    const result = await call(page, 'check', source)
    if (result.error) throw new Error(result.error)
    const { checks, passed } = result.value as {
      checks: { result: string; title: string; detail?: string; hint?: string }[]
      passed: boolean
    }
    expect(passed).toBe(false)
    return checks.filter((check) => check.result === 'bad').map(({ result: _, ...said }) => said)
  }
  // A kubeconfig with no context, or two: one cluster at a time.
  expect(await failed({ kubeconfig: kubeconfig(clusters, []) })).toEqual([
    { title: 'It has no context', hint: 'Paste one: Lumovi adds a cluster at a time.' },
  ])
  expect(
    await call(page, 'add', { name: 'lab', source: { kubeconfig: kubeconfig(clusters, []) } }),
  ).toEqual({ error: 'It can’t be added: It has no context.' })
  // A context that names a user, or a cluster, the kubeconfig doesn't have.
  const lab = { name: 'lab', cluster: 'demo', user: 'hub' }
  expect(await failed({ kubeconfig: kubeconfig(clusters, [{ ...lab, user: 'nobody' }]) })).toEqual([
    { title: 'Its context names a user it doesn’t have', detail: 'lab' },
  ])
  expect(
    await failed({ kubeconfig: kubeconfig(clusters, [{ ...lab, cluster: 'nowhere' }]) }),
  ).toEqual([{ title: 'Its context names a cluster it doesn’t have', detail: 'lab' }])
  // A token that isn't one: none, or with a space in it.
  const ca = clusters.demo.caPem!
  for (const token of ['', '   ', 'two words']) {
    expect(await failed({ server: clusters.demo.url, token, ca }), token).toEqual([
      { title: 'Its token isn’t one', hint: 'Paste the token alone.' },
    ])
  }
  // A way of signing in the hub can't use, or that doesn't work: said for what it is.
  const one = [lab]
  const NO_PROGRAMS =
    'This server can’t run programs, so it can’t use this kubeconfig. Use a token instead, such as a service account’s, or connect the cluster with an agent.'
  expect(await failed({ kubeconfig: kubeconfig(clusters, one, { username: 'someone' }) })).toEqual([
    { title: 'It has no credentials', hint: 'Give its user a token or a client certificate.' },
  ])
  expect(
    await failed({ kubeconfig: kubeconfig(clusters, one, { username: 'someone', password: 'p' }) }),
  ).toEqual([{ title: 'The credentials don’t work', detail: 'Unauthorized' }])
  expect(
    await failed({
      kubeconfig: kubeconfig(clusters, one, { 'auth-provider': { name: 'oidc', config: {} } }),
    }),
  ).toEqual([
    { title: 'It signs in with a plugin', detail: 'oidc', hint: NO_PROGRAMS, plugin: true },
  ])
  expect(
    await failed({
      kubeconfig: kubeconfig(clusters, one, {
        exec: { apiVersion: 'client.authentication.k8s.io/v1', command: 'gke-gcloud-auth-plugin' },
      }),
    }),
  ).toEqual([
    {
      title: 'It signs in by running a program',
      detail: 'gke-gcloud-auth-plugin',
      hint: NO_PROGRAMS,
      plugin: true,
    },
  ])
  // Its labels and groups, where they're given, are held to what they are.
  const good = { kubeconfig: kubeconfig(clusters, one) }
  expect(await call(page, 'add', { name: 'lab', labels: ['a'], source: good })).toEqual({
    error: 'Its labels must be a map of text, like { env: production }.',
  })
  expect(await call(page, 'add', { name: 'lab', groups: 'sre', source: good })).toEqual({
    error: 'Its groups must be a list of text, like [platform, sre].',
  })
  // And through all of it nothing was kept: the cluster was never asked to make a Secret.
  expect(made()).toEqual([])

  // A name the fleet has, and a Secret that's where one would be kept and isn't Lumovi's.
  expect(await call(page, 'add', { name: 'lab', source: good })).toEqual({})
  expect(made()).toEqual(['lumovi-cluster-lab'])
  expect(await call(page, 'add', { name: 'lab', source: good })).toEqual({
    error: 'The fleet has a cluster called lab already: give this one another name.',
  })
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'lumovi-cluster-other', namespace: 'lumovi-clusters' },
    data: {},
  } as KubeObject)
  expect(await call(page, 'add', { name: 'other', source: good })).toEqual({
    error:
      'A Secret called lumovi-cluster-other is in the lumovi-clusters namespace already: Lumovi doesn’t replace one it didn’t make.',
  })
  // (Asked to make it, and refused by the cluster: what was there is as it was.)
  expect(made()).toEqual(['lumovi-cluster-lab', 'lumovi-cluster-other'])
  expect(clusters.demo.object('Secret', 'lumovi-clusters', 'lumovi-cluster-other')?.data).toEqual(
    {},
  )
})

test('who may add a cluster, and why not: no admins named, nothing kept, not an admin', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const env = (extra: Record<string, string | undefined>) => ({
    ...inCluster(clusters).env,
    KUBECONFIG: undefined,
    LUMOVI_CONTEXT: undefined,
    LUMOVI_AUTH: 'proxy',
    LUMOVI_FLEET_LOCAL: 'false',
    LUMOVI_ADMINS: 'user:admin@example.com',
    LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-refusals-')),
    LUMOVI_FLEET_ADD_FROM_PAGE: 'true',
    ...extra,
  })
  await as(context, 'admin@example.com')
  // Nobody is named an admin: there's no one to add one.
  const none = await serve({ env: env({ LUMOVI_ADMINS: undefined }) })
  await page.goto(none.url)
  expect(await call(page, 'add', { name: 'lab' })).toEqual({
    error:
      'Clusters are added on this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).',
  })
  // A server that keeps nothing would forget what was added.
  const forgets = await serve({ env: env({ LUMOVI_DATA_DIR: undefined }) })
  await page.goto(forgets.url)
  expect(await call(page, 'add', { name: 'lab' })).toEqual({
    error:
      'This server keeps nothing when it restarts, so it would forget which clusters were added here: keep its state (the chart’s auth.keepSessions, or LUMOVI_DATA_DIR).',
  })
  // Someone who isn't an admin: neither adding nor checking.
  const hub = await serve({ env: env({}) })
  await as(context, 'someone@example.com')
  await page.goto(hub.url)
  const notAdmin = { error: 'Only Lumovi’s admins add clusters to the fleet.' }
  expect(await call(page, 'add', { name: 'lab' })).toEqual(notAdmin)
  expect(await call(page, 'check', {})).toEqual(notAdmin)
})

test('a cluster to connect is refused the same way; and one that isn’t being connected can’t be let go', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: {
      ...fleetEnv(clusters),
      LUMOVI_ADMINS: 'user:admin@example.com',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-refusals-')),
    },
  })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  expect(await call(page, 'connect')).toEqual({ error: 'Give the cluster a name.' })
  expect(await call(page, 'connect', { name: ['edge'] })).toEqual({
    error: 'Give the cluster a name.',
  })
  expect(await call(page, 'connect', { name: '' })).toEqual({ error: 'Its name: Enter a name.' })
  expect(await call(page, 'connect', { name: 'Edge AP' })).toEqual({ error: NAME_RULE })
  // Nothing is being connected for it.
  expect(await call(page, 'joins')).toMatchObject({ value: { joins: [] } })
  expect(await call(page, 'cancelJoin', 'edge-ap-south')).toEqual({
    error: 'No cluster called edge-ap-south is being connected.',
  })
  expect(await call(page, 'cancelJoin', 7)).toEqual({ error: 'Expected a cluster’s name.' })
  // Its labels and its groups are said, even when there are none: a name alone isn't a request.
  expect(await call(page, 'connect', { name: 'edge-ap-south' })).toEqual({
    error: 'Its labels must be a map of text, like { env: production }.',
  })
  expect(await call(page, 'connect', { name: 'edge-ap-south', labels: [], groups: [] })).toEqual({
    error: 'Its labels must be a map of text, like { env: production }.',
  })
  expect(await call(page, 'connect', { name: 'edge-ap-south', labels: {}, groups: 'sre' })).toEqual(
    {
      error: 'Its groups must be a list of text, like [platform, sre].',
    },
  )
  expect(
    await call(page, 'connect', { name: 'edge-ap-south', labels: {}, groups: [] }),
  ).toMatchObject({
    value: { join: { name: 'edge-ap-south', labels: {}, groups: [] } },
  })
  // Let go once, it isn't being connected any more.
  expect(await call(page, 'cancelJoin', 'edge-ap-south')).toEqual({})
  expect(await call(page, 'cancelJoin', 'edge-ap-south')).toEqual({
    error: 'No cluster called edge-ap-south is being connected.',
  })
  expect(await call(page, 'remove', 7)).toEqual({ error: 'Expected a cluster’s name.' })
})

test('a cluster’s settings are held to what they are: a name that’s text, labels and groups by their rules', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: {
      // Staging's kubeconfig doesn't label it: the page may.
      ...fleetEnv(clusters, { [FLEET.staging]: { labels: undefined } }),
      LUMOVI_ADMINS: 'user:admin@example.com',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-refusals-')),
    },
  })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  const nowhere = { error: 'This server has no cluster called “nowhere”.' }
  expect(await call(page, 'settings', 'nowhere')).toEqual(nowhere)
  expect(await call(page, 'saveSettings', 'nowhere', { labels: {} })).toEqual(nowhere)
  // A name that isn't text (a script's): said so, and what was given never said back.
  const notText = { error: 'A cluster is named by text, like “prod-eu”.' }
  expect(await call(page, 'settings', { name: 'nowhere' })).toEqual(notText)
  expect(await call(page, 'saveSettings', 7, { labels: {} })).toEqual(notText)
  // A group of no name.
  expect(await call(page, 'saveSettings', FLEET.staging, { groups: [''] })).toEqual({
    error: 'Its group is empty: name one, or leave it out.',
  })
  // Nothing given changes nothing, and says what's set.
  const asItWas = await call(page, 'settings', FLEET.staging)
  expect(asItWas.value).toMatchObject({ name: FLEET.staging, labels: { value: {} } })
  expect(await call(page, 'saveSettings', FLEET.staging)).toEqual(asItWas)
  expect(await call(page, 'saveSettings', FLEET.staging, { labels: {} })).toEqual(asItWas)
  const LABEL_RULE =
    'Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit.'
  const refused: [object, string][] = [
    [{ title: 5 }, 'Its name must be text.'],
    [{ labels: { 'bad key': 'x' } }, `Its label bad key: ${LABEL_RULE}`],
    [{ labels: { env: 'two words' } }, `Its label env: ${LABEL_RULE}`],
    [{ labels: ['env'] }, 'Its labels must be a map of text, like { env: production }.'],
    [{ groups: 'sre' }, 'Its groups must be a list of text, like [platform, sre].'],
  ]
  for (const [setting, error] of refused) {
    expect(await call(page, 'saveSettings', FLEET.staging, setting), error).toEqual({ error })
  }
  // And none of it was kept.
  expect(await call(page, 'settings', FLEET.staging)).toEqual(asItWas)
})
