/**
 * Clusters added on the Fleet page by kubeconfig or token, where the server allows it: checked,
 * kept as Lumovi's own Secrets in its namespace, and removed with them.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { audited, expect, inCluster, test } from './fixtures.ts'
import { as } from './fleet.ts'

/** What a fleet call from the page gives, or its error's message. */
const call = (
  page: Page,
  method: 'check' | 'add' | 'remove' | 'joins' | 'settings',
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

/** A kubeconfig of the demo cluster, as someone would paste it, with `user` its user's. */
function kubeconfig(
  clusters: TestClusters,
  user: Record<string, unknown> = { token: 'lumovi-demo-token' },
  cluster: Record<string, unknown> = {},
  contexts = ['lab'],
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
          ...cluster,
        },
      },
    ],
    users: [{ name: 'hub', user }],
    contexts: contexts.map((name) => ({ name, context: { cluster: 'demo', user: 'hub' } })),
    'current-context': contexts[0],
  })
}

/** A hub in the demo cluster, with admins, keeping what it must, adding from its page or not. */
function hubEnv(clusters: TestClusters, add = true) {
  return {
    ...inCluster(clusters).env,
    KUBECONFIG: undefined,
    LUMOVI_CONTEXT: undefined,
    LUMOVI_AUTH: 'proxy',
    LUMOVI_FLEET_LOCAL: 'false',
    LUMOVI_FLEET_REFRESH_SECONDS: '1',
    LUMOVI_ADMINS: 'user:admin@example.com',
    LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-added-')),
    ...(add ? { LUMOVI_FLEET_ADD_FROM_PAGE: 'true' } : { LUMOVI_FLEET_SECRETS: 'lumovi' }),
  }
}

/** The namespace the hub runs in, where it keeps what's added. */
const ownNamespace = (clusters: TestClusters) =>
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'lumovi' },
  } as KubeObject)

const names = (page: Page) =>
  page.evaluate(() =>
    window.lumovi!.kube.contexts().then(({ contexts }) => contexts.map((c) => c.name)),
  )

test('off unless the server allows it', async ({ page, context, serve, clusters }) => {
  const hub = await serve({ env: hubEnv(clusters, false) })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  expect(await call(page, 'joins')).toMatchObject({ value: { addFromPage: false, added: [] } })
  const off =
    'Adding clusters by kubeconfig or token is off on this server. It’s turned on with the Helm value fleet.addFromPage.'
  expect(await call(page, 'check', { kubeconfig: kubeconfig(clusters) })).toEqual({ error: off })
  expect(
    await call(page, 'add', {
      name: 'lab',
      labels: {},
      groups: [],
      source: { kubeconfig: kubeconfig(clusters) },
    }),
  ).toEqual({ error: off })
})

