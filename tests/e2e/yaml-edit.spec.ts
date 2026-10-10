/**
 * Edits to YAML text that leave the rest of it as it was written (`lib/yaml-edit`): what the
 * form beside Create's editor rests on. Asked of the text itself, not of what it parses to:
 * the bytes around a value that's replaced, the lines around one that's added or removed.
 */
import { parse, parseAllDocuments } from 'yaml'
import {
  elsewhere,
  linesAt,
  pathText,
  removeAt as tryRemove,
  setAt as trySet,
  type Path,
} from '../../src/renderer/src/lib/yaml-edit.ts'
import { expect, test } from './fixtures.ts'

const C = ['spec', 'template', 'spec', 'containers', 0] as const

/** An edit that's made: `null` (it couldn't be, without writing the whole document again) fails the test. */
function made(text: string | null): string {
  if (text === null) throw new Error('The edit wasn’t made')
  return text
}
const setAt = (...edit: Parameters<typeof trySet>) => made(trySet(...edit))
const removeAt = (...edit: Parameters<typeof tryRemove>) => made(tryRemove(...edit))

/** A Deployment as someone wrote it: comments, an order of their own, keys no form knows. */
const WRITTEN = `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: web
  annotations:
    team: storefront
spec:
  replicas: 2 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: web
          image: "ghcr.io/acme/web:2.4.1"   # pinned
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
`

const at = (text: string, path: Path): unknown =>
  path.reduce<unknown>(
    (value, part) => (value as Record<string | number, unknown> | undefined)?.[part],
    parse(text),
  )

/** The lines of `after` that aren't lines of `before`, and those of `before` that are gone. */
function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }
  return {
    at: head + 1,
    gone: a.slice(head, a.length - tail),
    added: b.slice(head, b.length - tail),
  }
}

test('a value that’s there is replaced where it is: not a byte around it changes', () => {
  for (const [path, value, from, to] of [
    [
      ['metadata', 'name'],
      'storefront',
      'name: web\n  annotations',
      'name: storefront\n  annotations',
    ],
    [['spec', 'replicas'], 3, 'replicas: 2 # two for now', 'replicas: 3 # two for now'],
    // Its quotes are the value's own characters: the new one is written as YAML would.
    [
      [...C, 'image'],
      'nginx:1.27',
      'image: "ghcr.io/acme/web:2.4.1"   # pinned',
      'image: nginx:1.27   # pinned',
    ],
    [[...C, 'ports', 0, 'containerPort'], 80, 'containerPort: 8080', 'containerPort: 80'],
    [[...C, 'env', 0, 'value'], 'debug', 'value: info', 'value: debug'],
  ] as const) {
    const next = setAt(WRITTEN, path, value)
    expect(next, pathText(path)).toBe(WRITTEN.replace(from, to))
    expect(at(next, path), pathText(path)).toEqual(value)
  }
  // The same value again changes nothing at all.
  expect(setAt(WRITTEN, ['metadata', 'name'], 'web')).toBe(WRITTEN)
  expect(setAt(WRITTEN, ['spec', 'replicas'], 2)).toBe(WRITTEN)
  // With Windows' line endings, likewise.
  const crlf = WRITTEN.replace(/\n/g, '\r\n')
  expect(setAt(crlf, ['spec', 'replicas'], 3)).toBe(
    crlf.replace('replicas: 2 # two', 'replicas: 3 # two'),
  )
})

test('a key with nothing after it takes its value after a space', () => {
  for (const [written, expected] of [
    ['metadata:\n  name:\n  namespace: shop\n', 'metadata:\n  name: web\n  namespace: shop\n'],
    ['metadata:\n  name:   \n', 'metadata:\n  name: web\n'],
    ['metadata:\n  name: # to be said\n', 'metadata:\n  name: web # to be said\n'],
    ['metadata:\n  name: ~\n', 'metadata:\n  name: web\n'],
    ['metadata:\n  name: null\n', 'metadata:\n  name: web\n'],
    ['metadata:\n  name:', 'metadata:\n  name: web'],
    ['metadata:\r\n  name:\r\n', 'metadata:\r\n  name: web\r\n'],
  ] as const) {
    expect(setAt(written, ['metadata', 'name'], 'web'), JSON.stringify(written)).toBe(expected)
  }
})

