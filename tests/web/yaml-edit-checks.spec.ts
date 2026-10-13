/**
 * The edits Create's form makes to YAML text (`lib/yaml-edit`), tried in Lumovi's own built page:
 * yaml-edit-cases' cases, run with the source's edits, and every call they make made again by
 * the page's own (the tests' stage lends them), answering the same. What's measured of the edits
 * is then what ran in a page; yaml-edit.spec tries the cases as plain functions.
 */
import type { Page } from '@playwright/test'
import * as yamlEdit from '../../src/renderer/src/lib/yaml-edit.ts'
import { YAML_EDIT_CASES, YAML_EDITS, type YamlEdits } from '../e2e/yaml-edit-cases.ts'
import { expect, test } from './fixtures.ts'

type Edit = (typeof YAML_EDITS)[number]
/** One call a case made: which edit, with what, and what the source's answered. */
interface Call {
  edit: Edit
  args: unknown[]
  answer: unknown
}

/** The source's edits, each call written down as it's made. */
function recording(calls: Call[]): YamlEdits {
  const edit =
    (name: Edit) =>
    (...args: unknown[]): unknown => {
      const answer = (yamlEdit[name] as unknown as (...args: unknown[]) => unknown)(...args)
      calls.push({ edit: name, args, answer })
      return answer
    }
  return Object.fromEntries(YAML_EDITS.map((name) => [name, edit(name)])) as unknown as YamlEdits
}

/** The same calls, made by the page's own edits: what each answered. */
const madeIn = (page: Page, calls: Call[]) =>
  page.evaluate(
    (calls) => {
      const lent = (
        window as unknown as {
          __lumoviDoor: { yamlChecks: Record<string, (...args: unknown[]) => unknown> }
        }
      ).__lumoviDoor.yamlChecks
      return calls.map(({ edit, args }) => lent[edit]!(...args))
    },
    calls.map(({ edit, args }) => ({ edit, args })),
  )

test('every call yaml-edit’s cases make, made again in Lumovi’s built page, answers the same', async ({
  page,
  serve,
}) => {
  test.slow()
  const { url } = await serve()
  await page.goto(url)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  for (const [title, run] of Object.entries(YAML_EDIT_CASES)) {
    await test.step(title, async () => {
      const calls: Call[] = []
      run(recording(calls))
      expect(calls.length, title).toBeGreaterThan(0)
      // (In turns: the run of seeded edits makes thousands.)
      for (let from = 0; from < calls.length; from += 500) {
        const turn = calls.slice(from, from + 500)
        expect(await madeIn(page, turn), `${title}, calls ${from + 1}–`).toEqual(
          turn.map(({ answer }) => answer),
        )
      }
    })
  }
})
