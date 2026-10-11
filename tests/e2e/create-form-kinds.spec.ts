/**
 * Create's form for the kinds that run nothing: a Service (its type, the pods it sends to,
 * its ports), a ConfigMap (keys and values of several lines), a Secret (its values hidden on
 * both sides until they're asked for) and a PersistentVolumeClaim.
 */
import type { Locator, Page } from '@playwright/test'
import { HIDDEN } from '../../src/renderer/src/lib/create-form.ts'
import { dialog, menuAction, open as openObject, toasts, writes } from './action-helpers.ts'
import { expect, openCluster, test } from './fixtures.ts'

const form = (page: Page) => dialog(page).getByRole('group', { name: 'Form', exact: true })
const field = (page: Page, name: string) => form(page).getByRole('textbox', { name, exact: true })
const choice = (page: Page, name: string) => form(page).getByRole('combobox', { name, exact: true })
const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const status = (page: Page) => dialog(page).getByRole('status')
const create = (page: Page) => dialog(page).getByRole('button', { name: 'Create', exact: true })
const add = (page: Page, what: string) => form(page).getByRole('button', { name: what })
const lines = (page: Page, how: 'lit' | 'wrong' | 'shaded') =>
  dialog(page).locator(`.cm-line-${how}`)
const yaml = (page: Page) =>
  editor(page).evaluate((content) =>
    [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
  )

/** Opens Create's form in `shop`, on a kind. */
async function open(page: Page, kind: string) {
  await openCluster(page)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'shop' }).click()
  await page.keyboard.press('ControlOrMeta+n')
  await dialog(page).getByRole('radio', { name: kind, exact: true }).click()
  await expect(dialog(page).getByRole('radio', { name: kind, exact: true })).toBeChecked()
}

/** Replaces the editor's text with `text`. */
async function type(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

const stepped = (page: Page) =>
  form(page).locator('div').filter({ hasText: 'The form can’t show this YAML' }).last()
const back = (page: Page) =>
  form(page).getByRole('button', { name: 'Go back to the form’s version' })

test('a Service: its type, the pods its labels match, and its ports', async ({
  page,
  clusters,
}) => {
  await open(page, 'Service')
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: Service
metadata:
  name:
  namespace: shop
spec:
  type: ClusterIP
  selector:
  ports:
    - port:
      protocol: TCP
`)
  await expect(status(page)).toHaveText('Name and Port are still empty.')
  await expect(create(page)).toBeDisabled()
  await field(page, 'Name').fill('web')

  // Its type is one of three, each said in a line; the arrows choose, as among radios.
  const types = form(page).getByRole('radiogroup', { name: 'Type' })
  await expect(types.getByRole('radio', { name: 'ClusterIP' })).toBeChecked()
  await expect(form(page)).toContainText('Reached from inside the cluster only.')
  await types.getByRole('radio', { name: 'LoadBalancer' }).click()
  await expect(lines(page, 'lit')).toHaveText(['  type: LoadBalancer'])
  await expect(form(page)).toContainText(
    'Reached from outside, through a load balancer the cluster’s provider makes.',
  )
  await page.keyboard.press('ArrowLeft')
  await expect(types.getByRole('radio', { name: 'NodePort' })).toBeChecked()
  await expect(types.getByRole('radio', { name: 'NodePort' })).toBeFocused()
  expect(await yaml(page)).toContain('  type: NodePort\n')

  // The pods it sends to are said by labels: a row each, in the YAML once it has a key.
  await expect(form(page)).toContainText(
    'With no labels, it sends to no pods until something else says which.',
  )
  await add(page, 'Add a label').click()
  await expect(field(page, 'A new label')).toBeFocused()
  await page.keyboard.type('app.kubernetes.io/name')
  // (The row that was new is the same row, named: what's typed next is still its key.)
  await expect(field(page, 'Label 1')).toBeFocused()
  await expect(field(page, 'Label 1')).toHaveValue('app.kubernetes.io/name')
  await expect(form(page).getByRole('alert')).toHaveText(
    'app.kubernetes.io/name needs a value to match.',
  )
  await field(page, 'app.kubernetes.io/name’s value').fill('storefront')
  await expect(lines(page, 'lit')).toHaveText(['    app.kubernetes.io/name: storefront'])
  // How many pods there match now is asked of the cluster, and said.
  await expect(form(page)).toContainText('3 pods in shop match now.')
  await field(page, 'app.kubernetes.io/name’s value').fill('nobody')
  await expect(form(page)).toContainText('No pods in shop match now.')
  // A value that can't be a label's is said, and not asked about.
  await field(page, 'app.kubernetes.io/name’s value').fill('store front')
  await expect(form(page).getByRole('alert')).toContainText('store front can’t be a label’s value')
  await expect(form(page)).not.toContainText('match now')
  await field(page, 'app.kubernetes.io/name’s value').fill('storefront')

  // A second label; one whose key is another's isn't written, and that's said.
  await add(page, 'Add a label').click()
  await page.keyboard.type('tier')
  await field(page, 'tier’s value').fill('frontend')
  await expect(form(page)).toContainText('No pods in shop match now.')
  await field(page, 'Label 2').fill('app.kubernetes.io/name')
  await expect(form(page).getByRole('alert')).toHaveText(
    'app.kubernetes.io/name is there already, and a label is there once.',
  )
  expect(await yaml(page)).toContain('    tier: frontend\n')
  // A key renamed is its own characters changed: its value stays.
  await field(page, 'Label 2').fill('app.kubernetes.io/component')
  expect(await yaml(page)).toContain('    app.kubernetes.io/component: frontend\n')
  await expect(form(page)).toContainText('3 pods in shop match now.')
  await form(page).getByRole('button', { name: 'Remove app.kubernetes.io/component' }).click()
  expect(await yaml(page)).not.toContain('component')

  // A port: the Service's, the pod's (the same, unless said), and its protocol.
  await field(page, 'Port 1').fill('80')
  await expect(status(page)).toHaveText('Edit either side: they stay in step.')
  await expect(field(page, 'Port 1, on the pod')).toHaveAttribute('placeholder', '80')
  await field(page, 'Port 1, on the pod').fill('8080')
  await choice(page, 'Port 1’s protocol').selectOption('UDP')
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: storefront
  ports:
    - port: 80
      targetPort: 8080
      protocol: UDP
`)
  await field(page, 'Port 1, on the pod').fill('http')
  expect(await yaml(page)).toContain('      targetPort: http\n')
  await field(page, 'Port 1, on the pod').fill('Not A Port')
  await expect(form(page).getByRole('alert')).toContainText(
    'The pod’s port is a number from 1 to 65535, or the name the pod gives it',
  )
  await field(page, 'Port 1, on the pod').fill('')
  expect(await yaml(page)).not.toContain('targetPort')
  await field(page, 'Port 1').fill('70000')
  await expect(form(page).getByRole('alert')).toHaveText('A port is a number from 1 to 65535.')
  await expect(lines(page, 'wrong')).toHaveText(['    - port: 70000'])
  await field(page, 'Port 1').fill('80')

  // One more: with two, the cluster asks a name of each, and so does the form.
  await add(page, 'Add a port').click()
  await expect(field(page, 'A new port')).toBeFocused()
  await page.keyboard.type('443')
  await expect(field(page, 'Port 2')).toBeFocused()
  await expect(field(page, 'Port 2')).toHaveValue('443')
  await expect(form(page).getByRole('alert')).toHaveText(
    'With more than one port, each needs a name.',
  )
  await expect(create(page)).toBeDisabled()
  await field(page, 'Port 1’s name').fill('http')
  await field(page, 'Port 2’s name').fill('http')
  await expect(form(page).getByRole('alert')).toHaveText(
    'Two ports are named http, and each needs its own.',
  )
  await field(page, 'Port 2’s name').fill('https')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  expect(await yaml(page)).toContain(`  ports:
    - port: 80
      name: http
      protocol: UDP
    - port: 443
      name: https
      protocol: TCP
`)
  await form(page).getByRole('button', { name: 'Remove port 2' }).click()
  expect(await yaml(page)).not.toContain('443')

  // What the YAML says that the form has no field for is kept, and named; a type the form
  // hasn't, or a label that's more than a value, and it steps back.
  const fitted = await yaml(page)
  await type(
    page,
    fitted.replace('  type: NodePort\n', '  type: NodePort\n  sessionAffinity: ClientIP\n'),
  )
  await expect(form(page)).toContainText('The YAML also sets spec.sessionAffinity.')
  await type(page, fitted.replace('NodePort', 'ExternalName'))
  await expect(stepped(page)).toContainText(
    'Its type is ExternalName, and the form’s are ClusterIP, NodePort and LoadBalancer.',
  )
  await back(page).click()
  await type(
    page,
    fitted.replace('app.kubernetes.io/name: storefront', 'app.kubernetes.io/name: [a, b]'),
  )
  await expect(stepped(page)).toContainText('holds more than one value')
  await back(page).click()

  await create(page).click()
  await expect(toasts(page)).toContainText('Created service web')
  expect(writes(clusters.demo, 'POST', '/api/v1/namespaces/shop/services').at(-1)!.body).toEqual({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'web', namespace: 'shop' },
    spec: {
      type: 'NodePort',
      // (What the form has no field for goes with the rest.)
      sessionAffinity: 'ClientIP',
      selector: { 'app.kubernetes.io/name': 'storefront' },
      ports: [{ port: 80, name: 'http', protocol: 'UDP' }],
    },
  })
})