test('what’s written new is quoted where an older YAML would read it as something else', () => {
  const env = (value: string) =>
    setAt('env:\n  - name: A\n    value: x\n', ['env', 0, 'value'], value)
  for (const [value, written] of [
    ['on', '"on"'],
    ['yes', '"yes"'],
    ['NO', '"NO"'],
    ['y', '"y"'],
    ['Off', '"Off"'],
    ['~', '"~"'],
    ['null', '"null"'],
    ['true', '"true"'],
    // A number as a string stays a string.
    ['8080', '"8080"'],
    ['0755', '"0755"'],
    ['1:30', '"1:30"'],
    // What nothing would misread is plain.
    ['info', 'info'],
    ['once', 'once'],
    ['north', 'north'],
  ] as const) {
    expect(env(value), value).toBe(`env:\n  - name: A\n    value: ${written}\n`)
    expect(at(env(value), ['env', 0, 'value']), value).toBe(value)
  }
  // In a block that's added, too.
  const added = setAt('spec:\n  a: 1\n', ['spec', 'env'], [{ name: 'DEBUG', value: 'on' }])
  expect(added).toBe('spec:\n  a: 1\n  env:\n    - name: DEBUG\n      value: "on"\n')
  // A schedule has what YAML needs quoted, and is.
  expect(setAt('spec:\n  schedule:\n', ['spec', 'schedule'], '30 2 * * *')).toBe(
    'spec:\n  schedule: 30 2 * * *\n',
  )
  expect(setAt('spec:\n  schedule:\n', ['spec', 'schedule'], '*/5 * * * *')).toBe(
    'spec:\n  schedule: "*/5 * * * *"\n',
  )
})

