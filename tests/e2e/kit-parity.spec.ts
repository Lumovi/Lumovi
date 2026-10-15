/**
 * A plugin's table draws as Lumovi's own lists do: Argo CD's Applications, drawn by its code through
 * the kit, beside Lumovi's Workloads, on one cluster, in one window and one theme. Styles are
 * compared, not pixels, so it holds on every platform; each part that differs is named with what
 * differs, and a part the kit's table lacks is named as missing.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, goTo, openCluster, test } from './fixtures.ts'

/** What's compared of each part, as the browser computes it. */
const TEXT = ['font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color'] as const
const BOX = ['height', 'padding-left', 'padding-right', 'border-radius'] as const
const PARTS = {
  'a header cell': [...TEXT, 'height', 'padding-left'],
  'a row': [...BOX, 'border-bottom-width', 'border-bottom-color', 'background-color'],
  'a row, hovered': ['background-color'],
  'the opened row': ['background-color'],
  'a status pill': [...BOX, ...TEXT, 'background-color'],
  'a status pill’s icon': ['width', 'height'],
  'a filter chip': [...BOX, 'border-top-width', 'border-top-color', ...TEXT],
  'a filter chip’s count': ['font-weight', 'color'],
  'the filter field': [...BOX, 'border-top-width', 'border-top-color', 'background-color'],
  'the filter field’s text': ['font-size', 'placeholder'],
  'the pager': ['height', 'font-size', 'color'],
  'rows per page': [...BOX, 'font-size'],
  'nothing matching: its heading': [...TEXT],
  'nothing matching: its line': ['font-size', 'color'],
} as const
type Part = keyof typeof PARTS
type Seen = Partial<Record<Part, Record<string, string> | 'missing'>>

/** A part's computed styles, or that it isn't there. (Its height is the box's, as drawn.) */
async function styled(
  part: Locator,
  props: readonly string[],
): Promise<Record<string, string> | 'missing'> {
  if ((await part.count()) === 0) return 'missing'
  return part.first().evaluate((el, props) => {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const out: Record<string, string> = {}
    for (const prop of props) {
      if (prop === 'height') out[prop] = `${Math.round(box.height)}px`
      else if (prop === 'width') out[prop] = `${Math.round(box.width)}px`
      else if (prop === 'placeholder') out[prop] = getComputedStyle(el, '::placeholder').color
      else out[prop] = style.getPropertyValue(prop)
    }
    return out
  }, props)
}

/** The background a row settles on, once a change of it has run its course. */
async function settled(row: Locator): Promise<string> {
  let last = ''
  await expect
    .poll(async () => {
      const now = await row.evaluate((el) => getComputedStyle(el).backgroundColor)
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
  return last
}

/** Every part of a list on the page shown: its grid, the bar above it and the pager below. */
async function parts(page: Page, grid: Locator): Promise<Seen> {
  const seen: Seen = {}
  const look = async (part: Part, at: Locator) => {
    seen[part] = await styled(at, PARTS[part])
  }
  const rows = grid.getByRole('row').filter({ has: page.getByRole('gridcell') })
  await look('a header cell', grid.getByRole('columnheader').filter({ hasText: /^Name/ }))
  await look('a row', rows.nth(1))
  // Hovered by the pointer, not by a class put on it.
  await rows.nth(2).hover()
  seen['a row, hovered'] = { 'background-color': await settled(rows.nth(2)) }
  await page.mouse.move(0, 0)
  await look('a status pill', grid.locator('[data-health]'))
  await look('a status pill’s icon', grid.locator('[data-health] svg'))
  const chips = page.getByRole('group', { name: 'Filters' }).locator('button[aria-pressed]')
  await look('a filter chip', chips)
  await look('a filter chip’s count', chips.first().locator('span').last())
  const field = page.getByPlaceholder(/^Filter /)
  // (Its box is the label that holds it; what's typed, and its placeholder, are the field's.)
  await look('the filter field', field.locator('xpath=ancestor::label[1]'))
  await look('the filter field’s text', field)
  await look('the pager', page.getByRole('navigation', { name: 'Pagination' }))
  await look('rows per page', page.getByRole('combobox', { name: 'Rows per page' }))
  // The opened row: clicked, as a person opens it.
  await rows.nth(1).click()
  const opened = grid.locator('[role="row"][aria-selected="true"]')
  seen['the opened row'] =
    (await opened.count()) === 0 ? 'missing' : { 'background-color': await settled(opened.first()) }
  await page.keyboard.press('Escape')
  // Nothing matching: its own words, where the list was.
  if ((await field.count()) > 0) {
    await field.fill('nothing-is-called-this')
    const heading = page.getByRole('heading', { name: 'Nothing matches', level: 3 })
    await expect(heading.or(page.getByText(/match/i).first())).toBeVisible()
    await look('nothing matching: its heading', heading)
    await look('nothing matching: its line', heading.locator('xpath=following-sibling::*[1]'))
    await field.fill('')
  } else {
    seen['nothing matching: its heading'] = 'missing'
    seen['nothing matching: its line'] = 'missing'
  }
  return seen
}

/** Each difference, as a line of a checklist: the part, the property, Lumovi's and the kit's. */
function differences(lumovi: Seen, kit: Seen): string[] {
  return (Object.keys(PARTS) as Part[]).flatMap((part) => {
    const ours = lumovi[part]
    const theirs = kit[part]
    if (ours === 'missing' || ours === undefined)
      return [`${part}: Lumovi's list has none to compare`]
    if (theirs === 'missing' || theirs === undefined) return [`${part}: the kit's table has none`]
    return Object.keys(ours)
      .filter((prop) => ours[prop] !== theirs[prop])
      .map(
        (prop) =>
          `${part}: ${prop} is ${theirs[prop]} in the kit's table, ${ours[prop]} in Lumovi's`,
      )
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`a plugin’s table draws as Lumovi’s own lists do (${theme})`, async ({ launch }) => {
    const { page } = await launch({ theme })
    await openCluster(page)
    await goTo(page, 'Workloads')
    const lumovi = await parts(page, page.getByRole('grid', { name: 'Workloads' }))
    await page.evaluate(() => {
      window.location.hash = '#/cluster/demo/plugins/argo-cd/applications'
    })
    const applications = page.getByRole('grid', { name: 'Applications' })
    await expect(applications.getByRole('row').nth(1)).toBeVisible()
    const kit = await parts(page, applications)
    expect(differences(lumovi, kit)).toEqual([])
  })
}
