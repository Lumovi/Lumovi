/**
 * Who gets the height in Lumovi's dialog for a change a plugin's page proposed, and what its box
 * shows of the change: a long change never squeezes the plugin's options, and a long form never
 * hides the change. The box opens on the change, keeps three rows of it whatever the form's
 * length, wraps a long line whole, and says under it, in Lumovi's words, how much of the change
 * shows where it's cut; a change that fits shows whole and says nothing. Where the boxes can't be
 * measured, nothing is folded or said to be cut.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { placed } from '../placed.ts'
import { DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'

const TINKER = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: tinker }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Tinker
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  changes: [{ group: example.com, kind: Widget, actions: [patch, create] }]
`

/** A sentence of some six hundred characters, as a person might write a note. */
const SENTENCE = 'a note that goes on for a while, as a person might write one, '.repeat(10).trim()

/**
 * Its code: a header whose buttons each propose a change to the first widget. Tune asks for as
 * many options as a form takes (five) and its change is long; Word's and Sentence's are one long
 * value; Mend's is one line; Copy creates a widget of many lines.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const BUTTONS = ['tune', 'word', 'sentence', 'mend', 'copy'].map((key) => ({
    key,
    name: key[0].toUpperCase() + key.slice(1),
    changes: true,
  }))
  let widget
  let n = 0
  const propose = (press, change, extra = {}) =>
    post(JSON.stringify({ propose: ++n, press, change, ...extra }))
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([['make', 1, 'Header', { name: 'ready', buttons: BUTTONS, onPress: 'press' }], ['put', 0, 1]])
    }
    if (said.read === 1 && said.objects) widget = said.objects[0] && said.objects[0].token
    if (said.call !== 'press') return
    const { button } = said.carries
    const patch = (patch, extra) => propose(said.press, { action: 'patch', target: widget, patch }, extra)
    if (button === 'tune') {
      const annotations = {}
      for (let i = 0; i < 24; i++) annotations['example.com/note-' + i] = 'note ' + i
      const fields = [
        { kind: 'number', key: 'size', label: 'Size', hint: 'In widget units.', min: 1, max: 10, value: 3 },
        { kind: 'choice', key: 'color', label: 'Colour', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }], value: 1 },
      ]
      for (const [key, label] of [['weight', 'Weight'], ['speed', 'Speed'], ['reach', 'Reach']]) {
        fields.push({ kind: 'number', key, label, hint: 'Between 1 and 10.', min: 1, max: 10, value: 5 })
      }
      const spec = { size: { field: 'size' }, color: { field: 'color' } }
      for (const key of ['weight', 'speed', 'reach']) spec[key] = { field: key }
      patch({ metadata: { annotations }, spec }, { verb: 'Tune', fields })
    }
    if (button === 'word') patch({ spec: { note: 'x'.repeat(1999) + 'Z' } })
    if (button === 'sentence') patch({ spec: { note: ${JSON.stringify(SENTENCE)}, zebra: 'last' } })
    if (button === 'mend') patch({ spec: { color: 'red' } })
    if (button === 'copy') {
      const spec = { size: 1 }
      for (let i = 0; i < 30; i++) spec['part' + i] = 'p' + i
      propose(said.press, { action: 'create', kind: 'example.com/Widget', in: widget, object: { spec, metadata: { generateName: 'copy-' } } })
    }
  })
})
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with Tinker in it, as if it came with Lumovi (it knows its own address, for the box). */
async function served(serve: Serve) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'tinker.yaml'), TINKER)
  writeFileSync(join(included, 'tinker.js'), CODE)
  const port = await freePort()
  return serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
}

const SMALLEST = { width: 1024, height: 640 }
const LARGE = { width: 1440, height: 900 }

const body = (page: Page) => page.locator('[data-plugin-body]')
const dialog = (page: Page) => page.locator('[data-plugin-proposal="tinker"]')