test('an admin adds a cluster by kubeconfig: checked, kept as Lumovi’s Secret, removed with it', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  ownNamespace(clusters)
  const hub = await serve({ env: hubEnv(clusters) })
  // Someone else may not.
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  expect(await call(page, 'check', { kubeconfig: kubeconfig(clusters) })).toEqual({
    error: 'Only Lumovi’s admins add clusters to the fleet.',
  })

  await as(context, 'admin@example.com')
  await page.reload()
  expect(await call(page, 'joins')).toMatchObject({ value: { addFromPage: true, added: [] } })
  const host = new URL(clusters.demo.url).host
  expect(await call(page, 'check', { kubeconfig: kubeconfig(clusters) })).toEqual({
    value: {
      checks: [
        { result: 'ok', title: 'It reads as a kubeconfig', detail: 'lab · user hub' },
        {
          result: 'ok',
          title: 'The server answers',
          detail: expect.stringMatching(new RegExp(`^${host} · v1\\.\\d+\\.\\d+ · \\d+ ms$`)),
        },
        {
          result: 'ok',
          title: 'The credentials work',
          detail: expect.stringMatching(/^Signed in as .+ · may act as each person$/),
        },
      ],
      passed: true,
      name: 'lab',
    },
  })

  expect(
    await call(page, 'add', {
      name: 'lab',
      labels: { env: 'lab' },
      groups: ['platform'],
      source: { kubeconfig: kubeconfig(clusters) },
    }),
  ).toEqual({})
  // Kept as Lumovi's own Secret, in its namespace, labelled as the hub reads them.
  const secret = clusters.demo.object('Secret', 'lumovi', 'lumovi-cluster-lab') as KubeObject & {
    data: { kubeconfig: string }
  }
  expect(secret.metadata.labels).toEqual({
    'lumovi.dev/cluster': '',
    'app.kubernetes.io/managed-by': 'lumovi',
  })
  const kept = JSON.parse(Buffer.from(secret.data.kubeconfig, 'base64').toString()) as {
    contexts: { name: string }[]
    users: { user: Record<string, unknown> }[]
  }
  expect(kept.contexts.map((c) => c.name)).toEqual(['lab'])
  expect(kept.users[0]!.user).toEqual({ token: 'lumovi-demo-token' })
  // In the fleet at once, with what the page set; the page's to remove.
  expect(await names(page)).toContain('lab')
  expect(await call(page, 'settings', 'lab')).toEqual({
    value: expect.objectContaining({
      labels: { value: { env: 'lab' } },
      groups: { value: ['platform'] },
      origin: expect.objectContaining({
        kind: 'secret',
        tool: 'lumovi',
        secret: 'lumovi-cluster-lab',
      }),
      removable: true,
      added: { at: expect.any(String), by: 'admin@example.com' },
    }),
  })
  expect(await call(page, 'joins')).toMatchObject({ value: { added: ['lab'] } })
  expect(audited(hub, 'cluster.added')).toEqual([
    expect.objectContaining({
      cluster: 'lab',
      details: {
        server: host,
        secret: 'lumovi/lumovi-cluster-lab',
        labels: ['env=lab'],
        groups: ['platform'],
      },
    }),
  ])
  expect(hub.log()).not.toContain('lumovi-demo-token')
  // A name the fleet has is another's.
  expect(
    await call(page, 'add', {
      name: 'lab',
      labels: {},
      groups: [],
      source: { kubeconfig: kubeconfig(clusters) },
    }),
  ).toEqual({ error: 'The fleet has a cluster called lab already: give this one another name.' })

  // Removed: its Secret deleted, the cluster gone, recorded.
  expect(await call(page, 'remove', 'lab')).toEqual({})
  expect(clusters.demo.object('Secret', 'lumovi', 'lumovi-cluster-lab')).toBeUndefined()
  expect(await names(page)).not.toContain('lab')
  expect(audited(hub, 'cluster.removed')).toEqual([
    expect.objectContaining({ cluster: 'lab', outcome: 'success' }),
  ])

  // One whose Secret was made again since, by someone else, isn't Lumovi's to delete.
  await call(page, 'add', {
    name: 'lab',
    labels: {},
    groups: [],
    source: { kubeconfig: kubeconfig(clusters) },
  })
  const made = clusters.demo.object('Secret', 'lumovi', 'lumovi-cluster-lab')!
  clusters.demo.remove('Secret', 'lumovi', 'lumovi-cluster-lab')
  clusters.demo.upsert({ ...made, metadata: { ...made.metadata, uid: 'someone-elses' } })
  expect(await call(page, 'remove', 'lab')).toEqual({
    error:
      'The Secret lumovi/lumovi-cluster-lab was made again since Lumovi made it: it’s left as it is, and no longer Lumovi’s to remove.',
  })
  expect(clusters.demo.object('Secret', 'lumovi', 'lumovi-cluster-lab')).toBeDefined()
})

