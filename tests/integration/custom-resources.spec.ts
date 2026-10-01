/**
 * Custom resources on a real API server: discovery, Table output with a
 * CRD's printer columns, OpenAPI v3 schemas, validation, the status and scale
 * subresources, and the views KubeStacks ships, against what
 * kube-prometheus-stack installed.
 */
import type { Page } from '@playwright/test'
import { dialog, menuAction, toasts } from '../e2e/action-helpers.ts'
import { panel, row } from '../e2e/fixtures.ts'
import { expect, freshNamespace, get, inNamespace, kubectl, test } from './fixtures.ts'

const NS = 'it-custom'
const GROUP = 'integration.kubestacks.dev'
const CRD = `gadgets.${GROUP}`

/** A CRD of our own, with what CRDs can have: columns, validation, status and scale. */
const DEFINITION = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: CRD },
  spec: {
    group: GROUP,
    names: { kind: 'Gadget', plural: 'gadgets', singular: 'gadget', shortNames: ['gdg'] },
    scope: 'Namespaced',
    versions: [
      {
        name: 'v1',
        served: true,
        storage: true,
        additionalPrinterColumns: [
          { name: 'Size', type: 'integer', jsonPath: '.spec.size' },
          { name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas' },
          { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
        ],
        subresources: {
          status: {},
          scale: { specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas' },
        },
        schema: {
          openAPIV3Schema: {
            type: 'object',
            properties: {
              spec: {
                type: 'object',
                properties: {
                  size: {
                    type: 'integer',
                    minimum: 1,
                    description: 'How big the gadget is, in gadget units.',
                  },
                  replicas: { type: 'integer', minimum: 0 },
                },
              },
              status: {
                type: 'object',
                properties: {
                  replicas: { type: 'integer' },
                  conditions: {
                    type: 'array',
                    items: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

/** Opens a custom kind's list from its API group on the API resources page. */
async function openKind(page: Page, group: string, label: string) {
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await page
    .getByRole('rowgroup', { name: group, exact: true })
    .getByRole('button', { name: new RegExp(`^${label}\\b`) })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
}

async function createFromYaml(page: Page, yaml: string) {
  await page.keyboard.press('ControlOrMeta+n')
  await dialog(page).getByRole('textbox', { name: 'YAML to create' }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(yaml)
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
}

const gadget = (size: number) => `apiVersion: ${GROUP}/v1
kind: Gadget
metadata:
  name: spinner
  namespace: ${NS}
spec:
  size: ${size}
  replicas: 1
`

test.beforeAll(() => {
  kubectl(['delete', 'crd', CRD, '--ignore-not-found', '--wait'])
  freshNamespace(NS, [])
})

test('a CRD of one’s own, end to end', async ({ page }) => {
  // A new CRD: the app finds it once the API server serves it.
  kubectl(['apply', '-f', '-'], JSON.stringify(DEFINITION))
  kubectl(['wait', '--for=condition=Established', `crd/${CRD}`, '--timeout=60s'])
  await page.reload()
  await inNamespace(page, NS)
  await openKind(page, GROUP, 'Gadgets')
  await expect(page.getByText(`No Gadgets in ${NS}`)).toBeVisible()

  // The real API server validates against the CRD's schema.
  await createFromYaml(page, gadget(0))
  await expect(dialog(page).getByRole('list', { name: 'Results' })).toContainText(
    'spec.size: Invalid value: 0: spec.size in body should be greater than or equal to 1',
  )
  await page.keyboard.press('Escape')
  await createFromYaml(page, gadget(3))
  await expect(toasts(page)).toContainText('Created gadget spinner')

  // Its printer columns, as the API server computes them.
  const spinner = row(page, 'Gadgets', 'spinner')
  await expect(page.getByRole('columnheader', { name: 'Size' })).toBeVisible()
  await expect(spinner).toContainText('3')

  // Its schema explains its fields.
  await spinner.getByRole('gridcell').nth(1).click()
  const detail = panel(page, 'Gadget', 'spinner')
  await detail.getByRole('tree', { name: 'Spec' }).getByText('size').hover()
  await expect(page.getByRole('tooltip')).toContainText('How big the gadget is')

  // Scaling goes through its scale subresource.
  await detail.getByRole('button', { name: 'Scale' }).click()
  await expect(dialog(page).getByLabel('Replicas', { exact: true })).toHaveValue('1')
  await dialog(page).getByLabel('Replicas', { exact: true }).fill('4')
  await dialog(page).getByRole('button', { name: 'Scale', exact: true }).click()
  await expect(toasts(page)).toContainText('Scaled spinner to 4 replicas')
  await expect.poll(() => get(`gadgets.${GROUP}`, 'spinner', '-n', NS).spec.replicas).toBe(4)

  // A controller's status, in the usual conventions, shows as its status.
  kubectl([
    'patch',
    `gadgets.${GROUP}/spinner`,
    '-n',
    NS,
    '--subresource=status',
    '--type=merge',
    '-p',
    JSON.stringify({
      status: {
        replicas: 4,
        conditions: [{ type: 'Ready', status: 'False', reason: 'Calibrating', message: 'Almost' }],
      },
    }),
  ])
  await expect(detail.locator('header')).toContainText('Calibrating', { timeout: 30_000 })

  // Deleting the CRD takes its objects with it, and the kind leaves the sidebar.
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'API resources' })
    .click()
  await page
    .getByRole('region', { name: 'Kubernetes' })
    .getByRole('button', { name: /^CustomResourceDefinitions/ })
    .click()
  await page.getByPlaceholder('Filter CustomResourceDefinitions').fill(CRD)
  await row(page, 'CustomResourceDefinitions', CRD).getByRole('gridcell').nth(1).click()
  await menuAction(page, 'CustomResourceDefinition', CRD, 'Delete…')
  await expect(dialog(page)).toContainText('Every Gadget in the cluster is deleted with it')
  await dialog(page).getByRole('textbox').fill(CRD)
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  // It leaves the sidebar too, where it was among the kinds opened lately.
  await expect(sidebar(page).getByRole('link', { name: 'Gadgets' })).toHaveCount(0, {
    timeout: 60_000,
  })
  expect(kubectl(['get', 'crd', '-o', 'name'])).not.toContain(CRD)
})

test('the Prometheus operator’s kinds, through KubeStacks’ views of them', async ({ page }) => {
  await openKind(page, 'monitoring.coreos.com', 'Prometheuses')
  const prometheus = row(page, 'Prometheuses', 'kps-kube-prometheus-stack-prometheus')
  await expect(prometheus).toContainText('Available')
  await expect(prometheus).toContainText(/v\d+\.\d+/)
  await openKind(page, 'monitoring.coreos.com', 'ServiceMonitors')
  await expect(row(page, 'ServiceMonitors', 'kps-kube-prometheus-stack-apiserver')).toContainText(
    'https',
  )
})
