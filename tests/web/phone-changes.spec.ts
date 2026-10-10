/**
 * What a phone may change: an assistant's change answered, a workload restarted or scaled, a
 * pod restarted, a node cordoned or uncordoned, and nothing else. It's held where every call
 * the page makes of its server goes out (src/renderer/src/web/phone-gate.ts), so this walks
 * every call there is and asks each one at 390 px: by its function, by key, by the palette and
 * by address.
 *
 * It's a rule of the phone's interface, not a wall. The same calls go through on a larger
 * screen, where the cluster's RBAC, Lumovi's access and read-only mode decide as they always do.
 */
import type { Page } from '@playwright/test'
import { DEMO, DEMO_TOKEN, expect, test } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const NOT_ON_A_PHONE = 'This isn’t done from a phone. Open Lumovi on a larger screen to do it.'

/**
 * Every call the page has, by its name in `window.lumovi`, and what it is to a phone:
 *
 *   reads    changes nothing, anywhere
 *   here     changes this page alone (its theme, a file it saves, a tab it opens)
 *   listens  is told of what happens: a way in, not out
 *   answers  changes something, and a phone does it: all of it, or (`kube.change`) some of it
 *   changes  changes a cluster or Lumovi's settings, and a phone doesn't
 *
 * A call that isn't here fails the test: whoever adds one says what it is.
 */
const CALLS: Record<string, 'reads' | 'here' | 'listens' | 'answers' | 'changes'> = {
  'app.info': 'reads',
  'app.settings': 'reads',
  'app.views': 'reads',
  'app.setTheme': 'here',
  'app.openExternal': 'here',
  'app.saveFile': 'here',
  'app.setReadOnly': 'changes',
  'app.setMetricsSource': 'changes',
  'app.setNodeShell': 'changes',
  'usage.source': 'reads',
  'usage.test': 'reads',
  'usage.range': 'reads',
  'usage.instant': 'reads',
  'metricsStack.status': 'reads',
  'metricsStack.install': 'changes',
  'metricsStack.uninstall': 'changes',
  'kube.contexts': 'reads',
  'kube.version': 'reads',
  'kube.resources': 'reads',
  'kube.schema': 'reads',
  'kube.list': 'reads',
  'kube.get': 'reads',
  'kube.metrics': 'reads',
  'kube.can': 'reads',
  'kube.history': 'reads',
  'kube.change': 'answers',
  'fleet.summary': 'reads',
  'fleet.agents': 'reads',
  'fleet.joins': 'reads',
  'fleet.settings': 'reads',
  'fleet.trustAgent': 'changes',
  'fleet.connect': 'changes',
  'fleet.cancelJoin': 'changes',
  'fleet.remove': 'changes',
  'fleet.check': 'changes',
  'fleet.add': 'changes',
  'fleet.saveSettings': 'changes',
  'approvals.pending': 'reads',
  'approvals.decide': 'answers',
  'approvals.onProposal': 'listens',
  'approvals.onOutcome': 'listens',
  'sponsor.card': 'reads',
  'sponsor.onChange': 'listens',
  'aiPermissions.get': 'reads',
  'aiPermissions.set': 'changes',
  'aiPermissions.onChanged': 'listens',
  'audit.info': 'reads',
  'audit.query': 'reads',
  'audit.verify': 'reads',
  'audit.onEvent': 'listens',
  'access.mine': 'reads',
  'access.admin': 'reads',
  'access.history': 'reads',
  'access.set': 'changes',
  'access.onChanged': 'listens',
  'serverAssistants.status': 'reads',
  'serverAssistants.revoke': 'changes',
  'serverAssistants.onStatus': 'listens',
  'helm.releases': 'reads',
  'helm.release': 'reads',
  'helm.cli': 'reads',
  'helm.defaults': 'reads',
  'helm.versions': 'reads',
  'helm.search': 'reads',
  'helm.deploy': 'changes',
  'helm.rollback': 'changes',
  'helm.uninstall': 'changes',
  'terminal.open': 'changes',
  'terminal.write': 'here',
  'terminal.resize': 'here',
  'terminal.close': 'reads',
  'terminal.onData': 'listens',
  'terminal.onExit': 'listens',
  // A file picked is this page's alone; copying it into a container, or one out of it, runs
  // `tar` there, and isn't done from a phone.
  'files.pick': 'here',
  'files.download': 'changes',
  'files.upload': 'changes',
  'files.cancel': 'here',
  'files.onProgress': 'listens',
  'files.onEnd': 'listens',
  'logs.start': 'reads',
  'logs.stop': 'reads',
  'logs.onLines': 'listens',
  'logs.onEnd': 'listens',
}

