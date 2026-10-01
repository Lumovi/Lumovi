import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { demoCluster } from '../mock-cluster/fixtures/demo.ts'
import { DEMO } from '../mock-cluster/kubeconfig.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { open, toasts } from './action-helpers.ts'
import { clipboardText, CONTEXTS, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const PODS = DEMO.pods.storefront
/** How the logs tell the storefront's pods apart: by what's left of their names. */
const short = (pod: string) => pod.split('-').at(-1)!

async function workloadLogs(page: Page) {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  return detail
}

/** Answers the save dialog as `answer` says, instead of asking. */
function saveAs(app: ElectronApplication, answer: { canceled: boolean; filePath?: string }) {
  return app.evaluate(({ dialog }, answer) => {
    dialog.showSaveDialog = (async () => answer) as unknown as typeof dialog.showSaveDialog
  }, answer)
}

const podLike = (name: string, labels: Record<string, string>, containers = ['app']) => {
  const template = demoCluster().objects.find(
    (o) => o.kind === 'Pod' && o.metadata.name === PODS[0],
  )!
  return {
    ...template,
    metadata: { ...template.metadata, name, labels, uid: undefined },
    spec: {
      ...template.spec,
      initContainers: undefined,
      containers: containers.map((c) => ({ ...template.spec.containers[0], name: c })),
    },
    status: {
      ...template.status,
      initContainerStatuses: undefined,
      containerStatuses: containers.map((c) => ({
        ...template.status.containerStatuses[0],
        name: c,
      })),
    },
  } as KubeObject
}

test('a workload’s logs: every pod’s, merged in the order they were written', async ({
  kubestacks,
  clusters,
}) => {
  const { page, app } = kubestacks
  await openCluster(page)
  const detail = await workloadLogs(page)
  const log = detail.getByRole('log', { name: 'Logs for app' })
  const chips = detail.getByRole('group', { name: 'Show lines from' })
  for (const pod of PODS) {
    await expect(chips.getByRole('button', { name: new RegExp(`^${short(pod)}`) })).toBeVisible()
  }
  await expect(chips.getByRole('button', { name: /^Errors/ })).toBeVisible()

  // Lines arrive as they're written, from every pod, in that order.
  clusters.demo.appendLogs('shop', PODS[2]!, 'app', ['merge-check first'])
  await expect(log).toContainText('merge-check first')
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', ['merge-check second'])
  await expect(log).toContainText('merge-check second')
  const search = detail.getByLabel('Search logs')
  await search.fill('merge-check')
  const rows = log.locator('[data-level]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText(`${short(PODS[2]!)}`)
  await expect(rows.nth(0)).toContainText('merge-check first')
  await expect(rows.nth(1)).toContainText(`${short(PODS[0]!)}`)

  // A pod's lines can be left out, and brought back.
  const first = chips.getByRole('button', { name: new RegExp(`^${short(PODS[0]!)}`) })
  await first.click()
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await expect(rows).toHaveCount(1)
  await first.click()
  await expect(rows).toHaveCount(2)
  await search.fill('')
  for (const pod of PODS) {
    await chips.getByRole('button', { name: new RegExp(`^${short(pod)}`) }).click()
  }
  await expect(log).toContainText('No lines to show.')
  for (const pod of PODS) {
    await chips.getByRole('button', { name: new RegExp(`^${short(pod)}`) }).click()
  }

  // Only errors, or warnings.
  const errors = chips.getByRole('button', { name: /^Errors/ })
  await errors.click()
  await expect(errors).toHaveAttribute('aria-pressed', 'true')
  await expect(log.locator('[data-level="info"]')).toHaveCount(0)
  await errors.click()
  await chips.getByRole('button', { name: /^Warnings/ }).click()
  await expect(log.locator('[data-level="error"]')).toHaveCount(0)
  await chips.getByRole('button', { name: /^Warnings/ }).click()

  // Copied and saved with their pods.
  await detail.getByRole('button', { name: 'Copy logs' }).click()
  await expect
    .poll(() => clipboardText(page))
    .toMatch(new RegExp(`Z ${PODS[0]}/app merge-check second`))
  const file = join(mkdtempSync(join(tmpdir(), 'kubestacks-logs-')), 'storefront.log')
  await saveAs(app, { canceled: false, filePath: file })
  await detail.getByRole('button', { name: 'Download' }).click()
  await expect(toasts(page)).toContainText('Saved the logs of storefront')
  expect(readFileSync(file, 'utf8')).toContain(`${PODS[2]}/app merge-check first`)
  await saveAs(app, { canceled: true })
  await detail.getByRole('button', { name: 'Download' }).click()
  await saveAs(app, { canceled: false, filePath: join(file, 'not-a-folder', 'x.log') })
  await detail.getByRole('button', { name: 'Download' }).click()
  await expect(toasts(page)).toContainText('Couldn’t save the logs')

  // Wrapped, a line's pod stays beside its time, on its first line; the pointer picks a line out.
  await detail.getByRole('button', { name: 'Wrap lines' }).click()
  const row = log.locator('[data-level="info"]').last()
  await expect(row.locator('[data-label]')).toHaveCSS('align-items', 'flex-start')
  await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await row.hover()
  await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await detail.getByRole('button', { name: 'Wrap lines' }).click()

  // Every container: each line says whose it is.
  await detail.getByRole('combobox', { name: 'Container' }).selectOption('All containers')
  const all = detail.getByRole('log', { name: 'Logs for all containers' })
  await expect(all).toContainText(`${short(PODS[0]!)}/envoy`)
  await expect(all).toContainText(`${short(PODS[0]!)}/app`)

  // From a time instead of a number of lines.
  await detail.getByRole('combobox', { name: 'Show' }).selectOption('Last hour')
  await expect
    .poll(() =>
      clusters.demo.requests.some(
        (r) => r.path.endsWith(`/pods/${PODS[1]}/log`) && r.query.sinceSeconds === '3600',
      ),
    )
    .toBe(true)
})

test('pods come and go, and streams pick up where they left off', async ({ page, clusters }) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  const log = detail.getByRole('log', { name: 'Logs for app' })
  const chips = detail.getByRole('group', { name: 'Show lines from' })
  const search = detail.getByLabel('Search logs')
  const labels = demoCluster().objects.find((o) => o.kind === 'Pod' && o.metadata.name === PODS[0])!
    .metadata.labels!

  // A new pod joins.
  const joined = `${PODS[0]!.slice(0, PODS[0]!.lastIndexOf('-'))}-zz9zz`
  clusters.demo.upsert(podLike(joined, labels))
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(chips.getByRole('button', { name: /^zz9zz/ })).toBeVisible()
  clusters.demo.appendLogs('shop', joined, 'app', ['hello from the new pod'])
  await search.fill('hello from the new pod')
  await expect(log).toContainText('zz9zz')

  // One goes: its lines stay, under its whole name.
  clusters.demo.appendLogs('shop', PODS[2]!, 'app', ['goodbye from a departing pod'])
  await search.fill('goodbye from a departing pod')
  await expect(log.locator('[data-level]')).toHaveCount(1)
  clusters.demo.remove('Pod', 'shop', PODS[2]!)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(chips.getByRole('button', { name: new RegExp(`^${short(PODS[2]!)}`) })).toHaveCount(
    0,
  )
  await expect(log).toContainText(PODS[2]!)

  // A connection that drops is picked up again.
  clusters.demo.endLogs('shop', PODS[0]!, { abruptly: true })
  await expect(detail.getByRole('status')).toContainText('Trying again…')
  await expect(detail.getByRole('status')).toHaveCount(0, { timeout: 10_000 })
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', ['back after the drop'])
  await search.fill('back after the drop')
  await expect(log.locator('[data-level]')).toHaveCount(1)

  // Without following, a stream that ends stays ended.
  await search.fill('')
  await detail.getByRole('button', { name: 'Follow' }).click()
  await expect(log).toContainText('back after the drop')
  clusters.demo.endLogs('shop', PODS[0]!)
  await expect(detail.getByRole('status')).toHaveCount(0)

  // Containers that never ran before: there's no previous one to read.
  await detail.getByRole('button', { name: 'Previous container' }).click()
  await expect(detail.getByRole('alert')).toContainText('previous terminated container')
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('alert')).toContainText('previous terminated container')
})

