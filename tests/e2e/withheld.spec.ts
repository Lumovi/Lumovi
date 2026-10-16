/**
 * Fields a plugin's view withholds: what Lumovi never shows nor hands over. Trivy's
 * ExposedSecretReport on its own CRD, whose `report.secrets[].match` is the line around a secret
 * it found, and a stand-in for trivy-operator that withholds it. The field reaches nothing: the
 * list and its CSV, the YAML tab and its copy, the object's other tabs, a plugin's code by a read
 * and as its list is kept up to date, an assistant's tools; nothing writes it back or blanks it;
 * and neither the plugin kept out, by its person or by a policy, nor another file's view of the
 * kind without it, brings it back.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AssistantsStatus } from '../../src/shared/assistants.ts'
import { unreadSaid, WITHHELD_EDIT, WITHHELD_PATCH } from '../../src/shared/withheld.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import {
  finding,
  KIND,
  LAST_APPLIED,
  report,
  REPORT,
  scanned,
  SECRET,
} from '../mock-cluster/fixtures/trivy.ts'
import { toasts } from './action-helpers.ts'
import {
  clipboardText,
  expect,
  hoverForTooltip,
  openCluster,
  panel,
  row,
  test,
} from './fixtures.ts'

const LABEL = 'ExposedSecretReports'
/** kubectl's annotation, as a JSON patch's path names it. */
const LAST_APPLIED_AT = `/metadata/annotations/${LAST_APPLIED.replace('/', '~1')}`
const WHY = 'The line around a secret Trivy found.'
/** What the YAML tab says of it. */
const SAID = `Lumovi doesn’t show report.secrets[].match here: trivy-operator’s file withholds it. It says: ${WHY}`

/**
 * A stand-in for trivy-operator, as one of Lumovi's own (in the place of the one it comes with):
 * Trivy's view of its reports, withholding the match. With a page, for its code to read them.
 */
const TRIVY = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: trivy-operator }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  label: Trivy
  kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
  pages: [{ id: overview, title: Overview }]
  views:
    - name: trivy-exposed-secret-reports
      kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      columns:
        - { name: Resource, path: ".metadata.labels['trivy-operator.resource.name']" }
        - { name: Critical, path: .report.summary.criticalCount, type: number }
      withholds:
        - { path: report.secrets.match, why: ${WHY} }
`

/** The stand-ins' folder, with trivy-operator's file and, where given, its code. */
function included(code?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'trivy-operator.yaml'), TRIVY)
  if (code) writeFileSync(join(folder, 'trivy-operator.js'), code)
  return folder
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

/** The report's list in shop, open. */
async function openReports(page: Page) {
  await go(page, `#/cluster/demo/r/${KIND}?namespaces=shop`)
  await expect(row(page, LABEL, REPORT)).toBeVisible()
}

/** Everything the window has: its page and what's drawn in it. */
const everything = (page: Page) => page.evaluate(() => document.documentElement.outerHTML)

/** What the page is handed for the report: by a read of it, and by a read of its list. */
function handed(page: Page) {
  return page.evaluate(
    async ({ kind, name }) => {
      const kube = window.lumovi!.kube
      return JSON.stringify([
        await kube.get({ context: 'demo', kind, namespace: 'shop', name }),
        await kube.list({ context: 'demo', kind, namespace: 'shop' }),
      ])
    },
    { kind: KIND, name: REPORT },
  )
}

/** Answers the save dialog with `file`. */
async function saveAs(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: file,
    })) as unknown as typeof dialog.showSaveDialog
  }, file)
}

