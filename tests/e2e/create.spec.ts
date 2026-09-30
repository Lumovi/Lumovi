import type { ElectronApplication, Page } from '@playwright/test'
import { dialog, focusDisabled, toasts, writes } from './action-helpers.ts'
import { expect, goTo, openCluster, panel, test } from './fixtures.ts'

const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const results = (page: Page) => dialog(page).getByRole('list', { name: 'Results' })
const create = (page: Page) => dialog(page).getByRole('button', { name: 'Create', exact: true })

/** Replaces the editor's text with `yaml`. */
async function write(page: Page, yaml: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(yaml)
}

/** Clicks an item of the native menu, like a user choosing it. */
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    Menu.getApplicationMenu()!.getMenuItemById(id)!.click()
  }, id)

test('create a deployment from a template and open it', async ({ page, clusters }) => {
  await openCluster(page)
  await goTo(page, 'Deployments')
  await page.keyboard.press('ControlOrMeta+n')
  const form = dialog(page)
  await expect(form).toContainText('Create from YAML')
  await expect(form).toContainText('New objects go to default unless they name a namespace')
  await expect(form).toContainText('kubectl create -f objects.yaml -n default --context demo')
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toContainText('kind: Deployment')
  await expect(editor(page)).toContainText('image: nginx:1.27')

  await create(page).click()
  await expect(toasts(page)).toContainText('Created deployment web')
  await expect(form).toHaveCount(0)
  // Checked by the cluster first, then created.
  const posts = writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/default/deployments')
  expect(posts.map((p) => p.query.dryRun)).toEqual(['All', undefined])
  await toasts(page).getByRole('button', { name: 'Open' }).click()
  await expect(panel(page, 'Deployment', 'web')).toBeVisible()
  // The mock's controllers roll it out like a real cluster.
  await expect
    .poll(() => clusters.demo.object('Deployment', 'default', 'web')?.status?.replicas)
    .toBe(2)
})

test('templates follow the chosen namespace; several objects go at once', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  const picker = page.getByRole('button', { name: 'Namespace' })
  await picker.click()
  await page.getByRole('option', { name: 'shop' }).click()
  await page.getByRole('button', { name: /Create from YAML/ }).click()
  await expect(dialog(page)).toContainText('New objects go to shop unless they name a namespace')

  const templates = dialog(page).getByRole('group', { name: 'Templates' })
  await templates.getByRole('button', { name: 'Secret' }).click()
  await expect(editor(page)).toContainText('namespace: shop')
  await expect(editor(page)).toContainText('stringData:')

  // Objects without a namespace go to the chosen one; empty documents are skipped.
  await write(
    page,
    `apiVersion: v1
kind: ConfigMap
metadata:
  name: flags
data:
  BETA: "true"
---
apiVersion: v1
kind: Secret
metadata:
  name: api-key
  namespace: data
stringData:
  key: s3cret
---
`,
  )
  // ⌘S creates too.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(toasts(page)).toContainText('Created 2 objects')
  expect(clusters.demo.object('ConfigMap', 'shop', 'flags')!.data).toEqual({ BETA: 'true' })
  // stringData is folded into data, as the API server does.
  expect(clusters.demo.object('Secret', 'data', 'api-key')!.data).toEqual({
    key: Buffer.from('s3cret').toString('base64'),
  })

  // Cluster-scoped objects ignore the namespace.
  await page.keyboard.press('ControlOrMeta+n')
  await dialog(page)
    .getByRole('group', { name: 'Templates' })
    .getByRole('button', { name: 'Namespace' })
    .click()
  await create(page).click()
  await expect(toasts(page)).toContainText('Created namespace playground')
  expect(clusters.demo.object('Namespace', undefined, 'playground')!.status).toEqual({
    phase: 'Active',
  })

  // A generateName gets its name from the cluster.
  await page.keyboard.press('ControlOrMeta+n')
  await write(
    page,
    `apiVersion: batch/v1
kind: Job
metadata:
  generateName: hello-
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: hello
          image: busybox:1.37
`,
  )
  await create(page).click()
  await expect(toasts(page)).toContainText(/Created job hello-\w{5}/)
})

