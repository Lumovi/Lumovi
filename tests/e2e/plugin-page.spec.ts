/**
 * A plugin's page, as Lumovi draws it: what a plugin's code describes goes through its box and
 * the door, and is drawn with Lumovi's own parts, under a strip that says whose it is; and when
 * it ends, its place says who ended it and why. Only test plugins of Lumovi's own run here, on
 * a stage the tests' build has: nothing in the app shows a plugin's page yet.
 */
import type { Page } from '@playwright/test'
import { BOX_LIMITS } from '../../src/shared/plugin-box.ts'
import { DOOR_LIMITS } from '../../src/shared/plugin-door.ts'
import { expect, test } from './fixtures.ts'

interface Shown {
  plugin: string
  name: string
  version: string
  code: string
  ended?: { why: string; said?: string }
}

/** Puts a test plugin's page on the stage. */
async function show(page: Page, shown: Partial<Shown> & { code: string }) {
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(
    (shown) =>
      (window as unknown as { __lumoviDoor: { show(shown: Shown): void } }).__lumoviDoor.show(
        shown,
      ),
    { plugin: 'karpenter', name: 'Karpenter', version: '1.0.0', ...shown },
  )
}

/** A plugin's code that sends these commits, one after another. */
const sends = (...commits: unknown[][]) =>
  `box.then(({ post }) => { for (const commit of ${JSON.stringify(commits)}) post(JSON.stringify({ commit })) })`

const stage = (page: Page) => page.getByTestId('plugin-stage')
const surface = (page: Page) => page.getByTestId('plugin-surface')
const ended = (page: Page) => page.getByTestId('plugin-ended')
const STILL =
  'The rest of Lumovi is as it was, and stopping the page changed nothing in your cluster.'

test('what a plugin describes is drawn with Lumovi’s parts, under a strip that says whose it is', async ({
  lumovi: { page },
}) => {
  await show(page, {
    code: sends(
      [
        ['make', 1, 'Stack', { gap: 2 }],
        ['make', 2, 'Label', { tone: 'quiet' }],
        ['text', 3, 'Nodes'],
        ['put', 2, 3],
        ['put', 1, 2],
        ['make', 4, 'Field', { name: 'Capacity', value: '24 of 64 cores' }],
        ['put', 1, 4],
        ['put', 0, 1],
      ],
      // And then it changes: a text, a part's properties, one more part before another.
      [
        ['text', 3, 'Node pools'],
        ['change', 4, { name: 'Capacity', value: '32 of 64 cores' }],
        ['make', 5, 'Field', { name: 'Zone', value: 'eu-west-1a' }],
        ['put', 1, 5, 4],
      ],
    ),
  })
  // (As it's shown: a phone's shorter words are in the strip too, and hidden here.)
  await expect(page.getByTestId('plugin-whose')).toHaveText(
    'This page is from the plugin Karpenter 1.0.0. Lumovi draws it from its own parts; what it shows and says is the plugin’s.',
    { useInnerText: true },
  )
  await expect(surface(page).locator('[data-part="Label"]')).toHaveText('Node pools')
  await expect(surface(page).locator('[data-part="Field"]')).toHaveText([
    /^Zone\s*eu-west-1a/,
    /^Capacity\s*32 of 64 cores/,
  ])
  // The strip is above the page and outside it: it stays where it is as the page scrolls.
  const strip = await page.getByTestId('plugin-whose').boundingBox()
  const drawn = await surface(page).boundingBox()
  expect(strip!.y + strip!.height).toBeLessThanOrEqual(drawn!.y)
  expect(
    await surface(page).evaluate((el) => el.closest('[data-testid="plugin-whose"]')),
  ).toBeNull()
  await expect(ended(page)).toHaveCount(0)
})

