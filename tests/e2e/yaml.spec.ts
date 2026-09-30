import type { Page } from '@playwright/test'
import { dialog, menuAction, open, toasts, writes } from './action-helpers.ts'
import { DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

/** Replaces everything in the open YAML editor. */
async function replaceYaml(page: Page, kind: string, name: string, yaml: string) {
  await panel(page, kind, name)
    .getByRole('textbox', { name: `YAML of ${name}` })
    .click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(yaml)
}

/** The editor's text, as CodeMirror renders it. */
const editorText = (page: Page, kind: string, name: string) =>
  panel(page, kind, name).getByRole('textbox', { name: `YAML of ${name}` })

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('edit an object as YAML: review the diff, then apply', async ({ page, clusters }) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = editorText(page, 'ConfigMap', 'storefront-config')
  await expect(editor).toBeFocused()
  // Server-managed fields are left out; the text is the object as written.
  await expect(editor).not.toContainText('resourceVersion')
  await expect(editor).not.toContainText('uid:')
  const review = detail.getByRole('button', { name: 'Review changes' })
  await expect(review).toBeDisabled()
  // ⌘S without changes does nothing.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail.getByRole('button', { name: 'Apply' })).toHaveCount(0)

  // Escape doesn't close the panel mid-edit, and the other tabs wait until it's done.
  await page.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  await detail.getByRole('tab', { name: 'Overview' }).click()
  await expect(editor).toBeVisible()

  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n  FEATURE_SEARCH: "on"')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail).toContainText('The cluster accepts this change')
  await expect(detail).toContainText('+1')
  await expect(detail).toContainText('−0')
  const changes = detail
    .getByRole('generic', { name: 'Changes' })
    .or(detail.locator('[aria-label="Changes"]'))
  await expect(changes.locator('[data-change="added"]')).toHaveText(/FEATURE_SEARCH: "on"/)
  await expect(changes.locator('[data-change="gap"]').first()).toContainText('unchanged lines')
  const path = '/api/v1/namespaces/shop/configmaps/storefront-config'
  expect(writes(clusters.demo, 'PUT', path)).toEqual([
    expect.objectContaining({ query: { dryRun: 'All' } }),
  ])

  // Back to editing keeps the change.
  await detail.getByRole('button', { name: 'Back to editing' }).click()
  await expect(editorText(page, 'ConfigMap', 'storefront-config')).toContainText('FEATURE_SEARCH')
  await page.keyboard.press('ControlOrMeta+s')
  await detail.getByRole('button', { name: 'Apply' }).click()
  await expect(toasts(page)).toContainText('Updated configmap storefront-config')
  const saved = writes(clusters.demo, 'PUT', path).at(-1)!
  expect(saved.query).toEqual({})
  expect(saved.body.data.FEATURE_SEARCH).toBe('on')
  // The edit is based on the version it started from.
  expect(saved.body.metadata.resourceVersion).toMatch(/^\d+$/)
  await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await expect(detail.getByRole('tabpanel', { name: 'YAML' })).toContainText('FEATURE_SEARCH')

  // A change at the top folds the unchanged lines after it.
  await detail.getByRole('button', { name: 'Edit', exact: true }).click()
  await editorText(page, 'ConfigMap', 'storefront-config').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.insertText('# Reviewed by the shop team\n')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(changes.locator('[data-change="added"]')).toHaveText(/# Reviewed by the shop team/)
  await expect(changes.locator('[data-change="gap"]')).toHaveCount(1)
  await detail.getByRole('button', { name: 'Back to editing' }).click()

  // Cancelling leaves things as they were.
  await detail.getByRole('button', { name: 'Cancel' }).click()
  await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
})

test('mistakes in the YAML are explained before anything is saved', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.cart)
  await menuAction(page, 'Deployment', DEMO.deployments.cart, 'Edit YAML')
  const detail = panel(page, 'Deployment', DEMO.deployments.cart)
  await expect(detail.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true')
  const text = await editorText(page, 'Deployment', DEMO.deployments.cart).innerText()

  await replaceYaml(page, 'Deployment', DEMO.deployments.cart, 'spec: [unclosed')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail.getByRole('alert')).toBeVisible()
  // Typing clears the message.
  await page.keyboard.type(']')
  await expect(detail.getByRole('alert')).toHaveCount(0)

  await replaceYaml(page, 'Deployment', DEMO.deployments.cart, '- just\n- a list')
  await detail.getByRole('button', { name: 'Review changes' }).click()
  await expect(detail.getByRole('alert')).toContainText('The YAML must describe a single object.')

  // The cluster's own validation, from a dry run.
  await replaceYaml(
    page,
    'Deployment',
    DEMO.deployments.cart,
    text.replace(/replicas: 2/, 'replicas: -1'),
  )
  await detail.getByRole('button', { name: 'Review changes' }).click()
  await expect(detail.getByRole('alert')).toContainText('spec.replicas: Invalid value: -1')
  expect(
    writes(clusters.demo, 'PUT', /deployments\/cart$/).every((w) => w.query.dryRun === 'All'),
  ).toBe(true)

  // Renaming isn't editing.
  await replaceYaml(
    page,
    'Deployment',
    DEMO.deployments.cart,
    text.replace(/name: cart\n/, 'name: basket\n'),
  )
  await detail.getByRole('button', { name: 'Review changes' }).click()
  await expect(detail.getByRole('alert')).toContainText('name does not match')
})