test('logs of services and empty workloads, and of many pods at once', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await open(page, 'Services', DEMO.services.storefront)
  const service = panel(page, 'Service', DEMO.services.storefront)
  await service.getByRole('tab', { name: 'Logs' }).click()
  await expect(service.getByRole('group', { name: 'Show lines from' })).toContainText(
    short(PODS[1]!),
  )
  await goTo(page, 'Nodes')
  await row(page, 'Nodes', 'worker-1').first().getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'Node', 'worker-1').getByRole('tab', { name: 'Logs' })).toHaveCount(0)

  // Nothing running.
  const deployment = demoCluster().objects.find(
    (o) => o.kind === 'Deployment' && o.metadata.name === 'storefront',
  )!
  const idle = {
    ...deployment,
    metadata: { ...deployment.metadata, name: 'idle', uid: undefined },
    spec: { ...deployment.spec, replicas: 0, selector: { matchLabels: { app: 'idle' } } },
  }
  clusters.demo.upsert(idle)
  await open(page, 'Deployments', 'idle')
  const idlePanel = panel(page, 'Deployment', 'idle')
  await idlePanel.getByRole('tab', { name: 'Logs' }).click()
  await expect(idlePanel.getByRole('heading', { name: 'No pods' })).toBeVisible()

  // Many: the first few dozen containers are streamed.
  for (let i = 0; i < 16; i++) {
    clusters.demo.upsert(podLike(`many-${String(i).padStart(2, '0')}`, { app: 'many' }, ['a', 'b']))
  }
  clusters.demo.upsert({
    ...idle,
    metadata: { ...idle.metadata, name: 'many' },
    spec: { ...idle.spec, replicas: 16, selector: { matchLabels: { app: 'many' } } },
  })
  await open(page, 'Deployments', 'many')
  const many = panel(page, 'Deployment', 'many')
  await many.getByRole('tab', { name: 'Logs' }).click()
  await many.getByRole('combobox', { name: 'Container' }).selectOption('All containers')
  await expect(many.getByRole('note')).toContainText(
    'Streaming the first 30 of 32 containers. Pick a container, or open a pod, to see the rest.',
  )
  // And only the latest lines are kept.
  clusters.demo.appendLogs(
    'shop',
    'many-00',
    'a',
    Array.from({ length: 20_001 }, (_, i) => `line ${i}`),
  )
  await expect(many.getByRole('note').last()).toHaveText('Showing the latest 20,000 lines.')
})

