/**
 * The desktop app's audit log: what's done through it, kept on this
 * computer as whoever's signed in to it (and each cluster's kubeconfig
 * user), and found on its Audit page, its objects' Audit tabs, and from
 * wherever else changes show.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { AuditEvent } from '../../src/shared/audit.ts'
import { dialog, open, toasts } from './action-helpers.ts'
import { DEMO, expect, openCluster, panel, test } from './fixtures.ts'

const ME = userInfo().username
const POD = DEMO.pods.storefront[0]!

/** Answers the save dialog as `answer` says, instead of asking. */
function saveAs(app: ElectronApplication, answer: { canceled: boolean; filePath?: string }) {
  return app.evaluate(({ dialog }, answer) => {
    dialog.showSaveDialog = (async () => answer) as unknown as typeof dialog.showSaveDialog
  }, answer)
}

const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)
/** Somewhere in the app, by its address. */
const go = (page: Page, path: string) => page.goto(`${page.url().split('#')[0]}#${path}`)
const list = (page: Page) => page.getByRole('listbox', { name: 'Events' })
const row = (page: Page, summary: string | RegExp) =>
  list(page).getByRole('option', { name: summary })

test('what’s done in the desktop app is kept on this computer, and found again', async ({
  page,
  lumovi,
  launch,
}) => {
  // Nothing done yet: nothing to show, or check.
  await go(page, '/audit')
  await expect(page.getByRole('heading', { name: 'Nothing yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Check integrity' }).click()
  await expect(page.getByRole('status', { name: 'Integrity' })).toHaveText('Nothing to check yet.')
  // However many listen, each hears until it stops.
  const heard = await page.evaluate(async () => {
    const api = window.lumovi!
    const got: string[] = []
    const first = api.audit.onEvent((e) => got.push(`first ${e.summary}`))
    const second = api.audit.onEvent((e) => got.push(`second ${e.summary}`))
    await api.app.setReadOnly('sandbox', true)
    await new Promise((done) => setTimeout(done, 200))
    first()
    await api.app.setReadOnly('sandbox', false)
    await new Promise((done) => setTimeout(done, 200))
    second()
    return got
  })
  expect(heard).toEqual([
    'first Made sandbox read-only in Lumovi',
    'second Made sandbox read-only in Lumovi',
    'second Made sandbox changeable in Lumovi',
  ])
  await go(page, '/')
  await openCluster(page)
  // Scaled from its dialog.
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('button', { name: 'Scale' }).click()
  await dialog(page).getByLabel('Replicas', { exact: true }).fill('4')
  await dialog(page).getByRole('button', { name: 'Scale', exact: true }).click()
  await expect(toasts(page)).toContainText('Scaled storefront')
  // Its port forwarded, and stopped; one that can't be.
  const [forwarded, failed] = await page.evaluate(async (pod) => {
    const forwards = window.lumovi!.forwards!
    const started = await forwards.start({
      context: 'demo',
      namespace: 'shop',
      kind: 'Pod',
      name: pod,
      port: 8080,
    })
    const nowhere = await forwards.start({
      context: 'demo',
      namespace: 'shop',
      kind: 'Pod',
      name: 'nowhere',
      port: 8080,
    })
    if (started.ok) await forwards.stop(started.data.id)
    return [started, nowhere]
  }, POD)
  expect(forwarded.ok).toBe(true)
  expect(failed.ok).toBe(false)
  const local = forwarded.ok ? forwarded.data.localPort : 0
  // What decides what assistants may do.
  await page.evaluate(async () => {
    const api = window.lumovi!
    await api.aiPermissions!.set({
      defaults: { changes: 'never', secrets: 'keys', env: 'sensitive', logs: 'read' },
      rules: [
        { id: 'shop', name: 'Shop', clusters: [], namespaces: ['shop'], set: { changes: 'ask' } },
      ],
    })
    await api.assistants!.configure({ enabled: true })
    await api.assistants!.configure({ port: 39_217 })
    await api.assistants!.configure({ enabled: false, port: 39_218 })
    await api.assistants!.resetToken()
  })

  const recorded = (await events(page)).reverse().slice(2)
  expect(recorded.map((e) => [e.action, e.outcome, e.summary])).toEqual([
    ['resource.scale', 'success', 'Scaled Deployment storefront to 4 replicas'],
    ['port-forward.open', 'success', `Forwarded port ${local} on this computer to Pod ${POD}:8080`],
    ['port-forward.open', 'failure', 'Forward port (any) on this computer to Pod nowhere:8080'],
    [
      'port-forward.close',
      'success',
      expect.stringMatching(
        new RegExp(
          `^Stopped forwarding port ${local} on this computer to Pod ${POD}:8080, after \\d+s$`,
        ),
      ),
    ],
    [
      'permissions.changed',
      'success',
      'Changed what AI assistants may do: by default, changes never, Secrets keys, env sensitive, logs read; 1 rule',
    ],
    ['assistants.changed', 'success', 'Let AI assistants connect'],
    ['assistants.changed', 'success', 'Moved where AI assistants connect to port 39217'],
    [
      'assistants.changed',
      'success',
      'Stopped AI assistants connecting; Moved where AI assistants connect to port 39218',
    ],
    [
      'assistants.changed',
      'success',
      'Made a new token for AI assistants: those set up with the old one can’t connect',
    ],
  ])
  // As this computer's person, and the kubeconfig's user for the cluster.
  expect(recorded[0]!.actor).toEqual({ user: ME, via: 'ui', kubeUser: 'demo-admin' })
  expect(recorded[4]!.actor).toEqual({ user: ME, via: 'ui' })
  expect(recorded[1]).toMatchObject({
    command: `kubectl port-forward pod/${POD} ${local}:8080 -n shop --context demo`,
    details: { pod: POD, podPort: 8080, localPort: local },
  })
  expect(recorded[4]!.details).toEqual({
    changes: 'never',
    secrets: 'keys',
    env: 'sensitive',
    logs: 'read',
    rules: ['Shop'],
  })

  // Its Audit page: this computer's, all of it.
  await page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('button', { name: 'Audit log' })
    .click()
  await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()
  await expect(page.getByRole('banner')).toContainText('This computer')
  await expect(page.getByRole('main')).toContainText('Kept on this computer for 90 days.')
  await expect(page.getByRole('main')).not.toContainText('auditors')
  await expect(row(page, /Scaled Deployment storefront to 4 replicas$/)).toBeVisible()
  await row(page, /Scaled Deployment storefront/).click()
  const event = page.getByRole('complementary', { name: 'Event' })
  await expect(event.getByRole('region', { name: 'Who' })).toContainText(
    `Person${ME}ThroughLumovi’s pageKubeconfig userdemo-admin`,
  )
  // Open where it is.
  await event.getByRole('link', { name: 'Open in Lumovi' }).click()
  await expect(panel(page, 'Deployment', DEMO.deployments.storefront)).toBeVisible()

  // Exported to where the person says; or not, when they cancel, or it can't be written.
  await go(page, '/audit')
  const file = join(tmpdir(), `lumovi-audit-${Date.now()}.csv`)
  await saveAs(lumovi.app, { canceled: false, filePath: file })
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'CSV for spreadsheets' }).click()
  await expect(toasts(page)).toContainText('Exported 11 events')
  expect(readFileSync(file, 'utf8').split('\r\n')[3]).toContain(
    `,${ME},ui,,resource.scale,success,demo,shop,Deployment,storefront,`,
  )
  await saveAs(lumovi.app, { canceled: true })
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'JSON Lines for log tools' }).click()
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
  await saveAs(lumovi.app, { canceled: false, filePath: join(tmpdir(), 'no', 'such', 'dir.jsonl') })
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'JSON Lines for log tools' }).click()
  await expect(toasts(page)).toContainText('Couldn’t export')
  await page.getByRole('button', { name: 'Check integrity' }).click()
  await expect(page.getByRole('status', { name: 'Integrity' })).toContainText('All 11 events hold.')

  // An object's own: who changed it.
  await go(page, '/cluster/demo')
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const panelled = panel(page, 'Deployment', DEMO.deployments.storefront)
  await panelled.getByRole('tab', { name: 'Audit' }).click()
  const own = panelled.getByRole('list', { name: 'Audit log' })
  await expect(own.getByRole('listitem')).toHaveCount(1)
  await expect(own).toContainText(`Scaled Deployment storefront to 4 replicas${ME} ·`)
  // What happens elsewhere doesn't; what happens to it, failed or not, shows at once.
  await page.evaluate(() => window.lumovi!.app.setReadOnly('sandbox', true))
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Deployment',
      name: 'storefront',
      namespace: 'shop',
      change: { action: 'patch', patchType: 'merge', subresource: 'status', patch: { status: {} } },
    }),
  )
  await expect(own.getByRole('listitem')).toHaveCount(2)
  await expect(own.getByRole('listitem').first()).toContainText(
    'Change Deployment storefront’s status: statusFailed',
  )
  await panelled.getByRole('button', { name: 'Restart' }).click()
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(own.getByRole('listitem')).toHaveCount(3)
  await expect(own.getByRole('listitem').first()).toContainText('Restarted Deployment storefront')
  await panelled.getByRole('link', { name: 'Open in the audit log' }).click()
  const chosen = page.getByLabel('Chosen filters')
  await expect(chosen).toContainText('Object:Deployment storefront in shop')
  await expect(chosen).toContainText('Cluster:demo')
  await expect(list(page).getByRole('option')).toHaveCount(3)

  // Nothing recorded of an object yet; a node's (no namespace).
  await go(page, '/cluster/demo')
  await open(page, 'Deployments', DEMO.deployments.cart)
  const cart = panel(page, 'Deployment', DEMO.deployments.cart)
  await cart.getByRole('tab', { name: 'Audit' }).click()
  await expect(cart.getByRole('heading', { name: 'Nothing recorded' })).toBeVisible()
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Node',
      name: 'worker-1',
      change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: true } } },
    }),
  )
  await open(page, 'Nodes', DEMO.nodes.worker1)
  const node = panel(page, 'Node', DEMO.nodes.worker1)
  await node.getByRole('tab', { name: 'Audit' }).click()
  await expect(node.getByRole('list', { name: 'Audit log' })).toContainText(
    'Cordoned Node worker-1',
  )
  await node.getByRole('link', { name: 'Open in the audit log' }).click()
  await expect(chosen).toContainText('Object:Node worker-1')
  await expect(chosen).not.toContainText(' in ')

  // Something deleted (or that never was): nothing of it to open.
  await go(page, '/cluster/demo')
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'ConfigMap',
      name: 'gone',
      namespace: 'shop',
      change: { action: 'delete' },
    }),
  )

  // From the session's activity, and the command palette.
  await page.getByRole('button', { name: 'Activity' }).click()
  await page
    .getByRole('link', { name: 'Everything done through Lumovi, kept: the audit log' })
    .click()
  await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()
  await row(page, /Delete ConfigMap gone/).click()
  await expect(event.getByRole('link', { name: 'Open in Lumovi' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Audit log' }).click()
  await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()

  // Kept, as the app is opened again.
  await lumovi.close()
  const again = await launch({ userDataDir: lumovi.userDataDir })
  const kept: AuditEvent[] = await events(again.page)
  expect(kept.map((e) => e.seq)).toEqual(
    Array.from({ length: kept.length }, (_, i) => kept.length - i),
  )
  expect(kept.at(-1)!.summary).toBe('Made sandbox read-only in Lumovi')
})

test('a folder the history can’t be kept in: kept in memory, and said why', async ({ launch }) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  // Where its folder would be, a file.
  writeFileSync(join(userDataDir, 'audit'), 'not a folder')
  const { page } = await launch({ userDataDir })
  await page.evaluate(() => window.lumovi!.app.setReadOnly('sandbox', true))
  await go(page, '/audit')
  await expect(row(page, 'Made sandbox read-only in Lumovi')).toBeVisible()
  // (Its path as the system has it: through /private, on a Mac.)
  await expect(page.getByRole('main')).toContainText(
    /Kept in memory until Lumovi quits: \S*lumovi-user-\w+[/\\]audit can’t be used: EEXIST/,
  )
})

test('who may do what is a server’s: the desktop app has no Access pages', async ({ page }) => {
  for (const path of ['/access', '/your-access']) {
    await go(page, path)
    await expect(page).toHaveURL(/#\/$/)
  }
  expect(await page.evaluate(() => window.lumovi!.access)).toBeUndefined()
})