test('a key that isn’t there is written on lines of its own, where it belongs', () => {
  const ORDER = ['name', 'image', 'command', 'ports', 'env', 'resources']
  // After the last of those it follows: resources, after env.
  const resources = setAt(WRITTEN, [...C, 'resources', 'requests', 'cpu'], '250m', ORDER)
  expect(lineDiff(WRITTEN, resources)).toEqual({
    at: 31,
    gone: [],
    added: ['          resources:', '            requests:', '              cpu: 250m'],
  })
  // One more beside it joins what's there.
  const memory = setAt(resources, [...C, 'resources', 'requests', 'memory'], '128Mi', ORDER)
  expect(lineDiff(resources, memory)).toEqual({
    at: 34,
    gone: [],
    added: ['              memory: 128Mi'],
  })
  const limit = setAt(memory, [...C, 'resources', 'limits', 'memory'], '256Mi', ORDER)
  expect(lineDiff(memory, limit).added).toEqual([
    '            limits:',
    '              memory: 256Mi',
  ])
  // Between the two it sits between: a command, after the image and before the ports.
  const command = setAt(WRITTEN, [...C, 'command'], ['sh', '-c', 'date'], ORDER)
  expect(lineDiff(WRITTEN, command)).toEqual({
    at: 26,
    gone: [],
    added: ['          command:', '            - sh', '            - -c', '            - date'],
  })
  // One that's named nowhere goes last.
  const last = setAt(WRITTEN, ['metadata', 'labels', 'tier'], 'web')
  expect(lineDiff(WRITTEN, last)).toEqual({
    at: 9,
    gone: [],
    added: ['  labels:', '    tier: web'],
  })
  // A list takes one more, lined up with its own.
  const variable = setAt(WRITTEN, [...C, 'env', 1], { name: 'PORT', value: '8080' })
  expect(lineDiff(WRITTEN, variable)).toEqual({
    at: 31,
    gone: [],
    added: ['            - name: PORT', '              value: "8080"'],
  })
  // With Windows' line endings, what's added ends as the rest does.
  const crlf = setAt(WRITTEN.replace(/\n/g, '\r\n'), [...C, 'env', 1], { name: 'A', value: 'b' })
  expect(crlf.split('\r\n').join('\n')).toBe(
    setAt(WRITTEN, [...C, 'env', 1], { name: 'A', value: 'b' }),
  )
  expect(crlf.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  // And in a text that ends without one, the last line still ends the text.
  const open = 'metadata:\n  name: web'
  expect(setAt(open, ['metadata', 'namespace'], 'shop')).toBe(
    'metadata:\n  name: web\n  namespace: shop',
  )
})

test('what’s removed takes its own lines, and a key left with nothing', () => {
  // The only variable: `env` goes with it.
  expect(lineDiff(WRITTEN, removeAt(WRITTEN, [...C, 'env', 0], C.length))).toEqual({
    at: 28,
    gone: ['          env:', '            - name: LOG_LEVEL', '              value: info'],
    added: [],
  })
  // The port: its list and `ports` go.
  expect(
    lineDiff(WRITTEN, removeAt(WRITTEN, [...C, 'ports', 0, 'containerPort'], C.length)),
  ).toEqual({
    at: 26,
    gone: ['          ports:', '            - containerPort: 8080'],
    added: [],
  })
  // One of two: only that one.
  const two = setAt(WRITTEN, [...C, 'env', 1], { name: 'PORT', value: '8080' })
  expect(lineDiff(two, removeAt(two, [...C, 'env', 0], C.length))).toEqual({
    at: 29,
    gone: ['            - name: LOG_LEVEL', '              value: info'],
    added: [],
  })
  expect(removeAt(two, [...C, 'env', 1], C.length)).toBe(WRITTEN)
  // A key with a comment after it: the comment was that line's, and goes with it.
  expect(lineDiff(WRITTEN, removeAt(WRITTEN, ['spec', 'replicas']))).toEqual({
    at: 10,
    gone: ['  replicas: 2 # two for now'],
    added: [],
  })
  // What isn't there to remove changes nothing.
  expect(removeAt(WRITTEN, [...C, 'resources'])).toBe(WRITTEN)
  // The first key of a list's item shares its line with the dash: the item is written again,
  // and nothing outside it moves.
  const named = removeAt(WRITTEN, [...C, 'name'], C.length)
  expect(at(named, C)).not.toHaveProperty('name')
  expect(at(named, [...C, 'image'])).toBe('ghcr.io/acme/web:2.4.1')
  expect(named.split('\n').slice(0, 23)).toEqual(WRITTEN.split('\n').slice(0, 23))
})

test('a block that isn’t written the plain way is written again, and nothing outside it', () => {
  // A map on one line takes a key: that map is laid out anew.
  const flow = `spec:
  # how much it may use
  resources: { limits: { memory: 256Mi } }   # for now
  replicas: 2
`
  const next = setAt(flow, ['spec', 'resources', 'requests', 'cpu'], '250m')
  expect(parse(next)).toEqual({
    spec: { resources: { limits: { memory: '256Mi' }, requests: { cpu: '250m' } }, replicas: 2 },
  })
  expect(next.split('\n').at(0)).toBe('spec:')
  expect(next).toContain('# how much it may use')
  expect(next).toContain('  replicas: 2\n')
  // A value over several lines is replaced whole.
  const block = `data:
  motd: |
    hello
    there
  other: kept   # as it was
`
  const said = setAt(block, ['data', 'motd'], 'hi')
  expect(parse(said)).toEqual({ data: { motd: 'hi', other: 'kept' } })
  expect(said).toContain('  other: kept   # as it was\n')
  // And one of one line becomes one of several.
  const lines = setAt(block, ['data', 'other'], 'one\ntwo\n')
  expect(parse(lines)).toEqual({ data: { motd: 'hello\nthere\n', other: 'one\ntwo\n' } })
  // A plain value that runs over two lines, too.
  const folded = 'a:\n  b: one\n    two\n  c: 3\n'
  expect(parse(setAt(folded, ['a', 'b'], 'x'))).toEqual({ a: { b: 'x', c: 3 } })
})

test('what’s an alias, anchored, or merged in isn’t one value in one place', () => {
  const text = `base: &base
  image: nginx
first:
  <<: *base
  name: one
second: *base
third:
  name: &n web
  again: *n
plain:
  name: web
`
  expect(elsewhere(text, ['second'])).toBe('alias')
  expect(elsewhere(text, ['second', 'image'])).toBe('alias')
  expect(elsewhere(text, ['base', 'image'])).toBe('anchor')
  expect(elsewhere(text, ['first', 'name'])).toBe('merge')
  expect(elsewhere(text, ['third', 'name'])).toBe('anchor')
  expect(elsewhere(text, ['third', 'again'])).toBe('alias')
  expect(elsewhere(text, ['plain', 'name'])).toBeUndefined()
  expect(elsewhere(text, ['plain', 'nothing', 'there'])).toBeUndefined()
})

test('which lines a path is on', () => {
  expect(linesAt(WRITTEN, ['metadata', 'name'])).toEqual([6, 6])
  expect(linesAt(WRITTEN, ['spec', 'strategy'])).toEqual([11, 12])
  expect(linesAt(WRITTEN, [...C, 'image'])).toEqual([25, 25])
  expect(linesAt(WRITTEN, [...C, 'env'])).toEqual([28, 30])
  expect(linesAt(WRITTEN, [...C, 'env', 0])).toEqual([29, 30])
  expect(linesAt(WRITTEN, C)).toEqual([24, 30])
  expect(linesAt(WRITTEN, [...C, 'resources'])).toBeUndefined()
  expect(linesAt('metadata:\n  name:\n', ['metadata', 'name'])).toEqual([2, 2])
})

test('what doesn’t parse, or holds several documents, is left as it is', () => {
  const broken = 'metadata:\n  name: [web\n'
  expect(trySet(broken, ['metadata', 'name'], 'x')).toBeNull()
  expect(tryRemove(broken, ['metadata', 'name'])).toBeNull()
  // Nor is an edit made where there's no map or list for it to be made in: nothing comes
  // back, and nothing is thrown.
  for (const [text, path] of [
    ['# only a comment\n', ['metadata', 'name']],
    ['', ['metadata', 'name']],
    ['just a string\n', ['metadata', 'name']],
    ['- a\n- b\n', ['metadata', 'name']],
    ['metadata: web\n', ['metadata', 'name']],
    ['a: &x {}\nb: *x\n', ['b', 'name']],
  ] as const) {
    expect(trySet(text, path, 'x'), JSON.stringify(text)).toBeNull()
  }
  expect(tryRemove('just a string\n', ['metadata', 'name'])).toBe('just a string\n')
  expect(tryRemove('- a\n- b\n', ['metadata', 'name'])).toBe('- a\n- b\n')
  expect(tryRemove('', ['metadata'])).toBe('')
  // An empty map or list takes what's set below it, as a key with nothing does.
  expect(
    setAt('spec:\n  containers: []\n  other: 1\n', ['spec', 'containers', 0, 'image'], 'nginx'),
  ).toBe('spec:\n  containers:\n    - image: nginx\n  other: 1\n')
  expect(setAt('a: {}\n', ['a', 'b', 'c'], 1)).toBe('a:\n  b:\n    c: 1\n')
})

/**
 * A value with every empty map and list as nothing: a key that's left with nothing and one
 * left with `{}` (where its map was written on one line) read the same to Kubernetes.
 */
const hollow = (value: unknown): unknown =>
  typeof value !== 'object' || value === null
    ? value
    : Object.keys(value).length === 0
      ? null
      : Array.isArray(value)
        ? value.map(hollow)
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hollow(item)]))