test('the pods behind the logs can fail to list', async ({ page, clusters }) => {
  await openCluster(page)
  const unfail = clusters.demo.fail('/api/v1/namespaces/shop/pods', { status: 500 })
  const detail = await workloadLogs(page)
  await expect(detail.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  unfail()
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('log')).toBeVisible()
})

test('streams stop when the logs close, even ones still starting', async ({ page, clusters }) => {
  await openCluster(page)
  await open(page, 'Pods', PODS[0]!)
  const detail = panel(page, 'Pod', PODS[0]!)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await expect(detail.getByRole('log')).toBeVisible()
  await expect.poll(() => clusters.demo.logFollowers()).toBe(1)
  await page.keyboard.press('Escape')
  await expect.poll(() => clusters.demo.logFollowers()).toBe(0)

  // Closed while the API server is still answering: let go once it does.
  clusters.demo.fail(`/api/v1/namespaces/shop/pods/${PODS[1]}/log`, { delayMs: 1500 })
  await open(page, 'Pods', PODS[1]!)
  await panel(page, 'Pod', PODS[1]!).getByRole('tab', { name: 'Logs' }).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => clusters.demo.requests.some((r) => r.path.endsWith(`/pods/${PODS[1]}/log`)))
    .toBe(true)
  await page.waitForTimeout(2000)
  expect(clusters.demo.logFollowers()).toBe(0)
})

