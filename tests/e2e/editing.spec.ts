import { dialog, menuAction, open, toasts, writes } from './action-helpers.ts'
import { DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const DEPLOYMENT = `/apis/apps/v1/namespaces/shop/deployments/${DEMO.deployments.storefront}`

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('change container images, then undo', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Change image…')
  const images = dialog(page)
  await expect(images).toContainText('Pods are replaced with the new images')
  const update = images.getByRole('button', { name: 'Update' })
  await expect(update).toBeDisabled()
  const app = images.getByLabel('Image for app')
  // The first image's tag is selected, ready to be replaced.
  await expect(app).toBeFocused()
  await expect
    .poll(() => app.evaluate((input: HTMLInputElement) => input.selectionStart))
    .toBe('ghcr.io/acme/storefront:'.length)
  await page.keyboard.type('v3.9.0')
  await expect(app).toHaveValue('ghcr.io/acme/storefront:v3.9.0')
  // Coming back to it selects what's there, like any field, rather than the tag again.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(app).toBeFocused()
  await expect.poll(() => app.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0)
  await expect(images).toContainText(
    'kubectl set image deployment/storefront app=ghcr.io/acme/storefront:v3.9.0',
  )
  // An empty image can't be saved.
  await images.getByLabel('Image for envoy').fill('')
  await expect(images).toContainText('envoyproxy/envoy:v1.35.1—')
  await expect(update).toBeDisabled()
  await images.getByLabel('Image for envoy').fill('envoyproxy/envoy:v1.35.1')
  await update.click()
  await expect(toasts(page)).toContainText(
    'Set app of storefront to ghcr.io/acme/storefront:v3.9.0',
  )
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)).toMatchObject({
    type: 'application/strategic-merge-patch+json',
    body: {
      spec: {
        template: {
          spec: { containers: [{ name: 'app', image: 'ghcr.io/acme/storefront:v3.9.0' }] },
        },
      },
    },
  })
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText('Restored the images of storefront')
  expect(
    writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!.body.spec.template.spec.containers,
  ).toEqual([{ name: 'app', image: 'ghcr.io/acme/storefront:v3.8.2' }])

  // Init containers, and several images at once; past images are suggested.
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Change image…')
  await expect(
    dialog(page).locator('datalist option[value="ghcr.io/acme/storefront:v3.7.4"]'),
  ).toHaveCount(1)
  await dialog(page).getByLabel('Image for migrate').fill('ghcr.io/acme/storefront:v3.9.1')
  await dialog(page).getByLabel('Image for envoy').fill('envoyproxy/envoy:v1.36.0')
  await dialog(page).getByRole('button', { name: 'Update' }).click()
  await expect(toasts(page)).toContainText('Updated 2 images of storefront')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!.body.spec.template.spec).toEqual({
    containers: [{ name: 'envoy', image: 'envoyproxy/envoy:v1.36.0' }],
    initContainers: [{ name: 'migrate', image: 'ghcr.io/acme/storefront:v3.9.1' }],
  })

  // Only an init container.
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Change image…')
  await dialog(page).getByLabel('Image for migrate').fill('ghcr.io/acme/storefront:v3.9.2')
  await dialog(page).getByRole('button', { name: 'Update' }).click()
  await expect(toasts(page)).toContainText('Set migrate of storefront')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!.body.spec.template.spec).toEqual({
    initContainers: [{ name: 'migrate', image: 'ghcr.io/acme/storefront:v3.9.2' }],
  })

  // CronJobs keep their template in the job template; images without a tag aren't split.
  await open(page, 'CronJobs', DEMO.cronJobs.cleanup)
  await menuAction(page, 'CronJob', DEMO.cronJobs.cleanup, 'Change image…')
  await expect(dialog(page)).toContainText('Jobs it starts from now on use the new images.')
  await dialog(page)
    .getByLabel(/^Image for/)
    .first()
    .fill('busybox')
  await dialog(page).getByRole('button', { name: 'Update' }).click()
  expect(
    writes(clusters.demo, 'PATCH', '/apis/batch/v1/namespaces/batch/cronjobs/cleanup')[0]!.body.spec
      .jobTemplate.spec.template.spec.containers[0].image,
  ).toBe('busybox')

  // Images without a tag have nothing to select.
  const cart = structuredClone(clusters.demo.object('Deployment', 'shop', DEMO.deployments.cart)!)
  cart.spec.template.spec.containers[0].image = 'nginx'
  clusters.demo.upsert(cart)
  await open(page, 'Deployments', DEMO.deployments.cart)
  await menuAction(page, 'Deployment', DEMO.deployments.cart, 'Change image…')
  await expect(
    dialog(page)
      .getByLabel(/^Image for/)
      .first(),
  ).toBeFocused()
  // Let the dialog settle (it would select a tag after a frame) before typing.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await page.keyboard.press('End')
  await page.keyboard.type(':1.29')
  await expect(
    dialog(page)
      .getByLabel(/^Image for/)
      .first(),
  ).toHaveValue('nginx:1.29')
})

