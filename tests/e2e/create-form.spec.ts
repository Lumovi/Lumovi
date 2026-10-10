/**
 * Create's form: a Deployment's fields beside the YAML they write, either side edited and the
 * two in step; what the form says of YAML it has no field for, or can't show; what's wrong
 * with a field, as it's typed and as the cluster says; and creating.
 */
import type { Page } from '@playwright/test'
import {
  DEPLOYMENT,
  problems,
  read,
  refusals,
  unowned,
  workloadValues,
  writer,
} from '../../src/renderer/src/lib/create-form.ts'
import { pathText } from '../../src/renderer/src/lib/yaml-edit.ts'
import { dialog, toasts, writes, yamlSide } from './action-helpers.ts'
import { expect, openCluster, panel, test } from './fixtures.ts'

const form = (page: Page) => dialog(page).getByRole('group', { name: 'Form', exact: true })
const field = (page: Page, name: string) => form(page).getByRole('textbox', { name, exact: true })
const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const status = (page: Page) => dialog(page).getByRole('status')
const create = (page: Page) => dialog(page).getByRole('button', { name: 'Create', exact: true })
/** The YAML's lines set apart: lit by the field in focus, marked wrong, or shaded. */
const lines = (page: Page, how: 'lit' | 'wrong' | 'shaded') =>
  dialog(page).locator(`.cm-line-${how}`)