test('colors and styles from escape codes', async ({ page, clusters }) => {
  await openCluster(page)
  await open(page, 'Pods', PODS[0]!)
  const detail = panel(page, 'Pod', PODS[0]!)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  const log = detail.getByRole('log', { name: 'Logs for app' })
  const esc = (codes: string) => `\x1b[${codes}`
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', [
    [
      `${esc('1;31m')}ERROR${esc('0m')} `,
      `${esc('2m')}dim${esc('22m')} ${esc('3m')}italic${esc('23m')} ${esc('4m')}under${esc('24m')} `,
      `${esc('32m')}green${esc('39m')} ${esc('92m')}bright${esc('39m')} `,
      `${esc('41m')}redbg${esc('49m')} ${esc('103m')}brightbg${esc('0m')}`,
      `${esc('38;5;4m')}c256${esc('38;5;208m')}cube${esc('38;5;240m')}gray`,
      `${esc('38;2;10;20;30m')}true${esc('48;5;21m')}bg256${esc('48;2;1;2;3m')}bgtrue`,
      `${esc('5m')}blink${esc('K')}${esc('0m')}`,
    ].join(''),
    `${esc('32m')}ok${esc('0m')} and plain text after`,
  ])
  const search = detail.getByLabel('Search logs')
  // Searched, and copied, without the codes; its level read from the text.
  await search.fill('ERROR dim italic under green bright redbg brightbg')
  const line = log.locator('[data-level="error"]')
  await expect(line).toHaveCount(1)
  const span = (text: string) =>
    line.locator('span[style]').filter({ hasText: new RegExp(`^${text}$`) })
  await expect(span('ERROR')).toHaveAttribute('style', /color: var\(--ansi-1\);.*font-weight: 600/)
  await expect(span('dim')).toHaveAttribute('style', /opacity: 0.7/)
  await expect(span('italic')).toHaveAttribute('style', /font-style: italic/)
  await expect(span('under')).toHaveAttribute('style', /text-decoration: underline/)
  await expect(span('bright')).toHaveAttribute('style', /color: var\(--ansi-10\)/)
  await expect(span('redbg')).toHaveAttribute('style', /background: var\(--ansi-1\)/)
  await expect(span('brightbg')).toHaveAttribute('style', /background: var\(--ansi-11\)/)
  await expect(span('c256')).toHaveAttribute('style', /color: var\(--ansi-4\)/)
  await expect(span('cube')).toHaveCSS('color', 'rgb(255, 135, 0)')
  await expect(span('gray')).toHaveCSS('color', 'rgb(88, 88, 88)')
  await expect(span('true')).toHaveCSS('color', 'rgb(10, 20, 30)')
  await expect(span('bg256')).toHaveCSS('background-color', 'rgb(0, 0, 255)')
  await expect(span('bgtrue')).toHaveCSS('background-color', 'rgb(1, 2, 3)')
  await expect(span('blink')).toBeVisible()
  // Black and white on a background are black and white.
  await expect(span('redbg')).toHaveClass('ansi-bg')
  await expect(span('dim')).not.toHaveClass('ansi-bg')
  // Matches are marked within a style.
  await search.fill('redbg')
  await expect(line.locator('mark')).toHaveText('redbg')
  await detail.getByRole('button', { name: 'Copy logs' }).click()
  await expect
    .poll(() => clipboardText(page))
    .toMatch(
      /Z ERROR dim italic under green bright redbg brightbgc256cubegraytruebg256bgtrueblink$/,
    )

  await search.fill('and plain text after')
  await expect(log.locator('[data-level]')).toContainText('ok and plain text after')

  // Every container of one pod: each line says which.
  await search.fill('')
  await detail.getByRole('combobox', { name: 'Container' }).selectOption('All containers')
  const all = detail.getByRole('log', { name: 'Logs for all containers' })
  await expect(all).toContainText('envoy')
  await expect(all.locator('[data-level]').first()).not.toContainText(short(PODS[0]!))
})

test('logs over plain HTTP, and an API server too slow to answer', async ({ launch, clusters }) => {
  const { page } = await launch({ env: { KUBESTACKS_REQUEST_TIMEOUT_MS: '1000' } })
  clusters.sandbox.upsert(podLike('plain', { app: 'plain' }))
  await openCluster(page, CONTEXTS.sandbox)
  await open(page, 'Pods', 'plain')
  const detail = panel(page, 'Pod', 'plain')
  await detail.getByRole('tab', { name: 'Logs' }).click()
  clusters.sandbox.appendLogs('shop', 'plain', 'app', ['sent over plain http'])
  await expect(detail.getByRole('log')).toContainText('sent over plain http')

  clusters.sandbox.fail('/api/v1/namespaces/shop/pods/plain/log', { hang: true })
  await detail.getByRole('combobox', { name: 'Show' }).selectOption('Last 100 lines')
  await expect(detail.getByRole('alert')).toContainText('The API server did not respond within 1s')
})
