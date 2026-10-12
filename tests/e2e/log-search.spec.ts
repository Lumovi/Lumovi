/**
 * Searching logs: a regular expression, matching case, the lines without it, stepping between
 * matches; a since typed as a duration or a time; the lines over time, and a stretch of them
 * picked. On a workload's logs, every pod's merged. No search runs on the page's own thread: one
 * that would never end is stopped, and the page answers all the while.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/kubeconfig.ts'
import { placed } from '../placed.ts'
import { open, toasts } from './action-helpers.ts'
import { expect, openCluster, panel, test } from './fixtures.ts'

const PODS = DEMO.pods.storefront

async function workloadLogs(page: Page) {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await expect(detail.getByRole('log')).toContainText(/\S/)
  return detail
}

/** The search field, and its toggles, count and steps. */
const searchOf = (detail: Locator) => ({
  field: detail.getByLabel('Search logs'),
  regex: detail.getByRole('button', { name: 'Regular expression' }),
  matchCase: detail.getByRole('button', { name: 'Match case' }),
  without: detail.getByRole('button', { name: 'Show lines without a match' }),
})

/** The lines drawn, as text (a few: the log draws only those in and near its view). */
const shownLines = (detail: Locator) =>
  detail.getByRole('log').locator('[data-level]').allInnerTexts()

/**
 * How many lines the log keeps: the last one's place, read with the log at its end. Not how many
 * it draws, which is as many as its view holds, however many lines there are.
 */
async function linesKept(detail: Locator): Promise<number> {
  const log = detail.getByRole('log')
  await log.evaluate(
    (element) =>
      new Promise((drawn) => {
        element.scrollTop = element.scrollHeight
        // (It draws for a scroll a frame later.)
        requestAnimationFrame(() => requestAnimationFrame(drawn))
      }),
  )
  const places = await log
    .locator('[data-index]')
    .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute('data-index'))))
  return Math.max(-1, ...places) + 1
}

/** Answers the save dialog with `file`, and keeps what it was asked with. */
function saveAs(app: ElectronApplication, file: string) {
  return app.evaluate(({ dialog }, file) => {
    // (Asked with its window first, or with its options alone.)
    dialog.showSaveDialog = (async (...args: { defaultPath?: string }[]) => {
      ;(globalThis as { asked?: string }).asked = args.at(-1)?.defaultPath
      return { canceled: false, filePath: file }
    }) as unknown as typeof dialog.showSaveDialog
  }, file)
}

