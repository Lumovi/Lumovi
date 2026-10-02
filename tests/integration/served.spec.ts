/**
 * KubeStacks served from the cluster, as people install it: the image (built
 * by cluster.ts) with the Helm chart, reached through a port forward. Its
 * service account's RBAC (impersonation), the in-cluster configuration and
 * the WebSocket through the API server's proxy all get checked for real.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { test as base, type Browser, type Page } from '@playwright/test'
import { CONTEXT, KUBECONFIG, SERVED_IMAGE } from './cluster.ts'
import { expect, freshNamespace, kubectl } from './fixtures.ts'
import { web } from './workloads.ts'

const NS = 'it-served'
const RELEASE = 'kubestacks'
const [repository, tag] = SERVED_IMAGE.split(':')

const test = base
test.describe.configure({ mode: 'serial' })

/** Installs (or upgrades) the chart with these values, and waits for it. */
function install(values: Record<string, string>) {
  execFileSync(
    'helm',
    [
      '--kubeconfig',
      KUBECONFIG,
      '--kube-context',
      CONTEXT,
      'upgrade',
      '--install',
      RELEASE,
      resolve('charts/kubestacks'),
      '--namespace',
      NS,
      '--set',
      `image.repository=${repository}`,
      '--set',
      `image.tag=${tag}`,
      '--set',
      'image.pullPolicy=Never',
      '--set',
      'clusterName=kind',
      ...Object.entries(values).flatMap(([key, value]) => ['--set', `${key}=${value}`]),
      '--wait',
      '--timeout',
      '3m',
    ],
    { stdio: 'inherit' },
  )
  kubectl(['rollout', 'status', `deployment/${RELEASE}`, '-n', NS, '--timeout=120s'])
}

let forward: ChildProcess
let url: string

/** Forwards a local port to the service, as the chart's notes say. */
async function portForward() {
  forward?.kill()
  forward = spawn(
    'kubectl',
    [
      '--kubeconfig',
      KUBECONFIG,
      '--context',
      CONTEXT,
      'port-forward',
      '-n',
      NS,
      `service/${RELEASE}`,
      '0:80',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  url = await new Promise<string>((done) => {
    forward.stdout!.setEncoding('utf8').on('data', (text: string) => {
      const port = /127\.0\.0\.1:(\d+)/.exec(text)?.[1]
      if (port) done(`http://127.0.0.1:${port}/`)
    })
  })
}

test.beforeAll(() => {
  freshNamespace(NS, [web(1)])
  kubectl(['delete', 'clusterrolebinding', 'it-served-viewer', '--ignore-not-found'])
  kubectl([
    'create',
    'clusterrolebinding',
    'it-served-viewer',
    '--clusterrole=view',
    '--group=served-viewers',
  ])
})

test.afterAll(() => {
  forward?.kill()
  execFileSync('helm', [
    '--kubeconfig',
    KUBECONFIG,
    '--kube-context',
    CONTEXT,
    'uninstall',
    RELEASE,
    '--namespace',
    NS,
    '--ignore-not-found',
  ])
  kubectl(['delete', 'clusterrolebinding', 'it-served-viewer', '--ignore-not-found'])
})

async function proxied(browser: Browser, user: string, groups: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups },
  })
  return context.newPage()
}

test('behind a proxy: each person with their own RBAC', async ({ browser }) => {
  install({ 'auth.mode': 'proxy' })
  await portForward()

  // In the view role's group: sees workloads in every namespace (not nodes: view doesn't).
  const viewer = await proxied(browser, 'vera@example.com', 'served-viewers')
  await viewer.goto(`${url}cluster/kind/deployments`)
  await expect(viewer.getByRole('grid', { name: 'Deployments' })).toContainText('web')
  await expect(viewer.getByRole('button', { name: 'Cluster', exact: true })).toContainText(
    /Kubernetes v1\.\d+/,
  )
  await viewer.goto(`${url}cluster/kind/nodes`)
  await expect(viewer.getByRole('alert')).toContainText(
    'User "vera@example.com" cannot list resource "nodes"',
  )

  // Nobody in particular: the cluster refuses what they ask.
  const nobody = await proxied(browser, 'nobody@example.com', '')
  await nobody.goto(`${url}cluster/kind/deployments`)
  await expect(nobody.getByRole('alert')).toContainText('Access denied')
})

test('with a token: the cluster checks it', async ({ browser }) => {
  install({ 'auth.mode': 'token' })
  await portForward()
  kubectl(['create', 'serviceaccount', 'reader', '-n', NS])
  kubectl([
    'create',
    'rolebinding',
    'reader',
    '--clusterrole=view',
    `--serviceaccount=${NS}:reader`,
    '-n',
    NS,
  ])
  const token = kubectl(['create', 'token', 'reader', '-n', NS, '--duration=1h']).trim()
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${url}cluster/kind/pods`)
  await page.getByPlaceholder('Paste a token').fill(token)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(
    page.getByRole('button', { name: `Signed in as system:serviceaccount:${NS}:reader` }),
  ).toBeVisible()
  // Its RBAC applies: its own namespace only.
  await expect(page.getByRole('alert')).toContainText(
    `User "system:serviceaccount:${NS}:reader" cannot list resource "pods" in API group "" at the cluster scope`,
  )
})
