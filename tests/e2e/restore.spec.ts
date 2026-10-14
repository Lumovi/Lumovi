/**
 * Lumovi opened again: each window where it was, on its page (the panel's object with it), and
 * with what it had below. A kept object reads again as if just opened; a terminal comes back
 * ended, its name and place kept, its shell started again only when the person asks. A window
 * whose cluster has gone from the kubeconfig opens the start screen.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { holds } from '../holds.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { clusterOption, DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const below = (page: Page) => page.getByRole('region', { name: 'Tabs below', exact: true })

test('opened again: the page and its panel, a kept object read anew, a terminal ended with its name', async ({
  launch,
}) => {
  // (Lumovi launched, quit and launched again: on a Windows runner, most of a minute.)
  test.slow()
  const first = await launch({ env: { SHELL: '/bin/sh' } })
  const pod = DEMO.pods.storefront[0]!
  await openCluster(first.page)
  await goTo(first.page, 'Pods')
  await first.page.getByPlaceholder('Filter pods').fill(pod)
  await row(first.page, 'Pods', pod).first().click()
  const detail = panel(first.page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByRole('button', { name: 'Keep open below' }).click()
  await below(first.page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  const tabs = (page: Page) => below(page).getByRole('tablist', { name: 'Tabs below' })
  await expect(tabs(first.page).getByRole('tab')).toHaveCount(2)
  // (What it has below is said a moment after it changes.)
  await expect
    .poll(() =>
      first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    )
    .toBe(true)
  await new Promise((settle) => setTimeout(settle, 1_000))
  const userDataDir = first.userDataDir
  await first.close()
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(settings.windows[0].page).toMatch(/^#\/cluster\/demo\/pods\?.*open=/)

  // (A shell that says when a terminal starts it: none does by itself. Not Lumovi's own read of
  // the login shell's PATH as it starts, -ilc. Windows' terminals start PowerShell.)
  const started = join(mkdtempSync(join(tmpdir(), 'lumovi-shell-')), 'started')
  const shell = join(mkdtempSync(join(tmpdir(), 'lumovi-shell-')), 'shell.sh')
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = -ilc ] || echo started >> ${JSON.stringify(started)}\nexec /bin/sh "$@"\n`,
  )
  chmodSync(shell, 0o755)
  const again = await launch({ userDataDir, env: { SHELL: shell } })
  // Where it was, the panel open on the pod.
  await expect(panel(again.page, 'Pod', pod)).toBeVisible()
  // Below: the pod kept, read anew; the terminal ended, its shell not started by itself.
  await expect(tabs(again.page).getByRole('tab', { name: `Pod ${pod}, Logs` })).toBeVisible()
  const terminal = tabs(again.page).getByRole('tab', { name: /^demo.*, ended$/ })
  await expect(terminal).toBeVisible()
  await terminal.click()
  const shown = below(again.page).getByRole('tabpanel')
  await expect(shown).toContainText('The shell ended when Lumovi quit.')
  await expect(shown).toContainText(
    'A terminal’s shell can’t outlive Lumovi. Its name, cluster and namespace are kept for a new one.',
  )
  const windows = process.platform === 'win32'
  if (!windows) await holds(() => !existsSync(started), 2_000, 'its shell isn’t started by itself')
  await shown.getByRole('button', { name: 'Start a new shell' }).click()
  await expect(tabs(again.page).getByRole('tab', { name: /^demo/ })).not.toHaveAccessibleName(
    /ended$/,
  )
  // Asked for, it starts.
  if (!windows) await expect.poll(() => existsSync(started), { timeout: 15_000 }).toBe(true)
  await again.close()
})

test('a window opened again on a cluster gone from the kubeconfig opens the start screen', async ({
  launch,
}) => {
  test.slow()
  const first = await launch()
  const userDataDir = first.userDataDir
  await first.close()
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      ...settings,
      windows: [
        { x: 40, y: 40, width: 1200, height: 800, maximized: false, page: '#/cluster/gone' },
      ],
    }),
  )
  const again = await launch({ userDataDir })
  await expect(clusterOption(again.page, 'demo')).toBeVisible()
  await holds(
    async () => (await again.page.getByRole('button', { name: 'Switch cluster' }).count()) === 0,
    2_000,
    'it stays on the start screen',
  )
  await again.close()
})

/** Lumovi's settings, as a person's computer would have them: these windows, and nothing else. */
function savedWindows(userDataDir: string, windows: unknown[]) {
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ theme: 'system', windows }))
}

test('a window opened again on a cluster that signs in through a program waits for a press: its page isn’t opened by itself', async ({
  launch,
  clusters,
}) => {
  test.slow()
  const { url, caPem } = clusters.demo
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
    currentContext: 'plugged',
    clusters: [{ name: 'plugged', server: url, caPem }],
    users: [{ name: 'plugged', exec: { command: process.execPath, args: [plugin] } }],
    contexts: [{ name: 'plugged', cluster: 'plugged', user: 'plugged' }],
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  savedWindows(userDataDir, [
    { x: 40, y: 40, width: 1200, height: 800, maximized: false, page: '#/cluster/plugged/pods' },
  ])
  const { page } = await launch({ userDataDir, env: { KUBECONFIG: kubeconfig } })
  // On the start screen: its page isn't opened again by itself, so nothing of it is read (its
  // pods, here). (The start screen's own check of each cluster is another matter.)
  const pods = () =>
    clusters.demo.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/pods')).length
  await expect(clusterOption(page, 'plugged')).toBeVisible()
  await holds(() => pods() === 0, 3_000, 'its page isn’t opened again before a press')
  // Pressed: it signs in, and its pages read then.
  await clusterOption(page, 'plugged').click()
  await expect.poll(() => existsSync(ran), { timeout: 15_000 }).toBe(true)
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('plugged')
})