test('a ConfigMap: keys, and values of several lines', async ({ page, clusters }) => {
  await open(page, 'ConfigMap')
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: ConfigMap
metadata:
  name:
  namespace: shop
data:
`)
  await expect(status(page)).toHaveText('Name is still empty.')
  await field(page, 'Name').fill('web-settings')
  await expect(form(page)).toContainText('A value can have several lines.')
  await add(page, 'Add a key').click()
  await page.keyboard.type('LOG')
  await expect(field(page, 'Key 1')).toHaveValue('LOG')
  // A key typed into a new row has its line lit at once, the focus being in it already; and
  // renamed, the line lit is the new key's.
  await expect(lines(page, 'lit')).toHaveText(['  LOG: ""'])
  await page.keyboard.type('_LEVEL')
  await expect(field(page, 'Key 1')).toHaveValue('LOG_LEVEL')
  await expect(lines(page, 'lit')).toHaveText(['  LOG_LEVEL: ""'])
  await field(page, 'LOG_LEVEL’s value').fill('info')
  // A value is text, whatever it looks like: what would read as something else is quoted.
  await add(page, 'Add a key').click()
  await page.keyboard.type('RETRIES')
  await field(page, 'RETRIES’s value').fill('5')
  await add(page, 'Add a key').click()
  await page.keyboard.type('features.yaml')
  await field(page, 'features.yaml’s value').fill('checkout:\n  express: true\n')
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: ConfigMap
metadata:
  name: web-settings
  namespace: shop
data:
  LOG_LEVEL: info
  RETRIES: "5"
  features.yaml: |
    checkout:
      express: true
`)
  // The field is as tall as its value; in it, Enter is a line, not Create.
  await expect(field(page, 'features.yaml’s value')).toHaveAttribute('rows', '3')
  await field(page, 'features.yaml’s value').focus()
  await expect(lines(page, 'lit')).toHaveText([
    '  features.yaml: |',
    '    checkout:',
    '      express: true',
  ])
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('  gift-cards: false')
  expect(await yaml(page)).toContain('      express: true\n      gift-cards: false\n')
  await expect(dialog(page)).toBeVisible()

  // A comment after a value stays with it, though the value comes to take several lines.
  const fitted = await yaml(page)
  await type(page, fitted.replace('LOG_LEVEL: info', 'LOG_LEVEL: info # how loud'))
  await field(page, 'LOG_LEVEL’s value').fill('info\ndebug\n')
  expect(await yaml(page)).toContain('  LOG_LEVEL: | # how loud\n    info\n    debug\n')
  await field(page, 'LOG_LEVEL’s value').fill('info')
  expect(await yaml(page)).toContain('  LOG_LEVEL: info # how loud\n')

  // A value the YAML has as a number is one the cluster refuses: said, with what puts it right.
  await type(page, fitted.replace('RETRIES: "5"', 'RETRIES: 5'))
  await expect(form(page).getByRole('alert')).toHaveText(
    'RETRIES is a number in the YAML, and a ConfigMap’s values are text: put it in quotes.',
  )
  await expect(lines(page, 'wrong')).toHaveText(['  RETRIES: 5'])
  await expect(create(page)).toBeDisabled()
  // (Typed in the form, it's text.)
  await field(page, 'RETRIES’s value').fill('6')
  expect(await yaml(page)).toContain('  RETRIES: "6"\n')
  await field(page, 'Key 2').fill('not a key')
  await expect(form(page).getByRole('alert')).toHaveText(
    'not a key can’t be a key: letters, digits, “-”, “_” and “.”.',
  )
  await field(page, 'Key 2').fill('RETRIES')
  // A key left empty stays what it was.
  await field(page, 'Key 2').fill('')
  await expect(form(page).getByRole('alert')).toHaveText(
    'A key needs a name: remove it with ×, or give it one.',
  )
  await field(page, 'Name').focus()
  await expect(field(page, 'Key 2')).toHaveValue('RETRIES')
  await form(page).getByRole('button', { name: 'Remove RETRIES' }).click()
  // What isn't keys and values of text is the YAML's: kept, and named.
  await type(page, `${(await yaml(page)).trimEnd()}\nbinaryData:\n  logo: aGk=\n`)
  await expect(form(page)).toContainText('The YAML also sets binaryData.')
  await type(page, (await yaml(page)).replace('LOG_LEVEL: info', 'LOG_LEVEL: {a: 1}'))
  await expect(stepped(page)).toContainText(
    'data.LOG_LEVEL holds more than one value, and the form’s field there takes one.',
  )
  await back(page).click()

  await create(page).click()
  await expect(toasts(page)).toContainText('Created configmap web-settings')
  expect(
    writes(clusters.demo, 'POST', '/api/v1/namespaces/shop/configmaps').at(-1)!.body,
  ).toMatchObject({
    data: {
      LOG_LEVEL: 'info',
      'features.yaml': 'checkout:\n  express: true\n  gift-cards: false',
    },
    binaryData: { logo: 'aGk=' },
  })
})