/** The editor's whole text. */
const yaml = (page: Page) =>
  editor(page).evaluate((content) =>
    [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
  )

async function open(page: Page, namespace?: string) {
  await openCluster(page)
  if (namespace) {
    await page.getByRole('button', { name: 'Namespace' }).click()
    await page.getByRole('option', { name: namespace }).click()
  }
  await page.keyboard.press('ControlOrMeta+n')
  await expect(dialog(page).getByRole('heading', { name: 'Create', exact: true })).toBeVisible()
}

/** Replaces the editor's text with `text`. */
async function type(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

const WEB = `apiVersion: apps/v1
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
          image: ghcr.io/acme/web:2.4.1
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
          resources:
            requests:
              cpu: 250m
              memory: 128Mi
            limits:
              memory: 256Mi`

test('the form, new: what it asks, the YAML it writes, and creating from it', async ({
  page,
  clusters,
}) => {
  await open(page, 'shop')
  // The form opens first, on its first field; the header says only the cluster.
  await expect(dialog(page).getByRole('radio', { name: 'Form' })).toBeChecked()
  await expect(dialog(page)).toContainText('On demo')
  await expect(dialog(page).getByRole('radio', { name: 'Deployment' })).toBeChecked()
  await expect(field(page, 'Name')).toBeFocused()
  // What must be said is empty, with its key in the YAML and nothing after it.
  expect(await yaml(page)).toBe(`apiVersion: apps/v1
kind: Deployment
metadata:
  name:
  namespace: shop
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
`)
  await expect(status(page)).toHaveText('Name and Image are still empty.')
  await expect(create(page)).toBeDisabled()
  await expect(form(page).getByRole('combobox', { name: 'Namespace' })).toHaveValue('shop')
  // Each field names the path it writes.
  for (const path of [
    'metadata.name',
    'metadata.namespace',
    'spec.replicas',
    'spec.template.spec.containers[0]',
    '.image',
    '.ports[0].containerPort',
    '.env',
    '.resources',
  ]) {
    await expect(form(page).getByText(path, { exact: true })).toBeVisible()
  }

  // The name is the container's and the app label's too: its field lights all four lines.
  await page.keyboard.type('web')
  await expect(lines(page, 'lit')).toHaveText([
    '  name: web',
    '      app: web',
    '        app: web',
    '        - name: web',
  ])
  await expect(status(page)).toHaveText('Image is still empty.')
  await expect(form(page)).toContainText('Labelled app=web')
  // By the keyboard alone from here: the namespace, the replicas, the image.
  await page.keyboard.press('Tab')
  await expect(form(page).getByRole('combobox', { name: 'Namespace' })).toBeFocused()
  await expect(lines(page, 'lit')).toHaveText(['  namespace: shop'])
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(field(page, 'Replicas')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(lines(page, 'lit')).toHaveText(['  replicas: 2'])
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(field(page, 'Image')).toBeFocused()
  await page.keyboard.type('ghcr.io/acme/web:2.4.1')
  await expect(lines(page, 'lit')).toHaveText(['          image: ghcr.io/acme/web:2.4.1'])
  await expect(status(page)).toHaveText('Edit either side: they stay in step.')
  await expect(create(page)).toBeEnabled()
  // The port, a variable and the amounts, each written where it belongs.
  await page.keyboard.press('Tab')
  await page.keyboard.type('8080')
  await form(page).getByRole('button', { name: 'Add a variable' }).click()
  await page.keyboard.type('LOG_LEVEL')
  await field(page, 'LOG_LEVEL’s value').fill('info')
  await form(page).getByRole('button', { name: 'Set them' }).click()
  await field(page, 'CPU request').fill('250m')
  await field(page, 'Memory request').fill('128Mi')
  await field(page, 'Memory limit').fill('256Mi')
  expect(await yaml(page)).toBe(`${WEB}\n`)
  await expect(dialog(page)).toContainText('kubectl create -f objects.yaml -n shop --context demo')

  // Enter creates: checked by the cluster first, as YAML's side does.
  await field(page, 'Image').press('Enter')
  await expect(toasts(page)).toContainText('Created deployment web')
  await expect(dialog(page)).toHaveCount(0)
  const posts = writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/shop/deployments')
  expect(posts.map((post) => post.query.dryRun)).toEqual(['All', undefined])
  expect(posts[1]!.body).toMatchObject({
    metadata: { name: 'web', namespace: 'shop' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'web' } },
      template: {
        metadata: { labels: { app: 'web' } },
        spec: {
          containers: [
            {
              name: 'web',
              image: 'ghcr.io/acme/web:2.4.1',
              ports: [{ containerPort: 8080 }],
              env: [{ name: 'LOG_LEVEL', value: 'info' }],
              resources: {
                requests: { cpu: '250m', memory: '128Mi' },
                limits: { memory: '256Mi' },
              },
            },
          ],
        },
      },
    },
  })
  await toasts(page).getByRole('button', { name: 'Open' }).click()
  await expect(panel(page, 'Deployment', 'web')).toBeVisible()
})

test('either side is edited, and the other follows', async ({ page }) => {
  await open(page, 'shop')
  await type(page, WEB)
  // The form reads what was typed in the YAML.
  await expect(field(page, 'Name')).toHaveValue('web')
  await expect(field(page, 'Replicas')).toHaveValue('2')
  await expect(field(page, 'Image')).toHaveValue('ghcr.io/acme/web:2.4.1')
  await expect(field(page, 'Port')).toHaveValue('8080')
  await expect(field(page, 'Variable 1’s name')).toHaveValue('LOG_LEVEL')
  await expect(field(page, 'LOG_LEVEL’s value')).toHaveValue('info')
  await expect(field(page, 'CPU request')).toHaveValue('250m')
  await expect(field(page, 'CPU limit')).toHaveValue('')
  await expect(field(page, 'Memory limit')).toHaveValue('256Mi')
  // A line changed there changes its field here.
  await editor(page).getByText('replicas: 2').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('5')
  await expect(field(page, 'Replicas')).toHaveValue('5')
  // A name of its own for the container, by hand: the form's name no longer writes it.
  await editor(page).getByText('- name: web').click()
  await page.keyboard.press('End')
  await page.keyboard.type('-main')
  await field(page, 'Name').fill('storefront')
  expect(await yaml(page)).toContain('  name: storefront\n')
  expect(await yaml(page)).toContain('      app: storefront\n')
  expect(await yaml(page)).toContain('        - name: web-main\n')
  await expect(lines(page, 'lit')).toHaveText([
    '  name: storefront',
    '      app: storefront',
    '        app: storefront',
  ])
  // Emptied, a field leaves its key with nothing; and what's optional goes, with what held it.
  await field(page, 'Port').fill('')
  await form(page).getByRole('button', { name: 'Remove LOG_LEVEL' }).click()
  await field(page, 'CPU request').fill('')
  await field(page, 'Memory request').fill('')
  const text = await yaml(page)
  expect(text).not.toMatch(/ports:|env:|requests:/)
  expect(text).toContain('          resources:\n            limits:\n              memory: 256Mi')
  await field(page, 'Image').fill('')
  expect(await yaml(page)).toContain('          image:\n')
  await expect(status(page)).toHaveText('Image is still empty.')
  // The comments and the order of whoever wrote the YAML are theirs, whatever the form edits.
  await type(
    page,
    `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: web
spec:
  replicas: 2 # two for now
  selector: { matchLabels: { app: web } }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - image: "nginx:1.27"   # pinned
          name: web
`,
  )
  await field(page, 'Replicas').fill('3')
  await field(page, 'Image').fill('nginx:1.28')
  await field(page, 'Port').fill('80')
  expect(await yaml(page)).toBe(`# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: web
spec:
  replicas: 3 # two for now
  selector: { matchLabels: { app: web } }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - image: nginx:1.28   # pinned
          name: web
          ports:
            - containerPort: 80
`)
})

test('a field in error is said under it as it’s typed, with its lines marked', async ({ page }) => {
  await open(page, 'shop')
  await type(page, WEB)
  await field(page, 'Name').fill('Web_API')
  await expect(form(page).getByRole('alert')).toHaveText(
    'Lowercase letters, digits and “-”, starting and ending with a letter or digit. The container takes the same name.',
  )
  await expect(field(page, 'Name')).toHaveAttribute('aria-invalid', 'true')
  // Where it's a name: the object's and its container's. Its app labels took it too, and
  // what can't be a name can still be a label's value: those lines aren't wrong.
  await expect(lines(page, 'wrong')).toHaveText(['  name: Web_API', '        - name: Web_API'])
  expect(await yaml(page)).toContain('      app: Web_API\n')
  await expect(status(page)).toHaveText('1 field to fix before it can be created.')
  await expect(create(page)).toBeDisabled()
  // Enter creates nothing either.
  await field(page, 'Name').press('Enter')
  await expect(dialog(page)).toBeVisible()
  await field(page, 'Name').fill('web')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(lines(page, 'wrong')).toHaveCount(0)

  // The others, each in its own words.
  for (const [name, typed, message] of [
    ['Port', '80800', 'A port is a number from 1 to 65535.'],
    ['Image', 'nginx 1.27', 'An image’s name has no spaces in it.'],
    [
      'Memory request',
      '128MB',
      'The memory request isn’t an amount Kubernetes reads: like 128Mi or 1Gi.',
    ],
    [
      'Variable 1’s name',
      '2FAST',
      '2FAST can’t be a variable’s name: letters, digits, “_”, “-” and “.”, not starting with a digit.',
    ],
  ] as const) {
    const before = await field(page, name).inputValue()
    await field(page, name).fill(typed)
    await expect(form(page).getByRole('alert'), name).toHaveText(message)
    await expect(create(page), name).toBeDisabled()
    await field(page, name).fill(before)
    await expect(form(page).getByRole('alert'), name).toHaveCount(0)
  }
  // Typed in the YAML, it's said the same.
  await editor(page).getByText('replicas: 2').click()
  await page.keyboard.press('End')
  await page.keyboard.type('x')
  await expect(form(page).getByRole('alert')).toHaveText('A whole number, 0 or more.')
  await expect(lines(page, 'wrong')).toHaveText(['  replicas: 2x'])
  await expect(field(page, 'Replicas')).toHaveValue('2x')
})

test('what the YAML sets that the form has no field for is kept, and said', async ({ page }) => {
  await open(page, 'shop')
  await type(
    page,
    WEB.replace('  selector:', '  strategy:\n    type: Recreate\n  selector:')
      .replace(
        '    spec:\n      containers:',
        '    spec:\n      nodeSelector:\n        pool: general\n      containers:',
      )
      .replace(
        '              value: info',
        `              value: info
            - name: API_KEY
              valueFrom:
                secretKeyRef:
                  name: payments
                  key: api-key
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          envFrom:
            - configMapRef:
                name: web-settings`,
      ),
  )
  const note = form(page).getByText(/^The YAML also sets/)
  await expect(note).toHaveText(
    'The YAML also sets spec.strategy, spec.template.spec.nodeSelector and spec.template.spec.containers[0].envFrom. The form has no field for them, and keeps them as they are.',
  )
  await expect(lines(page, 'shaded')).toHaveText([
    '  strategy:',
    '    type: Recreate',
    '      nodeSelector:',
    '        pool: general',
    '          envFrom:',
    '            - configMapRef:',
    '                name: web-settings',
  ])
  // A variable whose value comes from elsewhere has its row, which says where from: its
  // name can be changed and it can be removed, and its value isn't typed over here.
  await expect(field(page, 'Variable 2’s name')).toHaveValue('API_KEY')
  await expect(form(page).getByLabel('API_KEY’s value')).toHaveText(
    'from Secret payments, key api-key',
  )
  await expect(form(page).getByLabel('POD_IP’s value')).toHaveText(
    'from the pod’s field status.podIP',
  )
  await expect(form(page).getByRole('textbox', { name: 'API_KEY’s value' })).toHaveCount(0)
  // The form still edits what it has fields for, and what it hasn't stays as it was.
  await field(page, 'Replicas').fill('4')
  await field(page, 'Variable 2’s name').fill('PAYMENTS_KEY')
  await form(page).getByRole('button', { name: 'Remove POD_IP' }).click()
  const text = await yaml(page)
  expect(text).toContain('  replicas: 4\n  strategy:\n    type: Recreate\n')
  expect(text).toContain('      nodeSelector:\n        pool: general\n')
  expect(text).toContain(
    '            - name: PAYMENTS_KEY\n              valueFrom:\n                secretKeyRef:\n                  name: payments\n                  key: api-key\n          envFrom:',
  )
  expect(text).not.toContain('POD_IP')
  await expect(create(page)).toBeEnabled()
  // One thing only: said of one.
  await type(page, WEB.replace('  selector:', '  paused: true\n  selector:'))
  await expect(note).toHaveText(
    'The YAML also sets spec.paused. The form has no field for it, and keeps it as it is.',
  )
})

test('YAML the form can’t show: it steps back, says why, and can go back', async ({
  page,
  clusters,
}) => {
  await open(page, 'shop')
  await type(page, WEB)
  await field(page, 'Replicas').fill('3')
  const fitted = await yaml(page)
  const stepped = form(page).getByText('The form can’t show this YAML')
  const back = form(page).getByRole('button', { name: 'Go back to the form’s version' })
  const TWO = `${fitted.trimEnd()}
        - name: metrics
          image: ghcr.io/acme/metrics-sidecar:0.9.2
`
  for (const [text, why, shaded] of [
    [
      TWO,
      'It has two containers, and the form edits one.',
      ['        - name: metrics', '          image: ghcr.io/acme/metrics-sidecar:0.9.2'],
    ],
    [
      `${fitted.trimEnd()}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n`,
      'It has two objects, and the form edits one.',
      [],
    ],
    [
      fitted.replace('kind: Deployment', 'kind: DaemonSet'),
      'It’s a DaemonSet, and this is the form for a Deployment.',
      ['kind: DaemonSet'],
    ],
    [
      fitted.replace('  name: web\n', '  name: [web\n'),
      /It isn’t YAML as it stands: .+ at line 5, column \d+\. The YAML is what gets created/,
      null,
    ],
    [
      fitted.replace('  replicas: 3', '  replicas: &n 3'),
      'spec.replicas is anchored, to be repeated elsewhere in the YAML, so the form can’t edit it alone.',
      ['  replicas: &n 3'],
    ],
    [
      fitted.replace(
        '          image: ghcr.io/acme/web:2.4.1',
        '          image: { from: elsewhere }',
      ),
      'spec.template.spec.containers[0].image holds more than one value, and the form’s field there takes one.',
      null,
    ],
  ] as const) {
    await type(page, text)
    await expect(stepped, String(why)).toBeVisible()
    const said = form(page)
      .locator('div')
      .filter({ hasText: 'The form can’t show this YAML' })
      .last()
    if (typeof why === 'string') {
      await expect(said, why).toContainText(
        `${why} The YAML is what gets created; go on editing it there. Below is the form as it last was.`,
      )
    } else await expect(said).toContainText(why)
    if (shaded) await expect(lines(page, 'shaded'), String(why)).toHaveText([...shaded])
    await expect(status(page)).toHaveText('Edited by hand. This is what gets created.')
    // The form is as it last was, and isn't typed in.
    await expect(field(page, 'Replicas')).toHaveValue('3')
    await expect(field(page, 'Replicas')).toBeDisabled()
    await expect(field(page, 'Name')).toBeDisabled()
    // One button, and the YAML is the form's last again.
    await back.click()
    await expect(stepped).toHaveCount(0)
    expect(await yaml(page)).toBe(fitted)
    await expect(field(page, 'Replicas')).toBeEnabled()
  }
  // Put right by hand, the form is back by itself.
  await type(page, TWO)
  await expect(stepped).toBeVisible()
  await editor(page).getByText('- name: metrics').click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Backspace')
  await expect(stepped).toHaveCount(0)
  await expect(field(page, 'Replicas')).toBeEnabled()

  // Stepped back, the YAML is what's created: two containers and all.
  await type(page, TWO)
  await expect(create(page)).toBeEnabled()
  await create(page).click()
  await expect(toasts(page)).toContainText('Created deployment web')
  expect(
    writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/shop/deployments').at(-1)!.body.spec
      .template.spec.containers,
  ).toHaveLength(2)
})

test('an edit the form can’t make in the YAML as it’s written isn’t made, and it says so', async ({
  page,
}) => {
  await open(page, 'shop')
  // The container's resources are an alias of an empty map written elsewhere: there's no
  // place of its own for an amount to go.
  const aliased = `x-none: &none {}\n${WEB.slice(0, WEB.indexOf('          resources:'))}          resources: *none\n`
  await type(page, aliased)
  await expect(field(page, 'Name')).toHaveValue('web')
  await form(page).getByRole('button', { name: 'Set them' }).click()
  await field(page, 'CPU request').fill('250m')
  // Nothing of the YAML changed, and the form steps back as it does for YAML it can't show.
  expect(await yaml(page)).toBe(aliased)
  await expect(form(page)).toContainText(
    'The form can’t show this YAMLA field’s edit would have rewritten more of this YAML than its own lines, the way it’s written, so it wasn’t made. The YAML is what gets created; go on editing it there.',
  )
  await expect(field(page, 'Name')).toBeDisabled()
  await expect(create(page)).toBeEnabled()
  // Back to the form, or on with the YAML: either way it's over.
  await form(page).getByRole('button', { name: 'Go back to the form’s version' }).click()
  await expect(field(page, 'Name')).toBeEnabled()
  expect(await yaml(page)).toBe(aliased)
})

test('the cluster’s refusal is in the results, and under the field it names', async ({
  page,
  clusters,
}) => {
  await open(page, 'shop')
  await type(page, WEB.replace('memory: 128Mi', 'memory: 512Mi'))
  await create(page).click()
  // Nothing was made: the cluster checked it first.
  const results = dialog(page).getByRole('list', { name: 'Results' })
  await expect(results).toHaveText(
    'Deployment/webDeployment.apps "web" is invalid: spec.template.spec.containers[0].resources.requests: Invalid value: "512Mi": must be less than or equal to memory limit of 256Mi',
  )
  await expect(status(page)).toHaveText('Nothing was created.')
  expect(
    writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/shop/deployments').map(
      (post) => post.query.dryRun,
    ),
  ).toEqual(['All'])
  // Under the field the cluster names (it names the requests), with their lines marked.
  await expect(form(page).getByRole('alert')).toHaveText(
    'The cluster refused it: Invalid value: "512Mi": must be less than or equal to memory limit of 256Mi',
  )
  await expect(field(page, 'Memory request')).toHaveClass(/border-critical/)
  await expect(field(page, 'CPU request')).toHaveClass(/border-critical/)
  await expect(field(page, 'Memory limit')).not.toHaveClass(/border-critical/)
  await expect(lines(page, 'wrong')).toHaveText([
    '            requests:',
    '              cpu: 250m',
    '              memory: 512Mi',
  ])
  // It can be tried again as it is; changed, what the cluster said of the old one goes.
  await expect(create(page)).toBeEnabled()
  await field(page, 'Memory request').fill('128Mi')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(results).toHaveCount(0)
  await expect(lines(page, 'wrong')).toHaveCount(0)

  // A refusal that names no field (an admission webhook's) is in the results alone.
  clusters.demo.fail('/apis/apps/v1/namespaces/shop/deployments', {
    status: 403,
    body: JSON.stringify({
      kind: 'Status',
      status: 'Failure',
      message:
        'admission webhook "policy.example.com" denied the request: images must come from ghcr.io/acme',
      reason: 'Forbidden',
      code: 403,
    }),
  })
  await create(page).click()
  await expect(results).toContainText('images must come from ghcr.io/acme')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(lines(page, 'wrong')).toHaveCount(0)
})

