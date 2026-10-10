/**
 * Lumovi's metrics stack, from Lumovi served in a cluster: its admins' to install and remove
 * (it makes cluster roles, and is everyone's once it's there), as themselves, so their RBAC
 * decides; and a server can turn it off.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { METRICS_STACK } from '../../src/shared/metrics-stack.ts'
import { expect, test } from './fixtures.ts'

const { namespace: NAMESPACE, release: RELEASE } = METRICS_STACK
const ADMINS = { LUMOVI_AUTH: 'proxy', LUMOVI_ADMINS: 'platform-admins' }

async function as(context: BrowserContext, user: string, groups: string) {
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups })
}

const status = (page: Page) =>
  page.evaluate(async () => {
    const found = await window.lumovi!.metricsStack.status('demo')
    return found.ok ? found.data : found.error
  })
const install = (page: Page, dryRun = false) =>
  page.evaluate(
    (dryRun) => window.lumovi!.metricsStack.install({ context: 'demo', dryRun }),
    dryRun,
  )
const uninstall = (page: Page) =>
  page.evaluate(() => window.lumovi!.metricsStack.uninstall({ context: 'demo' }))

test('only Lumovi’s admins install it and remove it, as themselves', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: ADMINS })
  const made = () => clusters.demo.object('Namespace', undefined, NAMESPACE)

  // Someone who isn't one is told who does, and gets nothing done: not even a dry run.
  await as(context, 'dev@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo`)
  const ONLY_ADMINS = 'Only Lumovi’s admins install or remove its metrics stack. Ask one of them.'
  expect(await status(page)).toMatchObject({
    state: 'absent',
    off: { reason: 'admins', message: ONLY_ADMINS },
  })
  for (const refused of [await install(page, true), await install(page), await uninstall(page)]) {
    expect(refused).toEqual({ ok: false, error: { code: 'not-allowed', message: ONLY_ADMINS } })
  }
  expect(made()).toBeUndefined()

  // An admin: installed as them (helm goes as who they are), and recorded as theirs.
  await as(context, 'root@example.com', 'platform-admins')
  await page.reload()
  expect(await status(page)).toMatchObject({ state: 'absent', missing: [] })
  expect((await status(page)) as object).not.toHaveProperty('off')
  expect(await install(page)).toMatchObject({ ok: true, data: { revision: 1 } })
  expect(made()!.metadata.labels).toMatchObject({ 'app.kubernetes.io/managed-by': 'lumovi' })
  expect(
    clusters.demo.object('Deployment', NAMESPACE, `${RELEASE}-prometheus-server`),
  ).toBeDefined()
  expect(await status(page)).toMatchObject({ state: 'installed' })
  const events = await page.evaluate(() => window.lumovi!.audit.query({}))
  expect(events.events.find((event) => event.action === 'helm.install')).toMatchObject({
    outcome: 'success',
    actor: { user: 'root@example.com' },
    target: { kind: 'HelmRelease', name: RELEASE, namespace: NAMESPACE },
  })

  // Still not the others' to remove; the admin's, and then nothing of it is left.
  await as(context, 'dev@example.com', 'developers')
  await page.reload()
  expect(await uninstall(page)).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  expect(made()).toBeDefined()
  await as(context, 'root@example.com', 'platform-admins')
  await page.reload()
  expect(await uninstall(page)).toEqual({ ok: true, data: null })
  expect(made()).toBeUndefined()
  expect(
    clusters.demo.object('ClusterRole.rbac.authorization.k8s.io', undefined, `${RELEASE}-server`),
  ).toBeUndefined()
})

test('a server that names no admins installs none', async ({ page, context, serve, clusters }) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await as(context, 'root@example.com', 'platform-admins')
  await page.goto(`${served.url}cluster/demo`)
  const NONE =
    'Lumovi’s admins install or remove its metrics stack, and this server names none. Whoever runs it sets them with LUMOVI_ADMINS (the chart’s access.admins).'
  expect(await status(page)).toMatchObject({ off: { reason: 'admins', message: NONE } })
  for (const refused of [await install(page, true), await install(page), await uninstall(page)]) {
    expect(refused).toEqual({ ok: false, error: { code: 'not-allowed', message: NONE } })
  }
  expect(clusters.demo.object('Namespace', undefined, NAMESPACE)).toBeUndefined()
})

test('a server that turned it off', async ({ page, context, serve, clusters }) => {
  const served = await serve({ env: { ...ADMINS, LUMOVI_METRICS_STACK: 'off' } })
  await as(context, 'root@example.com', 'platform-admins')
  await page.goto(`${served.url}cluster/demo`)
  const OFF =
    'Installing a metrics stack is turned off on this Lumovi server (LUMOVI_METRICS_STACK=off).'
  expect(await status(page)).toMatchObject({ off: { reason: 'policy', message: OFF } })
  expect(await install(page)).toEqual({ ok: false, error: { code: 'not-allowed', message: OFF } })
  expect(clusters.demo.object('Namespace', undefined, NAMESPACE)).toBeUndefined()
})