test('a workload’s logs searched: an expression, matching case, the lines without it, and steps between matches', async ({
  lumovi: { page },
  clusters,
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', ['Order 1001 PAID', 'order 1002 paid'])
  clusters.demo.appendLogs('shop', PODS[1]!, 'app', ['Order 1003 REFUNDED', 'order 1004 paid'])
  clusters.demo.appendLogs('shop', PODS[2]!, 'app', ['search-check health ok'])
  await expect(detail.getByRole('log')).toContainText('search-check health ok')
  const search = searchOf(detail)

  // An expression, across every pod's lines, whatever their case.
  await search.regex.click()
  await expect(search.regex).toHaveAttribute('aria-pressed', 'true')
  await search.field.fill('order 10\\d+ paid')
  await expect.poll(() => shownLines(detail)).toHaveLength(3)
  for (const line of ['Order 1001 PAID', 'order 1002 paid', 'order 1004 paid']) {
    await expect(detail.getByRole('log')).toContainText(line)
  }
  await expect(detail.getByText('3 matches', { exact: true })).toBeVisible()
  await expect(detail.getByRole('log').locator('mark')).toHaveText([
    'Order 1001 PAID',
    'order 1002 paid',
    'order 1004 paid',
  ])
  // Stepping: Enter to the first, on to the next, and round again from the last.
  await search.field.press('Enter')
  await expect(detail.getByText('1 of 3', { exact: true })).toBeVisible()
  await expect(detail.getByRole('log').locator('mark[data-current]')).toHaveText('Order 1001 PAID')
  await search.field.press('Shift+Enter')
  await expect(detail.getByText('3 of 3', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Next match' }).click()
  await expect(detail.getByText('1 of 3', { exact: true })).toBeVisible()

  // Matching case.
  await search.matchCase.click()
  await expect.poll(() => shownLines(detail)).toHaveLength(2)
  await expect(detail.getByRole('log')).not.toContainText('Order 1001 PAID')

  // Without it: every other line, and nothing marked or stepped to.
  await search.without.click()
  await expect(detail.getByText('Without', { exact: true })).toBeVisible()
  await expect(detail.getByRole('log')).toContainText('Order 1001 PAID')
  await expect(detail.getByRole('log')).toContainText('search-check health ok')
  await expect(detail.getByRole('log')).not.toContainText('order 1002 paid')
  await expect(detail.getByRole('log').locator('mark')).toHaveCount(0)
  await expect(detail.getByText(/^\d[\d,]* lines$/)).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Next match' })).toHaveCount(0)

  // Escape takes the text away and leaves the toggles as they are.
  await search.field.press('Escape')
  await expect(search.field).toHaveValue('')
  await expect(search.without).toHaveAttribute('aria-pressed', 'true')
  await expect(detail.getByRole('log')).toContainText('order 1002 paid')
  await search.without.click()
})

test('an expression that isn’t one says why, and the lines stay as the last one left them', async ({
  lumovi: { page },
  clusters,
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', ['invalid-check alpha', 'invalid-check beta'])
  await expect(detail.getByRole('log')).toContainText('invalid-check beta')
  const search = searchOf(detail)
  await search.regex.click()
  await search.field.fill('invalid-check (alpha|beta)')
  await expect.poll(() => shownLines(detail)).toHaveLength(2)
  for (const [typed, why] of [
    ['invalid-check (alpha', 'This isn’t a regular expression: a ( isn’t closed.'],
    ['invalid-check [ab', 'This isn’t a regular expression: a [ isn’t closed.'],
    ['invalid-check \\', 'This isn’t a regular expression: a \\ ends it.'],
    ['*invalid-check', 'This isn’t a regular expression: there’s nothing for * to repeat.'],
    ['invalid-check (?<a>x)(?<a>y)', 'This isn’t a regular expression Lumovi can use.'],
  ]) {
    await search.field.fill(typed!)
    await expect(detail.getByRole('alert')).toHaveText(why!)
    await expect(search.field).toHaveAttribute('aria-invalid', 'true')
    // Nothing is cleared: the last expression that worked still says what's shown.
    await expect.poll(() => shownLines(detail)).toHaveLength(2)
  }
  // The same text, as plain text: there's no line with it, and nothing to say.
  await search.regex.click()
  await expect(detail.getByRole('alert')).toHaveCount(0)
  await expect(detail.getByText('No lines match “invalid-check (?<a>x)(?<a>y)”.')).toBeVisible()
})

test('an expression that would never end is stopped, and the page answers all the while', async ({
  lumovi: { page },
  clusters,
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  // Many a's and then not one: (a+)+$ tries every way to share them out before it gives up.
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', [`slow-check ${'a'.repeat(40)}!`])
  await expect(detail.getByRole('log')).toContainText('slow-check')
  const search = searchOf(detail)
  await search.regex.click()
  await search.field.fill('slow-check')
  await expect.poll(() => shownLines(detail)).toHaveLength(1)
  await search.field.fill('(a+)+$')
  await expect(detail.getByRole('alert')).toContainText(
    /^This expression took too long on [\d,]+ lines, so Lumovi stopped it\. Try a simpler one\. The lines are from the last one that worked\.$/,
  )
  // The page's own thread was never held: it answers at once, and the lines are the last ones.
  const answered = await page.evaluate(() => {
    const asked = performance.now()
    return new Promise<number>((done) => setTimeout(() => done(performance.now() - asked), 0))
  })
  expect(answered).toBeLessThan(200)
  await expect.poll(() => shownLines(detail)).toHaveLength(1)
  // Another expression is searched again.
  await search.field.fill('slow-check a+!')
  await expect(detail.getByRole('alert')).toHaveCount(0)
  await expect(detail.getByRole('log').locator('mark')).toHaveCount(1)
})

test('a since typed: a duration or a time, read back before it’s used; a long one keeps the last of it, and says so', async ({
  lumovi: { page },
  clusters,
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  await detail.getByRole('button', { name: 'Show', exact: true }).click()
  await page.getByRole('option', { name: 'Since…' }).click()
  const field = page.getByLabel('Since', { exact: true })
  const showIt = page.getByRole('button', { name: 'Show', exact: true }).last()
  await field.fill('90x')
  await expect(page.getByText('Not a duration or a time Lumovi reads.')).toBeVisible()
  await expect(showIt).toBeDisabled()
  await field.fill('2999-01-01 00:00')
  await expect(page.getByText('That’s still to come: pick a time before now.')).toBeVisible()
  await expect(showIt).toBeDisabled()
  await field.fill('90m')
  await expect(
    page.getByText(/^From \d\d:\d\d (today|yesterday), 90 minutes ago, your time \(UTC.*\)\.$/),
  ).toBeVisible()
  await showIt.click()
  await expect(detail.getByRole('button', { name: 'Show', exact: true })).toHaveText(
    'Last 90 minutes',
  )
  await expect
    .poll(() =>
      clusters.demo.requests.some(
        (r) =>
          r.path.endsWith(`/pods/${PODS[1]}/log`) &&
          r.query.sinceSeconds === '5400' &&
          // (Three containers share the 20,000 the view keeps.)
          r.query.tailLines === '6666',
      ),
    )
    .toBe(true)

  // One container, a date and time, and more lines since than the view keeps: the last of
  // them, and a line saying where the rest went.
  clusters.demo.appendLogs(
    'shop',
    PODS[0]!,
    'app',
    Array.from({ length: 20_050 }, (_, i) => `ceiling-check ${i}`),
  )
  await open(page, 'Pods', PODS[0]!)
  const pod = panel(page, 'Pod', PODS[0]!)
  await pod.getByRole('tab', { name: 'Logs' }).click()
  await pod.getByRole('button', { name: 'Show', exact: true }).click()
  await page.getByRole('option', { name: 'Since…' }).click()
  await page.getByLabel('Since', { exact: true }).fill('2020-01-01 00:00')
  await page.getByRole('button', { name: 'Show', exact: true }).last().click()
  await expect(pod.getByRole('button', { name: 'Show', exact: true })).toHaveText(
    'Since 1 Jan 2020 00:00',
  )
  await expect(pod.getByRole('note')).toHaveText(
    'Showing the last 20,000 lines since 1 Jan 2020 00:00. Pick a later time to see every line from it.',
  )
  // (From that moment, in the person's own time, and only the last of it.)
  expect(
    clusters.demo.requests.some(
      (r) =>
        r.path.endsWith('/log') &&
        Date.parse(r.query.sinceTime ?? '') === new Date(2020, 0, 1).getTime() &&
        r.query.tailLines === '20000',
    ),
  ).toBe(true)
})

test('what’s downloaded is what’s shown, named as a part of the log', async ({
  lumovi: { page, app },
  clusters,
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  clusters.demo.appendLogs('shop', PODS[0]!, 'app', ['download-check kept', 'download-check gone'])
  await expect(detail.getByRole('log')).toContainText('download-check gone')
  await searchOf(detail).field.fill('download-check kept')
  await expect.poll(() => shownLines(detail)).toHaveLength(1)
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-logs-')), 'saved.log')
  await saveAs(app, file)
  await detail.getByRole('button', { name: 'Download' }).click()
  await expect(toasts(page)).toContainText(`Saved the logs of ${DEMO.deployments.storefront}`)
  expect(await app.evaluate(() => (globalThis as { asked?: string }).asked)).toMatch(
    new RegExp(`${DEMO.deployments.storefront}-filtered\\.log$`),
  )
  const saved = readFileSync(file, 'utf8')
  expect(saved).toContain('download-check kept')
  expect(saved).not.toContain('download-check gone')
})

test('the lines over time: a stretch picked shows only its lines, stops following, and goes again', async ({
  lumovi: { page },
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  const strip = detail.getByRole('group', { name: /^Lines over time/ })
  await expect(strip).toBeVisible()
  const before = await linesKept(detail)
  // Dragged across a stretch of it.
  const box = await placed(strip)
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  const chip = detail.getByLabel(/^Only lines from \d\d:\d\d to \d\d:\d\d$/)
  await expect(chip).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Follow' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect.poll(() => linesKept(detail)).toBeLessThan(before)
  await chip.getByRole('button', { name: 'Show all times again' }).click()
  await expect(chip).toHaveCount(0)
  // (All of them again, and those written since.)
  await expect.poll(() => linesKept(detail)).toBeGreaterThanOrEqual(before)
  // By keys: a cursor bar, widened, picked; Escape lets it go.
  await strip.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(chip).toBeVisible()
  await strip.press('Escape')
  await expect(chip).toHaveCount(0)
})

test('the toggles’ keys work in the field, where a layout doesn’t type a letter with them', async ({
  lumovi: { page },
}) => {
  await openCluster(page)
  const detail = await workloadLogs(page)
  const search = searchOf(detail)
  await search.field.focus()
  await page.keyboard.press('Alt+KeyR')
  await expect(search.regex).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Alt+KeyR')
  await expect(search.regex).toHaveAttribute('aria-pressed', 'false')
  await expect(search.field).toHaveValue('')
  // A layout whose Option C types ć: the key is the letter's, the toggle stays as it was, and
  // its tooltip stops naming the key.
  await search.field.dispatchEvent('keydown', {
    key: 'ć',
    code: 'KeyC',
    altKey: true,
    bubbles: true,
  })
  await expect(search.matchCase).toHaveAttribute('aria-pressed', 'false')
  await search.matchCase.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Match case')
})