test('roll back to an earlier revision', async ({ page, clusters }) => {
  const revision = () =>
    clusters.demo.object('Deployment', 'shop', DEMO.deployments.storefront)!.metadata.annotations![
      'deployment.kubernetes.io/revision'
    ]
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Roll back…')
  await expect(dialog(page)).toContainText(
    'Running now: revision 4 — Release v3.8.2: faster product search',
  )
  await expect(dialog(page).getByRole('radio', { name: 'Revision 3' })).toBeChecked()
  await page.keyboard.press('Escape')

  // A restart makes revision 5, so two earlier ones are offered, newest first.
  await panel(page, 'Deployment', DEMO.deployments.storefront)
    .getByRole('button', { name: 'Restart' })
    .click()
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect.poll(revision).toBe('5')
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Roll back…')
  const rollback = dialog(page)
  await expect(rollback.getByRole('radio', { name: 'Revision 4' })).toBeChecked()
  const previous = rollback.getByRole('radio', { name: 'Revision 3' })
  await previous.check()
  await expect(rollback.getByRole('radio', { name: 'Revision 4' })).not.toBeChecked()
  await expect(rollback).toContainText('Release v3.7.4')
  await expect(rollback).toContainText('ghcr.io/acme/storefront:v3.7.4')
  await expect(rollback).toContainText('--to-revision=3')
  await rollback.getByRole('button', { name: 'Roll back' }).click()
  await expect(toasts(page)).toContainText('Rolled back storefront to revision 3')
  const patch = writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!
  expect(patch.type).toBe('application/json-patch+json')
  expect(patch.body[0]).toMatchObject({ op: 'replace', path: '/spec/template' })
  expect(
    patch.body[0].value.spec.containers.find((c: { name: string }) => c.name === 'app').image,
  ).toBe('ghcr.io/acme/storefront:v3.7.4')
  expect(patch.body[0].value.metadata.labels['pod-template-hash']).toBeUndefined()

  // The rolled-back revision becomes the newest.
  await expect.poll(revision).toBe('6')
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Roll back…')
  await expect(dialog(page)).toContainText('Running now: revision 6 — Release v3.7.4')
  await expect(dialog(page).getByRole('radio', { name: 'Revision 5' })).toBeChecked()
  await page.keyboard.press('Escape')

  // StatefulSets and DaemonSets keep their history in ControllerRevisions.
  await open(page, 'StatefulSets', DEMO.statefulSets.postgres)
  await menuAction(page, 'StatefulSet', DEMO.statefulSets.postgres, 'Roll back…')
  await expect(dialog(page)).toContainText('Running now: revision 2')
  await expect(dialog(page)).toContainText('postgres:17.5-alpine')
  await dialog(page).getByRole('button', { name: 'Roll back' }).click()
  await expect(toasts(page)).toContainText('Rolled back postgres to revision 1')

  await open(page, 'DaemonSets', DEMO.daemonSets.nodeExporter)
  await menuAction(page, 'DaemonSet', DEMO.daemonSets.nodeExporter, 'Roll back…')
  await expect(dialog(page)).toContainText('quay.io/prometheus/node-exporter:v1.8.2')
  await dialog(page).getByRole('button', { name: 'Roll back' }).click()
  await expect(toasts(page)).toContainText('Rolled back node-exporter to revision 1')

  // Nothing to go back to.
  await open(page, 'Deployments', DEMO.deployments.cart)
  await menuAction(page, 'Deployment', DEMO.deployments.cart, 'Roll back…')
  await expect(dialog(page)).toContainText('cart has no earlier revisions to roll back to.')
  await expect(dialog(page).getByRole('button', { name: 'Roll back' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // The history couldn't be loaded.
  clusters.demo.fail('/apis/apps/v1/namespaces/shop/replicasets', {
    status: 500,
    body: 'etcd timeout',
  })
  await menuAction(page, 'Deployment', DEMO.deployments.cart, 'Roll back…')
  await expect(dialog(page).getByRole('alert')).toContainText('HTTP 500')
})

test('pause and resume a rollout', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Pause rollout')
  await expect(toasts(page)).toContainText('Paused the rollout of storefront')
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('button', { name: 'Resume rollout' }).click()
  await expect(toasts(page)).toContainText('Resumed the rollout of storefront')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).map((p) => p.body)).toEqual([
    { spec: { paused: true } },
    { spec: { paused: null } },
  ])
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Pause rollout')
  await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
  await expect(toasts(page)).toContainText('Resumed the rollout of storefront')
})

