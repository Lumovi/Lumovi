/**
 * A plugin's code turned off on the desktop: by the person, on the Plugins page ("Run its code"),
 * and by the organization's policy, which can also leave plugins out, or a person's own, or all
 * of them, and keep any plugin's page from proposing a change or showing a Secret.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Node, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
`
/** Toys' code: told its page, it draws an empty Table titled so (one of Lumovi's own parts). */
const CODE = `box.then(({ post, listen }) => {
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open && said.open.page) {
      post(JSON.stringify({ commit: [['make', 1, 'Table', { title: 'Running', columns: [{ name: 'Name', kind: 'text' }], headings: true, rows: [] }], ['put', 0, 1]] }))
    }
  })
})`
/** Another of Lumovi's own, with no code. */
const PLAIN = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: plain }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [plain.example.com]
  label: Plain
  kinds: [{ group: plain.example.com, kind: Gadget }]
`

function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  writeFileSync(join(folder, 'toys.js'), CODE)
  writeFileSync(join(folder, 'plain.yaml'), PLAIN)
  return folder
}

/** A policy file, as IT would deploy it (LUMOVI_POLICY points at it, for trying one out). */
function policyFile(policy: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const toysPage = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
const plugins = `#/cluster/${CONTEXTS.demo}/plugins`
const running = (page: Page) => page.getByRole('region', { name: 'Running' })
const ended = (page: Page) => page.getByTestId('plugin-ended')
const runItsCode = (page: Page) =>
  page.locator('[data-plugin-code-switch="toys"]').getByRole('switch', { name: 'Run its code' })
/** What the one call that hands code over answers now, without the code. */
const handOver = (page: Page) => page.evaluate(() => window.lumovi!.kube.pluginHandOver('toys'))

test('“Run its code”: off, its page is Lumovi’s place and its code is never handed; on, it runs again', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, toysPage)
  await expect(running(page)).toBeVisible()

  // Its entry: the switch first, on, with what its code does in its file's words.
  await go(page, `${plugins}?plugin=toys`)
  await expect(runItsCode(page)).toBeChecked()
  await expect(page.locator('[data-plugin-code-switch="toys"]')).toContainText(
    'Draws its overview. It reads Nodes as you, and changes nothing.',
  )
  // One without code has no switch.
  await expect(page.locator('[data-plugin-code-switch="plain"]')).toHaveCount(0)

  // What a page of it was handed, which its reads name.
  const handed = (await page.evaluate(() => window.lumovi!.kube.pluginCode('toys'))) as {
    digest: string
    codeDigest: string
  }
  // Off: the row says so, quietly, and the backend hands nothing over.
  await runItsCode(page).click()
  await expect(runItsCode(page)).not.toBeChecked()
  await expect(page.locator('[data-plugin-code-off="toys"]')).toHaveText(
    'Its pages don’t run: you turned off its code.',
  )
  expect(await handOver(page)).toBe('turned-off')
  expect(await page.evaluate(() => window.lumovi!.kube.pluginCode('toys'))).toEqual({
    ok: false,
    refused: 'turned-off',
  })
  // Nor does it read for a page of it still open: refused at the door, as a proposal is.
  expect(
    await page.evaluate(
      ({ digest, codeDigest }) =>
        window.lumovi!.kube.pluginRead({
          plugin: 'toys',
          digest,
          codeDigest,
          context: 'demo',
          kind: 'example.com/Widget',
        } as never),
      handed,
    ),
  ).toEqual({ ok: false, refused: 'code-off' })

  // Its page: Lumovi's place, not a fault, with no strip of the plugin's, and the way back.
  await go(page, toysPage)
  await expect(ended(page)).toHaveAttribute('data-why', 'not-handed')
  await expect(ended(page).getByRole('heading')).toHaveText('You turned off its code.')
  await expect(ended(page)).toContainText('Turn it on in Plugins to see this page.')
  await expect(ended(page)).not.toContainText('The rest of Lumovi')
  await expect(page.getByText('This page is from the plugin')).toHaveCount(0)
  await expect(running(page)).toHaveCount(0)
  // "Open Plugins": its entry, opened, its switch focused.
  await ended(page).getByRole('link', { name: 'Open Plugins' }).click()
  await expect(runItsCode(page)).toBeFocused()

  // On again, kept across a restart of the page: it runs.
  await runItsCode(page).click()
  await expect(runItsCode(page)).toBeChecked()
  expect(await handOver(page)).toBe(true)
  await go(page, toysPage)
  await expect(running(page)).toBeVisible()
})

