/**
 * Access control: service accounts, roles and bindings have pages of their own. A role's
 * rules read as a table; a binding links its role and its subjects; a role and a service
 * account each list the bindings that name them; and a workload links its service account.
 */
import type { Page } from '@playwright/test'
import { open } from './action-helpers.ts'
import { expect, goTo, openCluster, panel, row, rows, test } from './fixtures.ts'

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
  await expect
    .poll(() => table(role, 'Rules'))
    .toEqual([
      ['core', 'configmaps', 'getlistwatch'],
      ['core', 'secretsonly those named payments-credentials', 'get'],
      ['batch', 'jobs', 'createdelete'],
    ])
  // Who it's granted to, and by which binding: the way back from a role.
  await expect
    .poll(() => table(role, 'Granted by'))
    .toEqual([['RoleBinding/checkout-reads-config', 'ServiceAccount shop/checkout', 'shop']])
  await role.getByRole('button', { name: 'RoleBinding/checkout-reads-config' }).click()
  await expect(panel(page, 'RoleBinding', 'checkout-reads-config')).toBeVisible()

  await open(page, 'Roles', 'nothing-yet')
  const empty = panel(page, 'Role', 'nothing-yet')
  await expect(empty).toContainText('RulesNone')
  await expect(empty).toContainText('No rules: it allows nothing.')
  await expect
    .poll(() => table(empty, 'Granted by'))
    .toEqual([['RoleBinding/nobody-yet', 'Nobody', 'shop']])
})

