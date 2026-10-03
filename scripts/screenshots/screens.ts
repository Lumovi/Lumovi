/**
 * Every screenshot taken, in the order the catalog shows them. A name is
 * where the files live (docs/screenshots/<name>-<theme>.webp), and the docs
 * and website link to them: keep names once published.
 */
import type { Page } from '@playwright/test'
import { DEMO } from '../../tests/mock-cluster/kubeconfig.ts'
import { CLUSTERS } from './clusters.ts'

export interface Screen {
  name: string
  title: string
  /** What it shows, in a sentence: its alt text. */
  description: string
  /** The desktop app, or KubeStacks served from a cluster (signed in as `server` says). */
  app: 'desktop' | 'server'
  server?: 'token' | 'sso' | 'proxy'
  /** Where it starts: a path in the app. */
  path: string
  /** What to do there before the screenshot, if anything. */
  steps?: (page: Page) => Promise<void>
  /** What to put back afterwards, for the screenshots after it. */
  after?: (page: Page) => Promise<void>
}

const cluster = `/cluster/${CLUSTERS.production}`
const [storefrontPod] = DEMO.pods.storefront

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text }).first()
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click()
const moreActions = async (page: Page, action: string) => {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: action }).click()
}
/** Turns the production cluster's read-only switch over. */
const toggleReadOnly = async (page: Page) => {
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
}