/** Everything of the dialog a value could be read from: its text, and what its fields hold. */
const everything = (page: Page) =>
  dialog(page).evaluate((root) =>
    [
      root.outerHTML,
      ...[...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map(
        (input) => input.value,
      ),
    ].join('\n'),
  )

test('a Secret: its values are hidden on both sides until they’re asked for', async ({
  page,
  clusters,
}) => {
  await open(page, 'Secret')
  const show = dialog(page).getByRole('button', { name: 'Show values' })
  const hide = dialog(page).getByRole('button', { name: 'Hide values' })
  await expect(show).toHaveAttribute('aria-pressed', 'false')
  await expect(form(page)).toContainText(
    'Opaque: keys and values of your own. For a TLS or registry secret, use the YAML.',
  )
  await expect(form(page)).toContainText(
    'Values are hidden on both sides until you choose Show values, above the YAML. The cluster stores them base64-encoded, which isn’t encryption.',
  )
  await field(page, 'Name').fill('payments-credentials')
  await expect(status(page)).toHaveText('Read-only while its values are hidden.')
  await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')

  // A value is typed blind, and is the YAML's at once: in what's shown there's none of it.
  await add(page, 'Add a key').click()
  await page.keyboard.type('API_KEY')
  await field(page, 'API_KEY’s value').fill('c41d07be6a3e8f29')
  await add(page, 'Add a key').click()
  await page.keyboard.type('tls.key')
  await field(page, 'tls.key’s value').fill('-----BEGIN-----\nline two\n-----END-----\n')
  await field(page, 'Name').focus()
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: payments-credentials
  namespace: shop
type: Opaque
stringData:
  API_KEY: ${HIDDEN}
  tls.key: ${HIDDEN}
`)
  // Left, a field holds nothing of its value: only that there is one.
  await expect(field(page, 'API_KEY’s value')).toHaveValue('')
  await expect(field(page, 'API_KEY’s value')).toHaveAttribute('placeholder', HIDDEN)
  for (const secret of ['c41d07be6a3e8f29', 'line two', 'BEGIN']) {
    expect(await everything(page)).not.toContain(secret)
  }
  // The field in focus still lights its line, which is one line whatever the value's are.
  await field(page, 'tls.key’s value').focus()
  await expect(lines(page, 'lit')).toHaveText([`  tls.key: ${HIDDEN}`])
  // Hidden, the YAML isn't edited: nothing typed in it, or undone in it, changes it.
  await editor(page).click()
  await page.keyboard.type('x')
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  expect(await yaml(page)).toContain(`  API_KEY: ${HIDDEN}\n`)
  expect(await everything(page)).not.toContain('c41d07be6a3e8f29')

  // Asked for, they show on both sides, and both are edited.
  await show.click()
  await expect(hide).toHaveAttribute('aria-pressed', 'true')
  await expect(status(page)).toHaveText('Edit either side: they stay in step.')
  await expect(editor(page)).toHaveAttribute('aria-readonly', 'false')
  await expect(form(page)).toContainText(
    'Values are showing on both sides; Hide values, above the YAML, hides them again.',
  )
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: payments-credentials
  namespace: shop
type: Opaque
stringData:
  API_KEY: c41d07be6a3e8f29
  tls.key: |
    -----BEGIN-----
    line two
    -----END-----
`)
  await expect(field(page, 'API_KEY’s value')).toHaveValue('c41d07be6a3e8f29')
  await field(page, 'API_KEY’s value').fill('6d2a57e41a4b1f0c')
  expect(await yaml(page)).toContain('  API_KEY: 6d2a57e41a4b1f0c\n')
  // Values the YAML holds encoded are the YAML's to say: kept, named, and hidden with the rest.
  const shown = await yaml(page)
  await type(page, `${shown.trimEnd()}\ndata:\n  encoded: aHVudGVyMg==\n`)
  await expect(form(page)).toContainText('The YAML also sets data.')
  // What undoing in the editor goes back to is what was typed there, and no further.
  await hide.click()
  await expect(show).toHaveAttribute('aria-pressed', 'false')
  expect(await yaml(page)).toContain(`  encoded: ${HIDDEN}\n`)
  for (const secret of ['6d2a57e41a4b1f0c', 'aHVudGVyMg', 'line two']) {
    expect(await everything(page)).not.toContain(secret)
  }
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await everything(page)).not.toContain('6d2a57e41a4b1f0c')

  // YAML that doesn't parse can't have its values told from the rest, nor can a value that's
  // written elsewhere and brought in by an alias: it stays shown until they can.
  await show.click()
  const whole = await yaml(page)
  await type(page, whole.replace('stringData:', 'stringData: [unclosed'))
  await expect(hide).toBeDisabled()
  // (As it was between the two, so the second isn't judged by the first's answer.)
  await type(page, whole)
  await expect(hide).toBeEnabled()
  await type(
    page,
    whole
      .replace(
        '  name: payments-credentials',
        '  name: payments-credentials\n  labels: {k: &v S3CR3T}',
      )
      .replace('API_KEY: 6d2a57e41a4b1f0c', 'API_KEY: *v'),
  )
  await expect(hide).toBeDisabled()
  await expect(hide).toHaveAccessibleDescription(/a value comes through an alias or a merge key/)
  // A comment among the values is where an old one is left: its words are hidden with them.
  await type(page, whole.replace('  API_KEY:', '  # API_KEY: 0ld-v4lue\n  API_KEY:'))
  await expect(hide).toBeEnabled()
  await hide.click()
  expect(await yaml(page)).toContain(`stringData:\n  # ${HIDDEN}\n  API_KEY: ${HIDDEN}\n`)
  expect(await everything(page)).not.toContain('0ld-v4lue')
  await show.click()
  await type(page, whole)
  // Another type isn't the form's; hidden, its values still are.
  await type(page, whole.replace('type: Opaque', 'type: kubernetes.io/tls'))
  await expect(stepped(page)).toContainText(
    'Its type is kubernetes.io/tls, and the form is for an Opaque one: keys and values of your own.',
  )
  await hide.click()
  expect(await yaml(page)).toContain(`  API_KEY: ${HIDDEN}\n`)
  await expect(lines(page, 'shaded')).toHaveText(['type: kubernetes.io/tls'])
  await back(page).click()
  await expect(stepped(page)).toHaveCount(0)

  // Created while hidden, it's the real one that's created.
  await create(page).click()
  await expect(toasts(page)).toContainText('Created secret payments-credentials')
  await expect(toasts(page)).not.toContainText('6d2a57e41a4b1f0c')
  expect(writes(clusters.demo, 'POST', '/api/v1/namespaces/shop/secrets').at(-1)!.body).toEqual({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'payments-credentials', namespace: 'shop' },
    type: 'Opaque',
    stringData: {
      API_KEY: '6d2a57e41a4b1f0c',
      'tls.key': '-----BEGIN-----\nline two\n-----END-----\n',
    },
    data: { encoded: 'aHVudGVyMg==' },
  })
})