test('a cluster role: everything, URLs, and rules gathered from others', async ({
  page,
  clusters,
}) => {
  await goTo(page, 'Cluster Roles')
  await expect(headers(page, 'Cluster Roles')).toHaveText(['', 'Name', 'Rules', 'Age'])
  await open(page, 'Cluster Roles', 'cluster-admin')
  const admin = panel(page, 'ClusterRole', 'cluster-admin')
  await expect
    .poll(() => table(admin, 'Rules'))
    .toEqual([
      ['All groups', 'All resources', 'All verbs'],
      ['Not a resource', 'URLs: *', 'All verbs'],
    ])
  await expect
    .poll(() => table(admin, 'Granted by'))
    .toEqual([
      ['ClusterRoleBinding/platform-admins', 'Group platform-team, Robot deployer', 'Everywhere'],
    ])
  // One granted in a namespace and everywhere: both kinds of binding are found.
  await open(page, 'Cluster Roles', 'view')
  await expect
    .poll(() => table(panel(page, 'ClusterRole', 'view'), 'Granted by'))
    .toEqual([
      ['RoleBinding/storefront-as-a-user', 'User system:serviceaccount:shop:storefront', 'default'],
      [
        'RoleBinding/shop-viewers',
        'Group shop-team, User jane@example.com, ServiceAccount shop/storefront',
        'shop',
      ],
      [
        'ClusterRoleBinding/checkout-views-everything',
        'ServiceAccount shop/checkout',
        'Everywhere',
      ],
    ])
  // Its rules are the cluster's to gather, and there are none yet.
  await open(page, 'Cluster Roles', 'shop-admin')
  const gathered = panel(page, 'ClusterRole', 'shop-admin')
  await expect(gathered).toContainText(
    'Its rules are gathered by the cluster from the cluster roles labelled rbac.example.com/aggregate-to-shop-admin=true.',
  )
  await expect(gathered).toContainText('No rules: it allows nothing.')
  await expect(gathered).toContainText('No binding grants it to anyone.')
  // Whatever a selector says is said: labels, expressions, and one that asks nothing. And a
  // rule's names narrow every resource in it.
  await open(page, 'Cluster Roles', 'job-runner')
  const runner = panel(page, 'ClusterRole', 'job-runner')
  await expect(runner).toContainText(
    'Its rules are gathered by the cluster from the cluster roles labelled rbac.example.com/jobs=true, tier in (batch, cron), !deprecated, and from the cluster roles labelled rbac.example.com/always.',
  )
  await expect
    .poll(() => table(runner, 'Rules'))
    .toEqual([['batch', 'jobs, cronjobsonly those named nightly', 'get']])
  await expect
    .poll(() => table(runner, 'Granted by'))
    .toEqual([['RoleBinding/shop-accounts-run-jobs', 'Group system:serviceaccounts:shop', 'shop']])

  // A cluster role whose rules another gathers is granted with that one, though no binding
  // names it: that's said, and never "to anyone".
  await open(page, 'Cluster Roles', 'shop-reports')
  const reports = panel(page, 'ClusterRole', 'shop-reports')
  await expect(reports).toContainText('No binding grants it by its own name.')
  await expect(reports).toContainText(
    'Its rules are also part of ClusterRole/shop-admin, which gathers them: whoever that is granted to has them too.',
  )
  await expect(reports).not.toContainText('to anyone')
  await reports.getByRole('button', { name: 'ClusterRole/shop-admin' }).click()
  await expect(panel(page, 'ClusterRole', 'shop-admin')).toBeVisible()
  // A selector that asks nothing gathers every cluster role: said, and each of them says it.
  clusters.demo.upsert({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: 'everything' },
    aggregationRule: { clusterRoleSelectors: [{}] },
  })
  await open(page, 'Cluster Roles', 'everything')
  await expect(panel(page, 'ClusterRole', 'everything')).toContainText(
    'Its rules are gathered by the cluster from every cluster role.',
  )
  await open(page, 'Cluster Roles', 'shop-reports')
  await expect(reports).toContainText(
    'Its rules are also part of ClusterRole/everything and ClusterRole/shop-admin, which gather them: whoever those are granted to has them too.',
  )
  // And three are said as a list is.
  clusters.demo.upsert({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: 'all-reports' },
    aggregationRule: {
      clusterRoleSelectors: [
        { matchLabels: { 'rbac.example.com/aggregate-to-shop-admin': 'true' } },
      ],
    },
  })
  await expect(reports).toContainText(
    'Its rules are also part of ClusterRole/all-reports, ClusterRole/everything and ClusterRole/shop-admin, which gather them',
  )
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
  await expect
    .poll(() => table(viewers, 'Subjects'))
    .toEqual([
      ['Group', 'shop-team', '—'],
      ['User', 'jane@example.com', '—'],
      ['ServiceAccount', 'ServiceAccount/storefront', 'shop'],
    ])
  await viewers.getByRole('button', { name: 'ServiceAccount/storefront' }).click()
  await expect(panel(page, 'ServiceAccount', 'storefront')).toBeVisible()

  // A service account named without its namespace is the binding's own; a binding to nobody
  // says so.
  await open(page, 'Role Bindings', 'checkout-reads-config')
  await expect
    .poll(() => table(panel(page, 'RoleBinding', 'checkout-reads-config'), 'Subjects'))
    .toEqual([['ServiceAccount', 'ServiceAccount/checkout', 'shop']])
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
  await expect
    .poll(() => table(admins, 'Subjects'))
    .toEqual([
      ['Group', 'platform-team', '—'],
      ['Robot', 'deployer', '—'],
    ])
  await admins.getByRole('button', { name: 'ClusterRole/cluster-admin' }).click()
  await expect(panel(page, 'ClusterRole', 'cluster-admin')).toBeVisible()
})

