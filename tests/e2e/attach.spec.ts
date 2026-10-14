/**
 * Attached to a container's main process, as `kubectl attach -it` is, on the Shell tab: what it
 * prints, and what's typed; detaching leaves it running. A container whose input closes after one
 * session is sent nothing, and one that takes no input shows what it prints. It's in the history
 * as attaching, and it's refused where shells are.
 */
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { menuAction, open } from './action-helpers.ts'
import { expect, openCluster, panel, test } from './fixtures.ts'

/** What the attached terminal shows. */
const screen = (page: Page, container = 'repl') =>
  page.getByRole('region', { name: `Attached to ${container}` }).locator('.xterm-rows')

/** A running pod in `default` whose one container, repl, is set up as `container` says. */
function consolePod(
  name: string,
  container: { stdin?: boolean; stdinOnce?: boolean; tty?: boolean },
): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      creationTimestamp: new Date().toISOString(),
    },
    spec: { containers: [{ name: 'repl', image: 'busybox:1.36', resources: {}, ...container }] },
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
}

const history = (page: Page) =>
  page
    .evaluate(() => window.lumovi!.audit.query({ actions: ['attach.open', 'attach.close'] }))
    .then((page) => page.events)

test('attached to a container’s main process: what’s typed goes to it, and detaching leaves it running', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(consolePod('console', { stdin: true, tty: true }))
  await openCluster(page)
  await open(page, 'Pods', 'console')
  await menuAction(page, 'Pod', 'console', 'Attach')
  const detail = panel(page, 'Pod', 'console')
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  const choice = detail.getByRole('group', { name: 'Shell or attach' })
  await expect(choice.getByRole('button', { name: 'Attach' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(screen(page)).toContainText(
    'What you type goes to repl’s main process, Ctrl+C and Ctrl+D included',
  )
  await expect(screen(page)).toContainText('repl is running (session 1)')
  const attach = clusters.demo.requests.find((r) => r.path.endsWith('/pods/console/attach'))!
  expect(attach.query).toMatchObject({ container: 'repl', stdin: 'true', tty: 'true' })
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText('repl read: hello')

  // Detached (a shell instead), then attached again: the same process, still running.
  await choice.getByRole('button', { name: 'Shell' }).click()
  await expect.poll(() => clusters.demo.attached()).toBe(0)
  await choice.getByRole('button', { name: 'Attach' }).click()
  await expect(screen(page)).toContainText('repl is running (session 2)')
  expect(clusters.demo.main('default', 'console', 'repl')).toMatchObject({
    sessions: 2,
    received: ['hello'],
  })

  // In the history: attached and detached, with the command that does the same.
  await expect
    .poll(async () => (await history(page)).map((event) => `${event.action} ${event.summary}`))
    .toEqual(
      expect.arrayContaining([
        'attach.open Attached to Pod console (repl)',
        expect.stringMatching(/^attach\.close Detached from Pod console \(repl\), after /),
      ]),
    )
  const opened = (await history(page)).find((event) => event.action === 'attach.open')!
  expect(opened.command).toContain('attach -it console -c repl')
})

test('a container whose input closes after one session is sent nothing; one that takes none shows what it prints', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(consolePod('once', { stdin: true, stdinOnce: true, tty: true }))
  clusters.demo.upsert(consolePod('quiet', {}))
  await openCluster(page)

  await open(page, 'Pods', 'once')
  await menuAction(page, 'Pod', 'once', 'Attach')
  await expect(screen(page)).toContainText(
    'repl’s input closes when one session ends, which would end its process',
  )
  await expect(screen(page)).toContainText('repl is running (session 1)')
  await page.keyboard.type('quit')
  await page.keyboard.press('Enter')
  expect(clusters.demo.main('default', 'once', 'repl')).toMatchObject({
    stdin: [false],
    received: [],
  })
  const once = clusters.demo.requests.find((r) => r.path.endsWith('/pods/once/attach'))!
  expect(once.query.stdin).toBe('false')

  await open(page, 'Pods', 'quiet')
  await menuAction(page, 'Pod', 'quiet', 'Attach')
  await expect(screen(page)).toContainText('repl takes no input (its stdin isn’t open)')
  await expect(screen(page)).toContainText('repl is running (session 1)')
  expect(clusters.demo.main('default', 'quiet', 'repl')).toMatchObject({ stdin: [false] })
  // (Its output only, in the history's command too.)
  await expect
    .poll(
      async () =>
        (await history(page)).find((event) => event.summary.includes('Pod quiet'))?.command,
    )
    .toMatch(/^kubectl attach quiet -c repl /)
})

test('attaching is refused where shells are: a read-only cluster, and RBAC without pods/attach', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert(consolePod('console', { stdin: true, tty: true }))
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  // (The page reads its settings again.)
  await page.reload()
  await open(page, 'Pods', 'console')
  const detail = panel(page, 'Pod', 'console')
  await detail.getByRole('tab', { name: 'Shell' }).click()
  await detail
    .getByRole('group', { name: 'Shell or attach' })
    .getByRole('button', { name: 'Attach' })
    .click()
  await expect(detail).toContainText('Attaching is off')
  // Asked anyway, the backend refuses it, and nothing reaches the cluster.
  const refused = await page.evaluate(() =>
    window.lumovi!.terminal.open('attach-read-only', {
      target: 'attach',
      context: 'demo',
      namespace: 'default',
      pod: 'console',
      container: 'repl',
    }),
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'read-only' } })
  expect(clusters.demo.requests.filter((r) => r.path.endsWith('/attach'))).toEqual([])

  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))
  clusters.demo.deny({ verb: 'create', resource: 'pods', subresource: 'attach' })
  await page.reload()
  await open(page, 'Pods', 'console')
  await detail.getByRole('tab', { name: 'Shell' }).click()
  await detail
    .getByRole('group', { name: 'Shell or attach' })
    .getByRole('button', { name: 'Attach' })
    .click()
  await expect(detail).toContainText('No attach access')
  await expect(detail).toContainText('Your account can’t attach to containers in default.')
})

test('an open Lumovi refuses before it begins says so, in its words: a terminal never waits blank', async ({
  lumovi,
  clusters,
}) => {
  const { page, app } = lumovi
  clusters.demo.upsert(consolePod('console', { stdin: true, tty: true }))
  await openCluster(page)
  // Refused by the main process itself, as a stream another window has would be.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('terminal:open')
    ipcMain.handle('terminal:open', () => {
      throw new Error('Blocked terminal:open: that stream is another window’s')
    })
  })
  await open(page, 'Pods', 'console')
  await menuAction(page, 'Pod', 'console', 'Attach')
  const detail = panel(page, 'Pod', 'console')
  await expect(detail).toContainText('Blocked terminal:open: that stream is another window’s')
  await expect(detail.getByRole('button', { name: 'Reconnect' }).last()).toBeVisible()
  expect(clusters.demo.requests.filter((r) => r.path.endsWith('/attach'))).toEqual([])
})
