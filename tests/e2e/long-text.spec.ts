/**
 * Long text stays in its place: every page, and the panel of what each lists, with names,
 * labels, images and messages as long as Kubernetes lets them be (the "long" cluster), in a
 * wide window and a narrow one. Nothing spills over what's beside it, is cut short without an
 * ellipsis, or is drawn over other text (see long-text.ts).
 *
 * In parts, each its own app on the cluster, so that they run beside each other: the start and
 * the overview; the sidebar's pages, every SIDEBAR_PARTS-th link from a part's own (so the parts
 * together are every link, however many there are); what opens over a page; and each list's
 * panel actions, in ACTION_PARTS.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { LONG, longCluster } from '../mock-cluster/fixtures/long.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { open } from './action-helpers.ts'
import { expect, goTo, mockOpenExternal, openTab, tabNames, test } from './fixtures.ts'
import { misplaced } from './long-text.ts'

/** A context named as long as people name them. */
const CONTEXT =
  'arn:aws:eks:eu-central-1:123456789012:cluster/a-production-cluster-with-a-long-name'

/**
 * Waits for what loads, and for what moves to stop: nothing busy, no transition or animation
 * that ends still running (a spinner's never does), and then nothing changed for two frames.
 */
async function settle(page: Page) {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[aria-busy="true"], .animate-pulse') &&
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect?.getComputedTiming().iterations === Infinity,
          ),
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined)
  await quiet(page.locator('body'))
}

/**
 * Waits until nothing in `where` has changed for two frames (two seconds at most, by the clock:
 * a window covered by another draws no frames): what the last change set off, a list's rows
 * drawn as it scrolls, say, is in place.
 */
function quiet(where: Locator): Promise<void> {
  return where.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let changed = true
        const changes = new MutationObserver(() => (changed = true))
        changes.observe(element, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        })
        let finished = false
        const done = () => {
          finished = true
          clearTimeout(cap)
          changes.disconnect()
          resolve()
        }
        const cap = setTimeout(done, 2_000)
        let calm = 0
        const frame = () => {
          if (finished) return
          calm = changed ? 0 : calm + 1
          changed = false
          if (calm >= 2) done()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
  )
}

/** How many parts the sidebar's pages are looked at in, and the panels' actions. */
const SIDEBAR_PARTS = 6
const ACTION_PARTS = 3

type Size = 'wide' | 'narrow'

/**
 * Lumovi on the long cluster, in a window of `size`: what each part looks with (`check`, and
 * the problems it found, by where), and what it opens with.
 */
async function opened(
  launch: Parameters<Parameters<typeof test>[2]>[0]['launch'],
  size: Size,
  outputPath: (name: string) => string,
) {
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
        await quiet(scroller)
        await look(`${where} (scrolled)`)
      }
      await scroller.evaluate((el) => (el.scrollTop = 0)).catch(() => undefined)
    }
    await page.screenshot({
      path: outputPath(`${String(++shot).padStart(3, '0')}-${where.replace(/\W+/g, '-')}.png`),
    })
  }
  /** Into the cluster, its long-named namespace picked. */
  const intoTheCluster = async () => {
    await page.getByRole('option', { name: new RegExp(CONTEXT.slice(0, 20)) }).click()
    await page.getByRole('button', { name: 'Namespace', exact: true }).click()
    await page.getByPlaceholder('Find a namespace…').fill(LONG.namespace.slice(0, 30))
    await page.keyboard.press('Enter')
    await settle(page)
  }
  /** Every problem found, each with where; none, for the part to pass. */
  const report = (part: string) => {
    const lines = [...found].map(([problem, where]) => `${problem}\n    at ${where.join(', ')}`)
    console.log(`${size}, ${part}: ${lines.length} problems\n${lines.join('\n')}`)
    expect(lines).toEqual([])
  }
  return { page, app, check, intoTheCluster, report }
}

