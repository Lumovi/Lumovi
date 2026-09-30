/**
 * Captures the README screenshots from the mock cluster.
 *
 *   npm run build && node scripts/screenshots.ts [outDir]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, KUBECONFIG: clusters.kubeconfigPath, SHELL: '' } as Record<
      string,
      string
    >,
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

/** Opens a row by clicking its first cell (other cells may hold links). */
async function openRow(page: Page, text: string) {
  await page
    .getByRole('row')
    .filter({ hasText: text })
    .first()
    .getByRole('gridcell')
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

    await nav(page, 'Nodes')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('dep')
    await page.waitForTimeout(400)
    await page.screenshot({ path: file('palette') })
  })
}

await clusters.close()
console.log(`Screenshots written to ${outDir}`)