test('what the hub can’t use is refused, saying why; a token, a server and its CA are checked too', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({ env: hubEnv(clusters) })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  ownNamespace(clusters)
  const checked = async (source: object) => {
    const result = await call(page, 'check', source)
    if (result.error) throw new Error(result.error)
    return result.value as {
      checks: { result: string; title: string; detail?: string; plugin?: true }[]
      passed: boolean
    }
  }
  const failed = async (source: object) =>
    (await checked(source)).checks.filter((check) => check.result === 'bad')

  // A credential plugin: refused, not asked about (the hub runs no programs).
  const exec = {
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    command: 'aws',
    args: ['eks', 'get-token', '--cluster-name', 'payments-prod'],
  }
  expect(await failed({ kubeconfig: kubeconfig(clusters, { exec }) })).toEqual([
    {
      result: 'bad',
      title: 'It signs in by running a program',
      detail: 'aws eks get-token --cluster-name payments-prod',
      hint: 'This server can’t run programs, so it can’t use this kubeconfig. Use a token instead, such as a service account’s, or connect the cluster with an agent.',
      plugin: true,
    },
  ])
  expect(
    await call(page, 'add', {
      name: 'payments',
      labels: {},
      groups: [],
      source: { kubeconfig: kubeconfig(clusters, { exec }) },
    }),
  ).toEqual({ error: 'It can’t be added: It signs in by running a program.' })
  expect((await failed({ kubeconfig: kubeconfig(clusters, {}) })).map((c) => c.title)).toEqual([
    'It has no credentials',
  ])
  expect(
    (
      await failed({
        kubeconfig: kubeconfig(clusters, {
          'client-certificate': '/home/me/.kube/me.crt',
          'client-key': '/home/me/.kube/me.key',
        }),
      })
    ).map((c) => [c.title, c.detail]),
  ).toEqual([['It points at files on your computer', 'client-certificate, client-key']])
  expect(
    (
      await failed({
        kubeconfig: kubeconfig(clusters, undefined, { 'insecure-skip-tls-verify': true }),
      })
    ).map((c) => c.title),
  ).toEqual(['It doesn’t check the server’s certificate'])
  expect(
    (
      await failed({
        kubeconfig: kubeconfig(clusters, undefined, { server: 'http://127.0.0.1:1' }),
      })
    ).map((c) => c.title),
  ).toEqual(['Its server isn’t https'])
  expect(
    (await failed({ kubeconfig: kubeconfig(clusters, undefined, {}, ['lab', 'other']) })).map(
      (c) => c.title,
    ),
  ).toEqual(['It has 2 contexts'])
  expect((await failed({ kubeconfig: 'clusters: [' })).map((c) => c.title)).toEqual([
    'It doesn’t read as a kubeconfig',
  ])
  // Its credentials don't work; or they do, but can't act as each person.
  expect(
    (await failed({ kubeconfig: kubeconfig(clusters, { token: 'nobodys' }) })).map((c) => c.title),
  ).toEqual(['The credentials don’t work'])
  clusters.demo.deny({ verb: 'impersonate', resource: 'users' })
  expect((await failed({ kubeconfig: kubeconfig(clusters) })).map((c) => c.title)).toEqual([
    'It can’t act as each person',
  ])
  // (As it was: the namespace again too.)
  clusters.demo.reset()
  ownNamespace(clusters)

  // A server, a token and its CA.
  const token = { server: clusters.demo.url, token: 'lumovi-demo-token', ca: clusters.demo.caPem }
  expect(await checked(token)).toMatchObject({
    passed: true,
    checks: [
      { result: 'ok', title: 'Its server, token and CA read' },
      { result: 'ok', title: 'The server answers' },
      { result: 'ok', title: 'The credentials work' },
    ],
  })
  expect((await failed({ ...token, ca: 'not one' })).map((c) => c.title)).toEqual([
    'Its CA isn’t a certificate',
  ])
  expect((await failed({ ...token, server: 'lumovi' })).map((c) => c.title)).toEqual([
    'Its server isn’t an address',
  ])
  expect(
    await call(page, 'add', { name: 'token-lab', labels: {}, groups: [], source: token }),
  ).toEqual({})
  await expect.poll(() => names(page)).toContain('token-lab')
})

