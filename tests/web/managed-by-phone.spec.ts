/**
 * What manages a workload, on a phone: a fact of its row whenever something does, after the
 * kind's first, its manager's name cut in its middle where it's long; on the second line where
 * the first can't hold its least, and never under the age.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const FLUX = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: flux }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [kustomize.toolkit.fluxcd.io]
  views:
    - kinds: [{ group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]
      manages:
        - labels:
            kustomize.toolkit.fluxcd.io/name: '{{ .metadata.name }}'
            kustomize.toolkit.fluxcd.io/namespace: '{{ .metadata.namespace }}'
`
const LONG = 'platform-observability-shared-infrastructure-eu-west'
const WIDE = 'observability-platform-shared-services'

test('a phone’s row says what manages a workload: on what’s left of its line, or the second', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  const plugins = join(served.helmDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'flux.yaml'), FLUX)
  clusters.demo.upsert({
    apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
    kind: 'Kustomization',
    metadata: { name: LONG, namespace: 'flux-system', creationTimestamp: new Date().toISOString() },
    spec: { path: './platform' },
  })
  const storefront = structuredClone(
    clusters.demo.object('Deployment', 'shop', 'storefront')!,
  ) as KubeObject
  storefront.metadata.labels = {
    ...storefront.metadata.labels,
    'kustomize.toolkit.fluxcd.io/name': LONG,
    'kustomize.toolkit.fluxcd.io/namespace': 'flux-system',
  }
  clusters.demo.upsert(storefront)
  // The same, in a namespace whose name leaves too little of the line for its least.
  const wide = structuredClone(storefront)
  wide.metadata = { ...wide.metadata, name: 'ledger', namespace: WIDE, uid: 'ledger-uid' }
  clusters.demo.upsert(wide)
  await signInNarrow(page, `${served.url}cluster/demo/deployments`, DEMO_TOKEN)
  const rows = page.getByRole('list', { name: 'Deployments' }).getByRole('listitem')
  const managed = rows.filter({ hasText: /^storefront/ })
  // All of the name is there to read; what's drawn is its start and its end.
  await expect(managed.getByRole('button')).toHaveAccessibleName(
    new RegExp(`shop · 3/3 ready · Managed by ${LONG}`),
  )
  await expect(managed.locator('[aria-hidden]').filter({ hasText: '…' })).toHaveText(
    /^platform-.*….*-west$/,
  )
  // On the first line, after the namespace and how many are ready, "Managed by" whole, and
  // nothing of it under the age; the image on the second line. (Measured until it's settled.)
  await expect(async () => {
    const at = await placed(managed, /^shop · 3\/3 ready/)
    expect(Math.abs(at.fact.y - at.first.y)).toBeLessThan(2)
    expect(at.fact.x).toBeGreaterThan(at.first.x + at.first.width - 2)
    expect(at.fact.x + at.fact.width).toBeLessThanOrEqual(at.age.x)
    expect(at.label.width).toBeGreaterThan(40)
    const image = (await managed.getByTitle(/^ghcr\.io\//).boundingBox())!
    expect(image.y).toBeGreaterThanOrEqual(at.first.y + at.first.height - 1)
  }).toPass()
  // Where its least doesn't fit after them, it starts the second line, still before the age.
  const ledger = rows.filter({ hasText: /^ledger/ })
  await expect(ledger.getByRole('button')).toHaveAccessibleName(
    new RegExp(`${WIDE} · 3/3 ready · Managed by ${LONG}`),
  )
  await expect(async () => {
    const moved = await placed(ledger, new RegExp(`^${WIDE}`))
    expect(moved.fact.y).toBeGreaterThanOrEqual(moved.first.y + moved.first.height - 1)
    expect(Math.abs(moved.fact.x - moved.first.x)).toBeLessThan(2)
    expect(moved.fact.x + moved.fact.width).toBeLessThanOrEqual(moved.age.x)
    expect(moved.label.width).toBeGreaterThan(40)
  }).toPass()
  // A row nothing manages says nothing of it.
  await expect(rows.filter({ hasText: /^cart/ })).not.toContainText('Managed by')
})

/** Where a row's facts are drawn: those it starts with, the manager's and its words, the age. */
async function placed(row: Locator, first: RegExp) {
  const box = async (locator: Locator) => {
    await expect(locator).toBeVisible()
    return (await locator.boundingBox())!
  }
  return {
    first: await box(row.getByText(first)),
    fact: await box(row.getByTitle(/^Kustomization flux-system\//)),
    label: await box(row.getByText('Managed by', { exact: true }).filter({ visible: true })),
    age: await box(row.getByText(/^(\d+[ydhms])+$/)),
  }
}