test('the namespace is the form’s to say; the side used last opens first', async ({ page }) => {
  // With All namespaces in the header, it starts at default and says so.
  await open(page)
  const namespace = form(page).getByRole('combobox', { name: 'Namespace' })
  await expect(namespace).toHaveValue('default')
  await expect(form(page)).toContainText(
    'No namespace is chosen in the header, so it starts at default. Choose another here.',
  )
  await expect(dialog(page)).toContainText(
    'kubectl create -f objects.yaml -n default --context demo',
  )
  await namespace.focus()
  await namespace.selectOption('shop')
  await expect(lines(page, 'lit')).toHaveText(['  namespace: shop'])
  await expect(form(page)).not.toContainText('No namespace is chosen in the header')
  await expect(dialog(page)).toContainText('kubectl create -f objects.yaml -n shop --context demo')
  // One the cluster doesn't have, typed in the YAML, is offered as it is.
  await editor(page).getByText('namespace: shop').click()
  await page.keyboard.press('End')
  await page.keyboard.type('-next')
  await expect(namespace).toHaveValue('shop-next')

  // YAML's side is today's dialog, with the switch; the arrows choose between the two.
  await dialog(page).getByRole('radio', { name: 'Form' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog(page).getByRole('radio', { name: 'YAML' })).toBeChecked()
  await expect(dialog(page).getByRole('radio', { name: 'YAML' })).toBeFocused()
  await expect(dialog(page).getByRole('group', { name: 'Templates' })).toBeVisible()
  await expect(dialog(page)).toContainText('New objects go to default unless they name a namespace')
  await expect(form(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('image: nginx:1.27')
  // It's the side that opens next time.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+n')
  await expect(dialog(page).getByRole('radio', { name: 'YAML' })).toBeChecked()
  await dialog(page).getByRole('radio', { name: 'Form' }).click()
  await expect(field(page, 'Name')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+n')
  await expect(dialog(page).getByRole('radio', { name: 'Form' })).toBeChecked()
  await yamlSide(page)
  await expect(dialog(page).getByRole('group', { name: 'Templates' })).toBeVisible()
})

test('creating from the form is off on read-only clusters', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_READ_ONLY: '1' } })
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  await type(page, WEB)
  await expect(dialog(page).getByRole('alert')).toContainText(
    'Changes are turned off for this cluster.',
  )
  await expect(create(page)).toBeDisabled()
})