test('what the cluster says of a Secret is shown without its values, while they’re hidden', async ({
  page,
}) => {
  // One the cluster has already, with a value that's the same as its name: the cluster's
  // answer quotes the name, and so, here, a value.
  await open(page, 'Secret')
  await field(page, 'Name').fill('registry-pull')
  await add(page, 'Add a key').click()
  await page.keyboard.type('password')
  await field(page, 'password’s value').fill('registry-pull')
  await create(page).click()
  // None of the cluster's words are shown: it may quote a value in any form.
  const results = dialog(page).getByRole('list', { name: 'Results' })
  await expect(results).toContainText(
    'The cluster refused it. Choose Show values to read what it said.',
  )
  await expect(results).not.toContainText('already exists')
  await expect(status(page)).toHaveText('Nothing was created.')
  // Shown, it's as the cluster said it.
  await dialog(page).getByRole('button', { name: 'Show values' }).click()
  await expect(results).toContainText('"registry-pull" already exists')
  // Another kind after it starts hidden again.
  await dialog(page).getByRole('radio', { name: 'ConfigMap', exact: true }).click()
  await dialog(page).getByRole('radio', { name: 'Secret', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Show values' })).toBeVisible()
  await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')
})

test('a refusal that quotes a Secret’s value shows none of it anywhere on the page, while hidden', async ({
  page,
  clusters,
}) => {
  // A value that's nothing like the name, quoted by the cluster in its message and in a
  // cause under a field: neither is shown, in the dialog or anywhere else on the page.
  const VALUE = 'V4LU3-0f-its-0wn'
  clusters.demo.fail('/api/v1/namespaces/shop/secrets', {
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'Status',
      status: 'Failure',
      reason: 'Invalid',
      code: 422,
      message: `Secret "api" is invalid: stringData: Invalid value: "${VALUE}"`,
      details: {
        name: 'api',
        kind: 'Secret',
        causes: [
          {
            reason: 'FieldValueInvalid',
            field: 'stringData',
            message: `Invalid value: "${VALUE}"`,
          },
        ],
      },
    }),
  })
  await open(page, 'Secret')
  await field(page, 'Name').fill('api')
  await add(page, 'Add a key').click()
  await page.keyboard.type('token')
  await field(page, 'token’s value').fill(VALUE)
  await create(page).click()
  const results = dialog(page).getByRole('list', { name: 'Results' })
  await expect(results).toContainText(
    'The cluster refused it. Choose Show values to read what it said.',
  )
  // Under its field, said once.
  await expect(form(page).getByRole('alert')).toHaveText(
    'The cluster refused it. Choose Show values to read what it said.',
  )
  // Nowhere on the page: not the dialog, a note, or the activity log behind it.
  await expect(page.locator('body')).not.toContainText(VALUE)
  expect(await page.locator('body').innerHTML()).not.toContain(VALUE.slice(0, 8))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Activity' }).click()
  await expect(page.getByRole('dialog', { name: 'Activity' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(VALUE)
})

test('a Secret’s change that fails is in the activity log as that, without the cluster’s words', async ({
  page,
  clusters,
}) => {
  // (Any change to one: here, a delete the cluster doesn't allow.)
  await openCluster(page)
  await openObject(page, 'Secrets', 'registry-pull')
  await menuAction(page, 'Secret', 'registry-pull', 'Delete…')
  clusters.demo.deny({ verb: 'delete', resource: 'secrets', namespace: 'shop' })
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('registry-pull')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Activity' }).click()
  const log = page.getByRole('dialog', { name: 'Activity' })
  await expect(log.getByRole('listitem').first()).toContainText(
    'What the cluster said of the Secret isn’t kept here: it can quote its values.',
  )
  await expect(log.getByRole('listitem').first()).not.toContainText('registry-pull" is forbidden')
})

test('a PersistentVolumeClaim: a size, a class, and who can mount it', async ({
  page,
  clusters,
}) => {
  await open(page, 'PersistentVolumeClaim')
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name:
  namespace: shop
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage:
`)
  await expect(status(page)).toHaveText('Name and Size are still empty.')
  await field(page, 'Name').fill('uploads')
  // A number is gibibytes; the class starts as the cluster's default, named.
  await field(page, 'Size').fill('50')
  await expect(lines(page, 'lit')).toHaveText(['      storage: 50Gi'])
  await expect(choice(page, 'Storage class').locator('option:checked')).toHaveText(
    'standard (default)',
  )
  await choice(page, 'Storage class').selectOption('fast-ssd')
  await expect(choice(page, 'Who can mount it').locator('option:checked')).toHaveText(
    'One node, to read and write',
  )
  await expect(form(page)).toContainText(
    'ReadWriteOnce. The class decides which of these it can give.',
  )
  await choice(page, 'Who can mount it').selectOption('ReadWriteMany')
  await expect(form(page)).toContainText('ReadWriteMany. The class decides')
  await expect(form(page)).toContainText(
    'Its size can grow later where the class allows it; it can’t shrink.',
  )
  expect(await yaml(page)).toBe(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads
  namespace: shop
spec:
  storageClassName: fast-ssd
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 50Gi
`)
  // What's wrong is said under its field.
  await field(page, 'Size').fill('lots')
  await expect(form(page).getByRole('alert')).toHaveText(
    'The size isn’t an amount of storage Kubernetes reads: like 20Gi.',
  )
  await field(page, 'Size').fill('500Mi')
  await expect(field(page, 'Size')).toHaveValue('500Mi')
  await field(page, 'Size').fill('50')
  await choice(page, 'Storage class').selectOption('')
  expect(await yaml(page)).not.toContain('storageClassName')
  // More than one way to mount it, and the form steps back; a way that isn't one is said.
  const fitted = await yaml(page)
  await type(
    page,
    fitted.replace('    - ReadWriteMany\n', '    - ReadWriteMany\n    - ReadOnlyMany\n'),
  )
  await expect(stepped(page)).toContainText(
    'It asks for two ways to be mounted, and the form’s field takes one.',
  )
  await back(page).click()
  await type(page, fitted.replace('ReadWriteMany', 'ReadWriteSometimes'))
  await expect(form(page).getByRole('alert')).toContainText(
    'ReadWriteSometimes isn’t a way a claim is mounted',
  )
  await expect(choice(page, 'Who can mount it')).toHaveValue('ReadWriteSometimes')
  await choice(page, 'Who can mount it').selectOption('ReadWriteMany')
  await expect(form(page).getByRole('alert')).toHaveCount(0)

  await create(page).click()
  await expect(toasts(page)).toContainText('Created persistentvolumeclaim uploads')
  expect(
    writes(clusters.demo, 'POST', '/api/v1/namespaces/shop/persistentvolumeclaims').at(-1)!.body,
  ).toEqual({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'uploads', namespace: 'shop' },
    spec: { accessModes: ['ReadWriteMany'], resources: { requests: { storage: '50Gi' } } },
  })
})

test('what’s begun and left is said or dropped; one pod is one pod; what the YAML says is shown', async ({
  page,
  clusters,
}) => {
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'the-only-one', namespace: 'shop', labels: { only: 'one' } },
    spec: { containers: [{ name: 'c', image: 'registry.example/c:1' }] },
  })
  await open(page, 'Service')
  await field(page, 'Name').fill('web')
  // One pod matches, and it's said as one.
  await add(page, 'Add a label').click()
  await page.keyboard.type('only')
  await field(page, 'only’s value').fill('one')
  await expect(form(page)).toContainText('1 pod in shop matches now.')
  // A label begun with a key that's there already stays begun, and says so; removed, it's gone.
  await add(page, 'Add a label').click()
  await field(page, 'A new label').fill('only')
  await field(page, 'A new label').blur()
  await expect(form(page).getByRole('alert')).toHaveText(
    'only is there already, and a label is there once.',
  )
  await form(page).getByRole('button', { name: 'Remove the new label' }).click()
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  // A label's key emptied isn't a label: remove it, or give it one.
  await field(page, 'Label 1').fill('')
  await expect(form(page).getByRole('alert')).toHaveText(
    'A label needs a key: remove it with ×, or give it one.',
  )
  expect(await yaml(page)).toContain('    only: one\n')
  // Left as it can't be, it's the key it was.
  await field(page, 'Label 1').blur()
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(field(page, 'Label 1')).toHaveValue('only')
  // A port begun and left empty is nothing yet, and is dropped by its ×.
  await field(page, 'Port 1').fill('80')
  await add(page, 'Add a port').click()
  await expect(field(page, 'A new port')).toBeFocused()
  // (A space is no number: it's still a port to be, and writes nothing.)
  await page.keyboard.type(' ')
  await expect(field(page, 'A new port')).toBeVisible()
  expect((await yaml(page)).match(/- port:/g)).toHaveLength(1)
  await field(page, 'A new port').fill('')
  await page.keyboard.press('Tab')
  await expect(field(page, 'A new port')).toHaveValue('')
  expect((await yaml(page)).match(/- port:/g)).toHaveLength(1)
  await form(page).getByRole('button', { name: 'Remove the new port' }).click()
  await expect(field(page, 'A new port')).toHaveCount(0)
  // Among its types only the arrows choose: another key is no choice.
  const types = form(page).getByRole('radiogroup', { name: 'Type' })
  await types.getByRole('radio', { name: 'ClusterIP' }).focus()
  await page.keyboard.press('a')
  await expect(types.getByRole('radio', { name: 'ClusterIP' })).toBeChecked()

  // A ConfigMap's key, likewise: begun as one that's there, emptied, dropped.
  await dialog(page).getByRole('radio', { name: 'ConfigMap', exact: true }).click()
  await add(page, 'Add a key').click()
  await page.keyboard.type('LOG_LEVEL')
  await add(page, 'Add a key').click()
  await field(page, 'A new key').fill('LOG_LEVEL')
  await field(page, 'A new key').blur()
  await expect(form(page).getByRole('alert')).toHaveText(
    'LOG_LEVEL is there already, and a key is there once.',
  )
  await form(page).getByRole('button', { name: 'Remove the new key' }).click()
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await field(page, 'Key 1').fill('')
  await expect(form(page).getByRole('alert')).toHaveText(
    'A key needs a name: remove it with ×, or give it one.',
  )
  await field(page, 'Key 1').blur()
  await expect(field(page, 'Key 1')).toHaveValue('LOG_LEVEL')

  // A claim whose YAML names a class the cluster hasn't, and a way to mount the form doesn't
  // offer: each is shown as what it says, in its own field.
  await dialog(page).getByRole('radio', { name: 'PersistentVolumeClaim', exact: true }).click()
  await field(page, 'Name').fill('uploads')
  await field(page, 'Size').fill('5')
  const fitted = await yaml(page)
  await type(
    page,
    fitted
      .replace('    - ReadWriteOnce\n', '    - ReadWriteSometimes\n')
      .replace('spec:\n', 'spec:\n  storageClassName: gone-class\n'),
  )
  await expect(choice(page, 'Storage class').locator('option:checked')).toHaveText('gone-class')
  // Where no class is the cluster's default there's none to name: it's said as that.
  clusters.demo.upsert({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'standard', annotations: {} },
    provisioner: 'rancher.io/local-path',
  })
  await expect(
    choice(page, 'Storage class').locator('option').filter({ hasText: 'The cluster’s default' }),
  ).toHaveCount(1)
  await expect(choice(page, 'Who can mount it').locator('option:checked')).toHaveText(
    'ReadWriteSometimes',
  )
})