/** Tinker's page, at a window's size. */
async function opened(page: Page, server: Served, size: typeof SMALLEST) {
  await page.setViewportSize(size)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/overview`, DEMO_TOKEN)
  await expect(body(page).getByRole('button', { name: /^More for / })).toBeVisible({
    timeout: 30_000,
  })
}

/** One of its buttons pressed (in its place, or in its More menu): the dialog, answered. */
async function asked(page: Page, name: string) {
  const button = body(page).getByRole('button', { name, exact: true })
  if (await button.isVisible()) await button.click()
  else {
    await body(page)
      .getByRole('button', { name: /^More for / })
      .click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const shown = dialog(page)
  await expect(shown).toContainText('The cluster accepts it', { timeout: 20_000 })
  return shown
}

const box = (shown: Locator) => shown.locator('[data-proposal-object]')
const cut = (shown: Locator) => shown.locator('[data-proposal-cut]')

/** The box's rows, each with what it is and whether all of it is in view. */
const rows = (shown: Locator) =>
  box(shown).evaluate((lines) => {
    const view = lines.getBoundingClientRect()
    return [...lines.querySelectorAll<HTMLElement>('[data-change]')].map((row) => {
      const rect = row.getBoundingClientRect()
      return {
        type: row.dataset.change!,
        whole: rect.top >= view.top - 0.5 && rect.bottom <= view.bottom + 0.5,
        height: rect.height,
      }
    })
  })
const changed = (row: { type: string }) => row.type === 'added' || row.type === 'removed'

/** The box never scrolls sideways, and nothing in it is wider than it. */
async function expectNoSideways(shown: Locator) {
  expect(
    await box(shown).evaluate((lines) => [
      lines.scrollWidth <= lines.clientWidth,
      [...lines.querySelectorAll<HTMLElement>('[data-change]')].every(
        (row) => row.scrollWidth <= lines.clientWidth,
      ),
      lines.scrollLeft,
    ]),
  ).toEqual([true, true, 0])
}

/** Scrolled by the keyboard to its end, the box shows its last changed line whole. */
async function expectEndReached(page: Page, shown: Locator) {
  await box(shown).focus()
  await page.keyboard.press('End')
  await expect
    .poll(async () => {
      const all = await rows(shown)
      return all.filter(changed).at(-1)?.whole
    })
    .toBe(true)
  await expectNoSideways(shown)
}

for (const size of [LARGE, SMALLEST]) {
  test(`at ${size.width} × ${size.height}, a form of five options and a long change: the options keep their height, the box opens on the change and says how much of it shows`, async ({
    serve,
    page,
  }) => {
    await opened(page, await served(serve), size)
    const shown = await asked(page, 'Tune')
    // The caption, the verdict and the buttons are in view, whatever else gives way.
    for (const inView of [
      shown.getByText('What Lumovi will send'),
      shown.getByText('The cluster accepts it, as the options stand.'),
      shown.locator('[data-cancel]'),
      shown.locator('[data-confirm]'),
    ]) {
      await expect(inView).toBeInViewport({ ratio: 1 })
    }
    // It opens on the change: one line for place, then the first changed line. Never a fold of
    // unchanged lines first, and never the object's top (the change is under its labels).
    const all = await rows(shown)
    expect(all.slice(0, 2).map((row) => row.type)).toEqual(['same', 'added'])
    await expect(box(shown).locator('[data-change]').first()).toContainText('tier: toys')
    await expect(box(shown)).not.toContainText('apiVersion')
    // Its floor: three rows of the change in view, whole.
    const whole = all.filter((row) => changed(row) && row.whole)
    expect(whole.length).toBeGreaterThanOrEqual(3)
    // Cut, it says so in Lumovi's words, under the box and outside the plugin's options: the
    // changed lines whole in view, of all of them.
    // (Its annotations and their heading, and the three fields its spec didn't have.)
    const total = all.filter(changed).length
    expect(total).toBe(28)
    await expect(cut(shown)).toHaveText(
      `Shows ${whole.length} of ${total} changed lines. Scroll to see the rest.`,
    )
    expect(
      await cut(shown).evaluate((line) => line.closest('[data-proposal-options]') === null),
    ).toBe(true)
    const [boxAt, cutAt] = [await placed(box(shown)), await placed(cut(shown))]
    expect(Math.round(cutAt.y - (boxAt.y + boxAt.height))).toBe(6)
    // The options: all the height the floors leave. Where that's two fields' height or more, the
    // command shows its two lines; where it's less, the command folds, and opens by hand.
    const options = shown.locator('[data-proposal-fields]')
    const optionsHeight = (await placed(options)).height
    const fold = shown.locator('[data-proposal-command-fold]')
    const command = shown.locator('[data-proposal-command]')
    const commandHeight = () => command.evaluate((code) => code.clientHeight)
    if (size === LARGE) {
      expect(optionsHeight).toBeGreaterThanOrEqual(190)
      await expect(fold).toHaveCount(0)
      expect(await commandHeight()).toBeGreaterThanOrEqual(38)
    } else {
      expect(optionsHeight).toBeLessThan(190)
      await expect(fold).toHaveAccessibleName('Show the command')
      await expect(fold).toHaveAttribute('aria-expanded', 'false')
      expect(await commandHeight()).toBe(0)
      // Folded, it's still copied, and still read by a screen reader.
      await expect(shown.getByRole('button', { name: 'Copy the command' })).toBeVisible()
      await expect(command).toContainText('kubectl patch widget.example.com/blue-widget')
      // Opened in place, to its two lines, which the options give up; the change keeps its rows.
      await fold.click()
      await expect(fold).toHaveAccessibleName('Hide the command')
      await expect(fold).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(commandHeight).toBeGreaterThanOrEqual(38)
      expect((await placed(options)).height).toBeLessThan(optionsHeight)
      expect((await rows(shown)).filter((row) => changed(row) && row.whole).length).toBe(
        whole.length,
      )
      await expect(shown.locator('[data-confirm]')).toBeInViewport({ ratio: 1 })
    }
    // The options scroll in their own box, under their caption, and a field focused by the
    // keyboard comes into view.
    expect(await options.evaluate((fields) => fields.scrollHeight > fields.clientHeight)).toBe(true)
    await expect(shown.getByText('Options, in Tinker’s words')).toBeInViewport({ ratio: 1 })
    await shown.getByLabel('Reach').focus()
    await expect(shown.getByLabel('Reach')).toBeInViewport({ ratio: 1 })
    // The whole change is one scroll away, up and down only: the count follows the box, and at
    // its end the last changed line is in view.
    await expectEndReached(page, shown)
    const after = (await rows(shown)).filter((row) => changed(row) && row.whole).length
    await expect(cut(shown)).toHaveText(
      `Shows ${after} of ${total} changed lines. Scroll to see the rest.`,
    )
  })
}

test('a long value wraps whole in the box: never cut at its edge, never scrolled sideways, its end a scroll away', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  // Two thousand characters with no space among them: one changed line, of many rows.
  await opened(page, server, SMALLEST)
  const word = await asked(page, 'Word')
  await expectNoSideways(word)
  const [place, value] = await rows(word)
  expect([place!.type, value!.type]).toEqual(['same', 'added'])
  expect(value!.height).toBeGreaterThan(20 * 20)
  // More of it than the box holds: none of the change is whole in view, and the line says which.
  await expect(cut(word)).toHaveText('Shows part of the changed line. Scroll to see the rest.')
  // Its sign on its first row only, and what runs over set in under its own text.
  expect(
    await box(word)
      .locator('[data-change="added"]')
      .evaluate((row) => {
        const range = document.createRange()
        range.selectNodeContents(row)
        const lefts = [...range.getClientRects()].map((rect) => Math.round(rect.left))
        return [row.textContent!.split('+').length - 1, Math.min(...lefts) < Math.max(...lefts)]
      }),
  ).toEqual([1, true])
  // Its last character is reached by scrolling down alone.
  await box(word).focus()
  await page.keyboard.press('End')
  await expect
    .poll(() =>
      box(word)
        .locator('[data-change="added"]')
        .evaluate((row) => {
          const text = [...row.childNodes].at(-1)!
          const last = document.createRange()
          last.setStart(text, text.textContent!.length - 1)
          last.setEnd(text, text.textContent!.length)
          const [at, view] = [
            last.getBoundingClientRect(),
            row.closest('[data-proposal-object]')!.getBoundingClientRect(),
          ]
          return [last.toString(), at.bottom <= view.bottom + 0.5 && at.top >= view.top - 0.5]
        }),
    )
    .toEqual(['Z', true])
  await expectNoSideways(word)
  await word.locator('[data-cancel]').click()

  // A long sentence, the first of two changed lines: broken between its words, as the command
  // is; and while only part of it shows, the line says it's the first.
  await expect(dialog(page)).toHaveCount(0)
  const sentence = await asked(page, 'Sentence')
  await expectNoSideways(sentence)
  await expect(cut(sentence)).toHaveText(
    'Shows part of the first of 2 changed lines. Scroll to see the rest.',
  )
  expect(
    await box(sentence)
      .locator('[data-change="added"]')
      .first()
      .evaluate((row) => {
        // (No word of it is cut in two: each row's text ends where a word does.)
        const text = [...row.childNodes].at(-1)!
        const said = text.textContent!
        const range = document.createRange()
        let cuts = 0
        let top: number | undefined
        for (let i = 0; i < said.length; i++) {
          range.setStart(text, i)
          range.setEnd(text, i + 1)
          const at = Math.round(range.getBoundingClientRect().top)
          if (top !== undefined && at !== top && said[i - 1] !== ' ' && said[i] !== ' ') cuts++
          top = at
        }
        return cuts
      }),
  ).toBe(0)
  await expectEndReached(page, sentence)
  await expect(cut(sentence)).toHaveText('Shows 1 of 2 changed lines. Scroll to see the rest.')
})

test('a change that fits shows whole and says nothing; a create starts at the object’s top, and every line of it counts', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  // One line changed: its box opens on the line before it, shows all of it, and nothing is cut.
  await opened(page, server, SMALLEST)
  const mend = await asked(page, 'Mend')
  const mended = await rows(mend)
  expect(mended.slice(0, 3).map((row) => row.type)).toEqual(['same', 'removed', 'added'])
  expect(mended.every((row) => row.whole)).toBe(true)
  await expect(cut(mend)).toHaveCount(0)
  await expect(mend.locator('[data-proposal-command-fold]')).toHaveCount(0)
  expect(await box(mend).evaluate((lines) => lines.style.maxHeight)).toBe('')
  await mend.locator('[data-cancel]').click()

  // A create is all change: from its first line, with no line before it, and its count is the
  // object's lines as Lumovi will send it.
  await expect(dialog(page)).toHaveCount(0)
  const copy = await asked(page, 'Copy')
  const created = await rows(copy)
  expect(created.every((row) => row.type === 'added')).toBe(true)
  await expect(box(copy).locator('[data-change]').first()).toContainText(
    'apiVersion: example.com/v1',
  )
  const object = await copy.getByLabel('The whole object Lumovi will create').innerText()
  expect(created.length).toBe(object.trimEnd().split('\n').length)
  const whole = created.filter((row) => row.whole).length
  expect(whole).toBeGreaterThanOrEqual(3)
  expect(whole).toBeLessThan(created.length)
  await expect(cut(copy)).toHaveText(
    `Shows ${whole} of ${created.length} changed lines. Scroll to see the rest.`,
  )
  await expect(copy.locator('[data-proposal-command]')).toContainText(
    `the object above, ${created.length} lines`,
  )
  await expectEndReached(page, copy)
})

/**
 * Where nothing was measured, the line that says there's more of the change stands over the box,
 * outside what scrolls, whole in view and inside "What Lumovi will send" (which is cut at its
 * bottom where it can't all fit).
 */
async function expectSaidOver(shown: Locator) {
  await expect(cut(shown)).toBeInViewport({ ratio: 1 })
  expect(
    await cut(shown).evaluate((line) => {
      const [said, lines, part] = [
        line.getBoundingClientRect(),
        line.parentElement!.querySelector('[data-proposal-object]')!.getBoundingClientRect(),
        line.closest('section')!.getBoundingClientRect(),
      ]
      return [
        line.closest('[data-proposal-object]') === null,
        said.bottom <= lines.top + 0.5,
        said.bottom <= part.bottom + 0.5,
      ]
    }),
  ).toEqual([true, true, true])
}

/** A page where something of the change's box can't be measured, as `broken` says how. */
const unmeasurable = (page: Page, broken: 'rows' | 'box') =>
  page.addInitScript((broken) => {
    if (broken === 'rows') {
      // (A row with no height to measure: as lines not laid out yet would say.)
      const measured = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const rect = measured.call(this)
        return this.matches('[data-proposal-object] [data-change]')
          ? new DOMRect(rect.x, rect.y, rect.width, 0)
          : rect
      }
    } else {
      // (The box itself can't say how much it holds.)
      const held = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!
      Object.defineProperty(Element.prototype, 'scrollHeight', {
        configurable: true,
        get(this: Element) {
          return this.matches('[data-proposal-object]') ? Number.NaN : held.get!.call(this)
        },
      })
    }
  }, broken)

test('where the box can’t be measured, nothing is folded and the change still has its floor: it opens on the change, keeps three rows, and says there’s more of it', async ({
  serve,
  page,
}) => {
  await unmeasurable(page, 'rows')
  // (A form long enough to squeeze the box, in the smallest window.)
  await opened(page, await served(serve), SMALLEST)
  const shown = await asked(page, 'Tune')
  // No rule laid it out: nothing is folded, and no box has a height set for it.
  await expect(shown.locator('[data-proposal-command-fold]')).toHaveCount(0)
  expect(
    await shown.evaluate((dialog) =>
      ['[data-proposal-fields]', '[data-proposal-object]', '[data-proposal-command]'].map(
        (each) => dialog.querySelector<HTMLElement>(each)!.style.maxHeight,
      ),
    ),
  ).toEqual(['', '', ''])
  // The options give way first and scroll; the change keeps three of its rows, and opens on the
  // change as it always does: that's how its lines are made, whatever can be measured.
  const options = shown.locator('[data-proposal-fields]')
  expect(await options.evaluate((fields) => fields.scrollHeight > fields.clientHeight)).toBe(true)
  expect((await placed(box(shown))).height).toBeGreaterThanOrEqual(3 * 20.4 - 0.5)
  expect(
    await box(shown).evaluate((lines) =>
      [...lines.querySelectorAll<HTMLElement>('[data-change]')]
        .slice(0, 2)
        .map((row) => row.dataset.change),
    ),
  ).toEqual(['same', 'added'])
  // Cut, it says so, in Lumovi's words and without a count it couldn't make: over the box there,
  // and no row of it, so nothing that's cut or scrolled takes the line away.
  await expect(cut(shown)).toHaveText('Scroll to see the rest of the change.')
  await expectSaidOver(shown)
  // The command, the verdict and the buttons are in view, and the button is as live as ever.
  for (const inView of [
    shown.locator('[data-proposal-command]'),
    shown.getByText('The cluster accepts it, as the options stand.'),
    shown.locator('[data-cancel]'),
    shown.locator('[data-confirm]'),
  ]) {
    await expect(inView).toBeInViewport({ ratio: 1 })
  }
  await expect(shown.locator('[data-confirm]')).toBeEnabled()
  await shown.locator('[data-cancel]').click()
  // A change that fits there says nothing: it isn't cut.
  await expect(dialog(page)).toHaveCount(0)
  const mend = await asked(page, 'Mend')
  await expect(cut(mend)).toHaveCount(0)
})

test('where even the box’s own height can’t be read, it says the box may not show all of the change', async ({
  serve,
  page,
}) => {
  await unmeasurable(page, 'box')
  await opened(page, await served(serve), SMALLEST)
  const shown = await asked(page, 'Tune')
  await expect(cut(shown)).toHaveText(
    'This box may not show all of the change. Scroll it to see the rest.',
  )
  await expect(shown.locator('[data-proposal-command-fold]')).toHaveCount(0)
  expect((await placed(box(shown))).height).toBeGreaterThanOrEqual(3 * 20.4 - 0.5)
  await expect(shown.locator('[data-confirm]')).toBeInViewport({ ratio: 1 })
  await expect(shown.locator('[data-confirm]')).toBeEnabled()
})

test('in a window too short for the change’s floor, the line that says there’s more of it is still in view, over the box, and so are the buttons', async ({
  serve,
  page,
}) => {
  // (Shorter than Lumovi's own window can be made: a browser's can.)
  await opened(page, await served(serve), { width: 1024, height: 400 })
  const shown = await asked(page, 'Tune')
  await expect(cut(shown)).toHaveText('Scroll to see the rest of the change.')
  await expectSaidOver(shown)
  await expect(shown.locator('[data-proposal-command-fold]')).toHaveCount(0)
  for (const inView of [
    shown.getByText('What Lumovi will send'),
    shown.locator('[data-cancel]'),
    shown.locator('[data-confirm]'),
  ]) {
    await expect(inView).toBeInViewport({ ratio: 1 })
  }
  await expect(shown.locator('[data-confirm]')).toBeEnabled()
  // Nothing of the options lies over what Lumovi will send: they gave way whole.
  expect(
    await shown.evaluate((dialog) => {
      const [options, sends] = [
        dialog.querySelector('[data-proposal-options]')!.getBoundingClientRect(),
        dialog.querySelector('[data-proposal-cut]')!.closest('section')!.getBoundingClientRect(),
      ]
      return options.bottom <= sends.top + 0.5
    }),
  ).toBe(true)
})