test('a text is drawn whatever its characters: what would turn it round or isn’t text is a mark of Lumovi’s', async ({
  lumovi: { page },
}) => {
  const fields = [
    ['family', '👨‍👩‍👧 می‌خواهم'],
    ['override', 'abc‮def'],
    ['colours', '\u001b[31mfailed\u001b[0m'],
    ['null', 'x\u0000y'],
    ['bells', '\u0007'.repeat(4000)],
    ['hebrew', 'שלום 123 ‏!'],
    ['stacked', `e${'́'.repeat(60)}`],
    ['lines', 'one\r\ntwo'],
  ]
  await show(page, {
    code: sends([
      ['make', 1, 'Stack', {}],
      ...fields.flatMap(([name, value], i) => [
        ['make', i + 2, 'Field', { name, value, lines: name === 'lines' }],
        ['put', 1, i + 2],
      ]),
      ['put', 0, 1],
    ]),
  })
  const field = (name: string) =>
    surface(page)
      .locator('[data-part="Field"]', { hasText: name })
      .locator('[data-their-text]')
      .nth(1)
  // Ordinary writing, as written, with no mark in it.
  await expect(field('family')).toHaveText('👨‍👩‍👧 می‌خواهم')
  await expect(field('family').locator('[data-mark]')).toHaveCount(0)
  // An override is a mark, and what follows it isn't turned round: "def" still reads d, e, f,
  // each letter to the right of the one before.
  await expect(
    field('override').getByRole('img', { name: 'invisible character U+202E' }),
  ).toBeVisible()
  const letters = await field('override').evaluate((el) => {
    const text = [...el.childNodes].find((node) => node.textContent === 'def')!
    const range = document.createRange()
    return [0, 1, 2].map((i) => {
      range.setStart(text, i)
      range.setEnd(text, i + 1)
      return Math.round(range.getBoundingClientRect().left)
    })
  })
  expect(letters[0]).toBeLessThan(letters[1]!)
  expect(letters[1]).toBeLessThan(letters[2]!)
  // An error's colours: two marks, the word between; nothing is obeyed.
  await expect(field('colours').locator('[data-mark]')).toHaveCount(2)
  await expect(field('colours')).toContainText('failed')
  await expect(field('null').getByRole('img', { name: 'invisible character U+0000' })).toBeVisible()
  // Four thousand of them are twenty marks and a count, not four thousand elements.
  await expect(field('bells').locator('[data-mark]')).toHaveCount(21)
  await expect(
    field('bells').getByRole('img', { name: 'and 3,980 more invisible characters' }),
  ).toBeVisible()
  // A text is an island of direction: Lumovi's own words beside one in Hebrew stay where they are.
  await expect(field('hebrew')).toHaveAttribute('dir', 'auto')
  expect(await field('hebrew').evaluate((el) => el.tagName)).toBe('BDI')
  const beside = surface(page)
    .locator('[data-part="Field"]', { hasText: 'hebrew' })
    .getByTestId('beside')
  const [text, own] = [await field('hebrew').boundingBox(), await beside.boundingBox()]
  expect(text!.x + text!.width).toBeLessThanOrEqual(own!.x + 1)
  // Marks stacked sixty high on a letter are clipped to their own row.
  expect(await field('stacked').evaluate((el) => getComputedStyle(el).overflow)).toBe('clip')
  // A line's end is one where the part draws lines.
  expect(await field('lines').evaluate((el) => (el as HTMLElement).innerText)).toBe('one\ntwo')
  await expect(ended(page)).toHaveCount(0)
})

