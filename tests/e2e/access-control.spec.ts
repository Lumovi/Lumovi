/**
 * Access control: service accounts, roles and bindings have pages of their own. A role's
 * rules read as a table; a binding links its role and its subjects; a role and a service
 * account each list the bindings that name them; and a workload links its service account.
 */
import type { Page } from '@playwright/test'
import { open } from './action-helpers.ts'
import { expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })
const headers = (page: Page, label: string) =>
  page.getByRole('grid', { name: label }).getByRole('columnheader')
/** A table in a panel, row by row, as its cells' text. */
const table = (within: ReturnType<typeof panel>, name: string) =>
  within
    .getByRole('table', { name })
    .getByRole('row')
    .evaluateAll((all) =>
      all
        .filter((one) => one.querySelector('td'))
        .map((one) => [...one.querySelectorAll('td')].map((cell) => cell.textContent)),
    )

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('the five kinds are in the sidebar, the palette and g navigation', async ({ page }) => {
  const group = sidebar(page)
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Access control' }) })
    .last()
  await expect(group.getByRole('link')).toHaveText([
    /^\s*Roles/,
    /^\s*Cluster Roles/,
    /^\s*Role Bindings/,
    /^\s*Cluster Role Bindings/,
    /^\s*Service Accounts/,
  ])
  for (const [key, title] of [
    ['r', 'Roles'],
    ['k', 'Cluster Roles'],
    ['b', 'Role Bindings'],
    ['g', 'Cluster Role Bindings'],
    ['t', 'Service Accounts'],
  ] as const) {
    await page.keyboard.press('g')
    await page.keyboard.press(key)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  }
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('role bind')
  await expect(palette.getByRole('option', { name: /^Role Bindings/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /^Cluster Role Bindings/ })).toBeVisible()
  await palette.getByRole('combobox').fill('service acc')
  await palette.getByRole('option', { name: /^Service Accounts/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Service Accounts')
})

test('a role: how many rules in its list, and its rules as a table', async ({ page }) => {
  await goTo(page, 'Roles')
  await expect(headers(page, 'Roles')).toHaveText(['', 'Name', 'Rules', 'Age'])
  await expect(row(page, 'Roles', 'config-reader')).toContainText('config-readershop3')
  // One with no rules at all is a row like another, and says it allows nothing.
  await expect(row(page, 'Roles', 'nothing-yet')).toContainText('nothing-yetshop0')

  await open(page, 'Roles', 'config-reader')
  const role = panel(page, 'Role', 'config-reader')
  await expect(role).toContainText('Rules3')
  expect(await table(role, 'Rules')).toEqual([
    ['core', 'configmaps', 'getlistwatch'],
    ['core', 'secrets (payments-credentials)', 'get'],
    ['batch', 'jobs', 'createdelete'],
  ])
  // Who it's granted to, and by which binding: the way back from a role.
  expect(await table(role, 'Granted by')).toEqual([
    ['RoleBinding/checkout-reads-config', 'ServiceAccount shop/checkout', 'shop'],
  ])
  await role.getByRole('button', { name: 'RoleBinding/checkout-reads-config' }).click()
  await expect(panel(page, 'RoleBinding', 'checkout-reads-config')).toBeVisible()

  await open(page, 'Roles', 'nothing-yet')
  const empty = panel(page, 'Role', 'nothing-yet')
  await expect(empty).toContainText('RulesNone')
  await expect(empty).toContainText('No rules: it allows nothing.')
  expect(await table(empty, 'Granted by')).toEqual([['RoleBinding/nobody-yet', 'Nobody', 'shop']])
})

test('a cluster role: everything, URLs, and rules gathered from others', async ({ page }) => {
  await goTo(page, 'Cluster Roles')
  await expect(headers(page, 'Cluster Roles')).toHaveText(['', 'Name', 'Rules', 'Age'])
  await open(page, 'Cluster Roles', 'cluster-admin')
  const admin = panel(page, 'ClusterRole', 'cluster-admin')
  expect(await table(admin, 'Rules')).toEqual([
    ['All groups', 'All resources', 'All verbs'],
    ['—', 'URLs: *', 'All verbs'],
  ])
  expect(await table(admin, 'Granted by')).toEqual([
    ['ClusterRoleBinding/platform-admins', 'Group platform-team, Robot deployer', 'Everywhere'],
  ])
  // One granted in a namespace and everywhere: both kinds of binding are found.
  await open(page, 'Cluster Roles', 'view')
  expect(await table(panel(page, 'ClusterRole', 'view'), 'Granted by')).toEqual([
    [
      'RoleBinding/shop-viewers',
      'Group shop-team, User jane@example.com, ServiceAccount shop/storefront',
      'shop',
    ],
    ['ClusterRoleBinding/checkout-views-everything', 'ServiceAccount shop/checkout', 'Everywhere'],
  ])
  // Its rules are the cluster's to gather, and there are none yet.
  await open(page, 'Cluster Roles', 'shop-admin')
  const gathered = panel(page, 'ClusterRole', 'shop-admin')
  await expect(gathered).toContainText(
    'Its rules are gathered by the cluster from the cluster roles labelled rbac.example.com/aggregate-to-shop-admin=true.',
  )
  await expect(gathered).toContainText('No rules: it allows nothing.')
  await expect(gathered).toContainText('No binding grants it to anyone.')
})

test('a binding: its role and its subjects, each a link where it’s an object', async ({ page }) => {
  await goTo(page, 'Role Bindings')
  await expect(headers(page, 'Role Bindings')).toHaveText(['', 'Name', 'Role', 'Subjects', 'Age'])
  await expect(row(page, 'Role Bindings', 'shop-viewers')).toContainText(
    'ClusterRole/viewGroup shop-team, and 2 more',
  )
  await expect(row(page, 'Role Bindings', 'nobody-yet')).toContainText('Role/nothing-yetNobody')
  // Its role opens from the list.
  await row(page, 'Role Bindings', 'checkout-reads-config')
    .getByRole('button', { name: 'Role/config-reader' })
    .click()
  await expect(panel(page, 'Role', 'config-reader')).toBeVisible()

  await open(page, 'Role Bindings', 'shop-viewers')
  const viewers = panel(page, 'RoleBinding', 'shop-viewers')
  await expect(viewers).toContainText('RoleClusterRole/view')
  await expect(viewers).toContainText('Subjects3')
  expect(await table(viewers, 'Subjects')).toEqual([
    ['Group', 'shop-team', '—'],
    ['User', 'jane@example.com', '—'],
    ['ServiceAccount', 'ServiceAccount/storefront', 'shop'],
  ])
  await viewers.getByRole('button', { name: 'ServiceAccount/storefront' }).click()
  await expect(panel(page, 'ServiceAccount', 'storefront')).toBeVisible()

  // A service account named without its namespace is the binding's own; a binding to nobody
  // says so.
  await open(page, 'Role Bindings', 'checkout-reads-config')
  expect(await table(panel(page, 'RoleBinding', 'checkout-reads-config'), 'Subjects')).toEqual([
    ['ServiceAccount', 'ServiceAccount/checkout', 'shop'],
  ])
  await open(page, 'Role Bindings', 'nobody-yet')
  const nobody = panel(page, 'RoleBinding', 'nobody-yet')
  await expect(nobody).toContainText('SubjectsNone')
  await expect(nobody).toContainText('No subjects: it grants its role to nobody.')

  // A subject of a kind nobody knows is shown as it's written.
  await goTo(page, 'Cluster Role Bindings')
  await expect(headers(page, 'Cluster Role Bindings')).toHaveText([
    '',
    'Name',
    'Role',
    'Subjects',
    'Age',
  ])
  await open(page, 'Cluster Role Bindings', 'platform-admins')
  const admins = panel(page, 'ClusterRoleBinding', 'platform-admins')
  expect(await table(admins, 'Subjects')).toEqual([
    ['Group', 'platform-team', '—'],
    ['Robot', 'deployer', '—'],
  ])
  await admins.getByRole('button', { name: 'ClusterRole/cluster-admin' }).click()
  await expect(panel(page, 'ClusterRole', 'cluster-admin')).toBeVisible()
})

test('a service account: its secrets, the bindings that name it, and the workloads that use it', async ({
  page,
}) => {
  await goTo(page, 'Service Accounts')
  await expect(headers(page, 'Service Accounts')).toHaveText(['', 'Name', 'Secrets', 'Age'])
  await expect(row(page, 'Service Accounts', 'checkout')).toContainText('checkoutshop1')
  await open(page, 'Service Accounts', 'checkout')
  const checkout = panel(page, 'ServiceAccount', 'checkout')
  await expect(checkout).toContainText('API tokenMounted in its pods')
  await expect(checkout).toContainText('SecretsSecret/checkout-token')
  await expect(checkout).toContainText('Image pull secretsSecret/registry-pull')
  // What it may do, by the bindings that name it: in its namespace, and everywhere.
  expect(await table(checkout, 'Bindings')).toEqual([
    ['RoleBinding/checkout-reads-config', 'Role/config-reader', 'shop'],
    ['ClusterRoleBinding/checkout-views-everything', 'ClusterRole/view', 'Everywhere'],
  ])
  await checkout.getByRole('button', { name: 'Role/config-reader' }).click()
  await expect(panel(page, 'Role', 'config-reader')).toBeVisible()

  // One with no secrets, and one no binding names.
  await open(page, 'Service Accounts', 'storefront')
  const storefront = panel(page, 'ServiceAccount', 'storefront')
  await expect(storefront).toContainText('API tokenNot mounted in its pods, unless a pod asks')
  await expect(storefront).not.toContainText('Image pull secrets')
  expect(await table(storefront, 'Bindings')).toEqual([
    ['RoleBinding/shop-viewers', 'ClusterRole/view', 'shop'],
  ])
  await open(page, 'Service Accounts', 'default')
  await expect(panel(page, 'ServiceAccount', 'default')).toContainText(
    'No binding names it: it may do only what every service account may.',
  )

  // A workload and its pods link the account they act as.
  await open(page, 'Deployments', 'checkout')
  const deployment = panel(page, 'Deployment', 'checkout')
  await deployment.getByRole('button', { name: 'ServiceAccount/checkout' }).click()
  await expect(checkout).toBeVisible()
})

test('someone who may not list them is told so, on the page and in a panel', async ({
  page,
  clusters,
}) => {
  const forbidden = (path: string, what: string) =>
    clusters.demo.fail(path, {
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'Status',
        reason: 'Forbidden',
        code: 403,
        message: `${what} is forbidden: User "demo" cannot list resource "${what}" at the cluster scope`,
      }),
    })
  forbidden('/apis/rbac.authorization.k8s.io/v1/clusterroles', 'clusterroles')
  await goTo(page, 'Cluster Roles')
  await expect(page.getByRole('alert')).toContainText('Access denied')
  await expect(page.getByRole('alert')).toContainText('clusterroles is forbidden')

  // A role's own page is read, and the bindings that grant it are said not to be.
  forbidden('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', 'clusterrolebindings')
  await open(page, 'Service Accounts', 'checkout')
  const checkout = panel(page, 'ServiceAccount', 'checkout')
  expect(await table(checkout, 'Bindings')).toEqual([
    ['RoleBinding/checkout-reads-config', 'Role/config-reader', 'shop'],
  ])
  await expect(checkout.getByRole('alert')).toContainText(
    'There may be more: some bindings couldn’t be read.',
  )
  await expect(checkout.getByRole('alert')).toContainText('clusterrolebindings is forbidden')
})
