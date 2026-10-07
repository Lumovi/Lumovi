/**
 * Every screenshot taken, in the order the catalog shows them. A name is
 * where the files live (docs/screenshots/<name>-<theme>.webp), and the docs
 * and website link to them: keep names once published.
 */
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEMO } from '../../tests/mock-cluster/kubeconfig.ts'
import { CLUSTERS } from './clusters.ts'

/** What AI assistants send to connect, in the screenshots (index.ts sets it). */
export const ASSISTANTS_TOKEN = 'lumovi-screenshots-assistants-token'

export interface Screen {
  name: string
  title: string
  /** What it shows, in a sentence: its alt text. */
  description: string
  /** The desktop app, or Lumovi served from a cluster (signed in as `server` says). */
  app: 'desktop' | 'server'
  /**
   * How people sign in; `audit`: behind a proxy, with a day of the audit log kept; `access`:
   * a fleet behind a proxy, whose admins set who may do what.
   */
  server?: 'token' | 'sso' | 'proxy' | 'fleet' | 'audit' | 'access'
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
/** How long each cluster takes to answer, as the desktop's screenshots show it (see harness.cjs). */
const LATENCY_MS: Record<string, number> = { production: 18, staging: 9, 'load-test': 24 }

/**
 * A fleet's page once every cluster is summed up, each answering in a steady
 * time: how long they took is measured, so it'd differ from one screenshot to
 * the next.
 */
const settledFleet = async (page: Page) => {
  await page.locator('[data-cluster-card]').first().waitFor()
  await page.waitForFunction(() => !document.querySelector('.animate-shimmer'))
  await page.evaluate((latency) => {
    for (const card of document.querySelectorAll('[data-cluster-card]')) {
      const name = card.getAttribute('aria-label')!.split(', ')[0]!
      const shown = [...card.querySelectorAll('span')].find((s) => /^\d+ ms$/.test(s.textContent))
      if (shown) shown.textContent = `${latency[name] ?? 12} ms`
    }
  }, LATENCY_MS)
}

/**
 * Waits for a terminal (by its region's name) to show `text`; when it doesn't, says what it
 * shows instead (a command that isn't there, say).
 */
async function terminalText(page: Page, terminal: string | RegExp, text: string) {
  const rows = page.getByRole('region', { name: terminal, exact: true }).locator('.xterm-rows')
  try {
    await rows.filter({ hasText: text }).waitFor()
  } catch (error) {
    const shown = (await rows.innerText().catch(() => ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4)
      .join(' ⏎ ')
    const [first, ...rest] = (error as Error).message.split('\n')
    throw new Error([`${first} The terminal shows: ${shown || '(nothing)'}`, ...rest].join('\n'), {
      cause: error,
    })
  }
}

/** Claude Code, as far as Lumovi can tell, connected while a screen needs it. */
let assistant: Client | undefined

const assistantConnects = async (page: Page) => {
  const status = await page.evaluate(() => window.lumovi!.assistants!.configure({ enabled: true }))
  assistant = new Client({ name: 'claude-code', version: '2.0.0' })
  await assistant.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
}

/** A change the assistant asks for (it waits for an answer: that's not waited for). */
const assistantAsks = (name: string, args: Record<string, unknown>) => {
  void assistant!
    .callTool({ name, arguments: { cluster: CLUSTERS.production, ...args } })
    .catch(() => undefined)
}

/** It leaves: what it asked for that's still waiting is withdrawn. */
const assistantLeaves = async (page: Page) => {
  await (assistant!.transport as StreamableHTTPClientTransport).terminateSession()
  await assistant!.close()
  await page.evaluate(() => window.lumovi!.assistants!.configure({ enabled: false }))
  while ((await page.evaluate(() => window.lumovi!.approvals!.pending())).length > 0) {
    await page.waitForTimeout(100)
  }
}

/**
 * What AI assistants may do, as the screens show it: staging's changes made
 * without asking, the system's namespaces hidden, and the database's Secrets
 * and logs kept from them.
 */
const permitForScreens = (page: Page) =>
  page.evaluate(
    (staging) =>
      window.lumovi!.aiPermissions!.set({
        defaults: { changes: 'ask', secrets: 'keys', env: 'sensitive', logs: 'read' },
        rules: [
          {
            id: 'system',
            name: 'System namespaces',
            clusters: [],
            namespaces: ['kube-*'],
            set: { visibility: 'hidden' },
          },
          {
            id: 'staging',
            name: 'Staging',
            clusters: [staging],
            namespaces: [],
            set: { changes: 'allow' },
          },
          {
            id: 'database',
            name: 'Database',
            clusters: [],
            namespaces: ['data'],
            set: { secrets: 'hidden', logs: 'off', changes: 'never' },
          },
        ],
      }),
    CLUSTERS.staging,
  )

const resetPermissions = async (page: Page) => {
  await page.evaluate(() =>
    window.lumovi!.aiPermissions!.set({
      defaults: { changes: 'ask', secrets: 'keys', env: 'sensitive', logs: 'read' },
      rules: [],
    }),
  )
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
    name: 'map',
    title: 'Map',
    description:
      'What leads to a deployment, from its gateway to its services, and what it uses and runs on, to the node under memory pressure.',
    app: 'desktop',
    path: `${cluster}/deployments?open=Deployment/shop/${DEMO.deployments.storefront}`,
    steps: async (page) => {
      await tab(page, 'Map')
      await page.getByRole('button', { name: 'Expand panel' }).click()
      await page.getByRole('group', { name: 'Map', exact: true }).waitFor()
    },
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
    name: 'node-shell',
    title: 'Node shell',
    description:
      'A shell on a node itself, as root, through a pod Lumovi starts there and deletes when the shell ends.',
    app: 'desktop',
    path: `${cluster}/nodes?open=Node//${DEMO.nodes.worker1}`,
    async steps(page) {
      await tab(page, 'Shell')
      await page.getByRole('button', { name: 'Start shell' }).click()
      await terminalText(page, `Shell on ${DEMO.nodes.worker1}`, '# ')
      for (const command of ['hostname', 'whoami', 'pwd']) {
        await page.keyboard.type(command)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(250)
      }
    },
  },
  {
    name: 'terminal',
    title: 'Terminal',
    description:
      'A terminal on this computer under the cluster’s pages, with kubectl pointed at the cluster.',
    app: 'desktop',
    path: `${cluster}/deployments`,
    async steps(page) {
      await page.keyboard.press('Control+Backquote')
      await terminalText(page, /^Terminal production/, '❯')
      await page.keyboard.type('kubectl get deployments -n shop')
      await page.keyboard.press('Enter')
      await terminalText(page, /^Terminal production/, 'UP-TO-DATE')
      await page.waitForTimeout(250)
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
    name: 'assistants',
    title: 'AI assistants',
    description:
      'AI assistants on this computer connected to Lumovi, and how to connect others: the AI assistants page’s Connect tab.',
    app: 'desktop',
    path: cluster,
    async steps(page) {
      await assistantConnects(page)
      await page.getByRole('button', { name: /^AI assistants/ }).click()
      await page.getByRole('region', { name: 'Connected now' }).getByText('Claude Code').waitFor()
    },
    after: assistantLeaves,
  },
  {
    name: 'assistant-permissions',
    title: 'What AI assistants may do',
    description:
      'What AI assistants may do, and where: defaults, rules for some clusters and namespaces, any namespace checked, and what assistants are told.',
    app: 'desktop',
    path: cluster,
    async steps(page) {
      await permitForScreens(page)
      await page.getByRole('button', { name: /^AI assistants/ }).click()
      await page.getByRole('link', { name: 'Permissions' }).click()
      const check = page.getByRole('region', { name: 'Check a namespace' })
      await check.getByRole('searchbox', { name: 'Namespace' }).fill('data')
      await check.getByRole('button', { name: /^data/ }).first().click()
      await check.getByText('Database', { exact: true }).first().waitFor()
    },
    after: resetPermissions,
  },
  {
    name: 'assistant-rule',
    title: 'A rule for AI assistants',
    description:
      'A rule for what AI assistants may do: where it applies, by name, pattern or label, with what each matches, and what it says there.',
    app: 'desktop',
    path: cluster,
    async steps(page) {
      await permitForScreens(page)
      await page.getByRole('button', { name: /^AI assistants/ }).click()
      await page.getByRole('link', { name: 'Permissions' }).click()
      await page.getByRole('button', { name: /^Database/, expanded: false }).click()
      const rule = page.getByRole('article', { name: 'Database' })
      await rule.getByLabel('Namespaces', { exact: true }).fill('mon')
      await rule.getByRole('group', { name: 'Suggestions for Namespaces' }).waitFor()
      await rule.scrollIntoViewIfNeeded()
    },
    after: resetPermissions,
  },
  {
    name: 'audit',
    title: 'The audit log',
    description:
      'What was done through Lumovi, by whom, and how it went, a day at a time: one of them open, a change an AI assistant made as Jane, as she approved it.',
    app: 'server',
    server: 'audit',
    path: '/audit',
    async steps(page) {
      await page
        .getByRole('listbox', { name: 'Events' })
        .getByRole('option', { name: /Restarted Deployment checkout$/ })
        .click()
      await page
        .getByRole('complementary', { name: 'Event' })
        .getByRole('region', { name: 'Approval' })
        .waitFor()
    },
  },
  {
    name: 'audit-checked',
    title: 'The audit log, checked',
    description:
      'The audit log’s changes, checked: each one follows from the one before it, and the newest’s hash is there to compare with a copy kept elsewhere.',
    app: 'server',
    server: 'audit',
    path: '/audit?category=change',
    async steps(page) {
      await page.getByRole('button', { name: 'Check integrity' }).click()
      await page.getByRole('status', { name: 'Integrity' }).waitFor()
    },
  },
  {
    name: 'access',
    title: 'Access, for admins',
    description:
      'Who may do what through Lumovi: Lumovi’s groups, each the identity provider’s groups and people by name, with who’s in them as they last signed in, and the provider’s groups seen at sign-in.',
    app: 'server',
    server: 'access',
    path: '/access/groups',
    async steps(page) {
      await page.getByRole('button', { name: /^Developers/ }).click()
      await page.getByRole('article', { name: 'Developers' }).getByText('In it now').waitFor()
    },
  },
  {
    name: 'access-profiles',
    title: 'Access profiles',
    description:
      'Profiles side by side: what everyone signed in gets, and what developers, operators and auditors get where grants give it, with what shows Secret values or runs code on nodes marked.',
    app: 'server',
    server: 'access',
    path: '/access/profiles',
  },
  {
    name: 'access-rules',
    title: 'Grants and limits',
    description:
      'Grants that give groups a profile in some clusters and namespaces, and limits that hold anyone back wherever they match: one open, with who it names and how far it reaches.',
    app: 'server',
    server: 'access',
    path: '/access/rules',
    async steps(page) {
      await page.getByRole('button', { name: /^Production/ }).click()
      await page
        .getByRole('article', { name: 'Production' })
        .getByText('people it holds back')
        .waitFor()
    },
  },
  {
    name: 'access-check',
    title: 'Check someone',
    description:
      'What someone may do in a namespace, and which grant or limit says so: Dan, an on-call developer, in the shop on production.',
    app: 'server',
    server: 'access',
    path: '/access/check',
    async steps(page) {
      const who = page.getByRole('region', { name: 'Check someone' })
      await who.getByRole('combobox', { name: 'Person' }).fill('dan')
      await who.getByRole('combobox', { name: 'Person' }).press('Enter')
      const where = page.getByRole('region', { name: 'Where' })
      await where.getByRole('combobox', { name: 'Namespace' }).fill('shop')
      await where.getByRole('combobox', { name: 'Namespace' }).press('Enter')
    },
  },
  {
    name: 'your-access',
    title: 'Your access',
    description:
      'What Lumovi lets someone do, cluster by cluster, and why: their groups, the grants that give them more than everyone gets, and the limits that hold them back.',
    app: 'server',
    server: 'access',
    path: '/your-access',
  },
  {
    name: 'assistant-approval',
    title: 'An AI assistant’s change',
    description:
      'A change Claude Code asks for, waiting for approval: why, the diff it makes, and the kubectl command that does the same.',
    app: 'desktop',
    path: `${cluster}/deployments`,
    async steps(page) {
      await assistantConnects(page)
      assistantAsks('scale', {
        kind: 'deployment',
        namespace: 'shop',
        name: DEMO.deployments.storefront,
        replicas: 5,
        reason:
          'Checkout latency has doubled since 14:00 and storefront’s pods are at 95% CPU: two more replicas spread the load.',
      })
      await page
        .getByRole('dialog', { name: 'Scale Deployment storefront to 5 replicas' })
        .waitFor()
    },
    after: assistantLeaves,
  },
  {
    name: 'assistant-activity',
    title: 'AI assistants’ changes',
    description:
      'The activity log: a change Claude Code asked for and was approved, and one rejected with a note for it.',
    app: 'desktop',
    path: `${cluster}/deployments`,
    async steps(page) {
      await assistantConnects(page)
      assistantAsks('restart', {
        kind: 'statefulset',
        namespace: 'data',
        name: 'postgres',
        reason: 'Its memory has grown steadily for three days.',
      })
      const restart = page.getByRole('dialog', { name: 'Restart StatefulSet postgres' })
      await restart.getByRole('button', { name: 'Reject…' }).click()
      await restart
        .getByRole('textbox', { name: 'Note' })
        .fill('Not during the sale: tonight, after 22:00.')
      await page.keyboard.press('ControlOrMeta+Enter')
      await restart.waitFor({ state: 'hidden' })
      assistantAsks('scale', {
        kind: 'deployment',
        namespace: 'shop',
        name: DEMO.deployments.cart,
        replicas: 4,
        reason: 'Carts take twice as long to load since 14:00.',
      })
      const scale = page.getByRole('dialog', { name: 'Scale Deployment cart to 4 replicas' })
      await scale.getByRole('button', { name: /^Approve/ }).click()
      await scale.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Activity' }).click()
      await page.getByRole('dialog', { name: 'Activity' }).getByText('via Claude Code').waitFor()
    },
    async after(page) {
      await assistantLeaves(page)
      // As it was, for the screenshots after it.
      await page.evaluate(
        ({ context, name }) =>
          window.lumovi!.kube.change({
            context,
            kind: 'Deployment',
            namespace: 'shop',
            name,
            change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 2 } } },
          }),
        { context: CLUSTERS.production, name: DEMO.deployments.cart },
      )
    },
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
    description: "A cert-manager certificate, shown with Lumovi's view of it.",
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
    description: "A cluster made read-only: Lumovi won't change anything in it until allowed.",
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
    description: 'Lumovi served from a cluster: signing in with a token.',
    app: 'server',
    server: 'token',
    path: '/',
  },
  {
    name: 'server-single-sign-on',
    title: 'Single sign-on',
    description: 'Lumovi served from a cluster: signing in with single sign-on.',
    app: 'server',
    server: 'sso',
    path: '/',
  },
  {
    name: 'server-account',
    title: 'Signed in',
    description: "Lumovi served from a cluster: who's signed in, and their groups.",
    app: 'server',
    server: 'proxy',
    path: cluster,
    steps: (page) => page.getByRole('button', { name: /^Signed in as/ }).click(),
  },
  {
    name: 'fleet',
    title: 'A fleet of clusters',
    description: 'Lumovi showing a fleet: every cluster summed up, what needs attention first.',
    app: 'server',
    server: 'fleet',
    path: '/',
    steps: settledFleet,
  },
  {
    name: 'fleet-search',
    title: 'Finding a workload in every cluster',
    description: 'Workloads found by name or namespace in every cluster of a fleet.',
    app: 'server',
    server: 'fleet',
    path: '/?group=region',
    steps: async (page) => {
      await settledFleet(page)
      await page.getByRole('button', { name: 'Find a workload' }).click()
      await page.keyboard.type('shop')
      await page.getByRole('listbox', { name: 'Workloads found' }).waitFor()
    },
  },
]