for (const size of ['wide', 'narrow'] as const) {
  test(`long text stays in its place (${size}): the start screen, the overview and its namespace picker`, async ({
    launch,
  }, testInfo) => {
    const { page, check, report } = await opened(launch, size, (name) => testInfo.outputPath(name))
    await check('start screen')
    await page.getByRole('option', { name: new RegExp(CONTEXT.slice(0, 20)) }).click()
    await check('overview')
    await page.getByRole('button', { name: 'Namespace', exact: true }).click()
    await check('namespace picker')
    report('start')
  })

  for (let part = 0; part < SIDEBAR_PARTS; part++) {
    test(`long text stays in its place (${size}): the sidebar's pages and their panels, part ${part + 1} of ${SIDEBAR_PARTS}`, async ({
      launch,
    }, testInfo) => {
      test.setTimeout(5 * 60_000)
      const { page, check, intoTheCluster, report } = await opened(launch, size, (name) =>
        testInfo.outputPath(name),
      )
      await intoTheCluster()

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
        // Every tab, those in More too.
        for (const name of await tabNames(side)) {
          // A shell starts a process in the cluster; its terminal draws itself.
          if (/shell/i.test(name)) continue
          await openTab(side, name)
          await check(`${where} › panel › ${name}`)
        }
        await page.keyboard.press('Escape')
      }

      // Every SIDEBAR_PARTS-th link, from this part's own: the parts together are every link.
      const sidebar = page.getByRole('navigation', { name: 'Resources' })
      const links = sidebar.getByRole('link')
      const count = await links.count()
      expect(count).toBeGreaterThan(SIDEBAR_PARTS)
      for (let i = part; i < count; i += SIDEBAR_PARTS) {
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
      report(`sidebar part ${part + 1}`)
    })
  }

  test(`long text stays in its place (${size}): what opens over a page, many picked, the terminal and the audit log`, async ({
    launch,
  }, testInfo) => {
    test.setTimeout(5 * 60_000)
    const { page, app, check, intoTheCluster, report } = await opened(launch, size, (name) =>
      testInfo.outputPath(name),
    )
    await intoTheCluster()
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
    await over('create from YAML', () => page.getByRole('button', { name: /^Create…/ }).click())
    await over('theme menu', () => page.getByRole('button', { name: 'Theme' }).click())
    await over('command palette', async () => {
      await page.keyboard.press('ControlOrMeta+k')
      await page.keyboard.type('a-')
    })
    await over('keyboard shortcuts', () => page.keyboard.press('ControlOrMeta+/'))
    await goTo(page, 'Helm releases')
    await over('install chart', () => page.getByRole('button', { name: 'Install chart' }).click())

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
    report('over a page')
  })

  /** Each list's object, and the Helm release, whose panel's actions and dialogs are looked at. */
  const OBJECTS = [
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
    ['Helm releases', LONG.release],
  ] as const
  for (let part = 0; part < ACTION_PARTS; part++) {
    test(`long text stays in its place (${size}): a panel's actions and their dialogs, part ${part + 1} of ${ACTION_PARTS}`, async ({
      launch,
    }, testInfo) => {
      test.setTimeout(5 * 60_000)
      const { page, app, check, intoTheCluster, report } = await opened(launch, size, (name) =>
        testInfo.outputPath(name),
      )
      await intoTheCluster()
      await mockOpenExternal(app)

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
          // (Not what's done at once, with no dialog: Pin, for one, and Keep open below.)
          (name) =>
            name &&
            !/^(More actions|Copy name|Expand panel|Restore panel|Close|Shell|Pin|Keep open below|Show below)/.test(
              name,
            ),
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
      // Every ACTION_PARTS-th object, from this part's own: the parts together are all of them.
      for (let i = part; i < OBJECTS.length; i += ACTION_PARTS) {
        const [list, name] = OBJECTS[i]!
        if (list === 'Helm releases') {
          await goTo(page, 'Helm releases')
          await page.getByRole('row').filter({ hasText: name }).first().click()
          await actions('Helm release')
        } else {
          await open(page, list, name)
          await actions(list)
        }
        await page.keyboard.press('Escape')
      }
      report(`actions part ${part + 1}`)
    })
  }
}
