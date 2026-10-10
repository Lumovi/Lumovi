/**
 * Create's form, against a real API server: what each of its nine kinds writes is what the
 * cluster takes, and what the form says of a schedule is what the cluster's cron says.
 */
import type { Page } from '@playwright/test'
import { dialog, toasts } from '../e2e/action-helpers.ts'
import { IMAGES } from './cluster.ts'
import { expect, freshNamespace, get, inNamespace, kubectl, test } from './fixtures.ts'

const NS = 'it-create'

// (A StatefulSet's Service is one that's there already.)
const headless = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'db' },
  spec: { clusterIP: 'None', selector: { app: 'db' }, ports: [{ port: 5432 }] },
}

test.beforeAll(() => freshNamespace(NS, [headless]))

test.beforeEach(async ({ page }) => {
  await inNamespace(page, NS)
})

const form = (page: Page) => dialog(page).getByRole('group', { name: 'Form', exact: true })
const field = (page: Page, name: string) => form(page).getByRole('textbox', { name, exact: true })
const choice = (page: Page, name: string) => form(page).getByRole('combobox', { name, exact: true })

/** Opens Create's form on a kind, and names what's being made. */
async function start(page: Page, kind: string, name: string) {
  await page.keyboard.press('ControlOrMeta+n')
  await dialog(page).getByRole('radio', { name: 'Form', exact: true }).click()
  await dialog(page).getByRole('radio', { name: kind, exact: true }).click()
  await field(page, 'Name').fill(name)
}

/** Creates it, and waits until the cluster has. */
async function made(page: Page, kind: string, name: string) {
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(toasts(page)).toContainText(`Created ${kind.toLowerCase()} ${name}`)
  await expect(dialog(page)).toHaveCount(0)
  return get(kind.toLowerCase(), name, '-n', NS)
}