test('a withheld field reaches neither the page, nor its copy, nor its CSV; the YAML tab says whose file withholds it, and Edit is off', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const { page, app } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await openReports(page)
  // What it's handed: every finding but its match, and nothing of kubectl's copy of it either.
  const given = await handed(page)
  expect(given).toContain('aws-access-key-id')
  expect(given).not.toContain(SECRET)
  expect(given).not.toContain(LAST_APPLIED)
  // No column of the cluster's shows it, as no column could: the view's own are the list's.
  await expect(page.getByRole('grid', { name: LABEL })).toContainText('storefront')
  await expect(page.getByRole('columnheader', { name: 'First match' })).toHaveCount(0)

  // Its CSV.
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-csv-')), 'reports.csv')
  await saveAs(app, file)
  await page.getByRole('button', { name: 'Columns', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Columns' })
    .getByRole('button', { name: 'Download CSV' })
    .click()
  await expect(toasts(page)).toContainText('Saved reports.csv')
  const csv = readFileSync(file, 'utf8')
  expect(csv).toContain(REPORT)
  expect(csv).not.toContain(SECRET)

  // The YAML tab: the findings, without it, and why; and its copy.
  await row(page, LABEL, REPORT).click()
  const detail = panel(page, 'ExposedSecretReport', REPORT)
  await detail.getByRole('tab', { name: 'YAML' }).click()
  const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
  await expect(yaml).toContainText('ruleID: aws-access-key-id')
  await expect(yaml).not.toContainText(SECRET)
  await expect(yaml).not.toContainText('match:')
  await expect(detail.getByRole('list', { name: 'Fields Lumovi doesn’t show' })).toHaveText(SAID)
  await detail.getByRole('button', { name: 'Copy YAML' }).click()
  await expect.poll(() => clipboardText(page)).toContain('ruleID: aws-access-key-id')
  expect(await clipboardText(page)).not.toContain(SECRET)
  // Never edited whole here: what's sent would write it back, or blank it.
  const edit = detail.getByRole('button', { name: 'Edit', exact: true })
  await expect(edit).toBeDisabled()
  await hoverForTooltip(edit.locator('..'), WITHHELD_EDIT)
  // Nor from the object's own Edit YAML.
  await expect(detail.getByRole('button', { name: 'Edit YAML' })).toBeDisabled()

  // Its other tabs.
  for (const tab of ['Map', 'Audit']) {
    await detail.getByRole('tab', { name: tab, exact: true }).click()
    await expect(detail.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  }
  expect(await everything(page)).not.toContain(SECRET)
})

test('nothing sends a withheld field back or blanks it: an edit whole, an apply and a patch of it refused, dry run or not; a label still changes', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await openReports(page)
  const change = (change: object, dryRun = false, name: string | undefined = REPORT) =>
    page.evaluate((request) => window.lumovi!.kube.change(request as never), {
      context: 'demo',
      kind: KIND,
      namespace: 'shop',
      name,
      dryRun,
      change,
    })
  // The object as the page has it: an edit of it would send it back without its match.
  const shown = JSON.parse(await handed(page))[0].data as KubeObject
  for (const dryRun of [true, false]) {
    for (const asked of [
      { action: 'replace', object: shown },
      { action: 'apply', object: shown, fieldManager: 'lumovi', force: true },
    ]) {
      const answer = await change(asked, dryRun)
      expect(answer, `${asked.action} ${dryRun}`).toMatchObject({
        ok: false,
        error: { code: 'invalid', message: WITHHELD_EDIT },
      })
    }
    // A patch that writes it, blanks it, or reads it a guess at a time or into a label.
    for (const [patchType, patch] of [
      ['merge', { report: { secrets: [] } }],
      ['merge', { report: null }],
      ['json', [{ op: 'copy', from: '/report/secrets/0/match', path: '/metadata/labels/x' }]],
      ['json', [{ op: 'test', path: '/report/secrets/0/match', value: 'AWS' }]],
      ['json', [{ op: 'remove', path: '/report/secrets/1/match' }]],
      // Out of kubectl's annotation, which holds every field, or what holds it.
      ['json', [{ op: 'copy', from: LAST_APPLIED_AT, path: '/metadata/labels/x' }]],
      ['json', [{ op: 'copy', from: '/metadata/annotations', path: '/report/note' }]],
      ['json', [{ op: 'move', from: '/metadata', path: '/report/note' }]],
      ['json', [{ op: 'test', path: LAST_APPLIED_AT, value: '{' }]],
      ['json', [{ op: 'remove', path: '/metadata/annotations' }]],
      ['merge', { metadata: { annotations: null } }],
      ['merge', { metadata: { annotations: { [LAST_APPLIED]: '{}' } } }],
    ] as const) {
      expect(
        await change({ action: 'patch', patchType, patch }, dryRun),
        JSON.stringify(patch),
      ).toMatchObject({ ok: false, error: { code: 'invalid', message: WITHHELD_PATCH } })
    }
  }
  // A label, by the same patches as Edit labels sends: changed, and answered without it.
  const labelled = await change({
    action: 'patch',
    patchType: 'merge',
    patch: { metadata: { labels: { team: 'payments' } } },
  })
  expect(labelled.ok).toBe(true)
  expect(JSON.stringify(labelled)).not.toContain(SECRET)
  // And as a JSON patch, with the test of the object's version Lumovi sends: another added, it
  // removed.
  const version = clusters.demo.object(KIND, 'shop', REPORT)!.metadata.resourceVersion
  const guarded = await change({
    action: 'patch',
    patchType: 'json',
    patch: [
      { op: 'test', path: '/metadata/resourceVersion', value: version },
      { op: 'add', path: '/metadata/labels/tier', value: 'front' },
      { op: 'remove', path: '/metadata/labels/team' },
    ],
  })
  expect(guarded.ok).toBe(true)
  expect(JSON.stringify(guarded)).not.toContain(SECRET)
  await change({
    action: 'patch',
    patchType: 'merge',
    patch: { metadata: { labels: { team: 'payments' } } },
  })
  // In the cluster, what was withheld is as it was: nothing blanked it.
  const kept = clusters.demo.object(KIND, 'shop', REPORT)!
  expect(kept.metadata.labels).toMatchObject({ team: 'payments', tier: 'front' })
  expect(kept.metadata.annotations?.[LAST_APPLIED]).toContain(SECRET)
  expect((kept.report as { secrets: { match: string }[] }).secrets.map((s) => s.match)).toEqual([
    `AWS_ACCESS_KEY_ID=${SECRET}-1`,
    `AWS_ACCESS_KEY_ID=${SECRET}-2`,
  ])
  // One made, its answer without it too; and what the cluster says of a change that fails is
  // Lumovi's words alone (it can quote the object).
  const made = await change(
    { action: 'create', object: report('another', [finding(3)]) },
    true,
    undefined,
  )
  expect(made.ok).toBe(true)
  expect(JSON.stringify(made)).not.toContain(SECRET)
  const missing = await change(
    { action: 'patch', patchType: 'merge', patch: { metadata: { labels: { a: 'b' } } } },
    false,
    'not-there',
  )
  expect(missing).toMatchObject({
    ok: false,
    error: { code: 'not-found', message: 'There’s no such object.' },
  })
})

test('a list of a thousand findings, and a report that comes as the list is watched: each without it, each time it’s read', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  clusters.demo.upsert(
    report(
      'thousand',
      Array.from({ length: 1000 }, (_, i) => finding(i)),
    ),
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await openReports(page)
  const listed = await page.evaluate(
    (kind) => window.lumovi!.kube.list({ context: 'demo', kind, namespace: 'shop' }),
    KIND,
  )
  const thousand = listed.ok
    ? (listed.data.items.find((item) => item.metadata.name === 'thousand') as
        { report: { secrets: object[] } } | undefined)
    : undefined
  expect(thousand!.report.secrets).toHaveLength(1000)
  expect(thousand!.report.secrets.every((s) => !('match' in s) && 'ruleID' in s)).toBe(true)
  expect(JSON.stringify(listed)).not.toContain(SECRET)

  // One more, as Trivy writes it: the list is told, reads it again, and has it without it.
  clusters.demo.upsert(report('checkout', [finding(7, `${SECRET}-NEW`)]))
  await expect(row(page, LABEL, 'checkout')).toBeVisible({ timeout: 15_000 })
  await row(page, LABEL, 'checkout').click()
  const detail = panel(page, 'ExposedSecretReport', 'checkout')
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await expect(detail).toContainText('ruleID: aws-access-key-id')
  expect(await everything(page)).not.toContain(SECRET)
})

/**
 * The stand-in's code: it reads its reports in shop, kept up to date, and shows in a Field what
 * it was handed: their names, whether the findings came, and whether the secret did.
 */
const READING = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1], ['make', 100, 'Field', { name: 'read 1', value: '' }], ['put', 1, 100]])
  listen((text) => {
    const said = JSON.parse(text)
    if (said.read !== 1) return
    const value = said.objects
      ? '|' + said.objects.map((o) => o.object.metadata.name).sort().join('|') + '| ' +
        (text.includes('aws-access-key-id') ? 'findings' : 'no findings') + ' ' +
        (text.includes(${JSON.stringify(SECRET)}) || text.includes('last-applied') ? 'LEAKED' : 'withheld')
      : 'ended ' + said.ended
    commit([['change', 100, { name: 'read 1', value }]])
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: 'aquasecurity.github.io/ExposedSecretReport', namespace: 'shop' }))
})`

test('a plugin’s code reads its own kind whole but for what’s withheld: by a read, and as the list is kept up to date', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const folder = included()
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  writeFileSync(join(folder, 'trivy-operator.js'), READING)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(
    (shown) =>
      (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show(
        shown,
      ),
    { plugin: 'trivy-operator', name: 'Trivy', version: '9.0.0', context: 'demo' },
  )
  const read = page.locator('[data-part="Field"]').filter({ hasText: 'read 1' })
  await expect(read).toContainText(`|${REPORT}| findings withheld`)
  // Another, as the list is kept up to date.
  clusters.demo.upsert(report('checkout', [finding(7, `${SECRET}-NEW`)]))
  await expect(read).toContainText(`|checkout|${REPORT}| findings withheld`, { timeout: 15_000 })
})

/** Turns assistants on, on a port of the test's own, and connects one. */
async function assistant(page: Page): Promise<Client> {
  const port = await new Promise<number>((resolve) => {
    // (A port nothing listens on, for now.)
    void import('node:net').then(({ createServer }) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number }
        server.close(() => resolve(port))
      })
    })
  })
  const status: AssistantsStatus = await page.evaluate(
    (port) => window.lumovi!.assistants!.configure({ enabled: true, port }),
    port,
  )
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
  return client
}

const answer = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  return (result.content[0] as { text: string }).text
}

test('an assistant’s tools read the report without it: the object, a field of it asked by name, and its list', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  const client = await assistant(page)
  const kind = 'exposedsecretreports.aquasecurity.github.io'
  const object = await answer(client, 'get_resource', {
    cluster: 'demo',
    kind,
    name: REPORT,
    namespace: 'shop',
  })
  expect(object).toContain('ruleID: aws-access-key-id')
  const asked = await answer(client, 'get_resource', {
    cluster: 'demo',
    kind,
    name: REPORT,
    namespace: 'shop',
    fields: ['report.secrets.match', 'report.secrets.ruleID'],
  })
  expect(asked).toContain('aws-access-key-id')
  const listed = await answer(client, 'list_resources', {
    cluster: 'demo',
    kind,
    namespace: 'shop',
  })
  expect(listed).toContain(REPORT)
  for (const text of [object, asked, listed]) expect(text).not.toContain(SECRET)
  await client.close()
})

test('neither the plugin kept out, by its person or by a policy, nor another file’s view of its kind without it, brings it back', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const policy = (said: object) => {
    const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
    writeFileSync(path, JSON.stringify(said))
    return path
  }
  // A person's own file, read after it, of the same kind with nothing withheld.
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  mkdirSync(join(userDataDir, 'plugins'), { recursive: true })
  writeFileSync(
    join(userDataDir, 'plugins', 'my-reports.yaml'),
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: my-reports }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      details: [{ name: Match, path: '.report.secrets[*].match' }]
`,
  )
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ pluginCode: { 'trivy-operator': false } }),
  )
  for (const env of [
    {},
    { LUMOVI_POLICY: policy({ plugins: 'off' }) },
    { LUMOVI_POLICY: policy({ pluginsAllowed: ['argo-cd'] }) },
    { LUMOVI_POLICY: policy({ plugins: 'bundled' }) },
  ]) {
    const lumovi = await launch({
      userDataDir,
      env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(), ...env },
    })
    const { page } = lumovi
    await openCluster(page)
    await openReports(page)
    const given = await handed(page)
    expect(given, JSON.stringify(env)).toContain('aws-access-key-id')
    expect(given, JSON.stringify(env)).not.toContain(SECRET)
    await row(page, LABEL, REPORT).click()
    const detail = panel(page, 'ExposedSecretReport', REPORT)
    await detail.getByRole('tab', { name: 'YAML' }).click()
    await expect(detail.getByRole('list', { name: 'Fields Lumovi doesn’t show' })).toHaveText(SAID)
    expect(await everything(page), JSON.stringify(env)).not.toContain(SECRET)
    await lumovi.close()
  }
})

