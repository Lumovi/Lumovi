/**
 * What AI assistants may do on a Lumovi server: each person's own rules,
 * kept for them (in a ConfigMap, a file, or memory), under the
 * administrator's, which nothing loosens; in one cluster, or across a fleet.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AiPermissions } from '../../src/shared/ai-permissions.ts'
import { FLEET } from '../mock-cluster/fleet.ts'
import { addRule, openPermissions, rulesNow } from '../e2e/ai-rules.ts'
import { call, connect } from './assistant-client.ts'
import { as, fleetEnv } from './fleet.ts'
import { DEMO, expect, inCluster, PEOPLE, refusedConfig, signIn, test } from './fixtures.ts'

const DEFAULTS = { changes: 'ask', secrets: 'keys', env: 'sensitive', logs: 'read' } as const

/** Keeps these as the signed-in person's AI permissions. */
const permit = (page: Page, permissions: AiPermissions) =>
  page.evaluate((given) => window.lumovi!.aiPermissions!.set(given as never), permissions)

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

/** The checked namespace's settings, as the page says them. */
async function checked(page: Page, namespace: string) {
  const check = page.getByRole('region', { name: 'Check a namespace' })
  await check.getByRole('searchbox', { name: 'Namespace' }).fill(namespace)
  await check
    .getByRole('button', { name: new RegExp(`^${namespace}`) })
    .first()
    .click()
  return check.getByRole('definition')
}

const RULES = `
- name: System namespaces
  namespaces: [kube-*]
  visibility: hidden
- name: Production
  changes: ask
  secrets: keys
- name: Shop logs
  namespaces: shop
  logs: off
`

test('an administrator’s rules are limits nobody’s own loosen', async ({ page, serve }) => {
  const served = await serve({
    env: { LUMOVI_ASSISTANT_RULES: RULES, LUMOVI_APPROVAL_SLICE_MS: '1000' },
  })
  expect(served.log()).toContain(
    'People’s AI rules are kept in memory: they’re lost when Lumovi stops. Set LUMOVI_DATA_DIR, or install the Helm chart, to keep them.',
  )
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  // Before she allows it, what it may do, counted.
  const { client } = await connect(page, served, {
    beforeAllow: async () => {
      await expect(
        page.getByRole('list', { name: 'What it may do' }).getByRole('listitem'),
      ).toHaveText([
        /^See \d+ namespaces in 1 cluster; 1 hidden from it\.$/,
        /^Ask you before it changes anything in \d+ namespaces, and never change 0\.$/,
        'Change 0 namespaces without asking.',
        'Read Secrets’ values in 0 namespaces.',
        /^Read logs in \d+ namespaces\.$/,
      ])
      await expect(
        page.getByRole('link', { name: 'Change what assistants may do' }),
      ).toHaveAttribute('href', `${served.url}assistants/permissions`)
    },
  })
  await page.goto(`${served.url}assistants/permissions`)
  await expect(page.getByRole('note')).toContainText(
    'This server keeps AI permissions in memory: when it restarts, yours are gone',
  )

  // Hers to see, not to change.
  await expect(page.getByRole('article', { name: 'System namespaces' })).toHaveText(
    /^System namespacesSet by your administratorkube-\*Hidden from assistants1 namespace$/,
  )
  await expect(page.getByRole('article', { name: 'Production' })).toHaveText(
    /^ProductionSet by your administratorall namespacesChanges always askNever Secret values\d+ namespaces$/,
  )
  await expect(page.getByRole('article', { name: 'Shop logs' })).toContainText('No logs')

  // What she'd loosen is said to stay as the administrator set it.
  const defaults = page.getByRole('region', { name: 'Defaults' })
  await defaults
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Without asking' })
    .click()
  await defaults
    .getByRole('group', { name: 'Secrets' })
    .getByRole('button', { name: 'Values' })
    .click()
  await expect(defaults).toContainText('Your administrator keeps “Production” at Ask you.')
  await expect(defaults).toContainText(
    'Assistants read Secret values, and send them to their model’s provider.',
  )
  await expect(defaults).toContainText('Your administrator keeps “Production” at Keys only.')
  await addRule(page, { name: 'Shop', namespaces: ['shop'], set: { Logs: 'Read' } })
  await page.getByRole('button', { name: /^Shop\b/, expanded: false }).click()
  await expect(page.getByRole('article', { name: 'Shop', exact: true })).toContainText(
    'Shop logs: Logs stay at Don’t read in 1 of these namespaces, as your administrator set.',
  )
  const shop = await checked(page, 'shop')
  await expect(shop).toHaveText([
    'VisibleDefaults',
    'Ask youProduction, by your administrator',
    'Keys onlyProduction, by your administrator',
    'Hide sensitiveDefaults',
    'Don’t readShop logs, by your administrator',
  ])
  await expect
    .poll(
      async () => (await page.evaluate(() => window.lumovi!.aiPermissions!.get())).mine.defaults,
    )
    .toEqual({
      ...DEFAULTS,
      changes: 'allow',
      secrets: 'values',
    })

  // Its assistant keeps to them.
  expect(
    await call(client, 'get_logs', {
      cluster: 'demo',
      namespace: 'shop',
      pod: DEMO.pods.storefront[0],
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants read logs in shop: this server’s administrator says so (“Shop logs”).',
  })
  const secret = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'secret',
    namespace: 'data',
    name: 'postgres-credentials',
  })
  expect(secret.text).toContain('password: (hidden by Lumovi)')
  const scaling = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  expect(scaling.text).toMatch(/^Still waiting for the person’s answer/)
  await page
    .getByRole('dialog', { name: 'Scale Deployment cart to 3 replicas' })
    .getByRole('button', { name: 'Later' })
    .click()
  expect(
    await call(client, 'list_resources', {
      cluster: 'demo',
      kind: 'pods',
      namespace: 'kube-system',
    }),
  ).toEqual({ error: false, text: 'kind: Pod\ntotal: 0\nitems: []\n' })
  const told = await call(client, 'list_clusters')
  expect(told.text).toContain(
    '    changes: ask\n    secrets: keys\n    env: sensitive\n    logs: read\n    inSomeNamespaces:\n      - namespaces: shop\n        logs: at most off\n      - namespaces: shop\n        logs: read\n',
  )
  expect(told.text).not.toContain('kube-')
})