// ——— The form's reading of the YAML, asked of it directly ———

const fitted = (text: string) => {
  const reading = read(text, DEPLOYMENT)
  if (!reading.fits) throw new Error(reading.why)
  return reading.object
}

test('what the form owns, and what it doesn’t', () => {
  const object = fitted(
    `${WEB}
            - name: metrics
          command: [sh]
      initContainers:
        - name: init
          image: busybox
  minReadySeconds: 5
status: {}
`
      .replace('            - name: metrics\n', '')
      .replace('metadata:\n  name: web', 'metadata:\n  labels:\n    tier: web\n  name: web'),
  )
  expect(unowned(object, DEPLOYMENT).map(pathText)).toEqual([
    'metadata.labels',
    'spec.template.spec.containers[0].command',
    'spec.template.spec.initContainers',
    'spec.minReadySeconds',
    'status',
  ])
  // Nothing more than the form writes: nothing to say.
  expect(unowned(fitted(WEB), DEPLOYMENT)).toEqual([])
  expect(unowned(fitted(DEPLOYMENT.blank('shop')), DEPLOYMENT)).toEqual([])
  // A second port, or a port's name, isn't the field's.
  const ports = fitted(
    WEB.replace(
      '            - containerPort: 8080',
      '            - containerPort: 8080\n              name: http\n            - containerPort: 9090',
    ),
  )
  expect(unowned(ports, DEPLOYMENT).map(pathText)).toEqual([
    'spec.template.spec.containers[0].ports[0].name',
    'spec.template.spec.containers[0].ports[1]',
  ])
})

