/**
 * Fields a plugin's view withholds, on a server: what its folder's file withholds of Trivy's
 * reports reaches neither the page nor its YAML tab, nor an assistant, and isn't written back.
 * The file isn't the one in use for the kind (trivy-operator, which Lumovi comes with, is): what
 * it withholds holds all the same.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WITHHELD_EDIT } from '../../src/shared/withheld.ts'
import { KIND, REPORT, scanned, SECRET } from '../mock-cluster/fixtures/trivy.ts'
import { call, connect } from './assistant-client.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

const WHY = 'Never on a page.'

/** A server's file of a view of Trivy's reports: data, withholding the match. */
const SCANS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: my-scans }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      withholds: [{ path: report.secrets.match, why: ${WHY} }]
`

test('on a server, a field its folder’s file withholds reaches neither the page, its YAML tab nor an assistant, and isn’t written back', async ({
  page,
  serve,
  clusters,
}) => {
  scanned(clusters.demo)
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-plugins-'))
  writeFileSync(join(folder, 'my-scans.yaml'), SCANS)
  const served = await serve({ env: { LUMOVI_PLUGINS_DIR: folder } })
  await signIn(page, `${served.url}cluster/demo/r/${KIND}?namespaces=shop`, DEMO_TOKEN)

  // What the page is handed: the findings, without the match.
  const given = await page.evaluate(
    async ({ kind, name }) => {
      const kube = window.lumovi!.kube
      return JSON.stringify([
        await kube.get({ context: 'demo', kind, namespace: 'shop', name }),
        await kube.list({ context: 'demo', kind, namespace: 'shop' }),
      ])
    },
    { kind: KIND, name: REPORT },
  )
  expect(given).toContain('aws-access-key-id')
  expect(given).not.toContain(SECRET)

  // The YAML tab, and why.
  const grid = page.getByRole('grid', { name: 'ExposedSecretReports' })
  await grid.getByRole('row').filter({ hasText: REPORT }).click()
  const detail = page.getByRole('complementary', { name: `ExposedSecretReport ${REPORT}` })
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await expect(detail.getByRole('tabpanel', { name: 'YAML' })).toContainText(
    'ruleID: aws-access-key-id',
  )
  await expect(detail.getByRole('list', { name: 'Fields Lumovi doesn’t show' })).toHaveText(
    `Lumovi doesn’t show report.secrets[].match here: my-scans’s file withholds it. It says: ${WHY}`,
  )
  await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET)

  // Not written back whole.
  const replaced = await page.evaluate(
    async ({ kind, name }) => {
      const kube = window.lumovi!.kube
      const got = await kube.get({ context: 'demo', kind, namespace: 'shop', name })
      return kube.change({
        context: 'demo',
        kind,
        namespace: 'shop',
        name,
        change: { action: 'replace', object: got.ok ? got.data : ({} as never) },
      })
    },
    { kind: KIND, name: REPORT },
  )
  expect(replaced).toMatchObject({ ok: false, error: { message: WITHHELD_EDIT } })
  expect(
    (clusters.demo.object(KIND, 'shop', REPORT)!.report as { secrets: { match: string }[] })
      .secrets[0]!.match,
  ).toContain(SECRET)

  // An assistant's read, as the person signed in.
  const { client } = await connect(page, served)
  const read = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'exposedsecretreports.aquasecurity.github.io',
    name: REPORT,
    namespace: 'shop',
  })
  expect(read.text).toContain('aws-access-key-id')
  expect(read.text).not.toContain(SECRET)
  await client.close()
})