test('a service account: its secrets, the bindings that name it, and the workloads that use it', async ({
  page,
  clusters,
}) => {
  await goTo(page, 'Service Accounts')
  await expect(headers(page, 'Service Accounts')).toHaveText(['', 'Name', 'Secrets', 'Age'])
  await expect(row(page, 'Service Accounts', 'checkout')).toContainText('checkoutshop1')
  await open(page, 'Service Accounts', 'checkout')
  const checkout = panel(page, 'ServiceAccount', 'checkout')
  await expect(checkout).toContainText('API tokenMounted in its pods, unless a pod says not to')
  await expect(checkout).toContainText('SecretsSecret/checkout-token')
  await expect(checkout).toContainText('Image pull secretsSecret/registry-pull')
  // What it may do, by the bindings that name it: in its namespace, and everywhere.
  // Those that name it first; then those that name a group it's in, which grant it as much.
  await expect
    .poll(() => table(checkout, 'Bindings'))
    .toEqual([
      ['RoleBinding/checkout-reads-config', 'Role/config-reader', 'shop'],
      ['ClusterRoleBinding/checkout-views-everything', 'ClusterRole/view', 'Everywhere'],
      [
        'RoleBinding/shop-accounts-run-jobsthrough the group system:serviceaccounts:shop',
        'ClusterRole/job-runner',
        'shop',
      ],
    ])
  await checkout.getByRole('button', { name: 'Role/config-reader' }).click()
  await expect(panel(page, 'Role', 'config-reader')).toBeVisible()

  // One with no secrets, and one no binding names.
  await open(page, 'Service Accounts', 'storefront')
  const storefront = panel(page, 'ServiceAccount', 'storefront')
  await expect(storefront).toContainText('API tokenNot mounted in its pods, unless a pod asks')
  await expect(storefront).not.toContainText('Image pull secrets')
  // Each row says how the account is reached, where it isn't by its name: as the user every
  // service account also is, or through a group it's in.
  await expect
    .poll(() => table(storefront, 'Bindings'))
    .toEqual([
      ['RoleBinding/shop-viewers', 'ClusterRole/view', 'shop'],
      [
        'RoleBinding/storefront-as-a-useras the user system:serviceaccount:shop:storefront',
        'ClusterRole/view',
        'default',
      ],
      [
        'RoleBinding/shop-accounts-run-jobsthrough the group system:serviceaccounts:shop',
        'ClusterRole/job-runner',
        'shop',
      ],
    ])
  // One in another namespace, which nothing reaches: said as what was looked for.
  await rows(page, 'Service Accounts')
  await page.getByPlaceholder('Filter service accounts').fill('default')
  await row(page, 'Service Accounts', /^defaultdefault/)
    .getByRole('gridcell')
    .nth(1)
    .click()
  const lone = panel(page, 'ServiceAccount', 'default')
  await expect(lone).toContainText('No binding names it, or a group it’s in.')
  // Until one names every service account, or everyone who's signed in.
  clusters.demo.upsert({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: 'accounts-discover' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
    subjects: [
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:serviceaccounts' },
    ],
  })
  await expect
    .poll(() => table(lone, 'Bindings'), { timeout: 15_000 })
    .toEqual([
      [
        'ClusterRoleBinding/accounts-discoverthrough the group system:serviceaccounts',
        'ClusterRole/view',
        'Everywhere',
      ],
    ])

  // A workload and its pods link the account they act as; one whose template names none
  // acts as its namespace's default, and links that.
  await open(page, 'Deployments', 'checkout')
  const deployment = panel(page, 'Deployment', 'checkout')
  await deployment.getByRole('button', { name: 'ServiceAccount/checkout' }).click()
  await expect(checkout).toBeVisible()
  clusters.demo.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'bare', namespace: 'shop' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'bare' } },
      template: {
        metadata: { labels: { app: 'bare' } },
        spec: { containers: [{ name: 'bare', image: 'nginx:1.27' }] },
      },
    },
    status: { replicas: 0 },
  })
  await open(page, 'Deployments', 'bare')
  await expect(panel(page, 'Deployment', 'bare')).toContainText(
    'Service accountServiceAccount/default',
  )
})

