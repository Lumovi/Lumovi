/**
 * A cluster that signs in through a program (an exec plugin: kubelogin, a cloud's tool) is never
 * asked anything by what lists every cluster: the start screen, the sidebar's switcher, the AI
 * permissions' count. Asked, it would start that program (a browser, a prompt) for a cluster
 * nobody picked. Each says so instead, and the program starts only when the cluster's opened, or
 * the count is asked for.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { holds } from '../holds.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { openPermissions } from './ai-rules.ts'
import { clusterOption, expect, openCluster, test } from './fixtures.ts'

/** A kubeconfig of `demo` (a token) and `plugged` (a stand-in program that says when it starts). */
function signingIn(demo: MockCluster) {
  const { url, caPem } = demo
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const plugin = join(tools, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-')), {
    currentContext: 'demo',
    clusters: [
      { name: 'demo', server: url, caPem },
      { name: 'plugged', server: url, caPem },
    ],
    users: [
      { name: 'demo', token: DEMO_TOKEN },
      { name: 'plugged', exec: { command: process.execPath, args: [plugin] } },
    ],
    contexts: [
      { name: 'demo', cluster: 'demo', user: 'demo' },
      { name: 'plugged', cluster: 'plugged', user: 'plugged' },
    ],
  })
  /** How many times the program started. */
  const starts = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').length - 1 : 0)
  return { kubeconfig, starts }
}

/** The program's name, as the kubeconfig gives it: its command's last part. */
const program = basename(process.execPath)

const noStarts = (starts: () => number, where: string) =>
  holds(() => starts() === 0, 3_000, `nothing signs in ${where}`)

test('the start screen asks nothing of a cluster that signs in through a program: it says so, and signs in when it’s opened', async ({
  launch,
  clusters,
}) => {
  const { kubeconfig, starts } = signingIn(clusters.demo)
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  const plugged = clusterOption(page, 'plugged')
  await expect(plugged).toBeVisible()
  // The other answers as ever.
  await expect(clusterOption(page, 'demo')).toContainText(/v\d+\.\d+\.\d+/)
  const says = plugged.getByText('Signs in when opened')
  await expect(says).toBeVisible()
  await expect(says).toHaveAttribute(
    'title',
    `Signs in through ${program}, so Lumovi checks it when you open it.`,
  )
  await noStarts(starts, 'as Lumovi starts')
  await plugged.click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('plugged')
  await expect.poll(starts, { timeout: 15_000 }).toBeGreaterThan(0)
})

test('the sidebar’s switcher asks nothing of the other clusters that sign in through a program', async ({
  launch,
  clusters,
}) => {
  const { kubeconfig, starts } = signingIn(clusters.demo)
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page, 'demo')
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  const row = page.getByRole('option', { name: /plugged/ })
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('title', 'Signs in when opened')
  await noStarts(starts, 'as the switcher opens')
  await row.click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('plugged')
  await expect.poll(starts, { timeout: 15_000 }).toBeGreaterThan(0)
})

/** The AI permissions' count, at a glance. */
const glance = (page: Page) => page.getByRole('region', { name: 'At a glance' })

test('the AI permissions’ count leaves out a cluster that signs in through a program until asked to count it', async ({
  launch,
  clusters,
}) => {
  const { kubeconfig, starts } = signingIn(clusters.demo)
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page, 'demo')
  await openPermissions(page)
  const waiting = glance(page).getByText('Not counted yet: plugged, which signs in when opened.', {
    exact: false,
  })
  await expect(waiting).toBeVisible()
  await noStarts(starts, 'as the count is made')
  await glance(page).getByRole('button', { name: 'Count them' }).click()
  await expect.poll(starts).toBeGreaterThan(0)
  await expect(waiting).toBeHidden()
})

test('a program’s name that would turn a line round is spelled where it’s said', async ({
  launch,
  clusters,
}) => {
  // (Never run: nothing's asked of the cluster here.)
  const program = join(mkdtempSync(join(tmpdir(), 'lumovi-plugin-')), 'aw\u202Es')
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-')), {
    currentContext: 'demo',
    clusters: [
      { name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem },
      { name: 'turned', server: clusters.demo.url, caPem: clusters.demo.caPem },
    ],
    users: [
      { name: 'demo', token: DEMO_TOKEN },
      { name: 'turned', exec: { command: program } },
    ],
    contexts: [
      { name: 'demo', cluster: 'demo', user: 'demo' },
      { name: 'turned', cluster: 'turned', user: 'turned' },
    ],
  })
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  const says = clusterOption(page, 'turned').getByText('Signs in when opened')
  await expect(says).toHaveAttribute(
    'title',
    'Signs in through aw U+202E s, so Lumovi checks it when you open it.',
  )
})
