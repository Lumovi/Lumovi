/**
 * A plugin's entry on the Plugins page, for a file that asks for more than most: a JSON patch,
 * two of its own kinds it creates, every kind of a group, a kind of Kubernetes' own it only
 * shows, what its code reads (with status, events and usage, and without), and the Secrets its
 * pages show by a path of an object of its own kinds. Each said in Lumovi's words, as the entry
 * writes it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN, expect, freePort, signIn, test } from './fixtures.ts'

/** A plugin that comes with Lumovi (so it carries code, and its file may say what that reads). */
const GADGETS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: gadgets }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com, toys.example.org]
  shows: [{ kind: LimitRange }]
  views:
    - kinds: [{ group: example.com, kind: Widget }]
      actions:
        - name: Paint red
          confirm: It turns {{ .metadata.name }} red.
          type: json
          patch: [{ op: replace, path: /spec/color, value: red }]
        - name: Make a widget
          create: { apiVersion: example.com/v1, kind: Widget, metadata: { generateName: w- } }
    - kinds: [{ group: example.com, kind: Item }]
      actions:
        - name: Make an item
          create: { apiVersion: example.com/v1, kind: Item, metadata: { generateName: i- } }
    - kinds: [{ group: toys.example.org, kind: '*' }]
    - kinds: [{ kind: LimitRange }]
  reads:
    - group: ''
      kind: Node
      fields: [metadata.name]
      status: true
      events: true
      usage: true
    - group: ''
      kind: Pod
      fields: [metadata.name, spec.nodeName]
  showsSecrets:
    - group: example.com
      kind: Item
      path: spec.secretName
      keys: [tls.crt]
    - group: example.com
      kind: Widget
      path: spec.passwordRef.name
      keys: [password, user]
`

test('a plugin’s entry says what it may change and create, what it reads and shows, and what each action sends', async ({
  serve,
  page,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'gadgets.yaml'), GADGETS)
  writeFileSync(join(included, 'gadgets.js'), 'box.then(() => {})\n')
  // (A server with plugins knows its own address.)
  const port = await freePort()
  const server = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.goto(`${server.url}cluster/demo/plugins?plugin=gadgets`)
  const changes = page.getByRole('region', { name: 'May change and create' })
  const reads = page.getByRole('region', { name: 'May read' })
  const actions = page.getByRole('region', { name: 'Its actions, and what each sends' })
  await expect(reads).toBeVisible()
  // Its file is read whole: nothing wrong with it.
  await expect(page.getByRole('list', { name: 'Problems with Lumovi’s plugins' })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Problems with gadgets.yaml' })).toHaveCount(0)

  // Its own kinds, every kind of a group among them; and two it creates.
  await expect(changes).toContainText('Widget, Item, every kind of toys.example.org')
  await expect(changes).toContainText('Creates: Widget and Item, each one of its own kinds.')

  // A kind of Kubernetes' own it only shows, named as the cluster names it.
  await expect(reads).toContainText('LimitRanges, which it shows and can’t change.')
  // What its code is handed: with their status, events and usage where the file says so, and
  // only the fields where it doesn't.
  await expect(reads).toContainText(
    'Of Nodes, its code is handed only metadata.name, with their status, events and usage, as far as you may read them.',
  )
  await expect(reads).toContainText(
    'Of Pods, its code is handed only metadata.name and spec.nodeName, as far as you may read them.',
  )
  // The Secrets its pages show, each by its kind with its article.
  await expect(reads).toContainText(
    'Shows you tls.crt of the Secret that an Item’s spec.secretName names.',
  )
  await expect(reads).toContainText(
    'Shows you password and user of the Secret that a Widget’s spec.passwordRef.name names.',
  )

  // An action that's a JSON patch says so over what it sends.
  await expect(actions).toContainText('Paint red')
  await expect(actions).toContainText('A JSON patch')
  // And what it sends, as the file writes it.
  await expect(actions).toContainText('/spec/color')
})