/** Every function the page has to call, by its path. */
const calls = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = []
    const walk = (object: object, path: string) => {
      for (const [name, value] of Object.entries(object)) {
        if (typeof value === 'function') found.push(`${path}${name}`)
        else if (value && typeof value === 'object') walk(value as object, `${path}${name}.`)
      }
    }
    walk(window.lumovi!, '')
    return found.sort()
  })

/** Calls one by its path with nothing, and says how it came out: refused here, or sent. */
const attempt = (page: Page, path: string, args: unknown[] = []) =>
  page.evaluate(
    async ({ path, args }) => {
      const call = path
        .split('.')
        .reduce<unknown>((at, name) => (at as Record<string, unknown>)[name], window.lumovi)
      try {
        await (call as (...given: unknown[]) => unknown)(...args)
        return 'sent'
      } catch (error) {
        return (error as Error).message
      }
    },
    { path, args },
  )

test('every call the page can make is known, and a phone makes only the few it may', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const has = await calls(page)
  // None the test doesn't know: a new way to change something is closed on a phone until
  // someone says here what it is.
  expect(has.filter((path) => !(path in CALLS))).toEqual([])

  // What changes a cluster or Lumovi's settings is refused before it's sent: the server hears
  // nothing of it.
  const writes = () =>
    clusters.demo.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)).length
  const before = writes()
  // (An upload asks for what was picked before it asks the server: a file is picked first.)
  const chooser = page.waitForEvent('filechooser')
  const picking = page.evaluate(() => window.lumovi!.files!.pick('file'))
  await (
    await chooser
  ).setFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') })
  const picked = (await picking) as { ok: true; data: { handle: string } }
  const given: Record<string, unknown[]> = {
    'files.upload': ['an-upload', { source: picked.data.handle }],
  }
  for (const path of has.filter((path) => CALLS[path] === 'changes')) {
    expect(await attempt(page, path, given[path]), path).toBe(NOT_ON_A_PHONE)
  }
  expect(writes()).toBe(before)

  // A change to an object: what a phone does goes out (as a dry run here), and nothing else.
  const deployment = {
    context: 'demo',
    kind: 'Deployment',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    dryRun: true,
  }
  const pod = { ...deployment, kind: 'Pod', name: DEMO.pods.storefront[0] }
  const node = { context: 'demo', kind: 'Node', name: DEMO.nodes.worker1, dryRun: true }
  const patch = (spec: unknown, more = {}) => ({
    action: 'patch',
    patchType: 'merge',
    patch: { spec },
    ...more,
  })
  const restarted = {
    template: {
      metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-10-10T00:00:00Z' } },
    },
  }
  for (const [what, request] of [
    ['a scale', { ...deployment, change: patch({ replicas: 3 }) }],
    ['a restart', { ...deployment, change: { ...patch(restarted), patchType: 'strategic' } }],
    ['a pod restarted', { ...pod, change: { action: 'delete' } }],
    ['a cordon', { ...node, change: patch({ unschedulable: true }) }],
    ['an uncordon', { ...node, change: patch({ unschedulable: null }) }],
  ] as const) {
    expect(await attempt(page, 'kube.change', [request]), what).toBe('sent')
  }
  for (const [what, request] of [
    ['a delete', { ...deployment, change: { action: 'delete' } }],
    [
      'an image changed',
      { ...deployment, change: patch({ template: { spec: { containers: [] } } }) },
    ],
    ['a scale with more in it', { ...deployment, change: patch({ replicas: 3, paused: true }) }],
    ['a restart with more in it', { ...deployment, change: patch({ ...restarted, replicas: 0 }) }],
    [
      'labels edited',
      {
        ...deployment,
        change: {
          action: 'patch',
          patchType: 'merge',
          patch: { metadata: { labels: { a: 'b' } } },
        },
      },
    ],
    ['an object replaced', { ...deployment, change: { action: 'replace', object: {} } }],
    ['an object created', { ...deployment, change: { action: 'create', object: {} } }],
    ['an eviction', { ...pod, change: { action: 'evict' } }],
    ['a node’s taints', { ...node, change: patch({ taints: [] }) }],
    ['a cordon of what isn’t a node', { ...deployment, change: patch({ unschedulable: true }) }],
  ] as const) {
    expect(await attempt(page, 'kube.change', [request]), what).toBe(NOT_ON_A_PHONE)
  }

  // With room, the same call goes out: it's the cluster and Lumovi's access that answer it.
  await page.setViewportSize({ width: 1024, height: 768 })
  expect(
    await attempt(page, 'kube.change', [{ ...deployment, change: { action: 'delete' } }]),
  ).toBe('sent')
})