test('an admin adds a cluster from the Fleet page: pasted, checked, named, then removed', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  ownNamespace(clusters)
  const hub = await serve({ env: hubEnv(clusters) })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  await page.getByRole('button', { name: 'Add cluster' }).click()
  await page.getByRole('menuitem', { name: /^Paste a kubeconfig…/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a cluster' })
  const paste = async (text: string) => {
    await dialog.getByRole('textbox', { name: 'Its kubeconfig' }).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(text)
  }

  // A credential plugin: refused, with what works instead.
  await paste(
    kubeconfig(clusters, {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1beta1',
        command: 'aws',
        args: ['eks', 'get-token', '--cluster-name', 'payments-prod'],
      },
    }),
  )
  await dialog.getByRole('button', { name: 'Check it' }).click()
  await expect(dialog.getByRole('list', { name: 'Checks' })).toContainText(
    'It signs in by running a programaws eks get-token --cluster-name payments-prodThis server can’t run programs',
  )
  await expect(dialog.getByRole('button', { name: 'Connect with an agent' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Use a token' }).click()
  await expect(dialog.getByLabel('Server')).toBeVisible()
  await dialog.getByRole('button', { name: /A kubeconfig/ }).click()

  // One that works: checked, named as its context, labelled and shared, added.
  await paste(kubeconfig(clusters))
  await dialog.getByRole('button', { name: 'Check it' }).click()
  await expect(dialog.getByRole('list', { name: 'Checks' }).getByRole('listitem')).toHaveCount(3)
  await expect(dialog.getByRole('img', { name: 'Failed' })).toHaveCount(0)
  await expect(dialog.getByLabel('Name')).toHaveValue('lab')
  await dialog.getByRole('textbox', { name: 'Add a label' }).fill('env=lab')
  await dialog.getByRole('textbox', { name: 'Add a label' }).press('Enter')
  await dialog.getByRole('button', { name: 'Add to the fleet' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Added lab to the fleet',
  )
  const card = page.getByRole('link', { name: /^lab, / })
  await expect(card).toContainText('env=lab')

  // Its settings say where it's kept; removed, its Secret goes with it.
  await page.getByRole('button', { name: 'lab’s actions' }).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const settings = page.getByRole('dialog', { name: 'lab' })
  await expect(settings).toContainText('Comes fromThis pageAdded')
  await expect(settings).toContainText('Kept asthe Secret lumovi/lumovi-cluster-lab')
  await settings.getByRole('button', { name: 'Remove from the fleet…' }).click()
  const removing = page.getByRole('dialog', { name: 'Remove lab?' })
  await expect(removing).toContainText('Lumovi deletes the Secret it kept it as')
  await expect(removing).not.toContainText('helm uninstall')
  await removing.getByLabel('Type lab to confirm').fill('lab')
  await removing.getByRole('button', { name: 'Remove' }).click()
  await expect(removing).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Removed lab from the fleet',
  )
  await expect(settings).toHaveCount(0)
  await expect(card).toHaveCount(0)
  expect(clusters.demo.object('Secret', 'lumovi', 'lumovi-cluster-lab')).toBeUndefined()
})

test('where adding is off, its menu says how it’s turned on', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({ env: hubEnv(clusters, false) })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  await page.getByRole('button', { name: 'Add cluster' }).click()
  await expect(page.getByRole('menuitem', { name: /^Connect with an agent…/ })).toBeEnabled()
  for (const item of [/^Paste a kubeconfig…/, /^Use a token…/]) {
    await expect(page.getByRole('menuitem', { name: item })).toHaveAttribute('data-disabled', '')
  }
  await expect(page.getByRole('menu')).toContainText(
    'Adding by kubeconfig or token is off on this server. It’s turned on with the Helm value fleet.addFromPage.',
  )
})