test('the workloads: a Deployment, a StatefulSet, a DaemonSet, a Job and a CronJob', async ({
  page,
}) => {
  await start(page, 'Deployment', 'form-web')
  await field(page, 'Image').fill(IMAGES.web)
  await field(page, 'Port').fill('80')
  const deployment = await made(page, 'Deployment', 'form-web')
  expect(deployment.spec.selector.matchLabels).toEqual({ app: 'form-web' })
  expect(deployment.spec.template.spec.containers[0]).toMatchObject({
    name: 'form-web',
    image: IMAGES.web,
    ports: [{ containerPort: 80 }],
  })

  await start(page, 'StatefulSet', 'form-db')
  // The namespace's headless Service is there to choose.
  await choice(page, 'Service').selectOption('db')
  await field(page, 'Image').fill(IMAGES.web)
  await form(page).getByRole('button', { name: 'Add storage' }).click()
  const set = await made(page, 'StatefulSet', 'form-db')
  expect(set.spec.serviceName).toBe('db')
  expect(set.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe('1Gi')
  expect(set.spec.template.spec.containers[0].volumeMounts).toEqual([
    { name: 'data', mountPath: '/data' },
  ])

  await start(page, 'DaemonSet', 'form-agent')
  await field(page, 'Image').fill(IMAGES.web)
  const daemons = await made(page, 'DaemonSet', 'form-agent')
  expect(daemons.spec.template.metadata.labels).toEqual({ app: 'form-agent' })

  await start(page, 'Job', 'form-once')
  await field(page, 'Image').fill(IMAGES.shell)
  await field(page, 'Command').fill('echo "hello: world" && exit 0')
  const job = await made(page, 'Job', 'form-once')
  expect(job.spec.backoffLimit).toBe(6)
  expect(job.spec.template.spec.restartPolicy).toBe('Never')
  expect(job.spec.template.spec.containers[0].command).toEqual([
    'sh',
    '-c',
    'echo "hello: world" && exit 0',
  ])

  await start(page, 'CronJob', 'form-nightly')
  await field(page, 'Schedule').fill('30 2 * * 1-5')
  await expect(form(page)).toContainText('Monday to Friday at 02:30')
  await field(page, 'Image').fill(IMAGES.shell)
  await field(page, 'Command').fill('date')
  const cron = await made(page, 'CronJob', 'form-nightly')
  expect(cron.spec.schedule).toBe('30 2 * * 1-5')
  expect(cron.spec.concurrencyPolicy).toBe('Allow')
})

test('a Service, a ConfigMap, a Secret and a PersistentVolumeClaim', async ({ page }) => {
  await start(page, 'Service', 'form-svc')
  await form(page).getByRole('button', { name: 'Add a label' }).click()
  await page.keyboard.type('app')
  await field(page, 'app’s value').fill('db')
  await field(page, 'Port 1').fill('80')
  await field(page, 'Port 1, on the pod').fill('http')
  // Two ports, each with the name the cluster asks of them.
  await form(page).getByRole('button', { name: 'Add a port' }).click()
  await page.keyboard.type('443')
  await field(page, 'Port 1’s name').fill('http')
  await field(page, 'Port 2’s name').fill('https')
  const service = await made(page, 'Service', 'form-svc')
  expect(service.spec.type).toBe('ClusterIP')
  expect(service.spec.selector).toEqual({ app: 'db' })
  expect(service.spec.ports).toMatchObject([
    { name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' },
    { name: 'https', port: 443, targetPort: 443, protocol: 'TCP' },
  ])

  await start(page, 'ConfigMap', 'form-settings')
  await form(page).getByRole('button', { name: 'Add a key' }).click()
  await page.keyboard.type('RETRIES')
  // (Text, though it looks a number: the API takes nothing else.)
  await field(page, 'RETRIES’s value').fill('5')
  await form(page).getByRole('button', { name: 'Add a key' }).click()
  await page.keyboard.type('features.yaml')
  await field(page, 'features.yaml’s value').fill('checkout:\n  express: true\n')
  const settings = await made(page, 'ConfigMap', 'form-settings')
  expect(settings.data).toEqual({
    RETRIES: '5',
    'features.yaml': 'checkout:\n  express: true\n',
  })

  await start(page, 'Secret', 'form-credentials')
  await form(page).getByRole('button', { name: 'Add a key' }).click()
  await page.keyboard.type('API_KEY')
  // Typed hidden, and created hidden: the cluster has what was typed.
  await field(page, 'API_KEY’s value').fill('c41d07be: "6a3e" #8f29')
  const secret = await made(page, 'Secret', 'form-credentials')
  expect(secret.type).toBe('Opaque')
  expect(Buffer.from(secret.data.API_KEY, 'base64').toString()).toBe('c41d07be: "6a3e" #8f29')

  await start(page, 'PersistentVolumeClaim', 'form-uploads')
  await field(page, 'Size').fill('1')
  const claim = await made(page, 'PersistentVolumeClaim', 'form-uploads')
  expect(claim.spec.accessModes).toEqual(['ReadWriteOnce'])
  expect(claim.spec.resources.requests.storage).toBe('1Gi')
})

test('a schedule the form calls wrong, or right without words, is so to the cluster', () => {
  const cronJob = (schedule: string) =>
    JSON.stringify({
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'form-schedule', namespace: NS },
      spec: {
        schedule,
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [{ name: 'c', image: IMAGES.shell }],
              },
            },
          },
        },
      },
    })
  const taken = (schedule: string) => {
    try {
      kubectl(['create', '--dry-run=server', '-f', '-'], cronJob(schedule))
      return true
    } catch {
      return false
    }
  }
  // Sunday is 0, and not 7; a time zone isn't the schedule's to say.
  expect(taken('0 0 * * 0')).toBe(true)
  expect(taken('0 0 * * 7')).toBe(false)
  expect(taken('CRON_TZ=UTC 0 0 * * *')).toBe(false)
  expect(taken('0 0 * * *  *')).toBe(false)
  // Every so long, and a date that never comes, are schedules to it.
  expect(taken('@every 1h30m')).toBe(true)
  expect(taken('@daily')).toBe(true)
  expect(taken('0 0 31 2 *')).toBe(true)
  expect(taken('*/90 * * * *')).toBe(true)
})