test('nor by a key, the palette or an address', async ({ page, serve }) => {
  const served = await serve()
  const name = DEMO.deployments.storefront
  await signInNarrow(
    page,
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${name}`,
    DEMO_TOKEN,
  )
  // The keys that create, delete and open the actions' menu where there's a keyboard.
  for (const keys of ['ControlOrMeta+n', 'ControlOrMeta+Backspace', '.', 'e']) {
    await page.keyboard.press(keys)
    await expect(page.getByRole('dialog'), keys).toHaveCount(0)
    await expect(page.getByRole('menu'), keys).toHaveCount(0)
  }
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0)
  // The palette lists nothing that changes more than a phone does.
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  for (const word of ['create', 'delete', 'read-only', 'metrics source', 'edit', 'drain']) {
    await palette.getByRole('combobox').fill(word)
    await expect(palette.getByRole('option', { name: new RegExp(word, 'i') }), word).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  // Pages for setting Lumovi up say where that's done, and offer nothing to press but the way back.
  for (const [address, title] of [
    ['access', 'Access'],
    ['assistants', 'AI assistants'],
    ['assistants/permissions', 'AI assistants'],
  ]) {
    await page.goto(`${served.url}${address}`)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByRole('main')).toContainText('Open Lumovi on a larger screen to')
    await expect(page.getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('link')).toHaveText(['Back to the cluster'])
  }
  // The Helm page reads releases, and right-sizing reads its advice.
  await page.goto(`${served.url}cluster/demo/helm`)
  await expect(page.getByRole('heading', { level: 1, name: 'Helm releases' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Install chart/ })).toHaveCount(0)
  await page
    .getByRole('list', { name: /Helm releases/i })
    .getByRole('button')
    .first()
    .click()
  await expect(page.getByRole('complementary')).toContainText(
    'Open Lumovi on a larger screen to upgrade it, roll it back or uninstall it.',
  )
  for (const gone of ['Upgrade…', 'Roll back…', 'Uninstall…']) {
    await expect(page.getByRole('button', { name: gone })).toHaveCount(0)
  }
  await page.goto(`${served.url}cluster/demo/metrics/right-sizing`)
  await expect(page.getByRole('button', { name: 'Apply…' })).toHaveCount(0)
})

test('what was opened with room doesn’t outlive it', async ({ page, serve }) => {
  const served = await serve()
  const name = DEMO.deployments.storefront
  await page.setViewportSize({ width: 800, height: 1000 })
  await signInNarrow(
    page,
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${name}`,
    DEMO_TOKEN,
  )
  const detail = page.getByRole('complementary', { name: `Deployment ${name}` })
  // A delete, about to be confirmed: narrowed to a phone, it's gone.
  await detail.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /^Delete/ }).click()
  await expect(page.getByRole('dialog', { name: new RegExp(`Delete ${name}`) })).toBeVisible()
  await page.setViewportSize(PHONE)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The YAML editor, with a change in it: the same.
  await page.setViewportSize({ width: 800, height: 1000 })
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'Edit' }).click()
  await expect(detail.getByRole('button', { name: 'Review changes' })).toBeVisible()
  await page.setViewportSize(PHONE)
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0)
  // A scale, which a phone does, stays.
  await page.setViewportSize({ width: 800, height: 1000 })
  await detail.getByRole('button', { name: 'Scale' }).click()
  await expect(page.getByRole('dialog', { name: `Scale ${name}` })).toBeVisible()
  await page.setViewportSize(PHONE)
  await expect(page.getByRole('dialog', { name: `Scale ${name}` })).toBeVisible()
})
