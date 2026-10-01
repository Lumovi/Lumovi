import { goTo, row } from '../e2e/fixtures.ts'
import { expect, test } from './fixtures.ts'

test('browses a real cluster', async ({ page }) => {
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('All ready', {
    timeout: 60_000,
  })
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('3/3')
  await expect(page.getByRole('region', { name: 'Pods running' })).not.toContainText('—')

  await goTo(page, 'Pods')
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'kube-system' }).click()
  const coredns = row(page, 'Pods', /coredns-/).first()
  await expect(coredns).toContainText('Running')
  await coredns.getByRole('gridcell').nth(1).click()
  const pod = page.getByRole('complementary', { name: /^Pod coredns-/ })
  await expect(pod.getByRole('article', { name: 'Container coredns' })).toContainText('Running for')
  await pod.getByRole('tab', { name: 'Logs' }).click()
  await expect(pod.getByRole('log')).toContainText('CoreDNS')

  await goTo(page, 'Nodes')
  await page
    .getByRole('grid', { name: 'Nodes' })
    .getByRole('row')
    .nth(1)
    .getByRole('gridcell')
    .nth(1)
    .click()
  await expect(page.getByRole('complementary', { name: /^Node / })).toContainText('Capacity')

  await goTo(page, 'Deployments')
  await expect(row(page, 'Deployments', 'coredns')).toContainText('Ready')
})
