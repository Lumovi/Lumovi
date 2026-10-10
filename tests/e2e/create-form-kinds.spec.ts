/**
 * Create's form for the kinds that run nothing: a Service (its type, the pods it sends to,
 * its ports), a ConfigMap (keys and values of several lines), a Secret (its values hidden on
 * both sides until they're asked for) and a PersistentVolumeClaim.
 */
import type { Page } from '@playwright/test'
import {
  check,
  FORM_KINDS,
  HIDDEN,
  masked,
  read,
  unowned,
  unquoted,
} from '../../src/renderer/src/lib/create-form.ts'
import { pathText } from '../../src/renderer/src/lib/yaml-edit.ts'
import { dialog, toasts, writes } from './action-helpers.ts'
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
  await page.keyboard.type('LOG_LEVEL')
  await expect(field(page, 'Key 1')).toHaveValue('LOG_LEVEL')
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

  // YAML that doesn't parse can't have its values told from the rest: it stays shown until
  // it's YAML again.
  await show.click()
  const whole = await yaml(page)
  await type(page, whole.replace('stringData:', 'stringData: [unclosed'))
  await expect(hide).toBeDisabled()
  await type(page, whole)
  await expect(hide).toBeEnabled()
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
  const results = dialog(page).getByRole('list', { name: 'Results' })
  await expect(results).toContainText(`"${HIDDEN}" already exists`)
  await expect(results).not.toContainText('"registry-pull" already exists')
  // Shown, it's as the cluster said it.
  await dialog(page).getByRole('button', { name: 'Show values' }).click()
  await expect(results).toContainText('"registry-pull" already exists')
  // Another kind after it starts hidden again.
  await dialog(page).getByRole('radio', { name: 'ConfigMap', exact: true }).click()
  await dialog(page).getByRole('radio', { name: 'Secret', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Show values' })).toBeVisible()
  await expect(editor(page)).toHaveAttribute('aria-readonly', 'true')
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

// ——— Asked directly ———

test('each of these kinds, new, fits its form and asks for what it must have', () => {
  for (const [kind, empty] of [
    ['Service', ['Name', 'Port']],
    ['ConfigMap', ['Name']],
    ['Secret', ['Name']],
    ['PersistentVolumeClaim', ['Name', 'Size']],
  ] as const) {
    const form = FORM_KINDS[kind]
    const reading = read(form.blank('shop'), form)
    expect(reading.fits, kind).toBe(true)
    if (!reading.fits) continue
    expect(unowned(reading.object, form).map(pathText), kind).toEqual([])
    expect(check(reading.object, form), kind).toEqual({ missing: empty, problems: [] })
  }
  // Their names aren't a workload's: a Service's starts with a letter, the others may have dots.
  const named = (kind: 'Service' | 'ConfigMap', name: string) => {
    const form = FORM_KINDS[kind]
    const reading = read(form.blank('shop').replace('name:', `name: ${name}`), form)
    return reading.fits ? check(reading.object, form).problems.map((problem) => problem.field) : []
  }
  expect(named('Service', '"1web"')).toEqual(['name'])
  expect(named('Service', 'web.internal')).toEqual(['name'])
  expect(named('ConfigMap', '"1web"')).toEqual([])
  expect(named('ConfigMap', 'web.internal')).toEqual([])
  expect(named('ConfigMap', 'Web')).toEqual(['name'])
})

test('a Secret’s values are hidden wherever one is written, or nothing is shown', () => {
  const text = `apiVersion: v1
kind: Secret
metadata:
  name: x # a note
data:
  enc: aGVsbG8=
stringData:
  A: hunter2 # kept
  B: "two words"
  C: |
    several
    lines
  D:
  E: { nested: deep }
  F: &f anchored
  G: *f
---
kind: List
items:
  - kind: Secret
    stringData: {a: inner, c: also}
  - kind: ConfigMap
    data: {shown: as-it-is}
`
  expect(masked(text)).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: x # a note
data:
  enc: ${HIDDEN}
stringData:
  A: ${HIDDEN} # kept
  B: ${HIDDEN}
  C: ${HIDDEN}
  D:
  E: ${HIDDEN}
  F: &f ${HIDDEN}
  G: ${HIDDEN}
---
kind: List
items:
  - kind: Secret
    stringData: {a: ${HIDDEN}, c: ${HIDDEN}}
  - kind: ConfigMap
    data: {shown: as-it-is}
`)
  // Something in place of its keys and values is hidden whole.
  expect(masked('kind: Secret\nstringData: just-this\n')).toBe(
    `kind: Secret\nstringData: ${HIDDEN}\n`,
  )
  // What can't be read has no values to tell from the rest: there's no text to show.
  expect(masked('kind: Secret\nstringData: [unclosed\n')).toBeNull()
  expect(masked('kind: Secret\nstringData:\n  a: b\n  a: c\n')).toBeNull()
  // What the cluster says has none of them in it: as written, or as read.
  expect(unquoted('Invalid value: "hunter2", and two words, and "two words"', text)).toBe(
    `Invalid value: "${HIDDEN}", and ${HIDDEN}, and ${HIDDEN}`,
  )
  expect(unquoted('nothing of it here', text)).toBe('nothing of it here')
  expect(unquoted('Invalid value: "x"', 'kind: Secret\nstringData: [unclosed\n')).toBe(
    'The cluster refused it. Show values to read what it said.',
  )
})