test('while a plugin file doesn’t read, nothing of the groups it names is shown, nor of any where it names none; read again once it does', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const folder = join(userDataDir, 'plugins')
  mkdirSync(folder, { recursive: true })
  // A file of Trivy's group with a key this Lumovi doesn't know: what it withholds can't be told.
  const broken = join(folder, 'my-scans.yaml')
  writeFileSync(
    broken,
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: my-scans }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      withholds: [{ path: report.secrets.target }]
      colour: blue
`,
  )
  const { page } = await launch({
    userDataDir,
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  const read = () =>
    page.evaluate(
      async ({ kind, name, widget }) => {
        const kube = window.lumovi!.kube
        return {
          report: await kube.get({ context: 'demo', kind, namespace: 'shop', name }),
          reports: await kube.list({ context: 'demo', kind, namespace: 'shop' }),
          widget: await kube.get({
            context: 'demo',
            kind: 'Widget.example.com',
            namespace: 'default',
            name: widget,
          }),
          pods: await kube.list({ context: 'demo', kind: 'Pod', namespace: 'shop' }),
        }
      },
      { kind: KIND, name: REPORT, widget: CUSTOM.widget },
    )
  const refused = { ok: false, error: { message: unreadSaid('my-scans.yaml') } }
  // Its group's: refused, saying why. Another group's, and Kubernetes' own: as ever.
  let now = await read()
  expect(now.report).toMatchObject(refused)
  expect(now.reports).toMatchObject(refused)
  expect(now.widget.ok).toBe(true)
  expect(now.pods.ok).toBe(true)
  expect(JSON.stringify(now)).not.toContain(SECRET)
  // Not even YAML: it may be of any group.
  writeFileSync(broken, 'spec: [\n')
  now = await read()
  expect(now.report).toMatchObject(refused)
  expect(now.widget).toMatchObject(refused)
  expect(now.pods.ok).toBe(true)
  // Whole again: read again, and what it and trivy-operator withhold are both withheld.
  writeFileSync(
    broken,
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: my-scans }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      withholds: [{ path: report.secrets.target }]
`,
  )
  now = await read()
  expect(now.report.ok).toBe(true)
  expect(now.widget.ok).toBe(true)
  const given = JSON.stringify(now.report)
  expect(given).toContain('aws-access-key-id')
  expect(given).not.toContain(SECRET)
  expect(given).not.toContain('/app/.env')
})
