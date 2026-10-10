/**
 * What Create's form says, where a person reads it: why it can't show a YAML, what the YAML
 * sets that it has no field for, what's wrong with what's typed, and what the cluster
 * refused, each under the field it's about. Every case is typed or pasted into the dialog,
 * in the built app, and the words are read off the page.
 */
import type { Page } from '@playwright/test'
import { dialog } from './action-helpers.ts'
import { expect, openCluster, test } from './fixtures.ts'

const form = (page: Page) => dialog(page).getByRole('group', { name: 'Form', exact: true })
const field = (page: Page, name: string) => form(page).getByRole('textbox', { name, exact: true })
const editor = (page: Page) => dialog(page).getByRole('textbox', { name: 'YAML to create' })
const status = (page: Page) => dialog(page).getByRole('status')
const create = (page: Page) => dialog(page).getByRole('button', { name: 'Create', exact: true })
const alerts = (page: Page) => form(page).getByRole('alert')
const yaml = (page: Page) =>
  editor(page).evaluate((content) =>
    [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
  )

async function open(page: Page) {
  await openCluster(page)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'shop' }).click()
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
            - name: REGION
              value: eu
          resources:
            requests:
              cpu: 250m
              memory: 128Mi
            limits:
              memory: 256Mi
`

test('why the form can’t show a YAML, each in its own words', async ({ page }) => {
  await open(page)
  await type(page, WEB)
  const said = form(page).locator('div').filter({ hasText: 'The form can’t show this YAML' }).last()
  const back = form(page).getByRole('button', { name: 'Go back to the form’s version' })
  const C = 'spec.template.spec.containers'
  for (const [text, why] of [
    ['', 'It’s empty, and the form needs an object to show.'],
    ['# only a comment\n', 'It’s empty, and the form needs an object to show.'],
    [`${WEB}---\n`, 'It has more than one document, and the form edits one.'],
    [
      `${WEB}---\nkind: ConfigMap\n---\nkind: Secret\n`,
      'It has three objects, and the form edits one.',
    ],
    ['- web\n- api\n', 'It isn’t an object with keys, as every Kubernetes object is.'],
    // (More than nine is said in figures.)
    [
      `${WEB.trimEnd()}\n${Array.from({ length: 9 }, (_, i) => `        - name: side-${i}\n          image: busybox\n`).join('')}`,
      'It has 10 containers, and the form edits one.',
    ],
    ['web\n', 'It isn’t an object with keys, as every Kubernetes object is.'],
    [
      WEB.replace('apps/v1', 'apps/v1beta1'),
      'Its apiVersion and kind aren’t apps/v1 and Deployment, which this form writes.',
    ],
    [
      WEB.replace('kind: Deployment\n', ''),
      'Its apiVersion and kind aren’t apps/v1 and Deployment, which this form writes.',
    ],
    [
      WEB.replace('metadata:\n  name: web\n  namespace: shop', 'metadata: web'),
      'metadata isn’t a group of keys, which the form expects there.',
    ],
    [
      WEB.replace(/ {6}containers:\n[\s\S]*$/, '      containers: web\n'),
      `${C} isn’t a list, which the form expects there.`,
    ],
    [
      WEB.replace(/ {6}containers:\n[\s\S]*$/, '      containers:\n        - web\n'),
      `${C}[0] isn’t a group of keys, which the form expects there.`,
    ],
    [
      WEB.replace(
        / {10}env:\n[\s\S]*? {10}resources:/,
        '          env: { A: b }\n          resources:',
      ),
      `${C}[0].env isn’t a list, which the form expects there.`,
    ],
    [
      WEB.replace('  replicas: 2', '  replicas: [2, 3]'),
      'spec.replicas holds more than one value, and the form’s field there takes one.',
    ],
    [
      WEB.replace(
        '  name: web\n  namespace: shop',
        '  name: web\n  namespace: shop\n  annotations: { n: &n 2 }',
      ).replace('  replicas: 2', '  replicas: *n'),
      'spec.replicas is an alias of a value elsewhere in the YAML, so the form can’t edit it alone.',
    ],
    [
      `base: &base { namespace: shop }\n${WEB.replace('  name: web\n  namespace: shop', '  <<: *base\n  name: web')}`,
      'metadata.name comes through a merge key (<<), so it isn’t written in one place for the form to edit.',
    ],
  ] as const) {
    await type(page, text)
    await expect(said, why).toContainText(
      `${why} The YAML is what gets created; go on editing it there. Below is the form as it last was.`,
    )
    await expect(status(page)).toHaveText('Edited by hand. This is what gets created.')
    await expect(field(page, 'Name')).toBeDisabled()
    await back.click()
    await expect(said).toHaveCount(0)
    expect(await yaml(page)).toBe(WEB.trimEnd() + '\n')
  }
})

test('what the YAML sets that the form has no field for is named, at its highest key', async ({
  page,
}) => {
  await open(page)
  const note = form(page).locator('div').filter({ hasText: 'The YAML also sets' }).last()
  await type(page, WEB)
  await expect(note).toHaveCount(0)
  await type(
    page,
    `${WEB.replace('metadata:\n  name: web', 'metadata:\n  labels:\n    tier: web\n  name: web').trimEnd()}
          command: [sh]
      initContainers:
        - name: init
          image: busybox
  minReadySeconds: 5