test('change an autoscaler’s replica range', async ({ page, clusters }) => {
  await open(page, 'Autoscalers', 'storefront')
  await panel(page, 'HorizontalPodAutoscaler', 'storefront')
    .getByRole('button', { name: 'Edit replica range' })
    .click()
  const range = dialog(page)
  await expect(range).toContainText('Running 3 replicas now. That is within the new range.')
  await expect(range.getByRole('button', { name: 'Save' })).toBeDisabled()
  await range.getByLabel('Minimum replicas', { exact: true }).fill('4')
  await expect(range).toContainText('It scales up to the new minimum.')
  await range.getByLabel('Minimum replicas', { exact: true }).fill('1')
  await range.getByLabel('Maximum replicas', { exact: true }).fill('2')
  await expect(range).toContainText('It scales down to the new maximum.')
  await range.getByLabel('Minimum replicas', { exact: true }).fill('5')
  await expect(range).toContainText('The minimum can’t be above the maximum.')
  await expect(range.getByRole('button', { name: 'Save' })).toBeDisabled()
  await range.getByLabel('Maximum replicas', { exact: true }).fill('12')
  await range.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page)).toContainText('storefront now scales between 5 and 12 replicas')
  const path = '/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers/storefront'
  expect(writes(clusters.demo, 'PATCH', path)[0]!.body).toEqual({
    spec: { minReplicas: 5, maxReplicas: 12 },
  })
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText('storefront scales between 2 and 10 replicas again')
})

