/**
 * Runs against a real cluster (kind in CI). Opt in with the context to use:
 *
 *   KUBESTACKS_E2E_REAL_CONTEXT=kind-kubestacks npx playwright test real-cluster
 *
 * Only that context is exported to the app, so no other cluster is contacted.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, goTo, openCluster, row, test } from './fixtures.ts'

const context = process.env.KUBESTACKS_E2E_REAL_CONTEXT

test.skip(!context, 'Set KUBESTACKS_E2E_REAL_CONTEXT to run against a real cluster')

test('browses a real cluster', async ({ launch }) => {
  test.setTimeout(120_000)
  const kubeconfig = join(mkdtempSync(join(tmpdir(), 'kubestacks-real-')), 'config')
  writeFileSync(
    kubeconfig,
    execFileSync('kubectl', ['config', 'view', '--minify', '--flatten', '--context', context!]),
  )
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })

  await openCluster(page, context)
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('All ready', {
    timeout: 60_000,
  })
  await expect(page.getByRole('region', { name: 'Pods running' })).not.toContainText('—')

  await goTo(page, 'Pods')
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'kube-system' }).click()
  const coredns = row(page, 'Pods', /coredns-/).first()
  await expect(coredns).toContainText('Running', { timeout: 60_000 })
  await coredns.click()
  const pod = page.getByRole('complementary', { name: /^Pod coredns-/ })
  await expect(pod.getByRole('article', { name: 'Container coredns' })).toContainText('Running for')
  await pod.getByRole('tab', { name: 'Logs' }).click()
  await expect(pod.getByRole('log')).toContainText('CoreDNS')

  await goTo(page, 'Nodes')
  await page.getByRole('grid', { name: 'Nodes' }).getByRole('row').nth(1).click()
  await expect(page.getByRole('complementary', { name: /^Node / })).toContainText('Capacity')

  await goTo(page, 'Deployments')
  await expect(row(page, 'Deployments', 'coredns')).toContainText('Ready')
})
