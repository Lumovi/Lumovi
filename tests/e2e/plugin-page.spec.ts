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
import { holds } from '../holds.ts'

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

test('a commit draws again only what it changed: not the row beside it, nor the part round a text', async ({
  lumovi: { page },
}) => {
  const first = [
    ['make', 1, 'Stack', {}],
    ['make', 2, 'Label', {}],
    ['text', 3, 'Nodes'],
    ['put', 2, 3],
    ['put', 1, 2],
    ['make', 4, 'Field', { name: 'Capacity', value: '24 of 64 cores' }],
    ['put', 1, 4],
    ['make', 5, 'Field', { name: 'Zone', value: 'eu-west-1a' }],
    ['put', 1, 5],
    ['put', 0, 1],
  ]
  // Then, six times half a second apart, one row's value and the label's text. (However
  // the commits fall into frames on a slow machine, what never changes is drawn once.)
  const then = (n: number) =>
    JSON.stringify({
      commit: [
        ['change', 4, { name: 'Capacity', value: `${24 + n} of 64 cores` }],
        ['text', 3, `Nodes ${n}`],
      ],
    })
  await show(page, {
    code: `box.then(({ post }) => {
      post(${JSON.stringify(JSON.stringify({ commit: first }))})
      const then = ${JSON.stringify([1, 2, 3, 4, 5, 6].map(then))}
      const tick = setInterval(() => { post(then.shift()); if (!then.length) clearInterval(tick) }, 500)
    })`,
  })
  const parts = (name: string) => surface(page).locator(`[data-part="${name}"]`)
  await expect(parts('Field')).toHaveText([/^Capacity\s*30 of 64 cores/, /^Zone\s*eu-west-1a/])
  await expect(parts('Label')).toHaveText('Nodes 6')
  // Drawn again: only the row that changed. Once: the row beside it, the stack round them, and
  // the label (its text is drawn again by itself, not the part round it).
  const drawn = (name: string) =>
    parts(name).evaluateAll((all) => all.map((part) => Number((part as HTMLElement).dataset.drawn)))
  const [changed, beside] = await drawn('Field')
  expect(changed).toBeGreaterThan(1)
  expect(beside).toBe(1)
  expect(await drawn('Label')).toEqual([1])
  expect(await drawn('Stack')).toEqual([1])
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
  // Four thousand of them are three marks and a count, not four thousand elements: the row's
  // own words stay in sight.
  await expect(field('bells').locator('[data-mark]')).toHaveCount(4)
  await expect(
    field('bells').getByRole('img', { name: 'and 3,997 more invisible characters' }),
  ).toBeVisible()
  // A text is an island of direction: its own letters in their own order, and nothing of
  // Lumovi's beside it turned round; but it starts at the left of its row like every other.
  await expect(field('hebrew')).toHaveAttribute('dir', 'auto')
  expect(await field('hebrew').evaluate((el) => el.tagName)).toBe('BDI')
  expect(await field('hebrew').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl')
  const [hebrew, plain] = [await field('hebrew').boundingBox(), await field('null').boundingBox()]
  expect(hebrew!.x).toBe(plain!.x)
  const firstLetter = await field('hebrew').evaluate((el) => {
    const range = document.createRange()
    range.setStart(el.firstChild!, 0)
    range.setEnd(el.firstChild!, 4)
    return range.getBoundingClientRect().left - el.getBoundingClientRect().left
  })
  expect(firstLetter).toBeLessThan(40)
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
  await holds(
    async () => (await stage(page).getAttribute('data-opened')) === '0',
    1500,
    'it isn’t opened again',
  )
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
  // The page is gone, not only its picture: no box of the plugin's is left, so none of its
  // code runs behind the words.
  await expect(page.locator('iframe[sandbox]')).toHaveCount(0)
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

test('a page at the door’s limits, changing as fast as a plugin may, leaves Lumovi’s own page answering', async ({
  lumovi: { page },
}) => {
  test.slow()
  // The widest part there can be, a row of Lumovi's with two texts in each place; then, for
  // three seconds, commits of the most steps a commit may have, each step moving a row across
  // all the others: about 16,000 steps a second (the most is 20,000; a plugin's own timer
  // isn't exact, and one commit too many in a second would stop it).
  // (One place is left for the line that says it's done.)
  const wide = DOOR_LIMITS.inOnePart - 1
  const code = `box.then(({ post }) => {
    const send = (commit) => post(JSON.stringify({ commit }))
    send([['make', 1, 'Stack', {}], ['put', 0, 1]])
    for (let from = 0; from < ${wide}; from += 500) {
      const steps = []
      for (let i = from; i < Math.min(from + 500, ${wide}); i++) {
        steps.push(['make', i + 2, 'Field', { name: 'row ' + i, value: 'value ' + i }], ['put', 1, i + 2])
      }
      send(steps)
    }
    let sent = 0
    // (After a pause: the test starts looking at Lumovi's frames once the rows are drawn.)
    setTimeout(() => {
    const timer = setInterval(() => {
      const steps = []
      for (let i = 0; i < ${DOOR_LIMITS.stepsACommit}; i++) {
        steps.push(i % 2 ? ['put', 1, 2 + ((i * 7 + sent) % ${wide})] : ['put', 1, 2 + ((i * 13 + sent) % ${wide}), 2 + ((i * 13 + sent + 500) % ${wide})])
      }
      send(steps)
      if (++sent === 25) {
        clearInterval(timer)
        send([['make', 5000, 'Label', {}], ['text', 5001, 'done moving'], ['put', 5000, 5001], ['put', 1, 5000, 2]])
      }
    }, 120)
    }, 4000)
  })`
  await show(page, { code })
  await expect(surface(page).locator('[data-part="Field"]')).toHaveCount(wide)
  await expect(stage(page)).not.toContainText('done moving')
  // The page's own frames while it goes on: how long Lumovi's thread is held at a time.
  const frames = await page.evaluate(
    () =>
      new Promise<{ frames: number; worst: number; over100: number; median: number }>((done) => {
        const gaps: number[] = []
        let last = performance.now()
        // (The page's one Label is the line that says it's done: looked for by its own element,
        // never in the page's whole text, which a thousand rows make heavy to read each frame,
        // on the thread this measures.)
        const said = () =>
          document.querySelector('[data-testid="plugin-surface"] [data-part="Label"]')
        const tick = (now: number) => {
          gaps.push(now - last)
          last = now
          if (said()) {
            const sorted = [...gaps].sort((a, b) => a - b)
            done({
              frames: gaps.length,
              worst: Math.round(sorted.at(-1)!),
              over100: gaps.filter((gap) => gap > 100).length,
              median: Math.round(sorted[Math.floor(sorted.length / 2)]!),
            })
          } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(`a page at its limits: ${JSON.stringify(frames)}`)
  // It wasn't stopped (it kept inside every limit, as it sent them: when Lumovi's own page is
  // busy its messages arrive in bunches, which isn't its doing), it's all there, and no single
  // stretch held Lumovi's page for the second the limits are counted in: their claim, through
  // to the drawing. (Measured: frames 8 ms apart and the worst 26 ms on a laptop; on CI's
  // machines 16 to 17 ms apart, and the worst 100 to 320 ms, most of it the browser laying out a
  // thousand rows that all moved.)
  await expect(ended(page)).toHaveCount(0)
  await expect(surface(page).locator('[data-part="Field"]')).toHaveCount(wide)
  // (The frames were of the moving, not of a page already done.)
  expect(frames.frames).toBeGreaterThan(10)
  expect(frames.worst).toBeLessThan(1000)
})
