/**
 * A plugin's links to Lumovi's own places, on a server and on a phone: a link to a place Lumovi
 * doesn't have there isn't drawn. A server has no port forwards; a phone opens no shells, and a
 * shell's link joins the line that says where the changes are.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

const POD = DEMO.pods.storefront[0]!

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  links: [logs, shell, port-forward]
`

/** Toys' code: a header linking to one of storefront's pods' logs, its shell, and a forward. */
const CODE = `box.then(({ post, listen }) => {
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read !== 1 || !said.objects) return
    const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
    if (!pod) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Header', { name: 'Storefront', buttons: [
        { key: 'logs', name: 'Its logs', goes: { object: pod.token, at: 'logs' } },
        { key: 'shell', name: 'Shell into app', goes: { object: pod.token, at: 'shell', container: 'app' } },
        { key: 'forward', name: 'Forward 8080', goes: { object: pod.token, at: 'port-forward', port: 8080 } },
      ] }],
      ['put', 0, 1],
    ] }))
  })
})
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with Toys in it, as if it came with Lumovi (it knows its own address, for the box). */
async function served(serve: Serve) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), CODE)
  const port = await freePort()
  return serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
}

const body = (page: Page) => page.locator('[data-plugin-body]')

test('on a server, a forward’s link isn’t drawn; a shell’s waits for Start, as on the desktop', async ({
  serve,
  page,
}) => {
  test.slow()
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
  const header = body(page).getByRole('group', { name: 'Storefront' })
  await expect(header.getByRole('button', { name: 'Shell into app' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(header.getByRole('button')).toHaveText(['Its logs', 'Shell into app'])
  await header.getByRole('button', { name: 'Shell into app' }).click()
  const start = page.locator('[data-shell-start]')
  await expect(start).toContainText(`A shell in ${POD}`)
  // As the person signed in, within their access.
  await expect(start).toContainText(/As.*with your RBAC/)
})

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

  test('on a phone, a pod’s logs link stays; a shell’s joins the line that says where it is, and a forward’s isn’t there', async ({
    serve,
    page,
  }) => {
    test.slow()
    const server = await served(serve)
    await signInNarrow(page, `${server.url}cluster/demo/plugins/toys/overview`, DEMO_TOKEN)
    const header = body(page).getByRole('group', { name: 'Storefront' })
    await expect(header.getByRole('button', { name: 'Its logs' })).toBeVisible({ timeout: 30_000 })
    await expect(header.getByRole('button')).toHaveText(['Its logs'])
    await expect(header.getByRole('paragraph').filter({ hasText: 'larger screen' })).toHaveText(
      'Open Lumovi on a larger screen to use Shell into app.',
    )
    // Its logs, opened as Lumovi opens a pod's.
    await header.getByRole('button', { name: 'Its logs' }).tap()
    await expect(page.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
  })
})
