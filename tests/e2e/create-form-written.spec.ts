/**
 * The form on YAML it didn't write. Someone pastes a Deployment from elsewhere (a manifest
 * with comments, one written as flow maps, one indented their own way, JSON) and edits it
 * with the form: what comes of it is the same text with those values changed, and nothing
 * else of it touched.
 *
 * `yaml-edit.spec.ts` asks the same of the editing layer directly, thousands of times over.
 * This asks it where a person meets it: through the dialog, in the built app. Each text's
 * whole result is compared, after the form changed values, added to it, and took away again.
 * (What each should be is in `create-form-written.expected.ts`, written by this spec with
 * LUMOVI_RECORD=1 and then read by a person, line by line, before it's kept.)
 */
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { dialog } from './action-helpers.ts'
import { EXPECTED } from './create-form-written.expected.ts'
import { expect, openCluster, test } from './fixtures.ts'

const form = (page: Page) => dialog(page).getByRole('group', { name: 'Form', exact: true })
const field = (page: Page, name: string) => form(page).getByRole('textbox', { name, exact: true })
const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const yaml = (page: Page) =>
  editor(page).evaluate((content) =>
    [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
  )

/** Replaces the editor's text with `text`, as pasting it over what's there does. */
async function paste(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

const BOM = String.fromCharCode(0xfeff)

/** Deployments as people write them. Each is one the form can show. */
const WRITTEN: Record<string, string> = {
  // Comments, an order of its own, keys the form has no field for, a quoted image.
  'with comments, in its own order': `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: web
  annotations:
    team: storefront
spec:
  replicas: 2 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: web
          image: "ghcr.io/acme/web:2.4.1"   # pinned
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
`,
  // Maps and lists in brackets, as a generator or a hurried hand writes them.
  'as flow maps': `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - { name: web, image: nginx:1.27, ports: [{ containerPort: 80 }] }
`,
  // Four spaces, and a list's dashes under its key's own column.
  'indented by four, its lists not indented': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: web
    namespace: shop
spec:
    replicas: 2
    selector:
        matchLabels:
            app: web
    template:
        metadata:
            labels:
                app: web
        spec:
            containers:
            - name: web
              image: nginx:1.27
              ports:
              - containerPort: 80
              env:
              - name: LOG_LEVEL
                value: info
`,
  // Keys with nothing yet, quotes of both kinds, a value over several lines beside them.
  'half filled in, with a note of several lines': `apiVersion: apps/v1
kind: Deployment
metadata:
  name:
  namespace: 'shop'
  annotations:
    note: |
      Ask the storefront team
      before changing this.
spec:
  replicas: 1
  selector:
    matchLabels:
      app:
  template:
    metadata:
      labels:
        app:
    spec:
      containers:
        - name:
          image:
          env: []
          resources: {}
`,
  // JSON is YAML too, and what kubectl prints with -o json.
  'as JSON': `{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": "web", "namespace": "shop" },
  "spec": {
    "replicas": 2,
    "selector": { "matchLabels": { "app": "web" } },
    "template": {
      "metadata": { "labels": { "app": "web" } },
      "spec": { "containers": [{ "name": "web", "image": "nginx:1.27" }] }
    }
  }
}
`,
  // A file that starts with a byte-order mark and a document marker, as some editors save.
  'with a byte-order mark and a document marker': `${BOM}---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
`,
}

const recorded: Record<string, string> = {}
const RECORD = process.env.LUMOVI_RECORD === '1'

/** The editor's text, which is what's expected of it there (or, recording, what is). */
async function expectText(page: Page, key: string) {
  // The form's last edit has reached the editor once its status says so.
  const text = await yaml(page)
  if (RECORD) recorded[key] = text
  else expect(text, key).toBe(EXPECTED[key])
}

for (const [how, text] of Object.entries(WRITTEN)) {
  test(`a Deployment written ${how} is edited by the form, and is otherwise as it was`, async ({
    page,
  }) => {
    await openCluster(page)
    await page.keyboard.press('ControlOrMeta+n')
    await paste(page, text)
    // The form shows it: it hasn't stepped back.
    await expect(form(page)).not.toContainText('The form can’t show this YAML')
    await expectText(page, `${how}: pasted`)

    // Values changed: the name (and what follows it), the replicas, the image, the port.
    await field(page, 'Name').fill('storefront')
    await field(page, 'Replicas').fill('3')
    await field(page, 'Image').fill('ghcr.io/acme/storefront:3.0.0')
    await field(page, 'Port').fill('9090')
    await expect(form(page)).not.toContainText('The form can’t show this YAML')
    await expectText(page, `${how}: values changed`)

    // Added to: two variables (one whose value an older YAML would read as true), and
    // what it asks for and may use.
    await form(page).getByRole('button', { name: 'Add a variable' }).click()
    await page.keyboard.type('FEATURE_FLAGS')
    await field(page, 'FEATURE_FLAGS’s value').fill('on')
    await form(page).getByRole('button', { name: 'Add a variable' }).click()
    await page.keyboard.type('GREETING')
    await field(page, 'GREETING’s value').fill('hello: world # not a comment')
    const amounts = form(page).getByRole('button', { name: 'Set them' })
    if (await amounts.count()) await amounts.click()
    await field(page, 'CPU request').fill('250m')
    await field(page, 'Memory limit').fill('256Mi')
    await expect(form(page)).not.toContainText('The form can’t show this YAML')
    await expectText(page, `${how}: added to`)

    // Taken away again: the variables, the amounts, the port.
    await form(page).getByRole('button', { name: 'Remove GREETING' }).click()
    await form(page).getByRole('button', { name: 'Remove FEATURE_FLAGS' }).click()
    await field(page, 'CPU request').fill('')
    await field(page, 'Memory limit').fill('')
    await field(page, 'Port').fill('')
    await expect(form(page)).not.toContainText('The form can’t show this YAML')
    await expectText(page, `${how}: taken away`)

    // And it's still a Deployment the cluster is asked to make.
    await expect(dialog(page).getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  })
}

/**
 * The editor's document as it holds it: the text the form's edits are made of. It's read
 * from CodeMirror's own view, which it keeps on its content's element (`cmTile`, as of
 * @codemirror/view 6.43): nothing public says what the document is, line ends and all. If
 * that handle isn't there, or isn't this editor's, the test fails saying so, and never passes
 * or fails for another reason.
 */
const held = (page: Page) =>
  editor(page).evaluate((content) => {
    interface View {
      contentDOM: Element
      state: { doc: { toString(): string; lines: number } }
    }
    const view = (content as unknown as { cmTile?: { view?: View } }).cmTile?.view
    if (
      !view ||
      view.contentDOM !== content ||
      typeof view.state?.doc?.lines !== 'number' ||
      view.state.doc.lines !== content.querySelectorAll('.cm-line').length
    ) {
      throw new Error(
        'The editor’s internals changed; this test pins that the form’s layer only ever sees plain line ends: find the editor’s document another way.',
      )
    }
    return view.state.doc.toString()
  })

// The editing layer writes and expects plain line ends, and nothing else: this is the fact
// that rests on. Whatever way text gets into the editor, the editor holds it with plain
// line ends, and that's what the form edits and what's created.
test('text with Windows’ line endings reaches the form with plain ones, however it gets in', async ({
  page,
}) => {
  const text = WRITTEN['with comments, in its own order']!
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  for (const [how, ending, enter] of [
    ['typed in, with Windows’ line endings', '\r\n', 'insert'],
    ['pasted, with Windows’ line endings', '\r\n', 'paste'],
    ['pasted, with old Mac line endings', '\r', 'paste'],
    ['pasted, with both kinds mixed', '\r\n', 'mixed'],
  ] as const) {
    const foreign =
      enter === 'mixed'
        ? text.replace(/\n/g, (_, at: number) => (at % 2 ? '\r\n' : '\n'))
        : text.replace(/\n/g, ending)
    await editor(page).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    if (enter === 'insert') await page.keyboard.insertText(foreign)
    else {
      // A paste, as the system's clipboard gives one.
      await editor(page).evaluate((content, pasted) => {
        const data = new DataTransfer()
        data.setData('text/plain', pasted)
        content.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        )
      }, foreign)
    }
    await expect.poll(() => held(page), how).toBe(text)
    // And the form's edits of it are the ones made of the same text with plain line ends.
    await field(page, 'Replicas').fill('3')
    await form(page).getByRole('button', { name: 'Add a variable' }).click()
    await page.keyboard.type('FEATURE_FLAGS')
    const edited = await held(page)
    expect(edited, how).not.toContain('\r')
    expect(edited, how).toBe(
      text
        .replace('replicas: 2 # two for now', 'replicas: 3 # two for now')
        .replace(
          '              value: info\n',
          '              value: info\n            - name: FEATURE_FLAGS\n',
        ),
    )
  }
})

test.afterAll(() => {
  if (!RECORD || Object.keys(recorded).length === 0) return
  const body = Object.entries(recorded)
    .map(([key, text]) => `  ${JSON.stringify(key)}: ${JSON.stringify(text)},`)
    .join('\n')
  writeFileSync(
    `tests/e2e/create-form-written.expected.${process.env.TEST_WORKER_INDEX ?? '0'}.json`,
    `{\n${body.replace(/,$/, '')}\n}\n`,
  )
})
