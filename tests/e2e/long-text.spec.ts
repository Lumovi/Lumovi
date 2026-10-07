/**
 * Long text stays in its place: every page, and the panel of what each lists, with names,
 * labels, images and messages as long as Kubernetes lets them be (the "long" cluster), in a
 * wide window and a narrow one. Nothing spills over what's beside it, is cut short without an
 * ellipsis, or is drawn over other text (see long-text.ts).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { LONG, longCluster } from '../mock-cluster/fixtures/long.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { open } from './action-helpers.ts'
import { expect, goTo, mockOpenExternal, test } from './fixtures.ts'
import { misplaced } from './long-text.ts'

/** A context named as long as people name them. */
const CONTEXT =
  'arn:aws:eks:eu-central-1:123456789012:cluster/a-production-cluster-with-a-long-name'

/** Waits for what loads, and for what moves to stop. */
async function settle(page: Page) {
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"], .animate-pulse'), null, {
      timeout: 5_000,
    })
    .catch(() => undefined)
  await page.waitForTimeout(400)
}

for (const size of ['wide', 'narrow'] as const) {
  test(`long text stays in its place, everywhere (${size})`, async ({ launch }, testInfo) => {
    test.setTimeout(15 * 60_000)
    const cluster = await startMockCluster({
      fixture: () => longCluster(),
      gitVersion: 'v1.34.1',
      tls: true,
    })
    const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-long-')), {
      currentContext: CONTEXT,
      clusters: [{ name: `${CONTEXT}-cluster`, server: cluster.url, caPem: cluster.caPem }],
      users: [{ name: `${CONTEXT}-user`, token: 'a-token' }],
      contexts: [{ name: CONTEXT, cluster: `${CONTEXT}-cluster`, user: `${CONTEXT}-user` }],
    })
    const { page, app } = await launch({
      env: { KUBECONFIG: kubeconfig },
      fullLayout: size === 'wide',
    })
    if (size === 'narrow') {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700),
      )
    }
    const found = new Map<string, string[]>()
    let shot = 0
    const look = async (where: string) => {
      for (const problem of await misplaced(page)) {
        found.set(problem, [...(found.get(problem) ?? []), where])
      }
    }
    const check = async (where: string) => {
      await settle(page)
      await look(where)
      // And what's further down: each place that scrolls, a screenful at a time.
      const scrollers = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-sweep]')) el.removeAttribute('data-sweep')
        const all = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => {
          const s = getComputedStyle(el)
          return (
            ['auto', 'scroll'].includes(s.overflowY) &&
            el.scrollHeight > el.clientHeight + 40 &&
            el.clientHeight > 100 &&
            !el.closest('.xterm, .cm-editor')
          )
        })
        all.forEach((el, i) => el.setAttribute('data-sweep', String(i)))
        return all.length
      })
      for (let i = 0; i < scrollers; i++) {
        const scroller = page.locator(`[data-sweep="${i}"]`)
        for (let step = 1; step <= 8; step++) {
          const moved = await scroller.evaluate((el) => {
            const before = el.scrollTop
            el.scrollTop += el.clientHeight * 0.9
            return el.scrollTop !== before
          })
          if (!moved) break
          await page.waitForTimeout(150)
          await look(`${where} (scrolled)`)
        }
        await scroller.evaluate((el) => (el.scrollTop = 0)).catch(() => undefined)
      }
      await page.screenshot({
        path: testInfo.outputPath(
          `${String(++shot).padStart(3, '0')}-${where.replace(/\W+/g, '-')}.png`,
        ),
      })
    }

    await check('start screen')
    await page.getByRole('option', { name: new RegExp(CONTEXT.slice(0, 20)) }).click()
    await check('overview')
    await page.getByRole('button', { name: 'Namespace', exact: true }).click()
    await check('namespace picker')
    await page.getByPlaceholder('Find a namespace…').fill(LONG.namespace.slice(0, 30))
    await page.keyboard.press('Enter')

    /** Opens what the page lists first, and looks at each tab of its panel. */
    const panels = async (where: string) => {
      await settle(page)
      const rows = page
        .getByRole('grid')
        .first()
        .getByRole('row')
        .filter({ has: page.getByRole('gridcell') })
      if (!(await rows.count())) return
      await rows.first().getByRole('gridcell').nth(1).click()
      // The panel: what's beside the list, with tabs.
      const side = page
        .getByRole('complementary')
        .filter({ has: page.getByRole('tablist') })
        .last()
      if (
        !(await side.waitFor({ timeout: 5_000 }).then(
          () => true,
          () => false,
        ))
      )
        return
      const tabs = side.getByRole('tab')
      for (let i = 0; i < (await tabs.count()); i++) {
        const name = (await tabs.nth(i).innerText()).trim()
        // A shell starts a process in the cluster; its terminal draws itself.
        if (/shell/i.test(name)) continue
        await tabs.nth(i).click()
        await check(`${where} › panel › ${name}`)
      }
      await page.keyboard.press('Escape')
    }

    const sidebar = page.getByRole('navigation', { name: 'Resources' })
    const links = sidebar.getByRole('link')
    for (let i = 0; i < (await links.count()); i++) {
      const link = links.nth(i)
      const name = (await link.innerText()).trim().split('\n')[0]!.trim()
      await link.click()
      await settle(page)
      if (name === 'Workloads') {
        const kinds = page.getByRole('navigation', { name: 'Workload types' }).getByRole('link')
        for (let k = 0; k < (await kinds.count()); k++) {
          const kind = (await kinds.nth(k).innerText()).trim().split('\n')[0]!
          await kinds.nth(k).click()
          await check(`Workloads › ${kind}`)
          await panels(`Workloads › ${kind}`)
        }
        continue
      }
      await check(name)
      await panels(name)
    }

    // What opens over a page: menus, popovers, the palette, dialogs.
    await mockOpenExternal(app)
    const over = async (where: string, open: () => Promise<unknown>) => {
      await open()
      await check(where)
      await page.keyboard.press('Escape')
      await settle(page)
    }
    await over('cluster switcher', () =>
      page.getByRole('button', { name: 'Switch cluster' }).click(),
    )
    await over('activity', () => page.getByRole('button', { name: 'Activity' }).click())
    await over('create from YAML', () =>
      page.getByRole('button', { name: /^Create from YAML/ }).click(),
    )
    await over('theme menu', () => page.getByRole('button', { name: 'Theme' }).click())
    await over('command palette', async () => {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('a-')
    })
    await over('keyboard shortcuts', () => page.keyboard.press('ControlOrMeta+/'))

    /** Each of a panel's actions, and the dialog each opens. */
    const actions = async (where: string) => {
      const side = page
        .getByRole('complementary')
        .filter({ has: page.getByRole('tablist') })
        .last()
      const bar = side.locator('header')
      const buttons = bar.getByRole('button')
      const names = (
        await buttons.evaluateAll((all) =>
          all.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''),
        )
      ).filter(
        (name) =>
          name && !/^(More actions|Copy name|Expand panel|Restore panel|Close|Shell)/.test(name),
      )
      for (const name of names) {
        await bar.getByRole('button', { name, exact: true }).first().click()
        if (
          await page
            .getByRole('dialog')
            .isVisible()
            .catch(() => false)
        ) {
          await check(`${where} › ${name}`)
        }
        await page.keyboard.press('Escape')
        await settle(page)
      }
      const more = bar.getByRole('button', { name: 'More actions' })
      if (!(await more.count())) return
      await more.click()
      await check(`${where} › more actions`)
      const items = (await page.getByRole('menuitem').allInnerTexts()).map(
        (t) => t.trim().split('\n')[0]!,
      )
      await page.keyboard.press('Escape')
      for (const item of items) {
        // What happens at once (no dialog) isn't for here.
        if (/^(Shell|Open|Copy|Port forward|Debug)/.test(item)) continue
        await more.click()
        await page.getByRole('menuitem', { name: item }).first().click()
        if (
          await page
            .getByRole('dialog')
            .isVisible()
            .catch(() => false)
        ) {
          await check(`${where} › ${item}`)
          await page.keyboard.press('Escape')
        }
        await settle(page)
      }
    }
    for (const [list, name] of [
      ['Deployments', LONG.deployment],
      ['StatefulSets', LONG.statefulSet],
      ['CronJobs', LONG.cronJob],
      ['Jobs', LONG.job],
      ['Pods', 'a-pod-that-cannot-pull'],
      ['Nodes', LONG.node.slice(0, 30)],
      ['Services', LONG.service],
      ['ConfigMaps', LONG.configMap.slice(0, 30)],
      ['Secrets', LONG.secret.slice(0, 30)],
      ['Ingresses', LONG.ingress],
      ['Namespaces', LONG.namespace],
    ] as const) {
      await open(page, list, name)
      await actions(list)
      await page.keyboard.press('Escape')
    }
    await goTo(page, 'Helm releases')
    await over('install chart', () => page.getByRole('button', { name: 'Install chart' }).click())
    await page.getByRole('row').filter({ hasText: LONG.release }).first().click()
    await actions('Helm release')
    await page.keyboard.press('Escape')

    // Many picked at once: what can be done to them all.
    await goTo(page, 'Pods')
    await page.getByRole('grid').first().getByRole('checkbox').first().check()
    await check('pods, all picked')
    await page.keyboard.press('Escape')

    // The terminal dock, with the cluster's long name on its tab.
    await page.keyboard.press('Control+Backquote')
    await check('terminal dock')
    await page.keyboard.press('Control+Backquote')

    // Last: the audit log is a page of its own, away from the cluster.
    await page.getByRole('button', { name: 'Audit log' }).click()
    await check('audit log')

    const report = [...found].map(([problem, where]) => `${problem}\n    at ${where.join(', ')}`)
    console.log(`${size}: ${report.length} problems\n${report.join('\n')}`)
    expect(report).toEqual([])
  })
}