status: {}
`,
  )
  await expect(note).toHaveText(
    'The YAML also sets metadata.labels, spec.template.spec.containers[0].command, spec.template.spec.initContainers, spec.minReadySeconds and status. The form has no field for them, and keeps them as they are.',
  )
  // A second port, and a port's name, aren't the field's.
  await type(
    page,
    WEB.replace(
      '            - containerPort: 8080',
      '            - containerPort: 8080\n              name: http\n            - containerPort: 9090',
    ),
  )
  await expect(note).toHaveText(
    'The YAML also sets spec.template.spec.containers[0].ports[0].name and spec.template.spec.containers[0].ports[1]. The form has no field for them, and keeps them as they are.',
  )
  // One thing alone is "it".
  await type(page, WEB.replace('  replicas: 2', '  replicas: 2\n  paused: true'))
  await expect(note).toHaveText(
    'The YAML also sets spec.paused. The form has no field for it, and keeps it as it is.',
  )
})

test('what’s wrong with what’s typed is said under its field, each in its own words', async ({
  page,
}) => {
  await open(page)
  await type(page, WEB)
  await expect(alerts(page)).toHaveCount(0)
  /** A field is typed wrong, says so, and is put right again. */
  const wrong = async (name: string, typed: string, said: string, right: string) => {
    await field(page, name).fill(typed)
    await expect(alerts(page), `${name}: ${typed}`).toHaveText([said])
    await expect(create(page)).toBeDisabled()
    await expect(status(page)).toHaveText('1 field to fix before it can be created.')
    await field(page, name).fill(right)
    await expect(alerts(page)).toHaveCount(0)
  }
  await wrong(
    'Name',
    'a'.repeat(64),
    'At most 63 characters: the container and the app label take the same name.',
    'web',
  )
  await wrong(
    'Name',
    'Web',
    'Lowercase letters, digits and “-”, starting and ending with a letter or digit. The container takes the same name.',
    'web',
  )
  await wrong('Replicas', '-1', 'A whole number, 0 or more.', '2')
  await wrong('Replicas', 'two', 'A whole number, 0 or more.', '2')
  await wrong('Image', 'nginx 1.27', 'An image’s name has no spaces in it.', 'nginx:1.27')
  await wrong('Port', '0', 'A port is a number from 1 to 65535.', '8080')
  await wrong('Port', '70000', 'A port is a number from 1 to 65535.', '8080')
  await wrong(
    'Variable 2’s name',
    'LOG_LEVEL',
    'LOG_LEVEL is set twice: the last one wins.',
    'REGION',
  )
  await wrong(
    'Variable 2’s name',
    '1REGION',
    '1REGION can’t be a variable’s name: letters, digits, “_”, “-” and “.”, not starting with a digit.',
    'REGION',
  )
  await wrong('Variable 2’s name', '', 'A variable needs a name.', 'REGION')
  await wrong(
    'CPU limit',
    'lots',
    'The CPU limit isn’t an amount Kubernetes reads: like 250m or 0.5.',
    '',
  )
  await wrong(
    'Memory request',
    'much',
    'The memory request isn’t an amount Kubernetes reads: like 128Mi or 1Gi.',
    '128Mi',
  )
  // A namespace is chosen, so only the YAML can say one that can't be.
  await type(page, WEB.replace('namespace: shop', 'namespace: Shop'))
  await expect(alerts(page)).toHaveText(['A namespace’s name: lowercase letters, digits and “-”.'])
  // Two at once are counted.
  await field(page, 'Port').fill('0')
  await expect(status(page)).toHaveText('2 fields to fix before it can be created.')
  // And one with no namespace at all is asked for one, with whatever else is still empty.
  await type(
    page,
    WEB.replace('namespace: shop', 'namespace:').replace('  name: web\n', '  name:\n'),
  )
  await expect(status(page)).toHaveText('Name and Namespace are still empty.')
})

test('a variable says its value, or where its value comes from', async ({ page }) => {
  await open(page)
  const from = (name: string) => form(page).getByLabel(`${name}’s value`, { exact: true })
  await type(
    page,
    WEB.replace(
      / {10}env:\n[\s\S]*? {10}resources:/,
      `          env:
            - name: LOG_LEVEL
              value: info
            - name: API_KEY
              valueFrom:
                secretKeyRef: { name: payments, key: api-key }
            - name: REGION
              valueFrom:
                configMapKeyRef: { name: settings, key: region }
            - name: POD_IP
              valueFrom:
                fieldRef: { fieldPath: status.podIP }
            - name: CPU_LIMIT
              valueFrom:
                resourceFieldRef: { resource: limits.cpu }
            - name: HALF_SAID
              valueFrom:
                secretKeyRef: {}
            - name: NOT_SAID
              valueFrom:
                fieldRef: {}
            - name: NOR_THIS
              valueFrom:
                resourceFieldRef: {}
            - name: FROM_A_FILE
              valueFrom:
                fileKeyRef: { path: /etc/app, key: token }
          resources:`,
    ),
  )
  for (const [name, said] of [
    ['API_KEY', 'from Secret payments, key api-key'],
    ['REGION', 'from ConfigMap settings, key region'],
    ['POD_IP', 'from the pod’s field status.podIP'],
    ['CPU_LIMIT', 'from the container’s limits.cpu'],
    // What the YAML doesn't say yet is left open, not made up.
    ['HALF_SAID', 'from Secret …, key …'],
    ['NOT_SAID', 'from the pod’s field …'],
    ['NOR_THIS', 'from the container’s …'],
    // A source this doesn't know is the YAML's to say.
    ['FROM_A_FILE', 'from elsewhere, as the YAML says'],
  ] as const) {
    await expect(from(name), name).toHaveText(said)
  }
  // One that's said here is typed here; emptied, its value is gone from the YAML, key and all.
  await expect(field(page, 'LOG_LEVEL’s value')).toHaveValue('info')
  await field(page, 'LOG_LEVEL’s value').fill('')
  expect(await yaml(page)).toContain('            - name: LOG_LEVEL\n            - name: API_KEY\n')
  await expect(alerts(page)).toHaveCount(0)
})

test('the name takes with it what was the name, and nothing that wasn’t', async ({ page }) => {
  await open(page)
  await type(page, WEB)
  await field(page, 'Name').fill('api')
  expect(await yaml(page)).toBe(WEB.replaceAll(': web\n', ': api\n'))
  // A label of its own is left alone.
  const own = WEB.replace('      labels:\n        app: web', '      labels:\n        app: frontend')
  await type(page, own)
  await field(page, 'Name').fill('api')
  expect(await yaml(page)).toBe(
    own
      .replace('  name: web\n', '  name: api\n')
      .replace('      app: web\n', '      app: api\n')
      .replace('- name: web\n', '- name: api\n'),
  )
})

/** The cluster refuses a Deployment in `shop`, saying these causes. */
const refusing = (
  cluster: { fail(match: string, fault: object): () => void },
  causes: unknown,
  message = 'Deployment.apps "web" is invalid',
) =>
  cluster.fail('/apis/apps/v1/namespaces/shop/deployments', {
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'Status',
      status: 'Failure',
      reason: 'Invalid',
      code: 422,
      message,
      details: { name: 'web', group: 'apps', kind: 'Deployment', causes },
    }),
  })

test('what the cluster refuses is under the field it names, or its parent’s; the rest is in the results', async ({
  page,
  clusters,
}) => {
  await open(page)
  await type(page, WEB)
  const results = dialog(page).getByRole('list', { name: 'Results' })
  const clear = refusing(clusters.demo, [
    { field: 'spec.template.spec.containers[0].image', message: 'Required value' },
    { field: 'spec.template.spec.containers[0].resources.requests', message: 'too much' },
    { field: 'metadata.name', message: 'bad', reason: 'FieldValueInvalid' },
    { field: 'spec.template.spec.containers[0].env[1].name', message: 'odd' },
    // One the form has no field for, and one that names none: nobody's.
    { field: 'spec.strategy.type', message: 'Unsupported value' },
    { message: 'no field at all' },
    // A field that isn't a path as the API writes one is nobody's either.
    { field: 'spec.template.spec.containers[first].image', message: 'not a path' },
    // What isn't a cause as the API writes one is left out.
    { field: 'spec.replicas' },
    { field: 7, message: 9 },
    'not a cause',
    null,
  ])
  await create(page).click()
  await expect(results).toContainText('Deployment.apps "web" is invalid')
  await expect(alerts(page)).toHaveText([
    'The cluster refused it: bad',
    'The cluster refused it: Required value',
    'The cluster refused it: odd',
    'The cluster refused it: too much',
  ])
  await expect(status(page)).toHaveText('Nothing was created.')
  // Typing in a field takes the cluster's word away: it was about what was there.
  await field(page, 'Image').fill('nginx:1.27')
  await expect(alerts(page)).toHaveCount(0)
  clear()

  // It's the cluster's text: no more than fifty causes are kept, nor more than a thousand
  // characters of each; and a refusal with no causes, or none that are, is in the results alone.
  const many = refusing(clusters.demo, [
    { field: 'spec.replicas', message: 'x'.repeat(3000) },
    ...Array.from({ length: 60 }, (_, i) => ({ field: 'metadata.name', message: `again ${i}` })),
    { field: 'spec.template.spec.containers[0].image', message: 'the sixty-second' },
  ])
  await create(page).click()
  await expect(alerts(page)).toHaveText([
    'The cluster refused it: again 0',
    `The cluster refused it: ${'x'.repeat(1000)}`,
  ])
  many()
  await field(page, 'Replicas').fill('3')
  for (const causes of [undefined, 'none', [], [{ field: 'spec.replicas' }]]) {
    const none = refusing(clusters.demo, causes, 'admission webhook "policy" denied the request')
    await create(page).click()
    await expect(results).toContainText('admission webhook "policy" denied the request')
    await expect(alerts(page)).toHaveCount(0)
    none()
    await field(page, 'Replicas').fill(await field(page, 'Replicas').inputValue())
  }
})