test('expand a volume', async ({ page, clusters }) => {
  await open(page, 'Volume Claims', 'data-redis-0')
  await menuAction(page, 'PersistentVolumeClaim', 'data-redis-0', 'Expand volume…')
  const expand = dialog(page)
  await expect(expand).toContainText('It has 5Gi now.')
  await expect(expand.getByLabel('New size', { exact: true })).toHaveValue('10')
  await expand.getByLabel('New size', { exact: true }).fill('4')
  await expect(expand).toContainText('The new size has to be larger than 5Gi.')
  await expect(expand.getByRole('button', { name: 'Expand' })).toBeDisabled()
  await expand.getByLabel('Unit').selectOption('Ti')
  await expand.getByRole('button', { name: 'Expand' }).click()
  await expect(toasts(page)).toContainText('Expanded data-redis-0 to 4Ti')
  expect(
    writes(
      clusters.demo,
      'PATCH',
      '/api/v1/namespaces/data/persistentvolumeclaims/data-redis-0',
    )[0]!.body,
  ).toEqual({
    spec: { resources: { requests: { storage: '4Ti' } } },
  })
  // The claim's capacity grows once the storage provider is done.
  await goTo(page, 'Volume Claims')
  await expect(row(page, 'Volume Claims', 'data-redis-0')).toContainText('4Ti')

  // Storage classes can forbid growing volumes.
  await open(page, 'Volume Claims', 'grafana-storage')
  await menuAction(page, 'PersistentVolumeClaim', 'grafana-storage', 'Expand volume…')
  await expect(dialog(page)).toContainText(
    'Its storage class, standard, doesn’t allow volumes to grow.',
  )
  await expect(dialog(page).getByRole('button', { name: 'Expand' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // Only bound claims can grow.
  await open(page, 'Volume Claims', 'data-redis-1')
  await panel(page, 'PersistentVolumeClaim', 'data-redis-1')
    .getByRole('button', { name: 'More actions' })
    .click()
  await expect(page.getByRole('menuitem', { name: 'Expand volume…' })).toHaveCount(0)
})

test('edit labels and annotations, then undo', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await menuAction(page, 'Deployment', DEMO.deployments.storefront, 'Edit labels…')
  const labels = dialog(page)
  await expect(labels.getByRole('tab', { name: /labels/i })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(labels).toContainText('No changes yet.')
  const save = labels.getByRole('button', { name: 'Save' })
  await expect(save).toBeDisabled()

  await labels.getByRole('button', { name: 'Add label' }).click()
  const keys = labels.getByLabel('Key', { exact: true })
  await expect(keys).toHaveCount(4)
  // A new, empty row doesn't complain until something is typed.
  await expect(labels.locator('p.text-critical-text')).toHaveCount(0)
  await keys.nth(3).fill('-bad')
  await expect(labels).toContainText('Up to 63 letters, digits')
  await keys.nth(3).fill('Bad Prefix/team')
  await expect(labels).toContainText('The prefix must be a DNS subdomain')
  await keys.nth(3).fill('app.kubernetes.io/part-of')
  await expect(labels).toContainText('This key is used twice')
  await keys.nth(3).fill('example.com/team')
  await labels.getByLabel('Value of example.com/team').fill('not ok!')
  await expect(labels).toContainText('Up to 63 letters')
  await labels.getByLabel('Value of example.com/team').fill('checkout-crew')
  await labels.getByLabel('Value of app.kubernetes.io/component').fill('web')
  await labels.getByRole('button', { name: 'Remove app.kubernetes.io/part-of' }).click()
  await expect(labels).toContainText('3 changes to save.')
  await expect(labels).toContainText(
    'kubectl label deployment/storefront app.kubernetes.io/part-of- app.kubernetes.io/component=web example.com/team=checkout-crew --overwrite',
  )

  await labels.getByRole('tab', { name: /annotations/ }).click()
  await labels.getByRole('button', { name: 'Add annotation' }).click()
  await labels.getByLabel('Key', { exact: true }).last().fill('example.com/owner')
  // Annotation values can be anything.
  await labels.getByLabel('Value of example.com/owner').fill('Shop team <shop@example.com>')
  await expect(labels).toContainText('4 changes to save.')
  await expect(labels).toContainText('kubectl annotate deployment/storefront')
  await save.click()
  await expect(toasts(page)).toContainText('Updated the labels and annotations of storefront')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT)[0]!.body).toEqual({
    metadata: {
      labels: {
        'app.kubernetes.io/part-of': null,
        'app.kubernetes.io/component': 'web',
        'example.com/team': 'checkout-crew',
      },
      annotations: { 'example.com/owner': 'Shop team <shop@example.com>' },
    },
  })
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText('Restored the labels and annotations of storefront')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT)[1]!.body).toEqual({
    metadata: {
      labels: {
        'example.com/team': null,
        'app.kubernetes.io/component': 'frontend',
        'app.kubernetes.io/part-of': 'shop',
      },
      annotations: { 'example.com/owner': null },
    },
  })

  // Objects without any, and a single change.
  await open(page, 'Secrets', 'feature-flags')
  await menuAction(page, 'Secret', 'feature-flags', 'Edit labels…')
  await expect(dialog(page)).toContainText('No labels yet.')
  await dialog(page)
    .getByRole('tab', { name: /annotations/ })
    .click()
  await expect(dialog(page)).toContainText('No annotations yet.')
  await dialog(page).getByRole('button', { name: 'Add annotation' }).click()
  await dialog(page).getByLabel('Key', { exact: true }).fill('note')
  await expect(dialog(page)).toContainText('1 change to save.')
  await dialog(page).getByRole('button', { name: 'Remove note' }).click()
  await dialog(page).getByRole('button', { name: 'Add annotation' }).click()
  await dialog(page).getByRole('button', { name: 'Remove new key' }).click()
  await page.keyboard.press('Escape')
})
