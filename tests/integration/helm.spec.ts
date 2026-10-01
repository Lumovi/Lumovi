/**
 * Helm releases on a real cluster, installed and changed with real helm:
 * reading both storage drivers, upgrading with the chart a release stores,
 * rolling back, uninstalling, and installing a chart from a folder.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('install a chart from this computer: checked, with its subcharts and values files', async ({
  page,
}) => {
  // A copy, so its subcharts download there: it depends on a library chart beside it.
  const dir = mkdtempSync(join(tmpdir(), 'kubestacks-chart-'))
  const chart = join(dir, 'hello')
  cpSync(CHART, chart, { recursive: true })
  mkdirSync(join(dir, 'greeter'))
  writeFileSync(
    join(dir, 'greeter', 'Chart.yaml'),
    'apiVersion: v2\nname: greeter\nversion: 0.1.0\ntype: library\n',
  )
  appendFileSync(
    join(chart, 'Chart.yaml'),
    'dependencies:\n  - name: greeter\n    version: 0.1.0\n    repository: file://../greeter\n',
  )
  writeFileSync(join(chart, 'values-prod.yaml'), 'message: hello from prod\n')

  await page.getByRole('button', { name: 'Install chart' }).click()
  const install = dialog(page)
  await install.getByRole('radio', { name: /A chart on this computer/ }).check()
  await install.getByLabel('Chart path').fill(chart)
  await install.getByLabel('Chart path').press('Enter')
  await expect(install).toContainText('hello 0.1.0 · app 1.27')
  await expect(install).toContainText('Its charts/ folder is missing greeter 0.1.0.')
  await expect(install).toContainText('helm lint: 1 warning')
  await install.getByRole('button', { name: 'Download dependencies' }).click()
  await expect(install).toContainText('helm lint found no problems')
  await expect(install).not.toContainText('Its charts/ folder is missing')
  expect(existsSync(join(chart, 'charts', 'greeter-0.1.0.tgz'))).toBe(true)
  await expect(install.getByRole('list', { name: 'helm lint' })).toContainText(
    'Chart.yaml: icon is recommended',
  )

  await install.getByLabel('Release name').fill('hello-b')
  await expect(install.getByLabel('Namespace', { exact: true })).toHaveValue(NS)
  await install.getByRole('combobox', { name: 'Load values from' }).selectOption('values-prod.yaml')
  await expect(install.getByRole('textbox', { name: 'Values' })).toContainText('hello from prod')
  await install.getByRole('button', { name: 'Review' }).click()
  await expect(install.getByLabel('Manifest changes')).toContainText('hello-b-greeting')
  await expect(install).toContainText('hello-b says "hello from prod".')
  await install.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(toasts(page)).toContainText('Installed hello-b')
  expect(greeting('hello-b')).toBe('hello from prod')
  await expect(row(page, 'Helm releases', 'hello-b')).toContainText('Deployed')
})
