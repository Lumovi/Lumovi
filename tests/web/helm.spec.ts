/**
 * Helm through a KubeStacks server: helm runs there, with a kubeconfig of its
 * own for each person, and only fetches charts from where the server allows.
 */
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { parse } from 'yaml'
import { HELM } from '../mock-cluster/fixtures/helm.ts'
import { expect, helmKubeconfigs, PEOPLE, signIn, test } from './fixtures.ts'

const releasePanel = (page: Page, name: string) =>
  page.getByRole('complementary', { name: `Helm release ${name}` })

async function openRelease(page: Page, name: string) {
  await page
    .getByRole('grid', { name: 'Helm releases' })
    .getByRole('row')
    .filter({ hasText: name })
    .first()
    .getByRole('gridcell')
    .nth(1)
    .click()
  return releasePanel(page, name)
}

/** A chart repository on this machine: an address in a private network. */
async function chartRepository() {
  const server = http.createServer((req, res) => {
    if (req.url === '/charts/index.yaml') {
      res.writeHead(200).end('apiVersion: v1\nentries:\n  podinfo:\n    - version: 6.7.0\n')
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/charts`,
    close: () => new Promise((done) => server.close(done)),
  }
}

test('helm acts as whoever is signed in', async ({ page, context, serve, clusters }) => {
  // With a token: helm has it.
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/helm`, PEOPLE.alice.token)
  const storefront = await openRelease(page, HELM.storefront)
  await storefront.getByRole('button', { name: 'Roll back…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Rolled back storefront',
  )
  // (Runs that don't reach the cluster have the server's own environment.)
  const run = helmKubeconfigs(served).find((r) => r.args[0] === 'rollback')
  expect(run!.args.slice(0, 5)).toEqual(['rollback', 'storefront', '2', '--namespace', 'shop'])
  expect(run!.args.slice(5)).toEqual(['--kube-context', 'demo'])
  const config = parse(run!.kubeconfig)
  expect(config.users).toEqual([{ name: 'user', user: { token: PEOPLE.alice.token } }])
  expect(config.clusters[0].cluster).toMatchObject({
    server: clusters.demo.url,
    'certificate-authority-data': expect.any(String),
  })

  // Behind a proxy: the server's credentials, acting as them.
  const proxied = await serve({
    env: { KUBESTACKS_AUTH: 'proxy', KUBESTACKS_GROUPS_PREFIX: 'sso:' },
  })
  await context.setExtraHTTPHeaders({
    'X-Forwarded-User': 'kate@example.com',
    'X-Forwarded-Groups': 'sre',
  })
  await page.goto(`${proxied.url}cluster/demo/helm`)
  const redis = await openRelease(page, HELM.redis)
  await redis.getByRole('button', { name: 'Uninstall…' }).click()
  const uninstall = page.getByRole('dialog')
  await uninstall.getByRole('textbox').fill(HELM.redis)
  await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Uninstalled redis',
  )
  const impersonated = parse(
    helmKubeconfigs(proxied).find((r) => r.args[0] === 'uninstall')!.kubeconfig,
  )
  expect(impersonated.users[0].user).toEqual({
    token: 'kubestacks-demo-token',
    as: 'kate@example.com',
    'as-groups': ['sso:sre'],
  })
})

test('charts come from repositories and registries the server may reach', async ({
  page,
  serve,
}) => {
  const repository = await chartRepository()
  const served = await serve({ env: { KUBESTACKS_ALLOW_PRIVATE_CHARTS: undefined } })
  await signIn(page, `${served.url}cluster/demo/helm`, PEOPLE.alice.token)
  await page.getByRole('button', { name: 'Install chart' }).click()
  const install = page.getByRole('dialog')
  const chart = install.getByLabel('Chart name or reference')
  const repositoryUrl = install.getByLabel('Repository URL')
  const versions = install.getByRole('button', { name: 'List its versions' })
  const defaults = install.getByRole('button', { name: 'Start from the chart’s defaults' })
  const refused = (host: string) =>
    `KubeStacks doesn’t fetch charts from ${host}: it’s in a private network. An administrator can allow that with KUBESTACKS_ALLOW_PRIVATE_CHARTS.`

  // Addresses inside private networks: this machine, the cluster's own, cloud metadata.
  await chart.fill('podinfo')
  for (const [url, host] of [
    [repository.url, '127.0.0.1'],
    ['http://[::1]:8080/charts', '::1'],
    ['http://169.254.169.254/latest', '169.254.169.254'],
    ['https://localhost/charts', 'localhost'],
  ]) {
    await repositoryUrl.fill(url!)
    await versions.click()
    await expect(install.getByRole('alert')).toHaveText(refused(host!))
  }
  await repositoryUrl.fill('')
  await chart.fill('oci://localhost:5000/charts/podinfo')
  await defaults.click()
  await expect(install.getByRole('alert').last()).toHaveText(refused('localhost'))

  // Not files on the server.
  for (const [source, repo] of [
    ['./charts/podinfo', ''],
    ['/etc/kubernetes', ''],
    ['../podinfo', 'https://charts.example.com'],
  ]) {
    await chart.fill(source!)
    await repositoryUrl.fill(repo!)
    await defaults.click()
    await expect(
      install.getByRole('alert').filter({ hasText: 'Choose a chart from a repository' }),
    ).toHaveText(
      'Choose a chart from a repository (its name and the repository’s URL), an oci:// registry or a URL.',
    )
  }

  // Public addresses are fine; ones that don't resolve are helm's to report.
  await chart.fill('https://charts.invalid/podinfo-6.7.0.tgz')
  await repositoryUrl.fill('')
  await defaults.click()
  await expect(install.getByLabel('Values')).toContainText('replicaCount: 1')

  // An administrator can allow private addresses.
  const allowed = await serve()
  await signIn(page, `${allowed.url}cluster/demo/helm`, PEOPLE.alice.token)
  await page.getByRole('button', { name: 'Install chart' }).click()
  await page.getByRole('dialog').getByLabel('Chart name or reference').fill('podinfo')
  await page.getByRole('dialog').getByLabel('Repository URL').fill(repository.url)
  await page.getByRole('dialog').getByRole('button', { name: 'List its versions' }).click()
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Version' })).toContainText(
    '6.7.0',
  )
  await repository.close()
  expect(existsSync(served.helmDir)).toBe(true)
})