test('what’s written in the YAML that a field can’t hold is said under that field', async ({
  page,
}) => {
  await open(page, 'Service')
  await field(page, 'Name').fill('web')
  await add(page, 'Add a label').click()
  await page.keyboard.type('app')
  await field(page, 'app’s value').fill('web')
  await field(page, 'Port 1').fill('80')
  const fitted = await yaml(page)
  const said = (words: string) => form(page).getByRole('alert').filter({ hasText: words })
  // A protocol that isn't one; a port's name that can't be; a label's value that isn't text;
  // a namespace that can't be a name.
  await type(page, fitted.replace('protocol: TCP', 'protocol: HTTP'))
  await expect(said('HTTP isn’t one of TCP, UDP and SCTP.')).toBeVisible()
  await type(page, fitted.replace('    - port: 80\n', '    - port: 80\n      name: My Port\n'))
  await expect(
    said('My Port can’t be a port’s name: lowercase letters, digits and “-”.'),
  ).toBeVisible()
  await type(page, fitted.replace('    app: web\n', '    app: true\n'))
  await expect(
    said('app is a boolean in the YAML, and a label’s value is text: put it in quotes.'),
  ).toBeVisible()
  await type(page, fitted.replace('  namespace: shop\n', '  namespace: My Shop\n'))
  await expect(said('A namespace’s name: lowercase letters, digits and “-”.')).toBeVisible()
  await expect(create(page)).toBeDisabled()
  // With no ports written at all, the form still has a place to begin one.
  await type(page, fitted.replace(/ {2}ports:\n( {4,}.*\n)+/, ''))
  await add(page, 'Add a port').click()
  await page.keyboard.type('8080')
  expect(await yaml(page)).toContain('  ports:\n    - port: 8080\n')

  // A ConfigMap's key that is nothing.
  await dialog(page).getByRole('radio', { name: 'ConfigMap', exact: true }).click()
  await field(page, 'Name').fill('settings')
  const blank = await yaml(page)
  await type(page, blank.replace('\ndata:\n', '\ndata:\n  "": nothing\n'))
  await expect(
    said('An empty key can’t be a key: letters, digits, “-”, “_” and “.”.'),
  ).toBeVisible()
})

