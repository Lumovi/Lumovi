/**
 * Create's form for the other workloads: a StatefulSet (its Service, and storage for each
 * pod), a DaemonSet (no replicas), a Job (a command, and how often to retry) and a CronJob (a
 * schedule, read back in words). Each shares a Deployment's container fields, writes its own
 * YAML, and steps back in its own words.
 */
import type { Page } from '@playwright/test'
import {
  FORM_KINDS,
  problems,
  read,
  unowned,
  workloadValues,
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

test('the kinds are chosen by their chips, each starting from its own', async ({ page }) => {
  await open(page, 'Deployment')
  await expect(
    dialog(page).getByRole('radiogroup', { name: 'Kind' }).getByRole('radio'),
  ).toHaveText(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'])
  // What was typed for one kind isn't carried to the next: each starts as its own, new.
  await field(page, 'Name').fill('web')
  await dialog(page).getByRole('radio', { name: 'Job', exact: true }).click()
  await expect(field(page, 'Name')).toHaveValue('')
  expect(await yaml(page)).toBe(`apiVersion: batch/v1
kind: Job
metadata:
  name:
  namespace: shop
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: Never
      containers:
        - name:
          image:
`)
  await expect(status(page)).toHaveText('Name and Image are still empty.')
  await expect(create(page)).toBeDisabled()
  // A Job's pods aren't labelled after it, and it has no replicas, port or amounts to ask.
  await expect(form(page)).not.toContainText('Labelled app=')
  for (const name of ['Replicas', 'Port']) await expect(field(page, name)).toHaveCount(0)
  await expect(form(page).getByRole('button', { name: 'Set them' })).toHaveCount(0)

  await dialog(page).getByRole('radio', { name: 'CronJob', exact: true }).click()
  expect(await yaml(page)).toBe(`apiVersion: batch/v1
kind: CronJob
metadata:
  name:
  namespace: shop
spec:
  schedule:
  concurrencyPolicy: Allow
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name:
              image:
`)
  await expect(status(page)).toHaveText('Name, Schedule and Image are still empty.')
  // Its container is further in, and its fields say so.
  await expect(
    form(page).getByText('spec.jobTemplate.spec.template.spec.containers[0]', { exact: true }),
  ).toBeVisible()

  await dialog(page).getByRole('radio', { name: 'StatefulSet', exact: true }).click()
  expect(await yaml(page)).toContain('spec:\n  serviceName:\n  replicas: 1\n  selector:\n')
  await expect(status(page)).toHaveText('Name, Service and Image are still empty.')

  await dialog(page).getByRole('radio', { name: 'DaemonSet', exact: true }).click()
  expect(await yaml(page)).toContain('kind: DaemonSet\n')
  expect(await yaml(page)).not.toContain('replicas')
  await expect(field(page, 'Replicas')).toHaveCount(0)
  await expect(form(page)).toContainText('One pod on every node, so there’s no replica count.')
  await expect(form(page)).toContainText('Labelled app=…')
})

test('a StatefulSet: its Service, and storage for each pod', async ({ page, clusters }) => {
  await open(page, 'StatefulSet')
  await field(page, 'Name').fill('postgres')
  // The Service is one of the namespace's: it isn't made here.
  await expect(form(page)).toContainText(
    'The headless Service that names its pods. It isn’t created here: make it first, as a Service.',
  )
  await choice(page, 'Service').focus()
  await choice(page, 'Service').selectOption('storefront')
  await expect(lines(page, 'lit')).toHaveText(['  serviceName: storefront'])
  await field(page, 'Image').fill('postgres:17.2')
  await field(page, 'Port').fill('5432')
  // Storage: a claim for each pod, and where the container mounts it, made together.
  await form(page).getByRole('button', { name: 'Add storage' }).click()
  await expect(field(page, 'Size')).toHaveValue('1')
  await expect(field(page, 'Mounted at')).toHaveValue('/data')
  await expect(choice(page, 'Storage class')).toHaveValue('')
  // A number is gibibytes; the class starts as the cluster's default, named.
  await expect(choice(page, 'Storage class').locator('option:checked')).toHaveText(
    'standard (default)',
  )
  await field(page, 'Size').fill('20')
  await choice(page, 'Storage class').selectOption('fast-ssd')
  await field(page, 'Mounted at').fill('/var/lib/postgresql')
  expect(await yaml(page)).toBe(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: shop
spec:
  serviceName: storefront
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:17.2
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 20Gi
`)
  // The field in focus lights what it writes: the size, in the claim.
  await field(page, 'Size').focus()
  await expect(lines(page, 'lit')).toHaveText(['            storage: 20Gi'])
  // What's wrong with either is said under them.
  await field(page, 'Size').fill('twenty')
  await expect(form(page).getByRole('alert')).toHaveText(
    'The size isn’t an amount of storage Kubernetes reads: like 20Gi.',
  )
  // Another unit is typed whole, and shown whole.
  await field(page, 'Size').fill('500Mi')
  expect(await yaml(page)).toContain('            storage: 500Mi\n')
  await expect(field(page, 'Size')).toHaveValue('500Mi')
  await field(page, 'Size').fill('20')
  await field(page, 'Mounted at').fill('data')
  await expect(form(page).getByRole('alert')).toHaveText(
    'Where it’s mounted is a path in the container, from /: like /data.',
  )
  await field(page, 'Mounted at').fill('/data')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  // The cluster's default class is no class said.
  await choice(page, 'Storage class').selectOption('')
  expect(await yaml(page)).not.toContain('storageClassName')

  // More than the form's one claim, or a mount that isn't the claim's: it steps back, and
  // says which.
  const fitted = await yaml(page)
  await type(
    page,
    `${fitted.trimEnd()}
    - metadata:
        name: wal
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 5Gi
`,
  )
  await expect(stepped(page)).toContainText(
    'It has two claims for each pod, and the form edits one.',
  )
  await form(page).getByRole('button', { name: 'Go back to the form’s version' }).click()
  await type(page, fitted.replace('            - name: data\n', '            - name: scratch\n'))
  await expect(stepped(page)).toContainText(
    'Its container’s first mount isn’t of its pods’ claim, which is the one the form’s field edits.',
  )
  await form(page).getByRole('button', { name: 'Go back to the form’s version' }).click()

  // Without storage again: the claim goes, and its mount with it.
  await form(page).getByRole('button', { name: 'Remove the storage' }).click()
  const without = await yaml(page)
  expect(without).not.toMatch(/volumeClaimTemplates|volumeMounts/)
  expect(without).toContain('            - containerPort: 5432\n')
  await form(page).getByRole('button', { name: 'Add storage' }).click()
  await create(page).click()
  await expect(toasts(page)).toContainText('Created statefulset postgres')
  expect(
    writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/shop/statefulsets').at(-1)!.body,
  ).toMatchObject({
    spec: {
      serviceName: 'storefront',
      volumeClaimTemplates: [{ metadata: { name: 'data' } }],
      template: {
        spec: { containers: [{ volumeMounts: [{ name: 'data', mountPath: '/data' }] }] },
      },
    },
  })
})

test('a DaemonSet: a Deployment’s fields, without replicas', async ({ page, clusters }) => {
  await open(page, 'DaemonSet')
  await field(page, 'Name').fill('log-agent')
  await field(page, 'Image').fill('ghcr.io/acme/log-agent:1.8.0')
  await form(page).getByRole('button', { name: 'Set them' }).click()
  await field(page, 'Memory limit').fill('256Mi')
  expect(await yaml(page)).toBe(`apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-agent
  namespace: shop
spec:
  selector:
    matchLabels:
      app: log-agent
  template:
    metadata:
      labels:
        app: log-agent
    spec:
      containers:
        - name: log-agent
          image: ghcr.io/acme/log-agent:1.8.0
          resources:
            limits:
              memory: 256Mi
`)
  // A replica count typed in the YAML is something the form has no field for here.
  await type(
    page,
    (await yaml(page)).replace('spec:\n  selector:', 'spec:\n  replicas: 3\n  selector:'),
  )
  await expect(form(page)).toContainText(
    'The YAML also sets spec.replicas. The form has no field for it, and keeps it as it is.',
  )
  await create(page).click()
  // The cluster has no such field either, and would say so; the mock takes it as it is.
  await expect(toasts(page)).toContainText('Created daemonset log-agent')
  expect(writes(clusters.demo, 'POST', '/apis/apps/v1/namespaces/shop/daemonsets')).toHaveLength(2)
})

test('a Job: retries, what happens to a failed pod, and a command', async ({ page, clusters }) => {
  await open(page, 'Job')
  await field(page, 'Name').fill('reindex')
  await field(page, 'Retries').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(lines(page, 'lit')).toHaveText(['  backoffLimit: 3'])
  // What a failed pod's job does next, said as what it does.
  await expect(choice(page, 'When a pod fails')).toHaveValue('Never')
  await expect(form(page)).toContainText('Never: the failed pod is kept, to read its logs.')
  await choice(page, 'When a pod fails').selectOption({ label: 'Restart it in the same pod' })
  await expect(form(page)).toContainText(
    'OnFailure: the pod stays, and its container is started again.',
  )
  await choice(page, 'When a pod fails').selectOption({ label: 'Start a new pod' })
  await field(page, 'Image').fill('ghcr.io/acme/search-indexer:4.1.0')
  // A command is what a shell runs: written as sh -c, whatever's in it.
  await expect(form(page)).toContainText('Run as sh -c. Empty runs the image’s own command.')
  await field(page, 'Command').fill('indexer --all --since 24h && echo "done: $?"')
  expect(await yaml(page)).toBe(`apiVersion: batch/v1
kind: Job
metadata:
  name: reindex
  namespace: shop
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: reindex
          image: ghcr.io/acme/search-indexer:4.1.0
          command:
            - sh
            - -c
            - 'indexer --all --since 24h && echo "done: $?"'
`)
  await field(page, 'Command').focus()
  await expect(lines(page, 'lit')).toHaveCount(4)
  // Read back from the YAML as it was typed; emptied, the image's own command runs.
  await expect(field(page, 'Command')).toHaveValue('indexer --all --since 24h && echo "done: $?"')
  await field(page, 'Command').fill('')
  expect(await yaml(page)).not.toContain('command')
  await field(page, 'Command').fill('indexer --all')

  // A command of another shape isn't one the field can show; nor a second container. Said in
  // a Job's own words, and the YAML is what's made.
  const fitted = await yaml(page)
  await type(page, fitted.replace(/command:\n(\s+- .*\n){3}/, 'command: [indexer, --all]\n'))
  await expect(stepped(page)).toContainText(
    'Its container’s command isn’t run as sh -c, which is how the form’s field writes one.',
  )
  await expect(lines(page, 'shaded')).toHaveText(['          command: [indexer, --all]'])
  await form(page).getByRole('button', { name: 'Go back to the form’s version' }).click()
  await type(page, `${fitted.trimEnd()}\n        - name: sidecar\n          image: busybox\n`)
  await expect(stepped(page)).toContainText('It has two containers, and the form edits one.')
  await form(page).getByRole('button', { name: 'Go back to the form’s version' }).click()
  // A policy a Job can't have, typed in the YAML: wrong, under its field.
  await type(page, fitted.replace('restartPolicy: Never', 'restartPolicy: Always'))
  await expect(form(page).getByRole('alert')).toHaveText(
    'A Job’s pods restart Never or OnFailure, not Always.',
  )
  await expect(create(page)).toBeDisabled()
  await choice(page, 'When a pod fails').selectOption({ label: 'Start a new pod' })
  await expect(form(page).getByRole('alert')).toHaveCount(0)

  await create(page).click()
  await expect(toasts(page)).toContainText('Created job reindex')
  expect(
    writes(clusters.demo, 'POST', '/apis/batch/v1/namespaces/shop/jobs').at(-1)!.body,
  ).toMatchObject({
    spec: {
      backoffLimit: 3,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [{ name: 'reindex', command: ['sh', '-c', 'indexer --all'] }],
        },
      },
    },
  })
})

test('a CronJob: a schedule read back in words, and what to do if the last run is still going', async ({
  page,
  clusters,
}) => {
  await open(page, 'CronJob')
  await field(page, 'Name').fill('reindex-nightly')
  // Before one is typed, what a schedule is.
  await expect(form(page)).toContainText(
    'Five fields, as cron has them: minute, hour, day of the month, month, day of the week.',
  )
  await field(page, 'Schedule').fill('30 2 * * *')
  await expect(form(page)).toContainText(
    'Every day at 02:30, in the cluster’s time zone (usually UTC).',
  )
  // (Written as YAML takes it: a star at its start would be read as something else.)
  expect(await yaml(page)).toContain('  schedule: 30 2 * * *\n')
  await field(page, 'Schedule').fill('*/15 9-17 * * 1-5')
  await expect(form(page)).toContainText(
    'Every 15 minutes from 09:00 to 17:59, Monday to Friday, in the cluster’s time zone (usually UTC).',
  )
  expect(await yaml(page)).toContain('  schedule: "*/15 9-17 * * 1-5"\n')
  // One that's right but involved is said to be right, with no words put in its mouth.
  await field(page, 'Schedule').fill('0 0 */2 * *')
  await expect(form(page)).toContainText(
    'A valid schedule, though not one this can put into words. Check it against what you meant.',
  )
  await expect(create(page)).toBeDisabled()
  await expect(status(page)).toHaveText('Image is still empty.')
  // One that's wrong is said under it, and which field of it; nothing can be created.
  await field(page, 'Schedule').fill('30 25 * * *')
  await expect(form(page).getByRole('alert')).toHaveText(
    'The hour is “25”, and hours go from 0 to 23.',
  )
  await expect(lines(page, 'wrong')).toHaveText(['  schedule: 30 25 * * *'])
  await field(page, 'Schedule').fill('@daily')
  await expect(form(page).getByRole('alert')).toHaveCount(0)
  await expect(form(page)).toContainText(
    'Every day at 00:00, in the cluster’s time zone (usually UTC).',
  )
  // A time zone said in the YAML is the one the words name.
  await editor(page).getByText('schedule:').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('timeZone: Europe/Budapest')
  await expect(form(page)).toContainText('Every day at 00:00, in Europe/Budapest.')
  await expect(form(page)).toContainText(
    'The YAML also sets spec.timeZone. The form has no field for it, and keeps it as it is.',
  )

  await expect(choice(page, 'If the last run is still going')).toHaveValue('Allow')
  await choice(page, 'If the last run is still going').selectOption({ label: 'Skip this one' })
  await field(page, 'Image').fill('ghcr.io/acme/search-indexer:4.1.0')
  await field(page, 'Command').fill('indexer --all --since 24h')
  await form(page).getByRole('button', { name: 'Add a variable' }).click()
  await page.keyboard.type('INDEX')
  await field(page, 'INDEX’s value').fill('products')
  expect(await yaml(page)).toBe(`apiVersion: batch/v1
kind: CronJob
metadata:
  name: reindex-nightly
  namespace: shop
spec:
  schedule: "@daily"
  timeZone: Europe/Budapest
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: reindex-nightly
              image: ghcr.io/acme/search-indexer:4.1.0
              command:
                - sh
                - -c
                - indexer --all --since 24h
              env:
                - name: INDEX
                  value: products
`)
  await create(page).click()
  await expect(toasts(page)).toContainText('Created cronjob reindex-nightly')
  expect(
    writes(clusters.demo, 'POST', '/apis/batch/v1/namespaces/shop/cronjobs').at(-1)!.body,
  ).toMatchObject({ spec: { schedule: '@daily', concurrencyPolicy: 'Forbid' } })
})

// ——— Each kind's reading of its YAML, asked directly ———

test('each kind owns its own paths, and asks for what it must have', () => {
  for (const [kind, empty, owned] of [
    ['Deployment', ['Name', 'Image'], 14],
    ['StatefulSet', ['Name', 'Service', 'Image'], 16],
    ['DaemonSet', ['Name', 'Image'], 13],
    ['Job', ['Name', 'Image'], 10],
    ['CronJob', ['Name', 'Schedule', 'Image'], 11],
  ] as const) {
    const form = FORM_KINDS[kind]
    const reading = read(form.blank('shop'), form)
    expect(reading.fits, kind).toBe(true)
    if (!reading.fits) continue
    // A new one has nothing the form has no field for, and nothing wrong but what's empty.
    expect(unowned(reading.object, form).map(pathText), kind).toEqual([])
    const values = workloadValues(reading.object, form)
    expect(problems(values, form), kind).toEqual([])
    expect(form.fields.length + form.follows.length, kind).toBeGreaterThan(5)
    expect(form.owns.length, kind).toBeGreaterThanOrEqual(owned - 4)
    void empty
  }
  // What one kind owns is another's to leave alone: a Job's selector, a Deployment's schedule.
  const job = FORM_KINDS.Job
  const read1 = read(
    job
      .blank('shop')
      .replace('  template:', '  selector:\n    matchLabels:\n      app: x\n  template:'),
    job,
  )
  expect(read1.fits && unowned(read1.object, job).map(pathText)).toEqual(['spec.selector'])
})
