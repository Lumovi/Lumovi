/**
 * Where a fleet's clusters come from: its kubeconfig (a setting, or files
 * read again as they change), Secrets of the cluster the server runs in
 * (Lumovi's, Cluster API's and Argo CD's), and that cluster itself.
 */
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { FLEET, fleetKubeconfig } from '../mock-cluster/fleet.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { expect, inCluster, refusedConfig, test } from './fixtures.ts'
import { as, card, fleetEnv } from './fleet.ts'

/** A kubeconfig of one context, `name`, for `server`. */
function kubeconfig(
  name: string,
  server: string,
  { user = { token: 'any' } as object, extension = undefined as object | undefined } = {},
): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster: { server, 'insecure-skip-tls-verify': true } }],
    users: [{ name, user }],
    contexts: [
      {
        name,
        context: {
          cluster: name,
          user: name,
          ...(extension && { extensions: [{ name: 'lumovi.dev', extension }] }),
        },
      },
    ],
  })
}

/** A Secret in the demo cluster, its data base64-encoded as the API has it. */
function secret(
  namespace: string,
  name: string,
  data: Record<string, string>,
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } = {},
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, ...metadata },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
    ),
  } as KubeObject
}

test('settings a fleet won’t start with', async ({ clusters }) => {
  const { env: kubernetes } = inCluster(clusters)
  const fleet = fleetEnv(clusters)
  const refusals: [Record<string, string | undefined>, string][] = [
    [
      { LUMOVI_FLEET_KUBECONFIG: fleet.LUMOVI_FLEET_KUBECONFIG },
      'A fleet needs single sign-on or a proxy (LUMOVI_AUTH=oidc or proxy)',
    ],
    [
      { ...fleet, LUMOVI_FLEET_KUBECONFIG: 'clusters: [' },
      'LUMOVI_FLEET_KUBECONFIG isn’t a kubeconfig:',
    ],
    [
      { ...fleet, LUMOVI_FLEET_KUBECONFIG: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64') },
      'LUMOVI_FLEET_KUBECONFIG must be YAML, or YAML encoded in base64.',
    ],
    [{ ...fleet, LUMOVI_FLEET_SECRETS: 'lumovi, rancher' }, 'not "rancher"'],
    [
      { ...fleet, LUMOVI_FLEET_SECRETS: 'lumovi' },
      'LUMOVI_FLEET_SECRETS reads Secrets of the cluster Lumovi runs in, and it isn’t running in one',
    ],
    [
      { ...fleet, LUMOVI_FLEET_LOCAL: 'yes' },
      'LUMOVI_FLEET_LOCAL must be true or false, not "yes".',
    ],
    [
      { LUMOVI_AUTH: 'proxy', LUMOVI_FLEET_LOCAL: 'true' },
      'LUMOVI_FLEET_LOCAL is true, but Lumovi isn’t running in a cluster',
    ],
    [
      { ...fleet, LUMOVI_FLEET_REFRESH_SECONDS: '0' },
      'LUMOVI_FLEET_REFRESH_SECONDS must be a number from 1 to 3600, not "0".',
    ],
    [{ ...fleet, LUMOVI_CLUSTER_LABELS: 'env' }, 'LUMOVI_CLUSTER_LABELS must be labels like'],
    [{ ...fleet, LUMOVI_FLEET_AGENTS: '[a' }, 'LUMOVI_FLEET_AGENTS isn’t YAML:'],
    [
      { ...fleet, LUMOVI_FLEET_AGENTS: 'name: edge' },
      'LUMOVI_FLEET_AGENTS must be a list of agents, each with a name and a token.',
    ],
    [{ ...fleet, LUMOVI_FLEET_AGENTS: '- edge' }, 'LUMOVI_FLEET_AGENTS[0] needs a name.'],
    [{ ...fleet, LUMOVI_FLEET_AGENTS: '- null' }, 'LUMOVI_FLEET_AGENTS[0] needs a name.'],
    [
      { ...fleet, LUMOVI_FLEET_AGENTS: '- { name: edge, token: short }' },
      'LUMOVI_FLEET_AGENTS[0] (edge) needs a token of at least 32 characters, or its tokenSha256.',
    ],
    [
      { ...fleet, LUMOVI_FLEET_AGENTS: '- { name: edge, tokenSha256: abc }' },
      'needs a token of at least 32 characters, or its tokenSha256.',
    ],
    [
      {
        ...fleet,
        LUMOVI_FLEET_AGENTS: `- { name: edge, tokenSha256: ${'a'.repeat(64)} }\n- { name: edge, tokenSha256: ${'b'.repeat(64)} }`,
      },
      'LUMOVI_FLEET_AGENTS[1]: there are two agents called edge.',
    ],
    [
      {
        ...fleet,
        LUMOVI_FLEET_AGENTS: `- { name: edge, tokenSha256: ${'a'.repeat(64)}, labels: [x] }`,
      },
      'LUMOVI_FLEET_AGENTS[0].labels must be a map of text, like { env: production }.',
    ],
    [
      {
        ...fleet,
        LUMOVI_FLEET_AGENTS: `- { name: edge, tokenSha256: ${'a'.repeat(64)}, groups: sre }`,
      },
      'LUMOVI_FLEET_AGENTS[0].groups must be a list of text, like [platform, sre].',
    ],
    [
      { ...fleet, LUMOVI_FLEET_AGENTS: Buffer.from('- { name: edge }').toString('base64') },
      'LUMOVI_FLEET_AGENTS[0] (edge) needs a token',
    ],
    [
      { ...fleet, LUMOVI_FLEET_AGENTS: Buffer.from([0xff, 0xfe]).toString('base64') },
      'LUMOVI_FLEET_AGENTS must be YAML, or YAML encoded in base64.',
    ],
    // In a cluster without its service account.
    [
      { ...fleet, ...kubernetes, LUMOVI_SERVICE_ACCOUNT_DIR: join(tmpdir(), 'nowhere') },
      'No service account token in',
    ],
    // PORT, as hosts like Sevalla set it.
    [{ ...fleet, LUMOVI_PORT: undefined, PORT: 'web' }, 'PORT must be a port number, not "web".'],
  ]
  for (const [env, message] of refusals) {
    expect(await refusedConfig(clusters, env)).toContain(message)
  }
})

test('as Sevalla runs it: its port, and a kubeconfig in one setting', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({
    env: { ...fleetEnv(clusters), LUMOVI_PORT: undefined, PORT: '0', KUBECONFIG: undefined },
  })
  expect(served.log()).toContain('shows a fleet of 4 clusters')
  await as(context, 'alice@example.com')
  await page.goto(served.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  // The same, as plain YAML.
  const plain = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_FLEET_KUBECONFIG: fleetKubeconfig(clusters),
      LUMOVI_FLEET_LOCAL: 'false',
    },
  })
  expect(plain.log()).toContain('shows a fleet of 4 clusters')
})

