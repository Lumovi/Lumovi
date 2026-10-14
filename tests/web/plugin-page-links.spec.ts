/**
 * A plugin's links to its own pages, on a server: a count on its overview opens its list page with
 * that page's table filtered as the link said, Lumovi's own doing, never the plugin's; and its list
 * page stands in its kind's tab, where Lumovi's own list of the kind was.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'

const TINKER = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: tinker }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Tinker
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: overview, title: Overview }
    - { id: widgets, title: Widgets, takes: { group: example.com, kind: Widget } }
`

/**
 * Its code: on its overview, counts of its widgets by size, each opening the list page filtered
 * to that size (and one to a page it hasn't); on its list page, a table filtered by size. What
 * it's told, it says in the table's title, so the test sees it was told nothing of a filter.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let told = 0
  listen((text) => {
    const said = JSON.parse(text)
    told++
    if (said.open && said.open.page === 'overview') {
      commit([
        ['make', 1, 'Counts', { groups: [{ title: 'Size', rows: [
          { value: 'Big', count: 2, opens: { page: 'widgets', filters: { size: ['Big'] } } },
          { value: 'Small', count: 1, opens: { page: 'widgets', filters: { size: ['Small'] }, search: 'w' } },
          { value: 'Elsewhere', count: 1, opens: { page: 'settings' } },
        ] }] }],
        ['put', 0, 1],
      ])
    }
    if (said.open && said.open.page === 'widgets') {
      const row = (name, size) => ({ key: name, lead: { name }, cells: [], facets: [{ filter: 'size', value: size }] })
      commit([
        ['make', 1, 'Table', {
          title: 'Widgets, told ' + told,
          headings: false,
          columns: [],
          filters: [{ key: 'size', name: 'Size' }],
          search: true,
          rows: [row('alpha', 'Big'), row('beta', 'Big'), row('wee', 'Small'), row('gamma', 'Small')],
        }],
        ['put', 0, 1],
      ])
    }
  })
})
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with Tinker in it, as if it came with Lumovi. */
async function served(serve: Serve) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'tinker.yaml'), TINKER)
  writeFileSync(join(included, 'tinker.js'), CODE)
  const port = await freePort()
  return serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
}

test('a count opens its plugin’s own page with the table filtered as the link said; that page stands in its kind’s tab', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/overview`, DEMO_TOKEN)
  const body = page.locator('[data-plugin-body]')
  await expect(body.getByRole('button', { name: /^Big/ })).toBeVisible({ timeout: 30_000 })
  // Its pages are its tabs, the list page where its kind's list was: no tab of Lumovi's for it.
  const tabs = page.getByRole('navigation', { name: 'Tinker' })
  await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Widgets'])
  // A link to a page it hasn't: the door makes none, so its count opens nothing.
  await expect(body.getByRole('button', { name: /^Elsewhere/ })).toHaveCount(0)
  // Big: its list page, its table showing only what the link set, with the chip to take it off.
  await body.getByRole('button', { name: /^Big/ }).click()
  await expect(page).toHaveURL(/\/plugins\/tinker\/widgets$/)
  const table = body.getByRole('region', { name: /^Widgets, told 1 table$/ })
  await expect(
    table.getByRole('row').filter({ hasNot: page.getByRole('columnheader') }),
  ).toHaveText([/alpha/, /beta/])
  await expect(table.getByRole('button', { name: 'Take off Size: Big' })).toBeVisible()
  // Taken off: all of them. The plugin was told only that its page opened (told 1).
  await table.getByRole('button', { name: 'Take off Size: Big' }).click()
  await expect(
    table.getByRole('row').filter({ hasNot: page.getByRole('columnheader') }),
  ).toHaveCount(4)
  // Small, with what the search starts with.
  await tabs.getByRole('link', { name: 'Overview' }).click()
  await body.getByRole('button', { name: /^Small/ }).click()
  await expect(page).toHaveURL(/\/plugins\/tinker\/widgets$/)
  const again = body.getByRole('region', { name: /^Widgets, told 1 table$/ })
  await expect(again.getByRole('textbox', { name: /^Search Widgets/ })).toHaveValue('w')
  await expect(
    again.getByRole('row').filter({ hasNot: page.getByRole('columnheader') }),
  ).toHaveText([/wee/])
})
