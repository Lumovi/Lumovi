/**
 * A Secret's values read by key, on the desktop: only the asked keys' values reach the page, and
 * the call is the page's own: a plugin's box has no way to it. No value is in a test's title,
 * an expectation or its output: marks are made as the test runs, and a check says only whether
 * one was found.
 */
import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { SecretValues } from '../../src/shared/api.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { expect, openCluster, test } from './fixtures.ts'

const base64 = (text: string) => Buffer.from(text).toString('base64')
const mark = () => `mark-${randomBytes(12).toString('hex')}`
const written = (text: string) => [text, base64(text)]

type Answer =
  { ok: true; data: SecretValues } | { ok: false; error: { code: string; message: string } }

const read = (page: Page, query: object) =>
  page.evaluate(
    (q) =>
      (
        window as unknown as { lumovi: { kube: { secretValues(q: object): Promise<unknown> } } }
      ).lumovi.kube.secretValues(q),
    query,
  ) as Promise<Answer>

test('a Secret’s values by key on the desktop: the asked keys’ and no others, and not from a plugin’s box', async ({
  page,
  clusters,
}) => {
  const marks = { token: mark(), password: mark(), annotation: mark() }
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'marked',
      namespace: 'batch',
      uid: 'marked-batch',
      creationTimestamp: new Date().toISOString(),
      annotations: { note: marks.annotation },
    },
    type: 'Opaque',
    data: { token: base64(marks.token), password: base64(marks.password) },
  } as unknown as KubeObject)
  try {
    await openCluster(page)
    const query = { context: 'demo', namespace: 'batch', name: 'marked' }
    const one = await read(page, { ...query, keys: ['token', 'absent'] })
    expect(one.ok).toBe(true)
    const answer = (one as { data: SecretValues }).data
    // What the call answered is all that crossed to the page: searched whole.
    const crossed = JSON.stringify(one)
    const found = (text: string) => written(text).some((form) => crossed.includes(form))
    expect(found(marks.token)).toBe(true)
    expect([found(marks.password), found(marks.annotation)]).toEqual([false, false])
    expect(answer.values.map(([key]) => key)).toEqual(['token'])
    expect(answer.values[0]![1].length).toBe(base64(marks.token).length)
    expect(answer.missing).toEqual(['absent'])
    expect([
      answer.namespace === 'batch',
      answer.name === 'marked',
      answer.uid === 'marked-batch',
      // (Not even the names of its other keys: nothing that wasn't asked for.)
      !crossed.includes('password'),
      answer.withheld,
    ]).toEqual([true, true, true, true, false])
    // Malformed, it's refused as on a server; a Secret that isn't there is said in Lumovi's words.
    const refused = async (q: object) => {
      const result = await read(page, q)
      return result.ok ? 'ok' : `${result.error.code}: ${result.error.message}`
    }
    expect(await refused({ ...query, keys: [] })).toBe(
      'invalid: Expected 1 to 20 of the Secret’s keys, each once and each a key’s name',
    )
    // (One for a plugin's page names what named the Secret too: without, it's malformed.)
    expect(await refused({ ...query, keys: ['token'], forPlugin: 'flux' })).toBe(
      'invalid: Expected a Secret, its keys and what named it',
    )
    expect(await refused({ ...query, name: 'no-such-secret', keys: ['token'] })).toBe(
      'not-found: There’s no such Secret.',
    )

    // The call is the page's own. A plugin's code runs in its box's worker, which has nothing of
    // Lumovi's to call: no `lumovi`, no way to the process behind the page.
    await page.waitForFunction(() => '__lumoviBox' in window)
    await page.evaluate(() => {
      const w = window as unknown as {
        __lumoviBox: { openBox(options: object): unknown }
        __heard?: string[]
      }
      w.__heard = []
      w.__lumoviBox.openBox({
        plugin: 'asker',
        code: `box.then(({ post }) => post(['lumovi', 'require', 'process', 'electron'].map((name) => name + ':' + typeof self[name]).join(' ')))`,
        heard: (text: string) => w.__heard!.push(text),
        ended: () => undefined,
      })
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __heard: string[] }).__heard))
      .toEqual(['lumovi:undefined require:undefined process:undefined electron:undefined'])
  } finally {
    clusters.demo.remove('Secret', 'batch', 'marked')
  }
})
