/**
 * Helm releases on a real cluster, installed and changed with real helm:
 * reading both storage drivers, upgrading with the chart a release stores,
 * rolling back, uninstalling, and installing a chart from a folder.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { dialog, toasts } from '../e2e/action-helpers.ts'
import { row, rows } from '../e2e/fixtures.ts'
import {
  CONTEXT,
  expect,
  freshNamespace,
  get,
  inNamespace,
  kubectl,
  KUBECONFIG,
  test,
} from './fixtures.ts'

const NS = 'it-helm'
const CHART = resolve('tests/integration/charts/hello')

/** helm against the test cluster. */
function helm(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('helm', [...args, '--kubeconfig', KUBECONFIG, '--kube-context', CONTEXT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** What a release's ConfigMap says, or undefined once it's gone. */
function greeting(release: string): string | undefined {
  const found = kubectl([
    'get',
    'configmap',
    `${release}-greeting`,
    '-n',
    NS,
    '--ignore-not-found',
    '-o',
    'name',
  ])
  return found.trim() ? get('configmap', `${release}-greeting`, '-n', NS).data.message : undefined
}

const revision = (release: string) =>
  JSON.parse(helm(['status', release, '--namespace', NS, '--output', 'json'])).version as number

test.beforeAll(() => {
  freshNamespace(NS, [])
  helm(['install', 'hello-a', CHART, '--namespace', NS])
  helm(['upgrade', 'hello-a', CHART, '--namespace', NS, '--set', 'message=hi'])
  // Kept in ConfigMaps instead of Secrets.
  helm(['install', 'hello-cm', CHART, '--namespace', NS, '--set', 'replicas=0'], {
    HELM_DRIVER: 'configmap',
  })
  kubectl(['rollout', 'status', 'deployment/hello-a', '-n', NS, '--timeout=120s'])
})

test.beforeEach(async ({ page }) => {
  await inNamespace(page, NS)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Helm releases' })
    .click()
})

async function openRelease(page: Page, name: string) {
  await row(page, 'Helm releases', name).getByRole('gridcell').nth(1).click()
  return page.getByRole('complementary', { name: `Helm release ${name}` })
}

test('releases as Helm stores them, with what they made', async ({ page }) => {
  await expect(rows(page, 'Helm releases')).toHaveCount(2)
  await expect(row(page, 'Helm releases', 'hello-a')).toContainText('Deployedhello 0.1.01.272')
  await expect(row(page, 'Helm releases', 'hello-cm')).toContainText('Deployedhello 0.1.0')

  const release = await openRelease(page, 'hello-a')
  await expect(release).toContainText('A small chart for KubeStacks')
  await expect(release).toContainText('hello-a says "hi".')
  await release.getByRole('tab', { name: 'Resources' }).click()
  const made = release.getByRole('list', { name: 'Release resources' }).getByRole('listitem')
  await expect(made).toHaveCount(3)
  await expect(made.filter({ hasText: 'Deployment' })).toContainText('Ready')
  await release.getByRole('tab', { name: 'Values' }).click()
  const values = release.locator('pre[aria-label="Values"]')
  await expect(values).toHaveText(/message: hi/)
  await release.getByRole('button', { name: 'With the chart’s defaults' }).click()
  await expect(values).toContainText('image: nginx:1.27-alpine')
  await release.getByRole('tab', { name: 'History' }).click()
  await expect(release.getByRole('list', { name: 'Revisions' }).getByRole('listitem')).toHaveCount(
    2,
  )
  await expect(release.getByLabel('Differences')).toContainText('message: hi')
})

test('upgrade with new values, roll back and uninstall, with helm', async ({ page }) => {
  const release = await openRelease(page, 'hello-a')
  await release.getByRole('button', { name: 'Upgrade…' }).click()
  const upgrade = dialog(page)
  await expect(
    upgrade.getByRole('radio', { name: /The chart it runs: hello 0\.1\.0/ }),
  ).toBeChecked()
  await upgrade.getByRole('textbox', { name: 'Values' }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('message: howdy\nreplicas: 2\n')
  // The API server checks it first; nothing changes yet.
  await upgrade.getByRole('button', { name: 'Review' }).click()
  const changes = upgrade.getByLabel('Manifest changes')
  await expect(changes).toContainText('message: "howdy"')
  await expect(changes).toContainText('replicas: 2')
  expect(greeting('hello-a')).toBe('hi')
  await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
  await expect(toasts(page)).toContainText('Upgraded hello-a')
  expect(greeting('hello-a')).toBe('howdy')
  expect(revision('hello-a')).toBe(3)
  // The panel follows: it lists the new revision.
  await release.getByRole('tab', { name: 'History' }).click()
  const revisions = release.getByRole('list', { name: 'Revisions' }).getByRole('listitem')
  await expect(revisions).toHaveCount(3)

  await release.getByRole('button', { name: 'Roll back…' }).click()
  await expect(dialog(page).getByRole('radio', { name: 'Revision 2' })).toBeChecked()
  await dialog(page).getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(toasts(page)).toContainText('Rolled back hello-a to revision 2')
  expect(greeting('hello-a')).toBe('hi')
  expect(revision('hello-a')).toBe(4)
  await expect(revisions.first()).toContainText('Rollback to 2')

  await release.getByRole('button', { name: 'Uninstall…' }).click()
  await dialog(page).getByLabel('Type hello-a to confirm').fill('hello-a')
  await dialog(page).getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(toasts(page)).toContainText('Uninstalled hello-a')
  expect(greeting('hello-a')).toBeUndefined()
  await expect(rows(page, 'Helm releases')).toHaveCount(1)
})

test('install a chart from a folder, starting from its defaults', async ({ page }) => {
  await page.getByRole('button', { name: 'Install chart' }).click()
  const install = dialog(page)
  await install.getByLabel('Release name').fill('hello-b')
  await expect(install.getByLabel('Namespace', { exact: true })).toHaveValue(NS)
  await install.getByLabel('Chart name or reference').fill(CHART)
  await install.getByRole('button', { name: 'Start from the chart’s defaults' }).click()
  await expect(install.getByRole('textbox', { name: 'Values' })).toContainText('message: hello')
  await install.getByRole('button', { name: 'Review' }).click()
  await expect(install.getByLabel('Manifest changes')).toContainText('hello-b-greeting')
  await expect(install).toContainText('hello-b says "hello".')
  await install.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(toasts(page)).toContainText('Installed hello-b')
  expect(greeting('hello-b')).toBe('hello')
  await expect(row(page, 'Helm releases', 'hello-b')).toContainText('Deployed')
})