test('each person’s rules are theirs, on every page of theirs, and kept in a file', async ({
  page,
  browser,
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: dir }
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const other = await page.context().newPage()
  await other.goto(`${served.url}assistants/permissions`)
  await openPermissions(page)
  await expect(page.getByRole('note')).toHaveCount(0)

  // Changed on one page: the other follows.
  await addRule(page, { name: 'Shop', namespaces: ['shop'], set: { Logs: 'Don’t read' } })
  await expect(other.getByRole('article', { name: 'Shop' })).toContainText('No logs')
  // Bob's are his.
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo`, PEOPLE.bob.token)
  expect(await rulesNow(bob)).toEqual([])
  await elsewhere.close()

  // Kept, for the server's next start, readable by it alone.
  const file = join(dir, 'assistant-rules.json')
  const kept = JSON.parse(readFileSync(file, 'utf8'))
  expect(kept).toEqual({
    version: 1,
    people: {
      'alice@example.com': {
        defaults: DEFAULTS,
        rules: [
          {
            id: expect.any(String),
            name: 'Shop',
            clusters: [],
            namespaces: ['shop'],
            set: { logs: 'off' },
          },
        ],
      },
    },
  })
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  await served.stop()
  // Her session outlives the server too (it's kept beside them): she's still signed in, her
  // own token unsealed with her cookie, and finds them.
  const again = await serve({ env, port: served.port })
  await page.goto(`${again.url}cluster/demo`)
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
  expect((await rulesNow(page)).map((r) => r.name)).toEqual(['Shop'])
  expect((await page.evaluate(() => window.lumovi!.aiPermissions!.get())).kept).toBe('file')
  await again.stop()
})

test('kept files that don’t make sense stop the server', async ({ clusters }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const file = join(dir, 'assistant-rules.json')
  const refused = () => refusedConfig(clusters, { LUMOVI_DATA_DIR: dir })
  writeFileSync(file, 'nope')
  expect(await refused()).toContain(
    `${file} isn’t JSON: Lumovi can’t read the AI rules it kept there.`,
  )
  writeFileSync(file, '{}')
  expect(await refused()).toContain(`${file} doesn’t hold the AI rules Lumovi keeps (no people).`)
  writeFileSync(file, JSON.stringify({ people: { 'alice@example.com': { defaults: 5 } } }))
  expect(await refused()).toContain(
    `${file}: alice@example.com’s AI rules: AI permissions need their defaults.`,
  )
  const unreadable = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  mkdirSync(join(unreadable, 'assistant-rules.json'))
  expect(await refusedConfig(clusters, { LUMOVI_DATA_DIR: unreadable })).toContain(
    `Lumovi can’t read ${join(unreadable, 'assistant-rules.json')}: EISDIR`,
  )
})

test('in a ConfigMap of the namespace Lumovi runs in, as the chart keeps them', async ({
  page,
  serve,
  clusters,
}) => {
  const sa = inCluster(clusters)
  const env = { ...sa.env, LUMOVI_ASSISTANT_RULES_CONFIGMAP: 'lumovi-assistant-rules' }
  const demo = clusters.demo
  // Not there: the server says so, and doesn't start.
  expect(await refusedConfig(clusters, env)).toContain(
    'Lumovi can’t read ConfigMap lumovi/lumovi-assistant-rules, where it keeps people’s AI rules: configmaps "lumovi-assistant-rules" not found',
  )
  const configMap = (data?: Record<string, string>) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'lumovi-assistant-rules',
      namespace: 'lumovi',
      creationTimestamp: ago(60),
      annotations: { 'helm.sh/resource-policy': 'keep' },
    },
    ...(data ? { data } : {}),
  })
  demo.upsert(configMap({ 'rules.json': 'nope' }))
  expect(await refusedConfig(clusters, env)).toContain(
    'ConfigMap lumovi/lumovi-assistant-rules isn’t JSON: Lumovi can’t read the AI rules it kept there.',
  )
  // As the chart makes it: empty.
  demo.upsert(configMap())
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const alice = { defaults: DEFAULTS, rules: [] }
  await permit(page, { ...alice, defaults: { ...DEFAULTS, logs: 'off' } })
  const stored = () =>
    JSON.parse(
      (
        demo.object('ConfigMap', 'lumovi', 'lumovi-assistant-rules')!.data as Record<string, string>
      )['rules.json']!,
    ).people
  expect(stored()).toEqual({
    'alice@example.com': { ...alice, defaults: { ...DEFAULTS, logs: 'off' } },
  })
  expect((await page.evaluate(() => window.lumovi!.aiPermissions!.get())).kept).toBe('configmap')
  // Its data alone is written: the chart's annotation (uninstalling keeps it) stays.
  expect(
    demo.object('ConfigMap', 'lumovi', 'lumovi-assistant-rules')!.metadata.annotations,
  ).toEqual({ 'helm.sh/resource-policy': 'keep' })

  // Changed by someone else meanwhile: theirs kept, with hers.
  const bob = { defaults: { ...DEFAULTS, changes: 'never' }, rules: [] }
  demo.upsert(
    configMap({ 'rules.json': JSON.stringify({ version: 1, people: { 'bob@example.com': bob } }) }),
  )
  await permit(page, alice)
  expect(stored()).toEqual({ 'bob@example.com': bob, 'alice@example.com': alice })

  // Lumovi can't write it: the page says so, and tries again when asked.
  await page.goto(`${served.url}assistants/permissions`)
  const refusing = demo.fail(/\/configmaps\/lumovi-assistant-rules$/, { status: 403 })
  await page
    .getByRole('region', { name: 'Defaults' })
    .getByRole('group', { name: 'Logs' })
    .getByRole('button', { name: 'Don’t read' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    /^Not kept: Lumovi couldn’t keep your AI rules: .+Try again$/,
  )
  refusing()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Kept$/ })).toBeVisible()
  expect(stored()['alice@example.com'].defaults.logs).toBe('off')

  // Changed again while the last change is being kept: each kept, in turn.
  const slow = demo.fail(/\/configmaps\/lumovi-assistant-rules$/, { delayMs: 1_500 })
  const defaults = page.getByRole('region', { name: 'Defaults' })
  await defaults
    .getByRole('group', { name: 'Logs' })
    .getByRole('button', { name: 'Read', exact: true })
    .click()
  await expect(page.getByRole('status').filter({ hasText: /^Keeping…$/ })).toBeVisible()
  await defaults
    .getByRole('group', { name: 'Env values' })
    .getByRole('button', { name: 'Hide all' })
    .click()
  await expect
    .poll(() => stored()['alice@example.com'].defaults, { timeout: 15_000 })
    .toEqual({ ...DEFAULTS, env: 'all' })
  slow()

  // More than a ConfigMap holds: refused, before it's tried.
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    name: `Rule ${i}`,
    clusters: [],
    namespaces: Array.from({ length: 50 }, (_, j) => `n${j}-${'x'.repeat(200)}`),
    set: { logs: 'off' },
  }))
  expect(
    await page.evaluate(
      (rules) =>
        window
          .lumovi!.aiPermissions!.set({
            defaults: { changes: 'ask', secrets: 'keys', env: 'sensitive', logs: 'read' },
            rules,
          } as never)
          .catch((error: Error) => error.message),
      many,
    ),
  ).toBe('Lumovi can’t keep more AI rules: everyone’s together would be over 1 MB.')
})

test('settings for assistants’ rules that don’t make sense stop the server', async ({
  clusters,
}) => {
  const rules = async (setting: string) =>
    refusedConfig(clusters, { LUMOVI_ASSISTANT_RULES: setting })
  expect(await rules('not: [valid')).toContain('LUMOVI_ASSISTANT_RULES isn’t YAML: ')
  // Base64 of what isn't text.
  expect(await rules('//79')).toContain(
    'LUMOVI_ASSISTANT_RULES must be YAML, or YAML encoded in base64.',
  )
  for (const [setting, message] of [
    [
      '{}',
      'LUMOVI_ASSISTANT_RULES must be a list of rules, each with a name, where it applies, and what it limits.',
    ],
    ['[5]', 'LUMOVI_ASSISTANT_RULES[0] must be a rule: a name, where, and what it says.'],
    ['[{logs: off}]', 'LUMOVI_ASSISTANT_RULES[0] needs a name, of up to 100 characters.'],
    [
      '[{name: x}]',
      'LUMOVI_ASSISTANT_RULES[0] (x) limits nothing: give it visibility, changes, secrets, env or logs.',
    ],
    [
      '[{name: x, logs: maybe}]',
      'LUMOVI_ASSISTANT_RULES[0]’s logs must be read, off, not “maybe”.',
    ],
    [
      '[{name: x, logs: read}]',
      'LUMOVI_ASSISTANT_RULES[0] (x) says logs: read, which limits nothing: it’s the loosest there is.',
    ],
    [
      '[{name: Production, clusters: [env=production], changes: ask}]',
      'The AI rule “Production” matches clusters by the label env, which this server’s cluster doesn’t have: give it its labels (LUMOVI_CLUSTER_LABELS, the chart’s clusterLabels), or name it.',
    ],
    [
      '[{name: x, colour: red}]',
      'LUMOVI_ASSISTANT_RULES[0] says “colour”, which isn’t a setting: visibility, changes, secrets, env, logs.',
    ],
    [
      '[{name: x, namespaces: 5, logs: off}]',
      'LUMOVI_ASSISTANT_RULES[0]’s namespaces must be a list of up to 50 names, patterns or labels.',
    ],
    [
      '[{name: x, namespaces: [a b], logs: off}]',
      'LUMOVI_ASSISTANT_RULES[0]’s namespaces[0] (“a b”): It has a space.',
    ],
    [
      '[{name: x, namespaces: [""], logs: off}]',
      'LUMOVI_ASSISTANT_RULES[0]’s namespaces[0] (“”): It’s empty.',
    ],
    [
      `[{name: x, namespaces: [${'n'.repeat(254)}], logs: off}]`,
      'It’s longer than 253 characters.',
    ],
    ['[{name: x, namespaces: ["!!x"], logs: off}]', 'It has more than one “!”.'],
    [
      '[{name: x, clusters: ["=x"], logs: off}]',
      'A label is key=value, as Kubernetes spells them (team=payments).',
    ],
  ] as const) {
    expect(await rules(setting), setting).toContain(message)
  }
  expect(await refusedConfig(clusters, { LUMOVI_ASSISTANT_CHANGES: 'ask,a b=never' })).toContain(
    'LUMOVI_ASSISTANT_CHANGES must be ask, allow or never, with clusters\' own after it (ask,staging=allow), not "ask,a b=never".',
  )
  expect(
    await refusedConfig(clusters, { LUMOVI_ASSISTANT_RULES_CONFIGMAP: 'Not_Valid' }),
  ).toContain(
    'LUMOVI_ASSISTANT_RULES_CONFIGMAP must name a ConfigMap, like lumovi-assistant-rules, not "Not_Valid".',
  )
  expect(
    await refusedConfig(clusters, { LUMOVI_ASSISTANT_RULES_CONFIGMAP: 'lumovi-assistant-rules' }),
  ).toContain(
    'LUMOVI_ASSISTANT_RULES_CONFIGMAP keeps people’s AI rules in the cluster Lumovi runs in, and it isn’t running in one (KUBERNETES_SERVICE_HOST isn’t set).',
  )
})

test('in a fleet, rules match clusters by name or label, and some can’t be counted', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await as(context, 'alice@example.com', 'developers')
  const served = await serve({ env: fleetEnv(clusters) })
  await page.goto(served.url)
  await permit(page, {
    defaults: { ...DEFAULTS, changes: 'allow', secrets: 'values' },
    rules: [],
  })
  // What it may do: changes without asking, and Secrets' values, said in warning's colours.
  const { client } = await connect(page, served, {
    beforeAllow: async () => {
      const facts = page.getByRole('list', { name: 'What it may do' }).getByRole('listitem')
      await expect(facts.nth(2)).toHaveText(/^Change \d+ namespaces without asking\.$/)
      await expect(facts.nth(2)).toHaveClass(/text-warn-text/)
      await expect(facts.nth(3)).toHaveClass(/text-warn-text/)
      await expect(
        page.getByText(`Not counted: ${FLEET.edge}, whose namespaces can’t be listed.`),
      ).toBeVisible()
    },
  })
  await page.goto(served.url)
  await openPermissions(page)
  await expect(page.getByRole('banner')).toContainText('Fleet4 clusters')

  // By a label clusters have: production's.
  await page.getByRole('button', { name: 'Add rule' }).click()
  const editor = page.getByRole('article').last()
  await editor.getByLabel('Clusters', { exact: true }).fill('env')
  await expect(
    editor.getByRole('group', { name: 'Suggestions for Clusters' }).getByRole('button'),
  ).toHaveText([
    'Patternenv*none yet',
    'Labelenv=production3 clusters',
    'Labelenv=staging1 cluster',
  ])
  await editor.getByLabel('Clusters', { exact: true }).fill('env=production')
  await editor.getByLabel('Clusters', { exact: true }).press('Enter')
  await editor.getByLabel('Name', { exact: true }).fill('Production')
  await editor
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Ask you' })
    .click()
  await editor.getByRole('button', { name: 'Done' }).click()
  const production = page.getByRole('article', { name: 'Production' })
  await expect(production).toContainText('env=production  /  all namespaces')
  await expect(production).toContainText(/\d+ namespaces · 2 clusters/)
  await expect
    .poll(async () => (await rulesNow(page)).map((r) => r.clusters))
    .toEqual([['env=production']])
  await expect(page.getByLabel('What assistants are told')).toContainText(
    `- name: ${FLEET.staging}`,
  )
  // Its assistant hears the same: production's clusters ask, staging's don't.
  const told = await call(client, 'list_clusters')
  expect(told.text).toMatch(new RegExp(`name: ${FLEET.prodEu}\\n(.*\\n)*?\\s+changes: ask\\n`))
  expect(told.text).toMatch(new RegExp(`name: ${FLEET.staging}\\n(.*\\n)*?\\s+changes: allow\\n`))
})

test('LUMOVI_ASSISTANT_CHANGES, as limits: a cluster’s never refuses its changes', async ({
  page,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_ASSISTANT_CHANGES: 'allow, demo = never' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  expect(
    await call(client, 'restart', {
      cluster: 'demo',
      kind: 'deploy',
      namespace: 'shop',
      name: DEMO.deployments.cart,
      reason: 'Stale.',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants change shop in demo: this server’s administrator says so (“Changes to demo (LUMOVI_ASSISTANT_CHANGES)”). Nothing was changed.',
  })
  await page.goto(`${served.url}assistants/permissions`)
  await expect(
    page.getByRole('article', { name: 'Changes to demo (LUMOVI_ASSISTANT_CHANGES)' }),
  ).toContainText('No changes')
})

test('one cluster, labelled: rules match it by its labels', async ({ page, serve }) => {
  const served = await serve({
    env: {
      LUMOVI_CLUSTER_LABELS: 'env=production',
      LUMOVI_ASSISTANT_RULES: '[{name: Production, clusters: [env=production], changes: never}]',
    },
  })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  expect(
    (
      await call(client, 'restart', {
        cluster: 'demo',
        kind: 'deploy',
        namespace: 'shop',
        name: DEMO.deployments.cart,
        reason: 'Stale.',
      })
    ).text,
  ).toBe(
    'Lumovi doesn’t let AI assistants change shop in demo: this server’s administrator says so (“Production”). Nothing was changed.',
  )
})