/** How far a sentence's bottom is above the bottom edge of the pane that scrolls it, in px. */
const clear = (said: Locator) =>
  said.evaluate((sentence) => {
    let pane = sentence.parentElement
    while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
    return pane!.getBoundingClientRect().bottom - sentence.getBoundingClientRect().bottom
  })
/** How far the form's pane has scrolled. */
const scrolled = (page: Page) => form(page).evaluate((pane) => pane.scrollTop)

test.describe('when the form’s pane moves by itself', () => {
  test('a sentence that appears cut by the pane’s edge comes clear, whatever has the focus', async ({
    launch,
  }) => {
    const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
    await openCluster(page)
    await page.keyboard.press('ControlOrMeta+n')
    await dialog(page).getByRole('radio', { name: 'Service', exact: true }).click()
    await field(page, 'Name').fill('web')
    await add(page, 'Add a label').click()
    await page.keyboard.type('app')
    await field(page, 'app’s value').fill('web')
    await field(page, 'Port 1').fill('80')
    // (With a mouse a port is one line at any width: its protocol beside its numbers.)
    await expect
      .poll(async () => {
        const [port, protocol] = [
          await field(page, 'Port 1').boundingBox(),
          await choice(page, 'Port 1’s protocol').boundingBox(),
        ]
        return port && protocol ? Math.abs(protocol.y - port.y) : NaN
      })
      .toBeLessThan(2)
    // A second port makes the first one's name wrong, while the focus is in the second.
    await add(page, 'Add a port').click()
    await page.keyboard.type('443')
    const wrong = form(page).getByRole('alert')
    await expect(wrong).toHaveText('With more than one port, each needs a name.')
    await expect.poll(() => clear(wrong)).toBeGreaterThanOrEqual(40)
    // And the field being typed in is still there to type in.
    await expect(field(page, 'Port 2')).toBeInViewport({ ratio: 1 })
    // The first port named, it's the second's name that's missing: the sentence is under that
    // one now, lower down, and comes clear again (the pane having just been moved to the field
    // typed in doesn't stop it: it waits for the pane to rest).
    await field(page, 'Port 1’s name').fill('http')
    await expect(wrong).toHaveText('With more than one port, each needs a name.')
    await expect.poll(() => clear(wrong)).toBeGreaterThanOrEqual(40)
  })

  test('never because the focus arrived; nor for a sentence wholly out of view', async ({
    launch,
  }) => {
    // A short window, so the pane is a few fields high.
    const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x560' }, fullLayout: false })
    await openCluster(page)
    await page.keyboard.press('ControlOrMeta+n')
    await dialog(page).getByRole('radio', { name: 'ConfigMap', exact: true }).click()
    await field(page, 'Name').fill('settings')
    // Nine keys, the last of them wrong: its sentence is under the last row, far below.
    const blank = await yaml(page)
    await type(
      page,
      blank.replace(
        '\ndata:\n',
        `\ndata:\n${Array.from({ length: 8 }, (_, i) => `  key${i + 1}: v\n`).join('')}  "not a key": v\n`,
      ),
    )
    const wrong = form(page).getByRole('alert')
    await expect(wrong).toHaveText(/not a key can’t be a key/)
    // It appeared wholly below the fold: nothing moved.
    await form(page).evaluate((pane) => pane.scrollTo(0, 0))
    expect(await scrolled(page)).toBe(0)
    await expect(wrong).not.toBeInViewport()
    // Tapping a field of that group moves nothing either: the field stays where it was tapped.
    await field(page, 'key1’s value').click()
    await expect(field(page, 'key1’s value')).toBeFocused()
    await page.waitForTimeout(300)
    expect(await scrolled(page)).toBe(0)
    await expect(field(page, 'key1’s value')).toBeInViewport({ ratio: 1 })
    // Typing in it changes no sentence, and moves nothing.
    await field(page, 'key1’s value').fill('changed')
    expect(await scrolled(page)).toBe(0)
  })

  test('the field being typed in stays whole: the move stops short for it', async ({ launch }) => {
    const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x560' }, fullLayout: false })
    await openCluster(page)
    await page.keyboard.press('ControlOrMeta+n')
    await dialog(page).getByRole('radio', { name: 'PersistentVolumeClaim', exact: true }).click()
    // The pane is put so the name's field is at its top edge; what's typed there is wrong, and
    // its sentence comes in under it.
    const name = field(page, 'Name')
    await name.fill('uploads')
    await name.evaluate((input) => input.scrollIntoView({ block: 'start' }))
    const before = await scrolled(page)
    await name.fill('Not A Name')
    await expect(form(page).getByRole('alert')).toBeVisible()
    await page.waitForTimeout(300)
    // Whatever it did for the sentence, the field and its label are still in view.
    await expect(name).toBeInViewport({ ratio: 1 })
    expect(await scrolled(page)).toBeLessThanOrEqual(before + 24)
  })
})

