/**
 * A plugin's code turned off on a server: by its administrator for everyone (LUMOVI_PLUGIN_CODE:
 * off, or only the plugins it names), and by each person for themselves, theirs alone, kept where
 * their AI rules are, and in the audit history.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { NotHanded } from '../../src/shared/plugin-hand-over.ts'
import { audited, expect, freePort, PEOPLE, signIn, test, type Served } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with a stand-in of Lumovi's own with code (it knows its own address). */
async function served(serve: Serve, env: Record<string, string> = {}) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), 'box.then(() => {})\n')
  const port = await freePort()
  return serve({
    port,
    env: {
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      ...env,
    },
  })
}

/** Whether toys' code would be handed to the page, asked without checking anything. */
const handOver = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        lumovi: { kube: { pluginHandOver(plugin: string): Promise<true | NotHanded> } }
      }
    ).lumovi.kube.pluginHandOver('toys'),
  )
const setCode = (page: Page, on: boolean) =>
  page.evaluate(
    (on) =>
      (
        window as unknown as {
          lumovi: { app: { setPluginCode(plugin: string, on: boolean): Promise<unknown> } }
        }
      ).lumovi.app.setPluginCode('toys', on),
    on,
  )
const runItsCode = (page: Page) =>
  page.locator('[data-plugin-code-switch="toys"]').getByRole('switch', { name: 'Run its code' })

test('off on the server: no plugin’s code runs for anyone, and no browser is checked for it', async ({
  serve,
  page,
}) => {
  for (const [value, refused, line] of [
    ['off', 'off-on-server', 'This server doesn’t run plugins’ code.'],
    ['argo-cd,cert-manager', 'off-on-server-for-it', 'This server doesn’t run this plugin’s code.'],
  ] as const) {
    const server = await served(serve, { LUMOVI_PLUGIN_CODE: value })
    await signIn(page, server.url, PEOPLE.alice.token)
    // Before any browser check: off is off.
    expect(await handOver(page), value).toBe(refused)
    // Its page: the place, whose words say who can turn it on.
    await page.goto(`${server.url}cluster/demo/plugins/toys/overview`)
    const ended = page.getByTestId('plugin-ended')
    await expect(ended.getByRole('heading')).toHaveText(line)
    await expect(ended).toContainText('Whoever runs Lumovi can turn it on.')
    await expect(ended.getByRole('link', { name: 'Open Plugins' })).toHaveCount(0)
    // The switch: locked, said to be the server's.
    await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
    await expect(runItsCode(page)).not.toBeChecked()
    await expect(runItsCode(page)).toHaveAttribute('aria-disabled', 'true')
    const entry = page.locator('[data-plugin-code-switch="toys"]')
    await expect(entry).toContainText('Helm chart')
    await expect(entry).toContainText('Turned off on this server.')
    // Turned on from a page: refused, and recorded so.
    await expect(setCode(page, true)).rejects.toThrow(line)
    expect(audited(server, 'plugin.code-switch').at(-1)).toMatchObject({
      outcome: 'refused',
      summary: 'Turned on the Toys plugin’s code',
    })
    await server.stop()
  }
  // Named by the server: its code may run, as far as the browser's check goes.
  const named = await served(serve, { LUMOVI_PLUGIN_CODE: 'toys' })
  await signIn(page, named.url, PEOPLE.alice.token)
  expect(await handOver(page)).toBe('not-checked')
})

test('each person’s switch is theirs alone, recorded, and kept across a restart', async ({
  serve,
  browser,
  page,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const port = await freePort()
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), 'box.then(() => {})\n')
  const env = {
    LUMOVI_URL: `http://127.0.0.1:${port}`,
    LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
    LUMOVI_DATA_DIR: data,
  }
  const server = await serve({ port, env })
  await signIn(page, server.url, PEOPLE.alice.token)
  await setCode(page, false)
  expect(await handOver(page)).toBe('turned-off')
  expect(audited(server, 'plugin.code-switch').at(-1)).toMatchObject({
    outcome: 'success',
    summary: 'Turned off the Toys plugin’s code',
    details: { plugin: 'toys', on: false },
  })
  // Another person's own: untouched.
  const other = await browser.newPage()
  await signIn(other, server.url, PEOPLE.bob.token)
  expect(await handOver(other)).toBe('not-checked')
  await other.close()
  // After a restart, from where it's kept: still off for her.
  await server.stop()
  const again = await serve({ port, env })
  // (In a browser of her own again: her session was kept too.)
  const fresh = await (await browser.newContext()).newPage()
  await signIn(fresh, again.url, PEOPLE.alice.token)
  expect(await handOver(fresh)).toBe('turned-off')
})