test('kubeconfig files, read again as they change', async ({ page, context, serve, clusters }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-fleet-'))
  const first = join(dir, 'first.yaml')
  const second = join(dir, 'second.yaml')
  // A CA beside it, by a relative path.
  writeFileSync(join(dir, 'demo-ca.crt'), clusters.demo.caPem!)
  const write = (file: string, text: string) => {
    writeFileSync(`${file}.new`, text)
    renameSync(`${file}.new`, file)
  }
  write(
    first,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'eu',
          cluster: { server: clusters.demo.url, 'certificate-authority': 'demo-ca.crt' },
        },
      ],
      users: [
        { name: 'hub', user: { token: 'lumovi-demo-token' } },
        { name: 'nobody', user: {} },
      ],
      contexts: [
        // Its own prefix for groups; the server's for names.
        {
          name: 'eu',
          context: {
            cluster: 'eu',
            user: 'hub',
            extensions: [{ name: 'lumovi.dev', extension: { groupsPrefix: 'team:' } }],
          },
        },
        // Nothing to sign in with, or no user at all.
        { name: 'bare', context: { cluster: 'eu', user: 'nobody' } },
        { name: 'ghost', context: { cluster: 'eu', user: 'gone' } },
        // A cluster it doesn't have.
        { name: 'lost', context: { cluster: 'gone', user: 'hub' } },
        // Lumovi's settings, not as they should be.
        {
          name: 'odd',
          context: {
            cluster: 'eu',
            user: 'hub',
            extensions: [{ name: 'lumovi.dev', extension: 'x' }],
          },
        },
        {
          name: 'odder',
          context: {
            cluster: 'eu',
            user: 'hub',
            extensions: [{ name: 'lumovi.dev', extension: { forwardToken: 'yes' } }],
          },
        },
        {
          name: 'oddest',
          context: {
            cluster: 'eu',
            user: 'hub',
            extensions: [{ name: 'lumovi.dev', extension: { groupsPrefix: 1 } }],
          },
        },
        {
          name: 'grouped',
          context: {
            cluster: 'eu',
            user: 'hub',
            extensions: [{ name: 'lumovi.dev', extension: { groups: 'sre' } }],
          },
        },
      ],
    }),
  )
  write(second, kubeconfig('staging', clusters.sandbox.url))
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_FLEET_KUBECONFIG_FILE: [first, second].join(delimiter),
      LUMOVI_FLEET_REFRESH_SECONDS: '1',
      // Prefixes: the server's, unless a cluster has its own.
      LUMOVI_USERNAME_PREFIX: 'sso:',
      LUMOVI_GROUPS_PREFIX: 'sso:',
    },
  })
  expect(served.log()).toContain(
    'shows a fleet of 9 clusters (eu, bare, ghost, lost, odd, odder, oddest, grouped, staging)',
  )
  await as(context, 'alice@example.com', 'developers')
  await page.goto(served.url)
  await expect(card(page, 'eu')).toContainText('Nodes3/4')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({
      user: 'sso:alice@example.com',
      headers: { 'impersonate-group': 'team:developers' },
    })
  const problems = {
    bare: 'Lumovi has no credentials for it: give its user a token or a client certificate, or set forwardToken to pass on each person’s own.',
    ghost: 'Lumovi has no credentials for it',
    lost: 'Its kubeconfig names a cluster it doesn’t have.',
    odd: 'Its lumovi.dev extension: should be a map, like { labels: { env: production } }.',
    odder: 'Its lumovi.dev extension: forwardToken must be true or false.',
    oddest: 'Its lumovi.dev extension: groupsPrefix must be text.',
    grouped: 'Its lumovi.dev extension: groups must be a list of text, like [platform, sre].',
  }
  for (const [name, problem] of Object.entries(problems)) {
    await expect(card(page, name)).toHaveAccessibleName(`${name}, Misconfigured`)
    await expect(card(page, name)).toContainText(problem)
  }
  // Opening one says why too.
  await page.goto(`${served.url}cluster/lost`)
  await expect(page.getByRole('alert')).toContainText(
    'Its kubeconfig names a cluster it doesn’t have.',
  )

  // A file that changes: a cluster added, and one gone.
  write(
    second,
    JSON.stringify({
      ...JSON.parse(kubeconfig('qa', clusters.sandbox.url)),
    }),
  )
  await expect.poll(() => served.log()).toContain('Fleet: qa added')
  expect(served.log()).toContain('Fleet: staging removed')
  // One that can't be read keeps what it had, and says so once.
  write(second, 'clusters: [')
  await expect
    .poll(() => served.log())
    .toContain(`Fleet: ${second} can’t be read: ${second} isn’t a kubeconfig:`)
  await page.waitForTimeout(2500)
  expect(served.log().split(`${second} can’t be read`)).toHaveLength(2)
  await page.goto(served.url)
  await expect(card(page, 'qa')).toBeVisible()
  // Readable again; two clusters of one name: the first stays.
  write(second, kubeconfig('eu', clusters.sandbox.url))
  await expect
    .poll(() => served.log())
    .toContain(
      `Fleet: Two clusters are called eu: the one from ${second} is left out (the one from ${first} stays).`,
    )
  await expect.poll(() => served.log()).toContain('Fleet: qa removed')
})