test('a change made meanwhile is caught, not overwritten', async ({ page, clusters }) => {
  await open(page, 'ConfigMaps', 'storefront-config')
  await menuAction(page, 'ConfigMap', 'storefront-config', 'Edit YAML')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await editorText(page, 'ConfigMap', 'storefront-config').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n  MINE: "yes"')

  // Someone else changes it.
  const theirs = structuredClone(clusters.demo.object('ConfigMap', 'shop', 'storefront-config')!)
  theirs.data = { ...(theirs.data as object), THEIRS: 'yes' }
  clusters.demo.upsert(theirs)

  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail.getByRole('alert')).toContainText('the object has been modified')
  // Fetching the latest can fail too.
  const clear = clusters.demo.fail('/api/v1/namespaces/shop/configmaps/storefront-config', {
    status: 503,
    body: 'unavailable',
  })
  await detail.getByRole('button', { name: 'Start over from the latest' }).click()
  await expect(detail.getByRole('alert')).toContainText('HTTP 503')
  clear()
  await detail.getByRole('button', { name: 'Start over from the latest' }).click()
  await expect(detail.getByRole('alert')).toHaveCount(0)
  await expect(editorText(page, 'ConfigMap', 'storefront-config')).toContainText('THEIRS')
  await expect(editorText(page, 'ConfigMap', 'storefront-config')).not.toContainText('MINE')

  // Refused when saving, e.g. because access changed after the review.
  await editorText(page, 'ConfigMap', 'storefront-config').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n  MINE: "yes"')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail.getByRole('button', { name: 'Apply' })).toBeVisible()
  clusters.demo.fail('/api/v1/namespaces/shop/configmaps/storefront-config', {
    status: 409,
    body: JSON.stringify({
      kind: 'Status',
      message: 'Operation cannot be fulfilled: the object has been modified',
    }),
  })
  await detail.getByRole('button', { name: 'Apply' }).click()
  await expect(detail.getByRole('alert')).toContainText('the object has been modified')
  await expect(detail.getByRole('button', { name: 'Review changes' })).toBeVisible()
})

test('secrets are edited as text and saved encoded', async ({ page, clusters }) => {
  await open(page, 'Secrets', 'java-keystore')
  await menuAction(page, 'Secret', 'java-keystore', 'Edit YAML')
  const editor = editorText(page, 'Secret', 'java-keystore')
  // Text values are readable; binary ones stay as they are.
  await expect(editor).toContainText('stringData:')
  await expect(editor).toContainText('password: changeit')
  await expect(editor).toContainText('keystore.p12: MIIKSwIBA//+gA==')
  const yaml = (await editor.innerText()).replace('password: changeit', 'password: s3cure')
  await replaceYaml(page, 'Secret', 'java-keystore', yaml)
  await page.keyboard.press('ControlOrMeta+s')
  await panel(page, 'Secret', 'java-keystore').getByRole('button', { name: 'Apply' }).click()
  await expect(toasts(page)).toContainText('Updated secret java-keystore')
  const saved = writes(clusters.demo, 'PUT', '/api/v1/namespaces/shop/secrets/java-keystore').at(
    -1,
  )!.body
  expect(saved.stringData).toBeUndefined()
  expect(saved.data).toEqual({ 'keystore.p12': 'MIIKSwIBA//+gA==', password: btoa('s3cure') })

  // A secret without data yet.
  await open(page, 'Secrets', 'feature-flags')
  await menuAction(page, 'Secret', 'feature-flags', 'Edit YAML')
  await expect(editorText(page, 'Secret', 'feature-flags')).toContainText('stringData: {}')
  await panel(page, 'Secret', 'feature-flags').getByRole('button', { name: 'Cancel' }).click()

  // A secret with only text; dropping stringData altogether empties it.
  await open(page, 'Secrets', DEMO.secrets.postgresCredentials)
  await menuAction(page, 'Secret', DEMO.secrets.postgresCredentials, 'Edit YAML')
  const text = await editorText(page, 'Secret', DEMO.secrets.postgresCredentials).innerText()
  await replaceYaml(
    page,
    'Secret',
    DEMO.secrets.postgresCredentials,
    text.replace(/stringData:[\s\S]*$/, ''),
  )
  await page.keyboard.press('ControlOrMeta+s')
  await panel(page, 'Secret', DEMO.secrets.postgresCredentials)
    .getByRole('button', { name: 'Apply' })
    .click()
  await expect(toasts(page)).toContainText(`Updated secret ${DEMO.secrets.postgresCredentials}`)
  expect(
    writes(
      clusters.demo,
      'PUT',
      `/api/v1/namespaces/data/secrets/${DEMO.secrets.postgresCredentials}`,
    ).at(-1)!.body.data,
  ).toEqual({})
})

test('an edit belongs to its object', async ({ page }) => {
  // Started from a row, the object opens in the editor.
  await goTo(page, 'ConfigMaps')
  await page.getByPlaceholder('Filter configmaps').fill('storefront-config')
  await row(page, 'ConfigMaps', 'storefront-config').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit YAML' }).click()
  await expect(editorText(page, 'ConfigMap', 'storefront-config')).toBeVisible()
  // Opening another object ends it; coming back shows the YAML, not the editor.
  await page.getByPlaceholder('Filter configmaps').fill('')
  await row(page, 'ConfigMaps', 'coredns').first().getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'ConfigMap', 'coredns')).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(panel(page, 'ConfigMap', 'storefront-config')).toBeVisible()
  await expect(editorText(page, 'ConfigMap', 'storefront-config')).toHaveCount(0)

  // Events can't be edited.
  await open(page, 'Events', 'NamespaceFinalizersRemaining')
  const event = page.getByRole('complementary', { name: /^Event / })
  await expect(event.getByRole('button', { name: 'More actions' })).toHaveCount(0)
  await event.getByRole('tab', { name: 'YAML' }).click()
  await expect(event.getByRole('button', { name: 'Copy YAML' })).toBeVisible()
  await expect(event.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(dialog(page)).toHaveCount(0)
})
