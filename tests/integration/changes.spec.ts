/**
 * Changes made in the app, checked with kubectl against what the API server
 * and its controllers actually did.
 */
import type { Page } from '@playwright/test'
import { dialog, menuAction, open, toasts } from '../e2e/action-helpers.ts'
import { goTo, panel, row } from '../e2e/fixtures.ts'
import { IMAGES } from './cluster.ts'
import { expect, freshNamespace, get, inNamespace, kubectl, test } from './fixtures.ts'
import { web } from './workloads.ts'

const NS = 'it-changes'
const deployment = () => get('deployment', 'web', '-n', NS)
const image = () => deployment().spec.template.spec.containers[0].image

const settings = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'feature-flags' },
  data: { SEARCH: 'off' },
}

test.beforeAll(() => freshNamespace(NS, [web(), settings]))

test.beforeEach(async ({ page }) => {
  await inNamespace(page, NS)
})

/** Waits until the deployment's rollout is done, as kubectl would. */
function rolledOut() {
  kubectl(['rollout', 'status', 'deployment/web', '-n', NS, '--timeout=120s'])
}

test('scale, change the image, roll back, restart and pause a deployment', async ({ page }) => {
  await open(page, 'Deployments', 'web')
  const detail = panel(page, 'Deployment', 'web')

  await detail.getByRole('button', { name: 'Scale' }).click()
  await dialog(page).getByLabel('Replicas', { exact: true }).fill('3')
  await dialog(page).getByRole('button', { name: 'Scale', exact: true }).click()
  await expect(toasts(page)).toContainText('Scaled web to 3 replicas')
  await expect.poll(() => deployment().status.readyReplicas, { timeout: 90_000 }).toBe(3)

  // A new image rolls out a new ReplicaSet, revision 2.
  await menuAction(page, 'Deployment', 'web', 'Change image…')
  await dialog(page).getByLabel('Image for web').fill(IMAGES.webNext)
  await dialog(page).getByRole('button', { name: 'Update' }).click()
  await expect(toasts(page)).toContainText(`Set web of web to ${IMAGES.webNext}`)
  expect(image()).toBe(IMAGES.webNext)
  rolledOut()

  // Rolling back offers revision 1 with its change cause, and brings its image back.
  await menuAction(page, 'Deployment', 'web', 'Roll back…')
  await expect(dialog(page)).toContainText('first release')
  await expect(dialog(page).getByRole('radio', { name: 'Revision 1' })).toBeChecked()
  await expect(dialog(page)).toContainText(IMAGES.web)
  await dialog(page).getByRole('button', { name: 'Roll back' }).click()
  await expect(toasts(page)).toContainText('Rolled back web to revision 1')
  expect(image()).toBe(IMAGES.web)
  rolledOut()
  // The controller numbers the rolled-back template as the newest revision.
  await expect
    .poll(() => deployment().metadata.annotations['deployment.kubernetes.io/revision'])
    .toBe('3')

  await detail.getByRole('button', { name: 'Restart' }).click()
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted web')
  expect(deployment().spec.template.metadata.annotations).toHaveProperty([
    'kubectl.kubernetes.io/restartedAt',
  ])
  rolledOut()

  await menuAction(page, 'Deployment', 'web', 'Pause rollout')
  await expect.poll(() => deployment().spec.paused).toBe(true)
  await detail.getByRole('button', { name: 'Resume rollout' }).click()
  await expect.poll(() => deployment().spec.paused ?? false).toBe(false)

  await menuAction(page, 'Deployment', 'web', 'Edit labels…')
  await dialog(page).getByRole('button', { name: 'Add label' }).click()
  await dialog(page).getByLabel('Key', { exact: true }).last().fill('example.com/team')
  await dialog(page).getByLabel('Value of example.com/team').fill('integration')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => deployment().metadata.labels['example.com/team']).toBe('integration')
})