test('a page that says what it can’t, or too much, is stopped whole: its place says so, calmly', async ({
  lumovi: { page, app },
}) => {
  let log = ''
  app.process().stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  app.process().stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  page.on('console', (message) => (log += `${message.text()}\n`))
  // Something no plugin's page can say, after a page was drawn: nothing of it is left.
  await show(page, {
    code: sends(
      [
        ['make', 1, 'Label', {}],
        ['text', 2, 'half a page'],
        ['put', 1, 2],
        ['put', 0, 1],
      ],
      [['make', 3, 'Label', { style: 'position: fixed; inset: 0' }]],
    ),
  })
  await expect(ended(page)).toHaveAttribute('data-why', 'not-allowed')
  await expect(ended(page).getByRole('heading')).toHaveText('Lumovi stopped Karpenter’s page.')
  await expect(ended(page)).toContainText('It sent something a plugin can’t.')
  await expect(ended(page)).toContainText(STILL)
  await expect(surface(page)).toHaveCount(0)
  await expect(stage(page)).not.toContainText('half a page')
  // The strip stays.
  await expect(page.getByTestId('plugin-whose')).toContainText('Karpenter 1.0.0')
  // For whoever writes the plugin, a line with the thing itself, quoted.
  await expect
    .poll(() => log)
    .toContain('Lumovi stopped the plugin karpenter: step 1: Label: takes nothing named "style"')

  // Too much: one text over its length.
  await show(page, { code: sends([['text', 1, 'a'.repeat(DOOR_LIMITS.text + 1)]]) })
  await expect(ended(page)).toHaveAttribute('data-why', 'too-much')
  await expect(ended(page)).toContainText('It sent more at once than a plugin may.')

  // A name ending in s takes the apostrophe alone, and a long one wraps: never cut.
  const long = 'Platform Team’s Reconciliation and Settlement Workflows'
  await show(page, { name: long, version: '12.104.3', code: sends([['eval', '1']]) })
  await expect(ended(page).getByRole('heading')).toHaveText(`Lumovi stopped ${long}’ page.`)
  await expect(page.getByTestId('plugin-whose')).toContainText(`${long} 12.104.3`)
  for (const part of [ended(page).getByRole('heading'), page.getByTestId('plugin-whose')]) {
    expect(await part.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})

test('a page that fails by itself says so in its plugin’s words, shown as the plugin’s and as text', async ({
  lumovi: { page },
}) => {
  await show(page, {
    code: `throw new Error('<a href="https://example.com">Lumovi says: sign in again</a>\\u202E\\nsecond line')`,
  })
  await expect(ended(page)).toHaveAttribute('data-why', 'failed')
  await expect(ended(page).getByRole('heading')).toHaveText('Karpenter’s page stopped by itself.')
  await expect(ended(page)).toContainText('Karpenter said')
  const said = ended(page).locator('[data-their-text]')
  // Its words are text: nothing in them is a link or anything of Lumovi's, and what can't be
  // seen is a mark.
  await expect(said).toContainText('<a href="https://example.com">Lumovi says: sign in again</a>')
  await expect(ended(page).getByRole('link')).toHaveCount(0)
  await expect(said.getByRole('img', { name: 'invisible character U+202E' })).toBeVisible()
  await expect(said).toContainText('second line')
  await expect(ended(page)).toContainText(STILL)
  await expect(ended(page).getByRole('button', { name: 'Open it again' })).toBeVisible()
})

test('“Open it again” opens it again, on the person’s press and never by itself', async ({
  lumovi: { page },
}) => {
  // A plugin that fails the first time it's opened, and not the second (it keeps count in the
  // one place a box lets it: nowhere, so the page it's given says which time it is).
  await show(page, { code: `throw new Error('not yet')` })
  await expect(ended(page)).toHaveAttribute('data-why', 'failed')
  // Lumovi doesn't try again by itself.
  await page.waitForTimeout(1500)
  await expect(stage(page)).toHaveAttribute('data-opened', '0')
  await ended(page).getByRole('button', { name: 'Open it again' }).click()
  await expect(stage(page)).toHaveAttribute('data-opened', '1')
  // It stops again, and says so again.
  await expect(ended(page)).toHaveAttribute('data-why', 'failed')
  await expect(ended(page).getByRole('button', { name: 'Open it again' })).toBeVisible()
})

test('a part of Lumovi’s own that fails as it draws takes the plugin’s page with it, and Lumovi says it’s its own fault', async ({
  lumovi: { page },
}) => {
  await show(page, {
    code: sends([
      ['make', 1, 'Label', {}],
      ['text', 2, 'before the fault'],
      ['put', 1, 2],
      ['put', 0, 1],
      ['make', 3, 'Faulty', {}],
      ['put', 0, 3],
    ]),
  })
  await expect(ended(page)).toHaveAttribute('data-why', 'drawing')
  await expect(ended(page).getByRole('heading')).toHaveText(
    'Lumovi couldn’t draw Karpenter’s page.',
  )
  await expect(ended(page)).toContainText('That’s a fault in Lumovi, not in the plugin.')
  await expect(ended(page)).toContainText('The rest of Lumovi is as it was.')
  await expect(ended(page)).not.toContainText('stopping the page')
  await expect(ended(page)).toContainText('If it happens again, tell us.')
  await expect(stage(page)).not.toContainText('before the fault')
  // The rest of Lumovi is as it was: the app under the stage still answers.
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { hide(): void } }).__lumoviDoor.hide(),
  )
  await expect(stage(page)).toHaveCount(0)
  await expect(page.getByRole('main')).toBeVisible()
})

test('a page that goes silent is stopped, and one whose place Lumovi ended says which limit', async ({
  lumovi: { page },
}) => {
  await show(page, { code: `box.then(() => { for (;;) {} })` })
  await expect(ended(page)).toHaveAttribute('data-why', 'silent', {
    timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 4),
  })
  await expect(ended(page)).toContainText('It had stopped answering.')
  // Each of the other endings, as its place says it.
  const endings: [string, string, string, boolean][] = [
    [
      'memory',
      'Lumovi stopped Karpenter’s page.',
      'It was using more memory than a plugin may.',
      true,
    ],
    [
      'processor',
      'Lumovi stopped Karpenter’s page.',
      'Over the last half minute it used more than half of a processor core.',
      true,
    ],
    [
      'shared',
      'Lumovi stopped Karpenter’s page.',
      'It wasn’t running apart from the rest, as a plugin must.',
      true,
    ],
    [
      'no-box',
      'Karpenter’s page couldn’t start.',
      'Lumovi couldn’t open the place a plugin’s code runs in.',
      false,
    ],
  ]
  for (const [why, title, sentence, again] of endings) {
    await show(page, { code: '', ended: { why } })
    await expect(ended(page)).toHaveAttribute('data-why', why)
    await expect(ended(page).getByRole('heading')).toHaveText(title)
    await expect(ended(page)).toContainText(sentence)
    await expect(ended(page).getByRole('button', { name: 'Open it again' })).toHaveCount(
      again ? 1 : 0,
    )
    const advised = why === 'memory' || why === 'processor'
    await expect(ended(page).getByText('On a very large cluster a page can need more')).toHaveCount(
      advised ? 1 : 0,
    )
    if (!again) await expect(ended(page)).not.toContainText('stopping the page')
  }
})