test('each of these kinds, new, asks for what it must have; and what a name may be', async ({
  page,
}) => {
  await open(page, 'Service')
  for (const [kind, empty] of [
    ['Service', 'Name and Port are still empty.'],
    ['ConfigMap', 'Name is still empty.'],
    ['Secret', 'Name is still empty.'],
    ['PersistentVolumeClaim', 'Name and Size are still empty.'],
  ] as const) {
    await dialog(page).getByRole('radio', { name: kind, exact: true }).click()
    // (Its own YAML first: two kinds ask for the same things in the same words.)
    await expect.poll(() => yaml(page), kind).toContain(`kind: ${kind}\n`)
    await expect(status(page), kind).toHaveText(empty)
    // Nothing wrong but what's empty, and nothing the form has no field for.
    await expect(form(page).getByRole('alert'), kind).toHaveCount(0)
    await expect(form(page), kind).not.toContainText('The YAML also sets')
    await expect(form(page), kind).not.toContainText('The form can’t show this YAML')
  }
  // Their names aren't a workload's: a Service's starts with a letter, the others may have dots.
  const SERVICE =
    'Lowercase letters, digits and “-”, starting with a letter and ending with a letter or digit, 63 at most.'
  const OTHER =
    'Lowercase letters, digits, “-” and “.”, starting and ending with a letter or digit.'
  for (const [kind, name, said] of [
    ['Service', '1web', SERVICE],
    ['Service', 'web.internal', SERVICE],
    ['Service', 'web', undefined],
    ['ConfigMap', '1web', undefined],
    ['ConfigMap', 'web.internal', undefined],
    ['ConfigMap', 'Web', OTHER],
    ['PersistentVolumeClaim', 'uploads_2', OTHER],
  ] as const) {
    await dialog(page).getByRole('radio', { name: kind, exact: true }).click()
    // (A name that's fine first, so each row is judged from nothing said.)
    await field(page, 'Name').fill('fine')
    await expect(form(page).getByRole('alert'), `${kind} fine`).toHaveCount(0)
    await field(page, 'Name').fill(name)
    if (said) await expect(form(page).getByRole('alert'), `${kind} ${name}`).toHaveText(said)
    else await expect(form(page).getByRole('alert'), `${kind} ${name}`).toHaveCount(0)
  }
})

test('a Secret’s values are hidden wherever one is written, or it isn’t hidden at all', async ({
  page,
}) => {
  await open(page, 'Secret')
  const show = dialog(page).getByRole('button', { name: 'Show values' })
  const hide = dialog(page).getByRole('button', { name: 'Hide values' })
  /** What's shown of `text` once its values are hidden. */
  const hidden = async (text: string) => {
    await show.click()
    await type(page, text)
    await expect(hide).toBeEnabled()
    await hide.click()
    await expect(show).toBeVisible()
    return yaml(page)
  }
  const text = `# A comment of the document's stays.
apiVersion: v1
kind: Secret
metadata:
  name: x # a note
data:
  # old: b2xk
  enc: aGVsbG8= # was b2xk
stringData:
  A: hunter2
  "k #1": "two #words"
  C: |
    # not a comment: a line of it
    lines
  D:
  E: { nested: deep }
  F: &f anchored
  #
# old-password: hunter1
---
kind: List
items:
  - kind: Secret
    stringData: {a: inner, c: also} # and this
  - kind: ConfigMap
    data: {shown: as-it-is} # and not this
`
  // Every value, and the words of every comment among them, which is where an old one is
  // left: in the Secret itself, and in one that's an item of a List.
  expect(await hidden(text)).toBe(`# A comment of the document's stays.
apiVersion: v1
kind: Secret
metadata:
  name: x # a note
data:
  # ${HIDDEN}
  enc: ${HIDDEN} # ${HIDDEN}
stringData:
  A: ${HIDDEN}
  "k #1": ${HIDDEN}
  C: ${HIDDEN}
  D:
  E: ${HIDDEN}
  F: &f ${HIDDEN}
  #
# ${HIDDEN}
---
kind: List
items:
  - kind: Secret
    stringData: {a: ${HIDDEN}, c: ${HIDDEN}} # ${HIDDEN}
  - kind: ConfigMap
    data: {shown: as-it-is} # and not this
`)
  // Something in place of its keys and values is hidden whole.
  expect(await hidden('kind: Secret\nstringData: just-this\n')).toBe(
    `kind: Secret\nstringData: ${HIDDEN}\n`,
  )
  // (An alias in what isn't a Secret is nobody's value: it's shown as it is.)
  const other = 'kind: ConfigMap\nx: &a 1\ndata: {a: *a}\n'
  expect(await hidden(other)).toBe(other)

  // What can't be read has no values to tell from the rest; nor has a Secret whose value is
  // written elsewhere and brought in (by an alias, as a whole map, through a merge key),
  // or that's a Secret by a kind or a key said elsewhere. None can be hidden: it stays shown,
  // and the button says why.
  await show.click()
  for (const elsewhere of [
    'kind: Secret\nstringData: [unclosed\n',
    'kind: Secret\nstringData:\n  a: b\n  a: c\n',
    'kind: Secret\nmetadata:\n  annotations: {k: &v S3CR3T}\nstringData: {a: *v}\n',
    'x: &d {a: S3CR3T}\nkind: Secret\nstringData: *d\n',
    'base: &b {a: S3CR3T}\nkind: Secret\nstringData:\n  <<: *b\n',
    'kind: Secret\nstringData:\n  a: {deep: [*v]}\nv: &v S3CR3T\n',
    'k: &k Secret\nkind: *k\nstringData: {a: S3CR3T}\n',
    'b: &b {kind: Secret}\n<<: *b\nstringData: {a: S3CR3T}\n',
    'b: &b {stringData: {a: S3CR3T}}\nkind: Secret\n<<: *b\n',
    'k: &k stringData\nkind: Secret\n*k :\n  a: S3CR3T\n',
    'k: &k kind\n*k : Secret\nstringData:\n  a: S3CR3T\n',
  ]) {
    // (One that can be hidden between each, so no row passes on the one before.)
    await type(page, 'kind: Secret\nstringData:\n  a: b\n')
    await expect(hide, elsewhere).toBeEnabled()
    await type(page, elsewhere)
    await expect(hide, elsewhere).toBeDisabled()
    // Why, in words on the page (a finger has no hover), and the button's own description.
    const why =
      'Its values can’t be told from the rest as it’s written, so they can’t be hidden: it isn’t YAML as it stands, or a value comes through an alias or a merge key.'
    await expect(dialog(page).getByText(why), elsewhere).toBeVisible()
    await expect(hide, elsewhere).toHaveAccessibleDescription(why)
    // The form's side says the same, and doesn't offer what's off.
    await expect(form(page), elsewhere).toContainText(
      'Values are showing on both sides and can’t be hidden as this YAML is written: why is said above the YAML.',
    )
    await expect(form(page), elsewhere).not.toContainText('hides them again')
  }
  // Read again as YAML whose values can be told, the reason is gone and it can be hidden.
  await type(page, 'kind: Secret\nstringData:\n  a: S3CR3T\n')
  await expect(hide).toBeEnabled()
  await expect(dialog(page).getByText('so they can’t be hidden')).toHaveCount(0)
})