/** Replaces everything in the open YAML editor. */
async function replaceYaml(page: Page, kind: string, name: string, yaml: string) {
  await panel(page, kind, name)
    .getByRole('textbox', { name: `YAML of ${name}` })
    .click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(yaml)
}

test('YAML edits: the API server validates them, and catches changes made meanwhile', async ({
  page,
}) => {
  // The real API server's validation, from a dry run.
  await open(page, 'Deployments', 'web')
  await menuAction(page, 'Deployment', 'web', 'Edit YAML')
  const web = panel(page, 'Deployment', 'web')
  await replaceYaml(
    page,
    'Deployment',
    'web',
    kubectl(['get', 'deployment', 'web', '-n', NS, '-o', 'yaml']).replace(
      /replicas: \d+/,
      'replicas: -1',
    ),
  )
  await web.getByRole('button', { name: 'Review changes' }).click()
  await expect(web.getByRole('alert')).toContainText('spec.replicas: Invalid value: -1')
  await web.getByRole('button', { name: 'Cancel' }).click()

  // Someone changes it with kubectl while the edit is open.
  await goTo(page, 'ConfigMaps')
  await open(page, 'ConfigMaps', 'feature-flags')
  await menuAction(page, 'ConfigMap', 'feature-flags', 'Edit YAML')
  const flags = panel(page, 'ConfigMap', 'feature-flags')
  const editor = flags.getByRole('textbox', { name: 'YAML of feature-flags' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n  MINE: "yes"')
  kubectl(['patch', 'configmap/feature-flags', '-n', NS, '-p', '{"data":{"THEIRS":"yes"}}'])
  await page.keyboard.press('ControlOrMeta+s')
  await expect(flags.getByRole('alert')).toContainText('the object has been modified')
  await flags.getByRole('button', { name: 'Start over from the latest' }).click()
  await expect(editor).toContainText('THEIRS')
  await expect(editor).not.toContainText('MINE')

  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n  MINE: "yes"')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(flags).toContainText('The cluster accepts this change')
  await flags.getByRole('button', { name: 'Apply' }).click()
  await expect(toasts(page)).toContainText('Updated configmap feature-flags')
  expect(get('configmap', 'feature-flags', '-n', NS).data).toEqual({
    SEARCH: 'off',
    THEIRS: 'yes',
    MINE: 'yes',
  })
})

test('create several objects from YAML, then delete them together', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+n')
  const editor = dialog(page).getByRole('textbox', { name: 'YAML to create' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(`apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  LOG_LEVEL: debug
---
apiVersion: v1
kind: Secret
metadata:
  name: credentials
stringData:
  password: change-me
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: extra
`)
  await expect(dialog(page)).toContainText(`New objects go to ${NS}`)
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(toasts(page)).toContainText('Created 3 objects')
  expect(get('configmap', 'settings', '-n', NS).data).toEqual({ LOG_LEVEL: 'debug' })
  // The API server folds stringData into data.
  const secret = get('secret', 'credentials', '-n', NS)
  expect(Buffer.from(secret.data.password, 'base64').toString()).toBe('change-me')

  // A name that's taken is refused before anything else is created.
  await page.keyboard.press('ControlOrMeta+n')
  await dialog(page).getByRole('textbox', { name: 'YAML to create' }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fresh\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n',
  )
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog(page).getByRole('list', { name: 'Results' })).toContainText(
    'configmaps "settings" already exists',
  )
  expect(kubectl(['get', 'configmaps', '-n', NS, '-o', 'name'])).not.toContain('fresh')
  await page.keyboard.press('Escape')

  await goTo(page, 'ConfigMaps')
  for (const name of ['settings', 'extra']) {
    await row(page, 'ConfigMaps', name).first().getByRole('checkbox').click()
  }
  await page
    .getByRole('toolbar', { name: 'Selected rows' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(toasts(page)).toContainText('Deleted 2 ConfigMaps')
  await expect
    .poll(() => kubectl(['get', 'configmaps', '-n', NS, '-o', 'name']))
    .not.toMatch(/settings|extra/)
})