test('nothing is created when the cluster refuses any object', async ({ page, clusters }) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  await write(
    page,
    `apiVersion: v1
kind: ConfigMap
metadata:
  name: fresh
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
spec:
  replicas: 1
---
apiVersion: v1
kind: Service
metadata:
  name: lost
  namespace: nope
`,
  )
  await create(page).click()
  await expect(results(page)).toContainText('Deployment/storefront')
  await expect(results(page)).toContainText('deployments.apps "storefront" already exists')
  await expect(results(page)).toContainText('Service/lost')
  await expect(results(page)).toContainText('namespaces "nope" not found')
  await expect(results(page)).not.toContainText('ConfigMap/fresh')
  expect(clusters.demo.object('ConfigMap', 'default', 'fresh')).toBeUndefined()
  await expect(dialog(page)).toBeVisible()

  // Editing clears the results.
  await editor(page).press('End')
  await page.keyboard.type(' ')
  await expect(results(page)).toHaveCount(0)

  // Two objects with one name both pass the check; the second then fails.
  await write(
    page,
    `apiVersion: v1
kind: ConfigMap
metadata:
  name: twin
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: twin
`,
  )
  await create(page).click()
  const items = results(page).getByRole('listitem')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toHaveText('ConfigMap/twin')
  await expect(items.nth(1)).toContainText('configmaps "twin" already exists')
  expect(clusters.demo.object('ConfigMap', 'default', 'twin')).toBeDefined()
})

test('explains YAML that can’t be created', async ({ page }) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  const cases: [string, string, string][] = [
    ['kind: [Deployment', 'YAML', 'Flow sequence'],
    ['just some text', 'YAML', 'Each object needs a kind, like Deployment.'],
    ['kind: Widget', 'Widget/…', 'KubeStacks can’t create Widget objects yet.'],
    ['kind: Widget\nmetadata:\n  name: gear', 'Widget/gear', 'KubeStacks can’t create Widget'],
    ['', 'YAML', 'There’s nothing to create.'],
    ['apiVersion: v1\nkind: ConfigMap', 'ConfigMap/…', 'name or generateName is required'],
  ]
  for (const [yaml, label, error] of cases) {
    await write(page, yaml)
    await create(page).click()
    await expect(results(page)).toContainText(label)
    await expect(results(page)).toContainText(error)
  }
  // Picking a template starts over.
  const templates = dialog(page).getByRole('group', { name: 'Templates' })
  await templates.getByRole('button', { name: 'ConfigMap' }).click()
  await expect(results(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('LOG_LEVEL: info')
  const starts: [string, string][] = [
    ['Service', 'targetPort: 80'],
    ['Job', 'restartPolicy: Never'],
    ['CronJob', 'schedule: "*/15 * * * *"'],
    ['Deployment', 'replicas: 2'],
  ]
  for (const [kind, text] of starts) {
    await templates.getByRole('button', { name: kind, exact: true }).click()
    await expect(editor(page)).toContainText(`kind: ${kind}`)
    await expect(editor(page)).toContainText(text)
  }
})

test('create from the header, the palette and the File menu', async ({ page, kubestacks }) => {
  const { app } = kubestacks
  // Not before a cluster is open.
  await menu(app, 'create')
  await expect(dialog(page)).toHaveCount(0)

  await openCluster(page)
  await page.getByRole('button', { name: /Create from YAML/ }).click()
  await expect(dialog(page)).toContainText('Create from YAML')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('create from')
  await page.getByRole('option', { name: /Create from YAML/ }).click()
  await expect(dialog(page)).toContainText('Create from YAML')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  await menu(app, 'create')
  await expect(dialog(page)).toContainText('Create from YAML')
})

test('creating is off on read-only clusters', async ({ launch }) => {
  const { page } = await launch({ env: { KUBESTACKS_READ_ONLY: '1' } })
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  await expect(dialog(page)).toContainText('Changes are turned off for this cluster.')
  await expect(create(page)).toBeDisabled()
  await page.keyboard.press('Escape')

  // Bulk actions too.
  await goTo(page, 'Pods')
  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).click()
  const bar = page.getByRole('toolbar', { name: 'Selected rows' })
  await focusDisabled(bar.getByRole('button', { name: 'Delete' }))
  await expect(page.getByRole('tooltip')).toContainText('Changes are turned off for this cluster.')
})