test('what’s only half an object is still drawn, as what it says', async ({ page, clusters }) => {
  const RBAC = 'rbac.authorization.k8s.io/v1'
  // A binding to a kind of role nobody knows, with a subject that says only what it is, one
  // that says only its name, and one that says nothing.
  clusters.demo.upsert({
    apiVersion: RBAC,
    kind: 'RoleBinding',
    metadata: { name: 'half-said', namespace: 'shop' },
    roleRef: { apiGroup: 'policy.example.com', kind: 'Policy', name: 'strict' },
    subjects: [{ kind: 'Group' }, { name: 'someone' }, {}],
  })
  // One that names no role at all.
  clusters.demo.upsert({
    apiVersion: RBAC,
    kind: 'RoleBinding',
    metadata: { name: 'no-role', namespace: 'shop' },
    roleRef: {},
    subjects: [{ kind: 'User', name: 'jane@example.com' }],
  })
  // A role with a rule that names no groups and no verbs, and one that names no resources.
  clusters.demo.upsert({
    apiVersion: RBAC,
    kind: 'Role',
    metadata: { name: 'half-ruled', namespace: 'shop' },
    rules: [{ resources: ['pods'] }, { apiGroups: ['apps'], verbs: ['get'] }],
  })
  // A service account whose list of secrets has an entry with no name.
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'half-kept', namespace: 'shop' },
    secrets: [{}, { name: 'half-kept-token' }],
  })

  await goTo(page, 'Role Bindings')
  await expect(row(page, 'Role Bindings', 'half-said')).toContainText(
    'Policy/strictGroup (unnamed), and 2 more',
  )
  await expect(row(page, 'Role Bindings', 'no-role')).toContainText('—User jane@example.com')
  await open(page, 'Role Bindings', 'half-said')
  const half = panel(page, 'RoleBinding', 'half-said')
  // The role is said as it's written, and isn't a link: there's nothing to open.
  await expect(half).toContainText('RolePolicy/strict')
  await expect(half.getByRole('button', { name: 'Policy/strict' })).toHaveCount(0)
  await expect
    .poll(() => table(half, 'Subjects'))
    .toEqual([
      ['Group', '—', '—'],
      ['—', 'someone', '—'],
      ['—', '—', '—'],
    ])
  await open(page, 'Role Bindings', 'no-role')
  await expect(panel(page, 'RoleBinding', 'no-role')).toContainText('RoleNone')

  await open(page, 'Roles', 'half-ruled')
  await expect
    .poll(() => table(panel(page, 'Role', 'half-ruled'), 'Rules'))
    .toEqual([
      ['', 'pods', ''],
      ['apps', '', 'get'],
    ])
  await open(page, 'Service Accounts', 'half-kept')
  await expect(panel(page, 'ServiceAccount', 'half-kept')).toContainText(
    'Secrets—Secret/half-kept-token',
  )
})

