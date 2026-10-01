/**
 * Captures the README screenshots from the mock cluster.
 *
 *   npm run build && node scripts/screenshots.ts [outDir]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from '@playwright/test'
import { DEMO, startTestClusters } from '../tests/mock-cluster/kubeconfig.ts'

const outDir = process.argv[2] ?? 'docs/screenshots'
mkdirSync(outDir, { recursive: true })
const clusters = await startTestClusters(mkdtempSync(join(tmpdir(), 'kubestacks-shots-')), {
  jitter: true,
})

async function session(
  theme: 'light' | 'dark',
  shoot: (page: Page, name: (n: string) => string) => Promise<void>,
) {
  const userData = mkdtempSync(join(tmpdir(), 'kubestacks-shots-user-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({
    // Captured without showing a window (see tests/e2e/background.cjs).
    args: ['-r', resolve('tests/e2e/background.cjs'), '.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      KUBECONFIG: clusters.kubeconfigPath,
      SHELL: '',
      // Only KubeStacks' own views, from a home of its own.
      KUBESTACKS_VIEWS_DIR: '',
      // The e2e tests' stand-in, so no real helm runs against the mock cluster.
      KUBESTACKS_HELM: resolve('tests/e2e/helm/helm'),
      HOME: userData,
      USERPROFILE: userData,
    } as Record<string, string>,
    colorScheme: null,
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
  )
  await page.waitForTimeout(800)
  await shoot(page, (n) => join(outDir, `${n}-${theme}.png`))
  await app.close()
}

async function openDemo(page: Page) {
  await page.getByRole('option', { name: /^demo\b/ }).click()
  await page.getByRole('heading', { level: 1, name: 'Overview' }).waitFor()
}

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text }).first()

/** Opens a row by clicking its name (other cells may hold links or its checkbox). */
async function openRow(page: Page, text: string) {
  await row(page, text)
    .getByRole('gridcell')
    .filter({ hasNot: page.getByRole('checkbox') })
    .first()
    .click()
}

async function nav(page: Page, label: string) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: label, exact: true })
    .click()
  await page.waitForTimeout(700)
}

for (const theme of ['dark', 'light'] as const) {
  await session(theme, async (page, file) => {
    await page.screenshot({ path: file('welcome') })
    await openDemo(page)
    // Let a few metrics samples arrive so the trend lines have shape.
    await page.waitForTimeout(16_000)
    await page.screenshot({ path: file('overview') })

    await nav(page, 'Pods')
    await page.screenshot({ path: file('pods') })

    await nav(page, 'Deployments')
    await openRow(page, DEMO.deployments.checkout)
    await page.waitForTimeout(600)
    await page.getByRole('tab', { name: 'Pods' }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: file('deployment') })

    await nav(page, 'Pods')
    await page.getByPlaceholder('Filter pods').fill(DEMO.pods.checkout[0]!)
    await openRow(page, DEMO.pods.checkout[0]!)
    await page.waitForTimeout(600)
    await page.screenshot({ path: file('pod') })
    await page.getByRole('tab', { name: 'Logs' }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: file('logs') })
    await page.getByRole('tab', { name: 'YAML' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: file('yaml') })

    // A shell in a running container.
    await page.getByPlaceholder('Filter pods').fill(DEMO.pods.storefront[0]!)
    await openRow(page, DEMO.pods.storefront[0]!)
    await page.getByRole('tab', { name: 'Shell' }).click()
    await page.waitForTimeout(800)
    for (const command of ['hostname', 'whoami', 'pwd', 'ls']) {
      await page.keyboard.type(command)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
    }
    await page.waitForTimeout(400)
    await page.screenshot({ path: file('shell') })
    // Escape belongs to the shell, so close the panel with its button.
    await page.getByRole('button', { name: 'Close (Esc)' }).click()
    await page.getByPlaceholder('Filter pods').fill('')

    // Several pods picked at once.
    await page.waitForTimeout(400)
    for (const pod of DEMO.pods.checkout) {
      await row(page, pod).getByRole('checkbox').click()
    }
    await page.waitForTimeout(500)
    await page.screenshot({ path: file('bulk') })
    await page.getByRole('button', { name: 'Clear selection' }).click()

    await nav(page, 'Deployments')
    await openRow(page, DEMO.deployments.storefront)
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: 'Scale', exact: true }).click()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(500)
    await page.screenshot({ path: file('scale') })
    await page.keyboard.press('Escape')

    await page.keyboard.press('ControlOrMeta+n')
    await page.waitForTimeout(600)
    await page.screenshot({ path: file('create') })
    await page.keyboard.press('Escape')

    // Usage history: the Metrics page, and a pod's Metrics tab.
    await nav(page, 'Metrics')
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '6h' })
      .click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: file('metrics') })
    await nav(page, 'Pods')
    await page.getByPlaceholder('Filter pods').fill(DEMO.pods.storefront[0]!)
    await openRow(page, DEMO.pods.storefront[0]!)
    await page.getByRole('tab', { name: 'Metrics' }).click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: file('pod-metrics') })
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '1h' })
      .click()
    await page.getByRole('button', { name: 'Close (Esc)' }).click()
    await page.getByPlaceholder('Filter pods').fill('')

    // Every kind the cluster serves; a custom resource, with KubeStacks' view of it.
    const apiResources = page
      .getByRole('navigation', { name: 'Resources' })
      .getByRole('link', { name: /API resources/ })
    await apiResources.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: file('api-resources') })
    await page
      .getByRole('rowgroup', { name: 'cert-manager.io', exact: true })
      .getByRole('button', { name: /^Certificates/ })
      .click()
    await page.waitForTimeout(700)
    await openRow(page, 'api-tls')
    await page.waitForTimeout(800)
    await page.screenshot({ path: file('custom') })
    await page.getByRole('button', { name: 'Close (Esc)' }).click()

    // A Helm release's history, and an upgrade with new values.
    await nav(page, 'Helm releases')
    await row(page, 'storefront').getByRole('gridcell').nth(1).click()
    await page.getByRole('tab', { name: 'History' }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: file('helm') })
    await page.getByRole('button', { name: 'Upgrade…' }).click()
    await page.getByRole('textbox', { name: 'Values' }).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('ingress:\n  enabled: true\n')
    await page.waitForTimeout(500)
    await page.screenshot({ path: file('helm-upgrade') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Close (Esc)' }).click()

    await nav(page, 'Nodes')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('dep')
    await page.waitForTimeout(400)
    await page.screenshot({ path: file('palette') })
  })
}

await clusters.close()
console.log(`Screenshots written to ${outDir}`)
