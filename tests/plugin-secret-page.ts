/**
 * The tests' stand-in for a plugin whose page shows a Secret by reference (Toys, with
 * `spec.showsSecrets`), the widget and the Secret it's tried on, and how a key's box is asked what
 * it shows. No value is in a title, an expectation or an output: a box is asked whether it shows
 * its dots, yes or no.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator } from '@playwright/test'
import { CUSTOM } from './mock-cluster/fixtures/custom.ts'
import type { MockCluster } from './mock-cluster/server.ts'
import type { KubeObject } from './mock-cluster/types.ts'

/** The stand-in's own button, in its proof: a press Lumovi does tell its code of. */
export const TELLS = 'Tell its code'

export const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  showsSecrets:
    - { group: example.com, kind: Widget, path: spec.secretName, keys: [password, note, empty, turned] }
`

/**
 * Its code: it reads the widgets, and for the one that names a Secret draws what `parts` says
 * with that Secret's token (\`T\`) and the widget's own (\`O\`). Its header says how many messages
 * it has been sent, every one counted.
 *
 * With `proof`, its header says what it could tell from them, too: Lumovi reads its list again
 * every few seconds and sends the answer each time, so the count alone rises with no press at
 * all. It keeps its read's first answer, and says how many messages came after it (`again`), how
 * many of those weren't that answer to the letter (`unlike`), and the least time between two of
 * them (`least`). And it has a button of its own, whose press Lumovi does tell it of: what the
 * proof looks like when something is sent.
 */
export const code = (parts: string, proof = false) => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let heard = 0
  let made = false
  let answer
  let again = 0
  let unlike = 0
  let least
  let last
  const header = () => (${
    proof
      ? `{
    name: 'heard ' + heard + ': ' + again + ' again, ' + unlike + ' unlike it, least ' + (least === undefined ? 'none' : least) + ' ms apart',
    buttons: [{ key: 'tell', name: '${TELLS}' }],
    onPress: 'press',
  }`
      : `{ name: 'heard ' + heard }`
  })
  commit([['make', 1, 'Header', header()], ['put', 0, 1]])
  listen((text) => {
    const now = Date.now()
    heard++
    const said = JSON.parse(text)
    if (answer === undefined) {
      if (said.objects) {
        answer = text
        last = now
      }
    } else {
      again++
      if (text !== answer) unlike++
      least = least === undefined ? now - last : Math.min(least, now - last)
      last = now
    }
    const keyed = said.objects && said.objects.find((o) => o.object.metadata.name === 'keyed')
    const T = keyed && keyed.secrets && keyed.secrets[0] && keyed.secrets[0].tokens[0]
    if (T && !made) {
      made = true
      const O = keyed.token
      const steps = []
      ;(${parts}).forEach((props, i) => steps.push(['make', 10 + i, 'Secret', props], ['put', 0, 10 + i]))
      commit(steps)
    }
    commit([['change', 1, header()]])
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
})
`
/** Its Secret whole, the same narrowed to one key, and three that name no Secret of its own. */
export const PARTS = `[
  { title: 'Widget keys', secret: T },
  { title: 'Only its password', secret: T, keys: ['password'] },
  { title: 'Made up', secret: 'AAAAAAAAAAAAAAAAAAAAAAAA' },
  { title: 'An object, not a Secret', secret: O },
  { title: 'Names none' },
]`
/**
 * What the stand-in's header says of the messages its code was sent (`code(parts, true)`): how
 * many after its read's first answer, how many of those weren't that answer to the letter, and
 * the least time between two of them (none yet: as long as can be).
 */
export function toldOf(header: string): { again: number; unlike: number; least: number } {
  const said = /heard \d+: (\d+) again, (\d+) unlike it, least (\d+|none) ms apart/.exec(header)
  if (!said) return { again: 0, unlike: 0, least: Infinity }
  return {
    again: Number(said[1]),
    unlike: Number(said[2]),
    least: said[3] === 'none' ? Infinity : Number(said[3]),
  }
}
/**
 * The least two messages may be apart, with no press starting one: Lumovi reads a list again five
 * seconds after its last answer, so a message a press caused would stand under half of that from
 * one of its neighbours. (Well under five seconds, for how unevenly a busy machine delivers.)
 *
 * It's a floor against a read started early, and no more than that: a re-read that comes a
 * little late because the page was busy drawing a reveal passes it. That's the jitter any page
 * has, far below anything a value could be read from.
 */
export const APART = 3000

export const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** Toys, as if it came with Lumovi, with `js` as its code. */
export function included(js: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  writeFileSync(join(folder, 'toys.js'), js)
  return folder
}

/**
 * A widget that names a Secret, and that Secret: a short value, a long one, an empty one, one
 * with a character that turns a line round, and a key its plugin's file doesn't name.
 */
export function keyed(cluster: MockCluster) {
  const widget = cluster.object('Widget.example.com', 'default', CUSTOM.widget)!
  cluster.upsert({
    ...structuredClone(widget),
    metadata: { ...widget.metadata, name: 'keyed', uid: 'keyed-uid' },
    spec: { ...(widget.spec as object), secretName: 'widget-keys' },
  } as KubeObject)
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'widget-keys', namespace: 'default', uid: 'widget-keys-uid' },
    type: 'Opaque',
    data: {
      password: base64('a stand-in for a password'),
      note: base64('a long stand-in, '.repeat(200)),
      empty: '',
      turned: base64('stand-in ‮ turned'),
      other: base64('a key its file never names'),
    },
  } as KubeObject)
}
export const SECRET = '/api/v1/namespaces/default/secrets/widget-keys'

const MASK = '••••••••'
/**
 * Whether a key's box shows the dots or something else: asked as yes or no, so that where it
 * fails nothing of what the box held is printed.
 */
export const expectHidden = (box: Locator, hidden: boolean) =>
  expect
    .poll(async () => (await box.locator('pre').innerText()) === MASK, {
      message: hidden ? 'the box should show its dots' : 'the box should show its value',
    })
    .toBe(hidden)