/** The same edits, to an object: what the text must come to mean. */
function applied(value: unknown, path: Path, next: unknown, remove: boolean): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>
  let node = copy
  for (const part of path.slice(0, -1)) {
    node[part] ??= {}
    node = node[part] as Record<string | number, unknown>
  }
  const key = path.at(-1)!
  if (!remove) {
    node[key] = next
    return copy
  }
  if (Array.isArray(node)) node.splice(key as number, 1)
  else delete node[key]
  // The last thing a key held leaves the key with nothing.
  if (path.length > 1 && Object.keys(node).length === 0) {
    const holder = path
      .slice(0, -2)
      .reduce((value, part) => value[part] as Record<string | number, unknown>, copy)
    holder[path.at(-2)!] = null
  }
  return copy
}

test('any run of edits, on YAML written any way: it means what was asked, and the rest is as it was', () => {
  // Written by construction every awkward way: Windows' endings, a comment on the line, a
  // map on one line, a key with no value, a value over several lines, four spaces, a tab.
  const seeds = [
    WRITTEN,
    WRITTEN.replace(/\n/g, '\r\n'),
    'a:\n    b: 1 # four spaces\n    c:\n        d: x\n    list:\n        - one\n        - two\n',
    'a: { b: 1, c: { d: x } }\nlist: [one, two]\ne:\n',
    'a:\n  b:\n  c: |\n    several\n    lines\n  d: plain\n# the end\n',
    'a:\n  b:\t1\n  c:   spaced   # and said\n',
    '\uFEFFa:\n  b: 1\n',
    '---\na:\n  b: 1\n',
  ]
  const paths: Path[] = [
    ['a', 'b'],
    ['a', 'c', 'd'],
    ['a', 'new'],
    ['a', 'deep', 'er', 'still'],
    ['metadata', 'name'],
    ['spec', 'replicas'],
    ['top'],
  ]
  const values = [1, 'x', 'on', '8080', 'two words', true, 'a: b', '# not a comment', '']
  let seed = 170
  const random = (below: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % below
  }
  let edits = 0
  for (const start of seeds) {
    for (let run = 0; run < 250; run++) {
      let text = start
      for (let step = 0; step < 6; step++) {
        const path = paths[random(paths.length)]!
        const value = values[random(values.length)]!
        const remove = random(4) === 0
        const before = parse(text) as unknown
        const said = `${remove ? 'remove' : `set ${JSON.stringify(value)} at`} ${pathText(path)} in ${JSON.stringify(text)}`
        // (A value can't be set under what isn't a map.)
        const reachable = path.slice(0, -1).every((_, i) => {
          const above = at(text, path.slice(0, i + 1))
          return above === undefined || typeof above === 'object'
        })
        if (!reachable) continue
        const there = at(text, path) !== undefined
        if (remove && !there) {
          expect(removeAt(text, path, path.length), said).toBe(text)
          continue
        }
        const next = remove ? removeAt(text, path, path.length) : setAt(text, path, value)
        edits += 1
        expect(
          parseAllDocuments(next).flatMap((d) => d.errors),
          said,
        ).toEqual([])
        expect(hollow(parse(next)), said).toEqual(
          hollow(applied(before ?? {}, path, value, remove)),
        )
        // What changed is as little as that edit takes, in the text itself: a value that was
        // there on one line changes on that line alone; one that's added takes only lines of
        // its own; one that's removed only gives lines up. (A map on one line is the block
        // that's written again: there, lines may change, and nothing is asked of them here.)
        const diff = lineDiff(text, next)
        const was = at(text, path)
        const plain = !start.startsWith('a: {')
        if (plain && !remove && there && typeof was !== 'object' && !String(was).includes('\n')) {
          expect(diff.gone.length, said).toBeLessThanOrEqual(1)
          expect(diff.added.length, said).toBeLessThanOrEqual(1)
        } else if (plain && !remove && !there) {
          expect(diff.gone, said).toEqual([])
        } else if (plain && remove) {
          expect(diff.added, said).toEqual([])
        }
        // The same again changes nothing.
        if (!remove) expect(setAt(next, path, value), said).toBe(next)
        // Its line endings are all of one kind, as they were.
        if (start.includes('\r\n')) expect(next.replace(/\r\n/g, ''), said).not.toMatch(/[\r\n]/)
        else expect(next, said).not.toContain('\r')
        // Comments are all still there.
        for (const comment of text.match(/#[^\n\r"]*$/gm) ?? []) {
          if (!remove && typeof at(text, path) !== 'object')
            expect(next, said).toContain(comment.trimEnd())
        }
        text = next
      }
    }
  }
  expect(edits).toBeGreaterThan(1500)
})