test('a kept pod or node opened again on its Shell comes back on its overview: no shell, no debug pod', async ({
  launch,
  clusters,
}) => {
  test.slow()
  const pod = DEMO.pods.storefront[0]!
  const node = DEMO.nodes.worker2
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  savedWindows(userDataDir, [
    {
      x: 40,
      y: 40,
      width: 1200,
      height: 800,
      maximized: false,
      page: '#/cluster/demo',
      below: {
        open: true,
        maximized: false,
        shown: 0,
        tabs: [
          {
            kind: 'kept',
            context: 'demo',
            object: { kind: 'Pod', name: pod, namespace: 'shop' },
            tab: 'shell',
          },
          { kind: 'kept', context: 'demo', object: { kind: 'Node', name: node }, tab: 'shell' },
        ],
      },
    },
  ])
  const { page } = await launch({ userDataDir })
  const tabs = below(page).getByRole('tablist', { name: 'Tabs below' })
  await expect(tabs.getByRole('tab', { name: `Pod ${pod}`, exact: true })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: `Node ${node}`, exact: true })).toBeVisible()
  await tabs.getByRole('tab', { name: `Node ${node}`, exact: true }).click()
  await holds(
    () =>
      clusters.demo.shells() === 0 &&
      !clusters.demo.requests.some((r) => r.method === 'POST' && r.path.endsWith('/pods')),
    3_000,
    'no shell, nor a node’s debug pod, starts by itself',
  )
})

test('opened again with everything that could start something, nothing does: no sign-in, no shell, no read of a cluster that signs in through a program, until a press', async ({
  launch,
  clusters,
}) => {
  test.slow()
  // A cluster that signs in through a program (on a server of its own, so what it's asked is
  // counted exactly), its stand-in program saying each time it starts; and the demo cluster.
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const plugin = join(tools, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: 'signed-in' } }))
`,
  )
  const signIns = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').length - 1 : 0)
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-')), {
    currentContext: 'demo',
    clusters: [
      { name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem },
      { name: 'plugged', server: clusters.sandbox.url, insecure: true },
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
  // A shell that says when a terminal starts it (not Lumovi's own read of the login shell's PATH
  // as it starts, -ilc). Windows' terminals start PowerShell.
  const started = join(mkdtempSync(join(tmpdir(), 'lumovi-shell-')), 'started')
  const shell = join(mkdtempSync(join(tmpdir(), 'lumovi-shell-')), 'shell.sh')
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = -ilc ] || echo started >> ${JSON.stringify(started)}\nexec /bin/sh "$@"\n`,
  )
  chmodSync(shell, 0o755)

  // Everything Lumovi opens again: a window on that cluster's page; another on demo's with,
  // below, that cluster's objects kept (the one shown among them), on their logs and a Shell,
  // demo's pod and node on their Shells, and a terminal on each cluster.
  const pod = DEMO.pods.storefront[0]!
  const kept = (context: string, object: object, tab: string) => ({
    kind: 'kept',
    context,
    object,
    tab,
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const at = { width: 1200, height: 800, maximized: false }
  savedWindows(userDataDir, [
    { ...at, x: 40, y: 40, page: '#/cluster/plugged/pods' },
    {
      ...at,
      x: 80,
      y: 80,
      page: '#/cluster/demo',
      below: {
        open: true,
        maximized: false,
        shown: 0,
        tabs: [
          kept('plugged', { kind: 'Node', name: 'sandbox-node' }, 'overview'),
          kept('plugged', { kind: 'Pod', name: 'web-1', namespace: 'default' }, 'logs'),
          kept('plugged', { kind: 'Service', name: 'kubernetes', namespace: 'default' }, 'shell'),
          kept('demo', { kind: 'Pod', name: pod, namespace: 'shop' }, 'shell'),
          kept('demo', { kind: 'Node', name: DEMO.nodes.worker2 }, 'shell'),
          { kind: 'terminal', context: 'plugged' },
          { kind: 'terminal', context: 'demo', namespace: 'shop' },
        ],
      },
    },
  ])
  const asked = clusters.sandbox.requests.length
  const { app } = await launch({ userDataDir, env: { KUBECONFIG: kubeconfig, SHELL: shell } })
  await expect.poll(() => app.windows().length).toBe(2)
  let demo: Page | undefined
  await expect
    .poll(() => {
      demo = app.windows().find((each) => each.url().includes('#/cluster/demo'))
      return demo !== undefined
    })
    .toBe(true)
  // The shown tab, of that cluster: it says it isn't read, and how it would be.
  const card = below(demo!).getByRole('tabpanel').getByRole('status')
  await expect(card).toContainText('Not read yet')
  await expect(card).toContainText(
    `plugged signs in through ${basename(process.execPath)}, so Lumovi reads this when you ask.`,
  )
  const windows = process.platform === 'win32'
  await holds(
    () =>
      signIns() === 0 &&
      clusters.sandbox.requests.length === asked &&
      clusters.demo.shells() === 0 &&
      !clusters.demo.requests.some((r) => r.method === 'POST' && r.path.endsWith('/pods')) &&
      (windows || !existsSync(started)),
    3_000,
    'nothing signs in, no shell or debug pod starts, and that cluster isn’t asked anything',
  )
  // Asked: it signs in, and reads.
  await card.getByRole('button', { name: 'Read it now' }).click()
  await expect.poll(signIns, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(() => clusters.sandbox.requests.length).toBeGreaterThan(asked)
})