test('the choice is kept with the person’s settings, and a name that isn’t a plugin with code is refused', async ({
  launch,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const env = { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() }
  const first = await launch({ env, userDataDir })
  await openCluster(first.page)
  const settings = await first.page.evaluate(() => window.lumovi!.app.setPluginCode('toys', false))
  expect(settings.pluginCode).toEqual({ toys: false })
  for (const [name, on] of [
    ['plain', false],
    ['nobody', false],
    ['Not A Name', false],
    ['toys', 'no'],
  ] as const) {
    await expect(
      first.page.evaluate(([name, on]) => window.lumovi!.app.setPluginCode(name, on as boolean), [
        name,
        on,
      ] as const),
      name,
    ).rejects.toThrow()
  }
  await first.app.close()
  const again = await launch({ env, userDataDir })
  await openCluster(again.page)
  expect(await handOver(again.page)).toBe('turned-off')
})

test('the organization’s policy: no plugin’s code, locked off however the person would turn it on', async ({
  launch,
}) => {
  const { page } = await launch({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(),
      LUMOVI_POLICY: policyFile({ plugins: 'no-code' }),
    },
  })
  await openCluster(page)
  await go(page, toysPage)
  await expect(ended(page).getByRole('heading')).toHaveText(
    'Your organization’s policy doesn’t let plugins run code.',
  )
  await expect(ended(page).getByRole('link', { name: 'Open Plugins' })).toHaveCount(0)
  await go(page, `${plugins}?plugin=toys`)
  // Locked: off, dim, still reachable, saying whose it is; a press changes nothing.
  await expect(runItsCode(page)).not.toBeChecked()
  await expect(runItsCode(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(page.locator('[data-plugin-code-switch="toys"]')).toContainText(
    'Turned off by your organization’s policy.',
  )
  await runItsCode(page).focus()
  await page.keyboard.press('Space')
  await expect(runItsCode(page)).not.toBeChecked()
  await expect(page.evaluate(() => window.lumovi!.app.setPluginCode('toys', true))).rejects.toThrow(
    'Your organization’s policy doesn’t let plugins run code.',
  )
  expect(await handOver(page)).toBe('off-by-policy')
})

test('the organization’s policy: only the plugins it names, only Lumovi’s own, or none at all', async ({
  launch,
}) => {
  const folder = included()
  // A person's own plugin, beside Lumovi's.
  const own = mkdtempSync(join(tmpdir(), 'lumovi-own-'))
  writeFileSync(
    join(own, 'mine.yaml'),
    PLAIN.replaceAll('plain', 'mine').replaceAll('Plain', 'Mine'),
  )
  const listed = async (policy: unknown) => {
    const { page, app } = await launch({
      env: {
        LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder,
        LUMOVI_PLUGINS_DIR: own,
        LUMOVI_POLICY: policyFile(policy),
      },
    })
    await openCluster(page)
    await go(page, plugins)
    const rows = page.locator('[data-plugin-row]')
    await expect(rows.first()).toBeVisible()
    const names = await rows.allInnerTexts()
    const code = await handOver(page)
    // (Where it names the plugins allowed, the page says the others aren't shown, naming none.)
    const allowedOnly = await page.locator('[data-plugins-allowed-only]').allInnerTexts()
    await app.close()
    // (Each row's name, without the version beside it.)
    return { names: names.map((text) => text.replace(/\d[\d.]*$/, '').trim()), code, allowedOnly }
  }
  const named = await listed({ pluginsAllowed: ['plain'] })
  expect(named.names).toContain('Plain')
  expect(named.names).not.toContain('Toys')
  expect(named.names).not.toContain('Mine')
  // Not there: its code isn't a plugin's in use.
  expect(named.code).toBe('not-in-use')
  expect(named.allowedOnly).toEqual([
    'Your organization’s policy allows only some plugins here: the others aren’t shown.',
  ])
  const bundled = await listed({ plugins: 'bundled' })
  expect(bundled.names).toEqual(expect.arrayContaining(['Plain', 'Toys']))
  expect(bundled.names).not.toContain('Mine')
  expect(bundled.code).toBe(true)
  expect(bundled.allowedOnly).toEqual([])
  // None at all: the page says there are none, and nothing's code is anyone's.
  const { page } = await launch({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder,
      LUMOVI_PLUGINS_DIR: own,
      LUMOVI_POLICY: policyFile({ plugins: 'off' }),
    },
  })
  await openCluster(page)
  await go(page, plugins)
  await expect(page.locator('[data-plugin-row]')).toHaveCount(0)
  expect(await handOver(page)).toBe('not-in-use')
})

test('the organization’s policy: no plugin’s page proposes a change or shows a Secret’s keys', async ({
  launch,
}) => {
  const { page } = await launch({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(),
      LUMOVI_POLICY: policyFile({ pluginProposals: 'off', pluginSecrets: 'off' }),
    },
  })
  await openCluster(page)
  // Asked at the door before anything else: refused, with the policy's word.
  expect(
    await page.evaluate(() =>
      window.lumovi!.kube.pluginChange({
        step: 'check',
        plugin: 'toys',
        digest: 'x',
        codeDigest: 'y',
        press: 'z',
        context: 'demo',
        proposal: { action: 'delete', target: 't' },
      } as never),
    ),
  ).toEqual({ ok: false, refused: 'off-by-policy' })
  expect(
    await page.evaluate(() =>
      window.lumovi!.kube.secretValues({
        forPlugin: 'toys',
        namedBy: { kind: 'example.com/Widget', path: 'spec.secretRef.name' },
        context: 'demo',
        namespace: 'default',
        name: 'anything',
        keys: ['token'],
      } as never),
    ),
  ).toEqual({
    ok: false,
    error: {
      code: 'not-allowed',
      message: 'Your organization’s policy doesn’t let plugins show what’s in Secrets.',
    },
  })
})