test('what’s wrong with what’s typed, and what the cluster’s causes are about', () => {
  const values = workloadValues(fitted(WEB), DEPLOYMENT)
  expect(problems(values, DEPLOYMENT)).toEqual([])
  expect(
    problems(
      {
        ...values,
        name: 'a'.repeat(64),
        namespace: 'Shop',
        replicas: '-1',
        port: '0',
        env: [
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
          { name: '', value: 'x' },
        ],
        resources: { ...values.resources, cpuLimit: 'lots' },
      },
      DEPLOYMENT,
    ).map((problem) => `${problem.field}: ${problem.message}`),
  ).toEqual([
    'name: At most 63 characters: the container and the app label take the same name.',
    'namespace: A namespace’s name: lowercase letters, digits and “-”.',
    'replicas: A whole number, 0 or more.',
    'port: A port is a number from 1 to 65535.',
    'env: A is set twice: the last one wins.',
    'env: A variable needs a name.',
    'resources: The CPU limit isn’t an amount Kubernetes reads: like 250m or 0.5.',
  ])
  // The API names a field, or its parent; one the form has no field for is nobody's.
  expect(
    refusals(
      [
        { field: 'spec.template.spec.containers[0].image', message: 'Required value' },
        { field: 'spec.template.spec.containers[0].resources.requests', message: 'too much' },
        { field: 'metadata.name', message: 'bad' },
        { field: 'spec.template.spec.containers[0].env[1].name', message: 'odd' },
        { field: 'spec.strategy.type', message: 'Unsupported value' },
        { message: 'no field at all' },
      ],
      DEPLOYMENT,
    ).map((refusal) => `${refusal.field} ${pathText(refusal.path)}: ${refusal.message}`),
  ).toEqual([
    'image spec.template.spec.containers[0].image: The cluster refused it: Required value',
    'resources spec.template.spec.containers[0].resources.requests: The cluster refused it: too much',
    'name metadata.name: The cluster refused it: bad',
    'env spec.template.spec.containers[0].env[1].name: The cluster refused it: odd',
  ])
  expect(refusals(undefined, DEPLOYMENT)).toEqual([])
})

test('the name takes with it only what was the name', () => {
  const object = fitted(WEB)
  const renamed = writer(DEPLOYMENT).name(WEB, object, 'api')
  expect(renamed).toBe(WEB.replaceAll(': web\n', ': api\n'))
  // A label of its own is left alone.
  const own = WEB.replace('      labels:\n        app: web', '      labels:\n        app: frontend')
  expect(writer(DEPLOYMENT).name(own, fitted(own), 'api')).toBe(
    own
      .replace('  name: web\n', '  name: api\n')
      .replace('      app: web\n', '      app: api\n')
      .replace('- name: web\n', '- name: api\n'),
  )
})