test('someone who may not list them is told so, on the page and in a panel', async ({
  page,
  clusters,
}) => {
  const forbidden = (path: string | RegExp, what: string) =>
    clusters.demo.fail(path, {
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'Status',
        reason: 'Forbidden',
        code: 403,
        message: `${what} is forbidden: User "demo" cannot list resource "${what}"`,
      }),
    })
  const crbRequests = () =>
    clusters.demo.requests.filter((request) => request.path.endsWith('/clusterrolebindings')).length

  // ClusterRoleBindings can't be listed. A Role is granted only by RoleBindings: its panel
  // doesn't ask for the other kind at all, and says nothing of it.
  forbidden('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', 'clusterrolebindings')
  await open(page, 'Roles', 'config-reader')
  const role = panel(page, 'Role', 'config-reader')
  await expect
    .poll(() => table(role, 'Granted by'))
    .toEqual([['RoleBinding/checkout-reads-config', 'ServiceAccount shop/checkout', 'shop']])
  await expect(role.getByRole('alert')).toHaveCount(0)
  expect(crbRequests()).toBe(0)
  // A service account's panel shows what it could read, and says the rest wasn't.
  await open(page, 'Service Accounts', 'checkout')
  const checkout = panel(page, 'ServiceAccount', 'checkout')
  await expect
    .poll(async () => (await table(checkout, 'Bindings')).map(([binding]) => binding))
    .toEqual([
      'RoleBinding/checkout-reads-config',
      'RoleBinding/shop-accounts-run-jobsthrough the group system:serviceaccounts:shop',
    ])
  await expect(checkout.getByRole('alert')).toContainText(
    'There may be more: some bindings couldn’t be read.',
  )
  await expect(checkout.getByRole('alert')).toContainText('clusterrolebindings is forbidden')
  // One that nothing it could read reaches is never said to be reached by nothing.
  await page.getByPlaceholder('Filter service accounts').fill('default')
  await row(page, 'Service Accounts', /^defaultdefault/)
    .getByRole('gridcell')
    .nth(1)
    .click()
  const lone = panel(page, 'ServiceAccount', 'default')
  await expect(lone.getByRole('alert')).toContainText('Some bindings couldn’t be read.')
  await expect(lone).not.toContainText('No binding names it')

  // ClusterRoles can't be listed: their page says so in the app's usual way.
  forbidden('/apis/rbac.authorization.k8s.io/v1/clusterroles', 'clusterroles')
  await goTo(page, 'Cluster Roles')
  // (The panel that's still open has its own word; this is the page's.)
  const denied = page.getByRole('alert').filter({ hasText: 'Access denied' })
  await expect(denied).toContainText('clusterroles is forbidden')
  await goTo(page, 'Cluster Role Bindings')
  await expect(denied).toContainText('clusterrolebindings is forbidden')
})

test('a role whose bindings can’t be listed says so, and not that nothing grants it', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail(/\/rolebindings$/, {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'Status',
      reason: 'Forbidden',
      code: 403,
      message: 'rolebindings is forbidden: User "demo" cannot list resource "rolebindings"',
    }),
  })
  await open(page, 'Roles', 'nothing-yet')
  const empty = panel(page, 'Role', 'nothing-yet')
  await expect(empty.getByRole('alert')).toHaveText(
    'Some bindings couldn’t be read. rolebindings is forbidden: User "demo" cannot list resource "rolebindings"',
  )
  await expect(empty.getByRole('table', { name: 'Granted by' })).toHaveCount(0)
  await expect(empty).not.toContainText('No binding grants it')
  // (What the role itself says is read, and shown.)
  await expect(empty).toContainText('No rules: it allows nothing.')
  // The same of a service account: nothing it's reached by is claimed.
  await open(page, 'Service Accounts', 'storefront')
  const storefront = panel(page, 'ServiceAccount', 'storefront')
  await expect(storefront.getByRole('alert')).toContainText('Some bindings couldn’t be read.')
  await expect(storefront).not.toContainText('No binding names it')
})

test('a cluster role opened where cluster roles can’t be listed says what it couldn’t tell', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail('/apis/rbac.authorization.k8s.io/v1/clusterroles', {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'Status',
      reason: 'Forbidden',
      code: 403,
      message: 'clusterroles is forbidden: User "demo" cannot list resource "clusterroles"',
    }),
  })
  // It's opened from a binding that grants it. Its own bindings are read; whether another
  // cluster role gathers its rules can't be, and that's said, with nothing said in its place.
  await goTo(page, 'Role Bindings')
  await row(page, 'Role Bindings', 'nobody-yet').first().waitFor()
  await page.getByPlaceholder('Filter role bindings').fill('shop-accounts')
  await row(page, 'Role Bindings', 'shop-accounts-run-jobs')
    .getByRole('button', { name: 'ClusterRole/job-runner' })
    .click()
  const runner = panel(page, 'ClusterRole', 'job-runner')
  await expect
    .poll(() => table(runner, 'Granted by'))
    .toEqual([['RoleBinding/shop-accounts-run-jobs', 'Group system:serviceaccounts:shop', 'shop']])
  await expect(runner.getByRole('alert')).toContainText(
    'Whether another cluster role gathers its rules couldn’t be read.',
  )
  await expect(runner.getByRole('alert')).toContainText('clusterroles is forbidden')
})