test('a Secret copied out of a cluster, and one written inside another, are hidden whole', async ({
  page,
}) => {
  await open(page, 'Secret')
  const show = dialog(page).getByRole('button', { name: 'Show values' })
  const hide = dialog(page).getByRole('button', { name: 'Hide values' })
  const hidden = async (text: string) => {
    await show.click()
    await type(page, text)
    await expect(hide).toBeEnabled()
    await hide.click()
    await expect(show).toBeVisible()
    return yaml(page)
  }
  // As `kubectl get secret -o yaml` prints one that was applied: an annotation holds the
  // whole Secret again, its values with it. Hidden, that goes too.
  const applied = `apiVersion: v1
kind: Secret
metadata:
  name: api
  annotations:
    team: checkout
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"v1","kind":"Secret","metadata":{"name":"api"},"stringData":{"token":"S3CR3T"}}
data:
  token: UzNDUjNU
`
  const shown = await hidden(applied)
  expect(shown).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: api
  annotations:
    team: checkout
    kubectl.kubernetes.io/last-applied-configuration: ${HIDDEN}
data:
  token: ${HIDDEN}
`)
  expect(shown).not.toContain('S3CR3T')
  expect(shown).not.toContain('UzNDUjNU')
  // Written on one line, quoted, it goes as well.
  expect(
    await hidden(
      `kind: Secret\nmetadata:\n  annotations: {kubectl.kubernetes.io/last-applied-configuration: '{"stringData":{"a":"S3CR3T"}}'}\nstringData: {a: S3CR3T}\n`,
    ),
  ).not.toContain('S3CR3T')
  // In anything that isn't a Secret the annotation is that kind's own business.
  const other = `kind: ConfigMap\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"a":"b"}}'\ndata:\n  a: b\n`
  expect(await hidden(other)).toBe(other)

  // The annotation with nothing in it has nothing to hide; a merge of things that are no
  // Secret's (a list of them, one written in place) is still a Secret that can be hidden.
  expect(
    await hidden(
      'kind: Secret\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration:\nstringData:\n  a: S3CR3T\n',
    ),
  ).not.toContain('S3CR3T')
  expect(
    await hidden(
      'a: &a {x: 1}\nkind: Secret\nmetadata:\n  labels:\n    <<: [*a, {y: 2}]\nstringData:\n  k: S3CR3T\n',
    ),
  ).not.toContain('S3CR3T')
  // (A key that's an alias, in what isn't a Secret, is that kind's own business too.)
  const keyed = 'k: &k x\nkind: ConfigMap\n*k : y\ndata:\n  a: b\n'
  expect(await hidden(keyed)).toBe(keyed)

  // A Secret written inside a Secret is one too, wherever in it.
  const nested = await hidden(
    'kind: Secret\nstringData:\n  a: OUTER\nitems:\n  - kind: Secret\n    stringData:\n      b: INNER\n',
  )
  expect(nested).not.toContain('OUTER')
  expect(nested).not.toContain('INNER')
  expect(nested).toContain(`      b: ${HIDDEN}`)

  // Annotations written elsewhere and brought in can't be read here for that annotation:
  // such a Secret can't be hidden, and says so.
  await show.click()
  for (const elsewhere of [
    'x: &a {kubectl.kubernetes.io/last-applied-configuration: S3CR3T}\nkind: Secret\nmetadata:\n  annotations: *a\nstringData: {a: b}\n',
    'x: &m {annotations: {kubectl.kubernetes.io/last-applied-configuration: S3CR3T}}\nkind: Secret\nmetadata: *m\nstringData: {a: b}\n',
    'x: &a {kubectl.kubernetes.io/last-applied-configuration: S3CR3T}\nkind: Secret\nmetadata:\n  annotations:\n    <<: *a\nstringData: {a: b}\n',
    'x: &v S3CR3T\nkind: Secret\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: *v\nstringData: {a: b}\n',
  ]) {
    await type(page, 'kind: Secret\nstringData:\n  a: b\n')
    await expect(hide, elsewhere).toBeEnabled()
    await expect(dialog(page).getByText('so they can’t be hidden'), elsewhere).toHaveCount(0)
    await type(page, elsewhere)
    await expect(hide, elsewhere).toBeDisabled()
    await expect(dialog(page).getByText('so they can’t be hidden'), elsewhere).toBeVisible()
  }
})