test('in a cluster: only itself, or with Secrets in its own namespace', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const { env: kubernetes } = inCluster(clusters)
  const inside = {
    ...kubernetes,
    KUBECONFIG: undefined,
    LUMOVI_CONTEXT: undefined,
    LUMOVI_AUTH: 'proxy',
  }
  const alone = await serve({ env: { ...inside, LUMOVI_FLEET_LOCAL: 'true' } })
  expect(alone.log()).toContain('shows a fleet of 1 cluster (in-cluster)')
  await as(context, 'alice@example.com')
  await page.goto(alone.url)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1 cluster1 needs attention')
  await expect(card(page, 'in-cluster')).toContainText('Nodes3/4')

  // Its namespace's Secrets (the service account's), and not itself.
  clusters.demo.upsert(
    secret(
      'lumovi',
      'staging',
      { kubeconfig: kubeconfig('staging', clusters.sandbox.url) },
      { labels: { 'lumovi.dev/cluster': '' } },
    ),
  )
  const secrets = await serve({
    env: { ...inside, LUMOVI_FLEET_SECRETS: 'lumovi', LUMOVI_FLEET_LOCAL: 'false' },
  })
  expect(secrets.log()).toContain('shows a fleet of 1 cluster (staging)')
  // Without either, it shows the one cluster, as ever.
  const single = await serve({ env: { ...inside, LUMOVI_FLEET_LOCAL: 'false' } })
  expect(single.log()).toContain('shows in-cluster (https://127.0.0.1:')
})

