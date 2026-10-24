/**
 * A page's workers answer only what the page that made them sends, through the worker's own
 * port: such a message has no origin, in every engine. One that comes any other way, with an
 * origin, is dropped.
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, firefox, webkit } from '@playwright/test'
import { expect, test } from './fixtures.ts'

/** Each worker, by the name its file is built under, and an ask of its kind (numbered). */
const WORKERS = [
  {
    name: 'match.worker',
    ask: {
      search: { kind: 'plain', needle: 'paid', matchCase: false },
      lines: [{ key: 0, message: 'Order 1001 PAID', parts: ['Order 1001 PAID'] }],
    },
  },
  { name: 'histogram.worker', ask: { ats: [0], levels: [2], start: 0, step: 1_000, bars: 1 } },
  { name: 'yaml-check.worker', ask: { text: 'kind: ConfigMap\n', known: {} } },
]

/** Where a build's worker is served from. */
const built = (name: string) => {
  const file = readdirSync(resolve('out/renderer/assets')).find(
    (each) => each.startsWith(`${name}-`) && each.endsWith('.js'),
  )
  if (!file) throw new Error(`No ${name} in the build`)
  return `assets/${file}`
}

for (const [name, engine] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test(`a page’s workers answer only what the page sends them: ${name}`, async ({ serve }) => {
    // Chromium is every run's. The other two are CI's Browsers job's, which says so
    // (LUMOVI_E2E_BROWSERS=all): there, one that isn't installed or doesn't start fails the
    // test. Elsewhere they run where they can, and are skipped where they can't.
    const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
    test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
    const served = await serve()
    const browser = await engine.launch().catch((error: unknown) => {
      if (must) throw error
      return undefined
    })
    test.skip(!browser, `${name} doesn’t start on this computer`)
    if (!browser) return
    try {
      const page = await browser.newPage()
      await page.goto(served.url)
      for (const { name: worker, ask } of WORKERS) {
        const url = `${served.url}${built(worker)}`
        const started = page.waitForEvent('worker', (each) => each.url() === url)
        // The page's own ask, answered.
        const answered = await page.evaluate(
          ({ url, ask }) =>
            new Promise<number>((done) => {
              const made = new Worker(url, { type: 'module' })
              made.addEventListener('message', ({ data }: MessageEvent<{ id?: number }>) => {
                if (data.id !== undefined) done(data.id)
              })
              made.postMessage({ ...ask, id: 1 })
            }),
          { url, ask },
        )
        expect(answered, worker).toBe(1)
        // Two more, heard as messages in the worker: one with an origin, then one without.
        const inside = await started
        const said = await inside.evaluate((ask) => {
          type Post = (message: { id?: number }, ...rest: unknown[]) => void
          const scope = self as unknown as { postMessage: Post }
          const sent: (number | undefined)[] = []
          const post = scope.postMessage.bind(scope)
          scope.postMessage = (message, ...rest) => {
            sent.push(message.id)
            post(message, ...rest)
          }
          for (const [id, origin] of [
            [2, 'https://elsewhere.example'],
            [3, ''],
          ] as const) {
            self.dispatchEvent(new MessageEvent('message', { data: { ...ask, id }, origin }))
          }
          return sent
        }, ask)
        expect(said, worker).toEqual([3])
      }
    } finally {
      await browser.close()
      await served.stop()
    }
  })
}
