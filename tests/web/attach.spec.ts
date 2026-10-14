/**
 * A server's attach: to a container's main process, as whoever is signed in, where Lumovi's
 * access lets them open shells; refused, on the page and by the server, where it doesn't.
 */
import type { KubeObject } from '../mock-cluster/types.ts'
import { as } from './fleet.ts'
import { DEMO, expect, test } from './fixtures.ts'

/** Shells for developers in default, and nowhere else. */
const POLICY = `
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: off, assistants: ask, audit: own }
grants:
  - { id: console, name: Developers use the console, who: [dev], profile: developer, namespaces: [default] }
`

const consolePod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'console', namespace: 'default', uid: 'uid-console' },
  spec: {
    containers: [{ name: 'repl', image: 'busybox:1.36', resources: {}, stdin: true, tty: true }],
  },
  status: {
    phase: 'Running',
    containerStatuses: [
      {
        name: 'repl',
        ready: true,
        restartCount: 0,
        image: 'busybox:1.36',
        state: { running: { startedAt: new Date().toISOString() } },
      },
    ],
  },
} as KubeObject

test('attached as whoever is signed in, where their access lets them open shells, and refused where it doesn’t', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  clusters.demo.upsert(consolePod)
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY, LUMOVI_ADMINS: 'platform-admins' },
  })
  await as(context, 'dana@example.com', 'developers')

  await page.goto(`${served.url}cluster/demo/pods?open=Pod/default/console`)
  const panel = page.getByRole('complementary').filter({ hasText: 'console' })
  await panel.getByRole('tab', { name: 'Shell' }).click()
  await panel
    .getByRole('group', { name: 'Shell or attach' })
    .getByRole('button', { name: 'Attach' })
    .click()
  const screen = page.getByRole('region', { name: 'Attached to repl' }).locator('.xterm-rows')
  await expect(screen).toContainText('repl is running (session 1)')
  const attach = clusters.demo.requests.find((r) => r.path.endsWith('/pods/console/attach'))!
  expect(attach.headers['impersonate-user']).toBe('dana@example.com')
  await page.getByRole('region', { name: 'Attached to repl' }).click()
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText('repl read: hello')

  // Where shells aren't hers: said on the tab, and refused by the server whatever the page asks.
  const coredns = DEMO.pods.coredns[0]!
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/kube-system/${coredns}`)
  const system = page.getByRole('complementary').filter({ hasText: coredns })
  await system.getByRole('tab', { name: 'Shell' }).click()
  await system
    .getByRole('group', { name: 'Shell or attach' })
    .getByRole('button', { name: 'Attach' })
    .click()
  await expect(system).toContainText('You can’t attach to containers here')
  const refused = await page.evaluate(
    (pod) =>
      window.lumovi!.terminal.open('attach-refused-1', {
        target: 'attach',
        context: 'demo',
        namespace: 'kube-system',
        pod,
        container: 'coredns',
      }),
    coredns,
  )
  expect(refused).toMatchObject({
    ok: false,
    error: {
      code: 'not-allowed',
      message: expect.stringContaining('attach to containers in kube-system'),
    },
  })
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/${coredns}/attach`))).toEqual([])
})