test('clusters described by Secrets, and the cluster it runs in', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const { env: kubernetes } = inCluster(clusters)
  const { demo } = clusters
  // Lumovi's own: a kubeconfig, with its settings as annotations.
  demo.upsert(
    secret(
      'lumovi',
      'staging',
      { kubeconfig: kubeconfig('staging', clusters.sandbox.url) },
      {
        labels: { 'lumovi.dev/cluster': '' },
        annotations: {
          'lumovi.dev/labels': 'env=staging',
          'lumovi.dev/groups': 'developers, qa',
          'lumovi.dev/forward-token': 'false',
        },
      },
    ),
  )
  // Several in one, each with its own settings (and none of the Secret's).
  const several = JSON.parse(
    kubeconfig('qa', clusters.sandbox.url, { extension: { labels: { env: 'qa' } } }),
  )
  several.contexts.push({ name: 'lost', context: { cluster: 'gone', user: 'qa' } })
  demo.upsert(
    secret(
      'lumovi',
      'several',
      { kubeconfig: JSON.stringify(several) },
      { labels: { 'lumovi.dev/cluster': '' } },
    ),
  )
  demo.upsert(secret('lumovi', 'empty', {}, { labels: { 'lumovi.dev/cluster': '' } }))
  demo.upsert({
    ...secret('lumovi', 'nothing', {}, { labels: { 'lumovi.dev/cluster': '' } }),
    data: undefined,
  } as KubeObject)
  demo.upsert(
    secret(
      'lumovi',
      'labelled-oddly',
      { kubeconfig: kubeconfig('labelled-oddly', clusters.sandbox.url) },
      { labels: { 'lumovi.dev/cluster': '' }, annotations: { 'lumovi.dev/labels': 'staging' } },
    ),
  )
  // Cluster API's: each cluster's <name>-kubeconfig, among others of the cluster.
  const capi = { 'cluster.x-k8s.io/cluster-name': 'workload-1' }
  demo.upsert(
    secret(
      'lumovi',
      'workload-1-kubeconfig',
      { value: kubeconfig('workload-1-admin@workload-1', clusters.large.url) },
      { labels: capi, annotations: { 'lumovi.dev/labels': 'provider=capi' } },
    ),
  )
  demo.upsert(secret('lumovi', 'workload-1-ca', { 'tls.crt': 'x' }, { labels: capi }))
  demo.upsert(secret('lumovi', 'workload-2-kubeconfig', {}, { labels: capi }))
  demo.upsert(
    secret(
      'lumovi',
      'workload-3-kubeconfig',
      { value: JSON.stringify({ apiVersion: 'v1', kind: 'Config' }) },
      { labels: capi },
    ),
  )
  // Argo CD's: name, server and config, with labels of their own.
  const argo = { 'argocd.argoproj.io/secret-type': 'cluster' }
  const argoSecret = (name: string, data: Record<string, string>, labels = {}) =>
    secret('argocd', name, data, { labels: { ...argo, ...labels } })
  demo.upsert(
    argoSecret(
      'cluster-prod-us',
      {
        name: 'prod-us',
        server: clusters.large.url,
        config: JSON.stringify({ bearerToken: 'any', tlsClientConfig: { insecure: true } }),
      },
      { env: 'production', 'argocd.argoproj.io/auto-label': 'x' },
    ),
  )
  demo.upsert({
    ...demo.object('Secret', 'argocd', 'cluster-prod-us')!,
    metadata: {
      ...demo.object('Secret', 'argocd', 'cluster-prod-us')!.metadata,
      annotations: { 'lumovi.dev/labels': 'tier=gold' },
    },
  })
  demo.upsert(
    argoSecret('cluster-eks', {
      name: 'eks',
      server: 'https://eks.example.com',
      config: JSON.stringify({ awsAuthConfig: { clusterName: 'eks' } }),
    }),
  )
  demo.upsert(
    argoSecret('cluster-gke', {
      name: 'gke',
      server: 'https://127.0.0.1:1',
      config: JSON.stringify({
        execProviderConfig: { command: 'lumovi-no-such-command', args: ['token'], env: { A: 'b' } },
      }),
    }),
  )
  demo.upsert(
    argoSecret('cluster-plain', {
      name: 'plain',
      server: 'https://127.0.0.1:1',
      config: JSON.stringify({ execProviderConfig: { command: 'lumovi-no-such-command' } }),
    }),
  )
  demo.upsert(argoSecret('cluster-bare', { name: 'bare', server: 'https://127.0.0.1:1' }))
  demo.upsert(argoSecret('cluster-nameless', { server: 'https://127.0.0.1:1' }))
  demo.upsert(argoSecret('cluster-garbled', { name: 'garbled', server: 'x', config: '{' }))
  // A namespace it may not list in.
  demo.fail('/api/v1/namespaces/elsewhere/secrets', { status: 403 })

  const served = await serve({
    env: {
      ...kubernetes,
      KUBECONFIG: undefined,
      LUMOVI_CONTEXT: undefined,
      LUMOVI_AUTH: 'proxy',
      LUMOVI_CLUSTER_NAME: 'hub',
      LUMOVI_CLUSTER_LABELS: 'env=ops',
      LUMOVI_FLEET_SECRETS: 'lumovi,cluster-api,argocd',
      LUMOVI_FLEET_SECRETS_NAMESPACES: 'lumovi, argocd, elsewhere',
      LUMOVI_FLEET_REFRESH_SECONDS: '1',
      LUMOVI_ADMINS: 'user:admin@example.com',
    },
  })
  for (const kind of ['lumovi', 'cluster-api', 'argocd']) {
    expect(served.log()).toContain(`Fleet: Secrets for ${kind} in elsewhere can’t be listed:`)
  }
  await as(context, 'alice@example.com', 'developers')
  await page.goto(served.url)
  // The cluster it runs in, as it's called there.
  await expect(card(page, 'hub')).toContainText('env=ops')
  await expect(card(page, 'hub')).toContainText('Nodes3/4')
  await expect(card(page, 'staging')).toContainText('env=staging')
  await expect(card(page, 'staging')).toContainText('v1.33.4')
  await expect(card(page, 'qa')).toContainText('env=qa')
  await expect(card(page, 'lost')).toContainText('Its kubeconfig names a cluster it doesn’t have.')
  await expect(card(page, 'empty')).toContainText('It has no kubeconfig (data.kubeconfig).')
  await expect(card(page, 'nothing')).toContainText('It has no kubeconfig (data.kubeconfig).')
  await expect(card(page, 'labelled-oddly')).toContainText(
    'lumovi.dev/labels must be labels like env=production,region=eu, not "staging".',
  )
  await expect(card(page, 'workload-1')).toContainText('provider=capi')
  await expect(card(page, 'workload-1')).toContainText('Pods running2,500')
  await expect(card(page, 'prod-us')).toContainText('env=productiontier=gold')
  await expect(card(page, 'prod-us')).not.toContainText('auto-label')
  await expect(card(page, 'eks')).toContainText(
    'Argo CD signs in to it with AWS (awsAuthConfig), which Lumovi can’t: give it a bearerToken.',
  )
  await expect(card(page, 'gke')).toHaveAccessibleName(/^gke, /)
  await expect(card(page, 'gke')).toContainText('lumovi-no-such-command')
  await expect(card(page, 'plain')).toContainText('lumovi-no-such-command')
  await expect(card(page, 'bare')).toContainText('Lumovi has no credentials for it')
  await expect(card(page, 'cluster-nameless')).toContainText('It has no name or server.')
  await expect(card(page, 'cluster-garbled')).toHaveAccessibleName('cluster-garbled, Misconfigured')
  await expect(page.locator('[data-cluster-card]')).toHaveCount(15)

  // Read again: a Secret gone, its cluster with it.
  demo.remove('Secret', 'lumovi', 'empty')
  await expect.poll(() => served.log()).toContain('Fleet: empty removed')
  // A list that can't be read now keeps its clusters, and says why.
  const failing = demo.fail('/api/v1/namespaces/lumovi/secrets', { status: 403 })
  await expect
    .poll(() => served.log())
    .toContain('Fleet: Secrets for lumovi in lumovi can’t be listed:')
  await page.waitForTimeout(1500)
  await page.reload()
  await expect(card(page, 'qa')).toBeVisible()
  expect(served.log()).not.toContain('Fleet: qa removed')
  failing()
  // Someone not in its groups doesn't see staging.
  await as(context, 'bob@example.com')
  await page.reload()
  await expect(card(page, 'hub')).toBeVisible()
  await expect(card(page, 'staging')).toHaveCount(0)

  // What each source sets of a cluster's settings is its own, and an admin sees where.
  await as(context, 'admin@example.com')
  await page.reload()
  const settings = (name: string) =>
    page.evaluate((name) => window.lumovi!.fleet!.settings(name), name)
  const itsSecret = (name: string, ...keys: string[]) => ({
    by: `its Secret, ${name}`,
    in: keys.map((key) => ({ key })),
  })
  expect(await settings('staging')).toEqual({
    name: 'staging',
    title: {},
    labels: { value: { env: 'staging' }, managed: itsSecret('staging', 'lumovi.dev/labels') },
    groups: { value: ['developers', 'qa'], managed: itsSecret('staging', 'lumovi.dev/groups') },
    origin: {
      kind: 'secret',
      tool: 'lumovi',
      secret: 'staging',
      namespace: 'lumovi',
      uid: expect.any(String),
    },
    removable: false,
  })
  expect(await settings('qa')).toMatchObject({
    labels: {
      value: { env: 'qa' },
      managed: { by: 'its Secret, several', in: [{ key: 'lumovi.dev', context: 'qa' }] },
    },
    groups: { value: [] },
  })
  expect((await settings('qa')).groups.managed).toBeUndefined()
  expect(await settings('hub')).toMatchObject({
    labels: {
      value: { env: 'ops' },
      managed: { by: 'the server’s settings', in: [{ key: 'LUMOVI_CLUSTER_LABELS' }] },
    },
    origin: { kind: 'this' },
  })
  expect(await settings('prod-us')).toMatchObject({
    labels: {
      value: { env: 'production', tier: 'gold' },
      managed: itsSecret('cluster-prod-us', 'metadata.labels', 'lumovi.dev/labels'),
    },
    origin: { kind: 'secret', tool: 'argocd', secret: 'cluster-prod-us', namespace: 'argocd' },
  })
  // What a source leaves unset, the page sets.
  expect(await settings('bare')).toEqual(
    expect.objectContaining({ labels: { value: {} }, groups: { value: [] } }),
  )
  expect(await settings('workload-1')).toMatchObject({
    origin: { kind: 'secret', tool: 'cluster-api' },
  })
})