export const SCREENS: Screen[] = [
  {
    name: 'clusters',
    title: 'Clusters',
    description: 'Every cluster in the kubeconfig, ready to open.',
    app: 'desktop',
    path: '/',
  },
  {
    name: 'overview',
    title: 'Overview',
    description:
      "A cluster's overview: nodes, pods and workloads, CPU and memory with their last hour, and what needs attention.",
    app: 'desktop',
    path: cluster,
  },
  {
    name: 'workloads',
    title: 'Workloads',
    description: 'Every workload, whatever its kind, in one list, with its health.',
    app: 'desktop',
    path: `${cluster}/workloads`,
  },
  {
    name: 'deployment',
    title: 'A deployment',
    description: "A deployment that's failing, with its pods and why they're restarting.",
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.checkout}`,
    steps: (page) => tab(page, 'Pods'),
  },
  {
    name: 'logs',
    title: 'Logs',
    description: 'The logs of every pod of a deployment, merged as they happened.',
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.checkout}`,
    steps: (page) => tab(page, 'Logs'),
  },
  {
    name: 'pods',
    title: 'Pods',
    description: 'Every pod, its status and restarts, with the failing ones first.',
    app: 'desktop',
    path: `${cluster}/pods`,
  },
  {
    name: 'pod',
    title: 'A pod',
    description: "A pod's details next to the list: its containers, their usage and state.",
    app: 'desktop',
    path: `${cluster}/pods?open=Pod/shop/${storefrontPod}`,
  },
  {
    name: 'shell',
    title: 'Shell',
    description: 'A shell in a running container.',
    app: 'desktop',
    path: `${cluster}/pods?open=Pod/shop/${storefrontPod}`,
    async steps(page) {
      await tab(page, 'Shell')
      await page.waitForTimeout(800)
      for (const command of ['hostname', 'whoami', 'pwd', 'ls']) {
        await page.keyboard.type(command)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(250)
      }
    },
  },
  {
    name: 'yaml',
    title: 'Editing YAML',
    description:
      "A change to a ConfigMap's YAML, checked by the cluster and shown before it's saved.",
    app: 'desktop',
    path: `${cluster}/configmaps?open=ConfigMap/shop/storefront-config`,
    async steps(page) {
      await tab(page, 'YAML')
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('textbox', { name: /^YAML of/ }).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.insertText('\n  FEATURE_SEARCH: "on"')
      await page.getByRole('button', { name: 'Review changes' }).click()
      await page.getByText('The cluster accepts this change').waitFor()
    },
  },
  {
    name: 'bulk',
    title: 'Several at once',
    description: 'Several pods picked, to act on them at once.',
    app: 'desktop',
    path: `${cluster}/pods`,
    async steps(page) {
      for (const pod of DEMO.pods.checkout) await row(page, pod).getByRole('checkbox').click()
    },
  },
  {
    name: 'scale',
    title: 'Scaling',
    description: 'Scaling a deployment, with what will change.',
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.storefront}`,
    async steps(page) {
      await page.getByRole('button', { name: 'Scale', exact: true }).click()
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
    },
  },
  {
    name: 'create',
    title: 'Create from YAML',
    description: "Creating resources from YAML, checked as it's typed.",
    app: 'desktop',
    path: `${cluster}/pods`,
    steps: (page) => page.keyboard.press('ControlOrMeta+n'),
  },
  {
    name: 'metrics',
    title: 'Metrics',
    description: 'Usage over the last six hours from Prometheus, by namespace.',
    app: 'desktop',
    path: `${cluster}/metrics?range=6h`,
  },
  {
    name: 'right-sizing',
    title: 'Right-sizing',
    description:
      'What each workload should request from a week of usage, with why, and its week against the request, the recommendation and the limit.',
    app: 'desktop',
    path: `${cluster}/metrics/right-sizing`,
    steps: (page) =>
      page.getByRole('button', { name: 'Show recommendation for prometheus', exact: true }).click(),
  },
  {
    name: 'pod-metrics',
    title: "A pod's usage",
    description: "A pod's CPU and memory over time, against its requests and limits.",
    app: 'desktop',
    path: `${cluster}/pods?open=Pod/shop/${storefrontPod}`,
    steps: (page) => tab(page, 'Metrics'),
  },
  {
    name: 'nodes',
    title: 'Nodes',
    description: 'Nodes, their usage and conditions: one under memory pressure, one not ready.',
    app: 'desktop',
    path: `${cluster}/nodes`,
  },
  {
    name: 'node',
    title: 'A node',
    description: 'A node under memory pressure, with what runs on it and ways to drain it.',
    app: 'desktop',
    path: `${cluster}/nodes?open=Node//${DEMO.nodes.worker2}`,
  },
  {
    name: 'events',
    title: 'Events',
    description: 'What happened in the cluster, warnings first.',
    app: 'desktop',
    path: `${cluster}/events`,
  },
  {
    name: 'services',
    title: 'Services',
    description: 'Services with their ports and endpoints.',
    app: 'desktop',
    path: `${cluster}/services?open=Service/shop/${DEMO.services.storefront}`,
  },
  {
    name: 'port-forward',
    title: 'Port forwarding',
    description: 'Forwarding a local port to a service.',
    app: 'desktop',
    path: `${cluster}/services?open=Service/shop/${DEMO.services.storefront}`,
    steps: (page) => moreActions(page, 'Forward a port…'),
  },
  {
    name: 'secret',
    title: 'A secret',
    description: "A secret's keys, hidden until asked for.",
    app: 'desktop',
    path: `${cluster}/secrets?open=Secret/data/${DEMO.secrets.postgresCredentials}`,
  },
  {
    name: 'storage',
    title: 'Storage',
    description: 'Persistent volume claims, their capacity and what uses them.',
    app: 'desktop',
    path: `${cluster}/persistentvolumeclaims`,
  },
  {
    name: 'api-resources',
    title: 'API resources',
    description: 'Every kind the cluster serves, custom resources included.',
    app: 'desktop',
    path: `${cluster}/api-resources`,
  },
  {
    name: 'custom-resource',
    title: 'A custom resource',
    description: "A cert-manager certificate, shown with KubeStacks' view of it.",
    app: 'desktop',
    path: `${cluster}/api-resources`,
    async steps(page) {
      await page
        .getByRole('rowgroup', { name: 'cert-manager.io', exact: true })
        .getByRole('button', { name: /^Certificates/ })
        .click()
      await row(page, 'api-tls').getByRole('gridcell').nth(1).click()
    },
  },
  {
    name: 'add-on',
    title: 'An add-on',
    description:
      "Flux's add-on: everything Flux runs in one list, what's failing first, and a tab for each of its kinds.",
    app: 'desktop',
    path: `${cluster}/add-ons/flux`,
  },
  {
    name: 'karpenter',
    title: 'Karpenter',
    description:
      "Karpenter's node pools against their limits, the nodes they launched, and what's being replaced or waiting for a node.",
    app: 'desktop',
    path: `${cluster}/add-ons/karpenter`,
  },
  {
    name: 'helm-releases',
    title: 'Helm releases',
    description: 'Every Helm release, its chart, version and status.',
    app: 'desktop',
    path: `${cluster}/helm`,
  },
  {
    name: 'helm',
    title: 'A Helm release',
    description: "A Helm release's history, ready to roll back.",
    app: 'desktop',
    path: `${cluster}/helm?release=shop/storefront`,
    steps: (page) => tab(page, 'History'),
  },
  {
    name: 'helm-upgrade',
    title: 'Upgrading a release',
    description: 'Upgrading a Helm release with new values.',
    app: 'desktop',
    path: `${cluster}/helm?release=shop/storefront`,
    async steps(page) {
      await page.getByRole('button', { name: 'Upgrade…' }).click()
      await page.getByRole('textbox', { name: 'Values' }).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.insertText('ingress:\n  enabled: true\n')
    },
  },
  {
    name: 'helm-install',
    title: 'Installing a chart',
    description: 'Finding a chart on Artifact Hub to install.',
    app: 'desktop',
    path: `${cluster}/helm`,
    async steps(page) {
      await page.getByRole('button', { name: 'Install chart' }).click()
      await page.getByLabel('Search Artifact Hub').fill('redis')
      await page.getByRole('button', { name: 'Search' }).click()
      await page.getByRole('list', { name: 'Charts found' }).waitFor()
    },
  },
  {
    name: 'command-palette',
    title: 'Command palette',
    description: 'Finding anything in the cluster, or anything to do, from the keyboard.',
    app: 'desktop',
    path: `${cluster}/pods`,
    async steps(page) {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('check')
    },
  },
  {
    name: 'shortcuts',
    title: 'Keyboard shortcuts',
    description: 'Every keyboard shortcut.',
    app: 'desktop',
    path: cluster,
    async steps(page) {
      await page.keyboard.press('?')
      // Opened from the keyboard, its close button would show it has focus.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    },
  },
  {
    name: 'delete',
    title: 'Deleting safely',
    description: 'Deleting in a production cluster asks for its name first.',
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.cart}`,
    steps: (page) => moreActions(page, 'Delete…'),
  },
  {
    name: 'read-only',
    title: 'Read-only',
    description: "A cluster made read-only: KubeStacks won't change anything in it until allowed.",
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.storefront}`,
    async steps(page) {
      await toggleReadOnly(page)
      await page.getByRole('button', { name: 'More actions' }).click()
    },
    async after(page) {
      await page.keyboard.press('Escape')
      await toggleReadOnly(page)
    },
  },
  {
    name: 'unreachable',
    title: 'An unreachable cluster',
    description: "A cluster that doesn't answer, and what to try.",
    app: 'desktop',
    path: `/cluster/${CLUSTERS.edge}`,
  },
  {
    name: 'large-cluster',
    title: 'Thousands of pods',
    description: 'Thousands of pods, listed as fast as a handful.',
    app: 'desktop',
    path: `/cluster/${CLUSTERS.loadTest}/pods`,
  },
  {
    name: 'server-sign-in',
    title: 'Signing in with a token',
    description: 'KubeStacks served from a cluster: signing in with a token.',
    app: 'server',
    server: 'token',
    path: '/',
  },
  {
    name: 'server-single-sign-on',
    title: 'Single sign-on',
    description: 'KubeStacks served from a cluster: signing in with single sign-on.',
    app: 'server',
    server: 'sso',
    path: '/',
  },
  {
    name: 'server-account',
    title: 'Signed in',
    description: "KubeStacks served from a cluster: who's signed in, and their groups.",
    app: 'server',
    server: 'proxy',
    path: cluster,
    steps: (page) => page.getByRole('button', { name: /^Signed in as/ }).click(),
  },
]
