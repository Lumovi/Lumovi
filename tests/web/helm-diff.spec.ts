/**
 * What a Helm rollback's dialog shows of what it changes (src/renderer/src/lib/helm-diff.ts): a
 * Secret's values masked line for line, the values by key alone, and what Helm did after a failure.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseAllDocuments } from 'yaml'
import { expect, test } from '../temp-folders.ts'
import { fetchHelm } from '../../scripts/helm.ts'
import {
  asHelmKeeps,
  FORMS,
  MORE_SHAPES,
  olderKubernetesDocuments,
  SEPARATORS,
  separated,
  shows,
  VALUE,
} from '../manifest-forms.ts'
import {
  HIDDEN_WHOLE,
  helm3Manifests,
  helmManifests,
  kubernetesDocuments,
  MASK,
  maskedManifest,
  maskedPair,
  masking,
  undoneBy,
  valueKeys,
} from '../../src/renderer/src/lib/helm-diff.ts'

/** The helm Lumovi ships, its checksum checked, with homes of its own: run, and given charts. */
interface Helm {
  run: (...args: string[]) => string
  /** A chart of these files (by path in it), and where it is. */
  chart: (files: Record<string, string | Buffer>) => string
  /** A chart rendered, as `helm template` renders it; none where it refuses it. */
  rendered: (chart: string) => string | undefined
  /** What `helm lint` says of a chart, its errors too. */
  linted: (chart: string) => string
}

/** Tests that read through the helm Lumovi ships: fetched once for each worker. */
const withHelm = test.extend<object, { helm: Helm }>({
  helm: [
    async ({ workerTemp }, use) => {
      const root = mkdtempSync(join(workerTemp, 'helm-'))
      const binary = await fetchHelm(process.platform, process.arch, join(root, 'bin'))
      const env = {
        ...process.env,
        HELM_CACHE_HOME: join(root, 'cache'),
        HELM_CONFIG_HOME: join(root, 'config'),
        HELM_DATA_HOME: join(root, 'data'),
        KUBECONFIG: join(root, 'kubeconfig'),
      }
      const run = (...args: string[]) =>
        execFileSync(binary, args, {
          encoding: 'utf8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 1 << 28,
        })
      let charts = 0
      const chart = (files: Record<string, string | Buffer>) => {
        const dir = join(root, `chart-${charts++}`)
        for (const [path, content] of Object.entries({
          'Chart.yaml': 'apiVersion: v2\nname: probe\nversion: 0.1.0\n',
          ...files,
        })) {
          mkdirSync(dirname(join(dir, path)), { recursive: true })
          writeFileSync(join(dir, path), content)
        }
        return dir
      }
      const rendered = (dir: string) => {
        try {
          return run('template', 'probe', dir)
        } catch {
          return undefined
        }
      }
      const linted = (dir: string) => {
        try {
          return run('lint', dir)
        } catch (error) {
          return String((error as { stdout?: string }).stdout ?? '')
        }
      }
      await use({ run, chart, rendered, linted })
    },
    { scope: 'worker', timeout: 120_000 },
  ],
})

const MANIFEST = `---
# Source: api/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-db
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"password":"c2VjcmV0"}}'
type: Opaque
data:
  password: c2VjcmV0
  "user.name": YWRtaW4=
stringData:
  config.yaml: |
    token: hunter2
    url: https://db
  empty:
---
# Source: api/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:2.4.2
          env:
            - name: data
              value: shown
`

test('a Secret’s data, stringData and last-applied annotation are masked, line for line; nothing else is', () => {
  const masked = maskedManifest(MANIFEST)
  const lines = masked.split('\n')
  // Line for line: a diff of the real text can be shown through it.
  expect(lines).toHaveLength(MANIFEST.split('\n').length)
  expect(masked).not.toContain('c2VjcmV0')
  expect(masked).not.toContain('YWRtaW4=')
  expect(masked).not.toContain('hunter2')
  expect(masked).not.toContain('https://db')
  expect(lines).toContain(`  password: ${MASK}`)
  expect(lines).toContain(`  "user.name": ${MASK}`)
  expect(lines).toContain(`    kubectl.kubernetes.io/last-applied-configuration: ${MASK}`)
  // A block scalar's key stays, its lines are masked; an empty one stays as it is.
  expect(lines).toContain('  config.yaml: |')
  expect(lines).toContain(`    ${MASK}`)
  expect(lines).toContain('  empty:')
  // The Secret's own fields, and a Deployment's (its `data` env var too), are as they were.
  expect(lines).toContain('  name: api-db')
  expect(lines).toContain('type: Opaque')
  expect(masked).toContain('image: ghcr.io/acme/api:2.4.2')
  expect(masked).toContain('            - name: data')
  expect(masked).toContain('              value: shown')
})

/**
 * No value's text anywhere in what's shown, and the same lines, each where it was. (Said yes or
 * no, by which: a failure prints no value.)
 */
function hidden(manifest: string, values: string[]) {
  const masked = maskedManifest(manifest)
  expect(masked.split('\n')).toHaveLength(manifest.split('\n').length)
  values.forEach((value, i) => expect(masked.includes(value), `value ${i + 1} shown`).toBe(false))
  return masked
}

test('a Secret written in any style is masked: where its lines can’t be masked one by one, the whole document is, but for what names it', () => {
  // Flow style, as `data: {{ .Values.secrets | toJson }}` renders it.
  const flow = hidden(
    `---
# Source: api/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-db
  namespace: shop
data: {password: c2VjcmV0, "user": YWRtaW4=}
`,
    ['c2VjcmV0', 'YWRtaW4='],
  )
  // What names it is kept.
  expect(flow).toContain('# Source: api/templates/secret.yaml')
  expect(flow).toContain('kind: Secret')
  expect(flow).toContain('  name: api-db')
  expect(flow).toContain('  namespace: shop')
  // A JSON document, as a template can render one, on one line.
  hidden(
    `---
{"apiVersion":"v1","kind":"Secret","metadata":{"name":"api-db"},"data":{"password":"c2VjcmV0"}}
`,
    ['c2VjcmV0'],
  )
  // A Secret among a List's items: its kind line indented.
  hidden(
    `---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: api-db
    data:
      password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // Its kind's key quoted.
  hidden(
    `---
apiVersion: v1
"kind": Secret
metadata:
  name: api-db
data:
  password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // Its data tagged.
  hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-db
data: !!map
  password: c2VjcmV0
`,
    ['c2VjcmV0'],
  )
  // A block scalar under stringData: masked line by line, its key kept.
  const block = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-config
stringData:
  config.yaml: |
    token: hunter2
    url: https://db.internal
`,
    ['hunter2', 'https://db.internal'],
  )
  expect(block).toContain('  config.yaml: |')
})

test('a document that names a value by an alias is masked whole, but for what names it', () => {
  // Merged into its data from a map beside it.
  const merged = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: a
base: &b
  k: SECRETVALUE
data:
  <<: *b
`,
    ['SECRETVALUE'],
  )
  expect(merged).toContain('kind: Secret')
  expect(merged).toContain('  name: a')
  // Anchored in a label, named in its data.
  hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: a
  labels:
    x: &v SECRETVALUE
data:
  k: *v
`,
    ['SECRETVALUE'],
  )
  // A document with no Secret is masked whole too, but for what names it, and says so: what it
  // is can't be told by every reader alike.
  const plain = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: c
  labels:
    x: &v made-up
data:
  k: *v
`
  expect(maskedManifest(plain)).toBe(`---
apiVersion: v1
kind: ConfigMap
metadata:
  name: c
  ${MASK} # ${HIDDEN_WHOLE}
    ${MASK}
${MASK}
  ${MASK}
`)
  // What's hidden, as the bar over it says: a document whole, no Secret's values; with a Secret
  // beside it, both; in a diff, what either side hides.
  expect(masking(plain).hidden).toEqual({ values: false, documents: 1 })
  expect(masking(MANIFEST).hidden).toEqual({ values: true, documents: 0 })
  expect(masking(`${MANIFEST}${plain}${plain}`).hidden).toEqual({ values: true, documents: 2 })
  expect(maskedPair(MANIFEST, plain).hidden).toEqual({ values: true, documents: 1 })
  // (A document of nothing, as an empty template's, hides nothing.)
  const empty = '---\n# Source: api/templates/off.yaml\n\n---\n# Source: api/templates/none.yaml\n'
  expect(masking(empty)).toEqual({ text: empty, hidden: { values: false, documents: 0 } })
})

test('a document that can’t be read is masked whole: nothing of it is shown but its marker', () => {
  const masked = hidden(
    `---
apiVersion: v1
kind: Secret
metadata:
  name: api-db
data:
  password: c2VjcmV0
  broken: [unclosed
`,
    ['c2VjcmV0', 'unclosed'],
  )
  // (What would name it can't be told from a value where it can't be read.)
  expect(masked.split('\n')[0]).toBe('---')
  expect(masked.includes('api-db')).toBe(false)
})

test('a Secret’s values are masked however its manifest is written', () => {
  // (Made-up values, each said yes or no: a failure prints none.)
  const value = 'made-up'
  const flow = `{apiVersion: v1, kind: Secret, metadata: {name: x}, stringData: {password: ${value}}}`
  const json = `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"x"},"stringData":{"password":"${value}"}}`
  const quoted = (lines: string) =>
    `{apiVersion: v1, kind: Secret, metadata: {name: x}, stringData: {password: "abc\n${lines}\n"}}\n`
  const spaces = ['\u00a0', '\f', '\v', '\ufeff', '\u2028', '\u202f', '\u200a', '\u3000']
  const manifests = [
    `--- ${flow}\n`,
    `--- ${json}\n`,
    `---\t${flow}\n`,
    `---\r${flow}\n`,
    `---\f${flow}\n`,
    `---\u00a0${flow}\n`,
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n--- ${flow}\n---\nkind: Namespace\n`,
    quoted(`kind: ${value}`),
    quoted(`apiVersion: ${value}`),
    quoted(`metadata:\n  name: ${value}`),
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\nstringData:\n  password: "m\\x61de-up"\n`,
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: &n ${value}\nstringData:\n  password: *n\n`,
    ...spaces.flatMap((space) => [
      `{kind: Secret, stringData: {password:\n---${space}${value}}}\n`,
      `{apiVersion: v1, kind: Secret, metadata: {name: x}, stringData: {password: "abc\n---${space}${value}"}}\n`,
      `{apiVersion: v1, kind: Secret, metadata: {name: x}, stringData: {password: abc\n---${space}${value}}}\n`,
      `{apiVersion: v1, kind: Secret, stringData: {password: "abc\n---${space}# ${value}\n`,
    ]),
  ]
  for (const manifest of manifests) {
    const masked = maskedManifest(manifest)
    expect(masked.includes(value)).toBe(false)
    expect(masked.includes('m\\x61de-up')).toBe(false)
    expect(masked.split('\n')).toHaveLength(manifest.split('\n').length)
  }
  // What names a Secret is kept as it was: from what it reads as, its marker and comment too.
  const commented = `--- # the database\napiVersion: v1\nkind: Secret\nmetadata:\n  name: x\nstringData:\n  password: ${value}\n`
  const masked = maskedManifest(commented)
  expect(masked.includes(value)).toBe(false)
  expect(masked).toContain('--- # the database')
  expect(masked).toContain(`  password: ${MASK}`)
  // What isn't a Secret is as it was; but written on its `---` line, which the cluster's reader
  // refuses, it's hidden whole.
  const map = `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {a: b}\n`
  expect(maskedManifest(`---\n${map}`)).toBe(`---\n${map}`)
  expect(maskedManifest(`--- {apiVersion: v1, kind: ConfigMap, data: {a: b}}\n`)).toBe(
    `--- ${MASK} # ${HIDDEN_WHOLE}\n`,
  )
})

test('a Secret’s values are masked in every form a template can give it', () => {
  // (And in what reaches the rest of the masking: what it fails closed on, and how.)
  for (const shape of MORE_SHAPES) {
    const masked = maskedManifest(shape)
    expect.soft(shows(masked), JSON.stringify(shape.replaceAll(VALUE, '…'))).toBe(false)
    expect(masked.split('\n')).toHaveLength(shape.split('\n').length)
  }
  for (const form of FORMS) {
    const manifest = asHelmKeeps(form.template)
    const masked = maskedManifest(manifest)
    expect.soft(shows(masked), form.name).toBe(false)
    expect(masked.split('\n'), form.name).toHaveLength(manifest.split('\n').length)
    // (What's after it, plainly a ConfigMap, is as it was, where the cluster's reader takes it.)
    if (kubernetesDocuments(manifest) === undefined) continue
    expect(
      masked.endsWith('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n\n'),
      form.name,
    ).toBe(true)
  }
})

withHelm(
  'everything helm installs as a Secret is masked, and an ordinary chart’s manifest reads as it was',
  async ({ helm }) => {
    test.setTimeout(180_000)
    for (const form of FORMS) {
      // Beside a ServiceAccount, which helm installs before a Secret, and a ConfigMap, after one.
      const manifest = helm.rendered(
        helm.chart({
          'templates/a.yaml': 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: a\n',
          'templates/c.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n',
          'templates/z.yaml': form.template,
        }),
      )
      const order = [...(manifest ?? '').matchAll(/^# Source: probe\/templates\/(\w)\.yaml$/gm)]
        .map((source) => source[1])
        .join('')
      const place = manifest === undefined ? 'refused' : /^az/.test(order) ? 'secret' : 'elsewhere'
      expect(place, form.name).toBe(form.helm)
      if (manifest === undefined) continue
      const masked = maskedManifest(manifest)
      expect.soft(shows(masked), form.name).toBe(false)
      expect(masked.split('\n'), form.name).toHaveLength(manifest.split('\n').length)
    }
    // An ordinary chart's, as `helm create` makes one, and Lumovi's own (but for its Secrets).
    const scaffold = helm.chart({})
    helm.run('create', join(scaffold, 'ordinary'))
    const ordinary = helm.rendered(join(scaffold, 'ordinary'))!
    expect(ordinary).toContain('kind: Deployment')
    expect(maskedManifest(ordinary)).toBe(ordinary)
    const ours = helm.rendered(join(import.meta.dirname, '..', '..', 'charts', 'lumovi'))!
    const pieces = (text: string) => text.split(/^---$/m)
    const [before, after] = [pieces(ours), pieces(maskedManifest(ours))]
    expect(after).toHaveLength(before.length)
    const kept = before.filter((piece, i) => !/^kind: Secret$/m.test(piece) && after[i] === piece)
    expect(kept).toHaveLength(before.filter((piece) => !/^kind: Secret$/m.test(piece)).length)
    expect(kept.length).toBeGreaterThan(5)
  },
)

withHelm(
  'Helm’s split of a manifest, as Lumovi has it, is the shipped helm’s own',
  async ({ helm }) => {
    test.setTimeout(120_000)
    let compared = 0
    for (const text of SEPARATORS.flatMap(separated)) {
      // (Each in a chart of its own: where helm can't read a piece, it renders none of the chart.)
      const output = helm.rendered(helm.chart({ 'templates/t.yaml': text }))
      if (output === undefined) continue
      // What helm made of it: its pieces, each after its `# Source:`.
      const made = output
        .split(/^---\n# Source: probe\/templates\/t\.yaml\n/m)
        .slice(1)
        .map((piece) => piece.replace(/\s+$/, ''))
      const ours = helmManifests(text).map(([from, to]) => text.slice(from, to).replace(/\s+$/, ''))
      expect(made.sort(), JSON.stringify(text)).toEqual(ours.sort())
      compared++
    }
    expect(compared).toBeGreaterThan(40)
  },
)

withHelm(
  'the cluster’s split of a manifest, as Lumovi has it, is the shipped helm’s own',
  async ({ helm }) => {
    // (helm lint reads each template with the cluster's reader, and says each document's name; it
    // stops at a chart's first template it can't read, so each is in a chart of its own.)
    test.setTimeout(120_000)
    // (Not where a separator holds what readers can't all read alike, nor YAML's end of a document,
    // which the YAML library cuts at and the others don't: either is masked whole.)
    const texts = [
      ...SEPARATORS.filter(
        (separator) =>
          separator !== ' ---' && separator !== '...' && !/[\f\v\r\u0085\u2028]/.test(separator),
      ).flatMap(separated),
      '{"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "Doc_A"}}\n',
      '{"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "Doc_A"}}\n---\n{"metadata": {"name": "Doc_B"}}\n',
    ]
    let refusedHere = 0
    for (const text of texts) {
      const said = helm.linted(helm.chart({ 'templates/t.yaml': text }))
      const named = [...said.matchAll(/templates\/t\.yaml: object name [^"]*"([^"]*)"/g)].map(
        (name) => name[1],
      )
      const refused = /templates\/t\.yaml: unable to parse YAML/.test(said)
      const documents = kubernetesDocuments(text)
      // Refused here is masked whole: never less than the cluster's reader takes.
      if (documents === undefined) {
        refusedHere++
        continue
      }
      // Its documents, each read: lint names each it reads, and stops at the first it can't.
      const lines = text.split('\n')
      const read = documents.map(
        ([first, last]) =>
          parseAllDocuments(lines.slice(first, last + 1).join('\n'), { uniqueKeys: false })[0],
      )
      const bad = read.findIndex((document) => (document?.errors.length ?? 0) > 0)
      const ours = read.slice(0, bad < 0 ? undefined : bad).flatMap((document) => {
        const name = (document?.toJS() as { metadata?: { name?: string } } | null | undefined)
          ?.metadata?.name
        return name ? [name] : []
      })
      expect({ named, refused }, JSON.stringify(text)).toEqual({ named: ours, refused: bad >= 0 })
    }
    expect(refusedHere).toBeLessThan(texts.length / 4)
  },
)

/** The same run of numbers in [0, 1) for a seed, every time (mulberry32). */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Manifests a probe starts from, a made-up value's place `%v` (as stringData has it) or `%b`. */
const PROBED = [
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\ntype: Opaque\ndata:\n  password: %b\n',
  '{apiVersion: v1, kind: Secret, metadata: {name: a}, stringData: {password: %v}}\n',
  '{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "a"}, "data": {"password": "%b"}}\n',
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: a\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: a\n  stringData:\n    password: %v\n',
  'apiVersion: v1\nkind: SecretList\nitems:\n- metadata:\n    name: a\n  stringData:\n    password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {"stringData": {"password": "%v"}}\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\nstringData:\n  config.yaml: |\n    user: admin\n    password: %v\n',
  '<<: {apiVersion: v1, kind: Secret}\nmetadata:\n  name: a\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\nstringData:\n  password: %v\n',
]

/** What a probe does to a manifest, of each kind this family has had, at a place of the seed's. */
const PROBES: Record<
  string,
  (lines: string[], at: number, pick: <T>(of: readonly T[]) => T) => void
> = {
  // A line that may cut, or not, as each reader takes it.
  marker: (lines, at, pick) =>
    lines.splice(
      at,
      0,
      pick([
        '---',
        '--- # c',
        '---# c',
        '--- ',
        '--- # c',
        '---\f',
        '...',
        '---x: y',
        '--- {kind: Secret, metadata: {name: m}, stringData: {password: %v}}',
        '---kind: Secret',
      ]),
    ),
  // A line glued to a marker.
  glued: (lines, at) => (lines[at] = `---${lines[at]}`),
  // A line break only some readers break at, alone or in a comment.
  break: (lines, at, pick) =>
    (lines[at] =
      `${lines[at]}${pick([' # c kind: Secret', ' # c\u0085kind: Secret', ' # c\rkind: Secret', ' ', '\r', '\u0085'])}`),
  // White space only some readers take as such.
  space: (lines, at, pick) => (lines[at] = lines[at]!.replace(' ', pick([' ', '\t', '　', '  ']))),
  // A kind written another way, or given by a merge, a tag, a list.
  kind: (lines, at, pick) => {
    const kind = lines.findIndex((line) => /^\s*"?kind"?:/.test(line))
    if (kind >= 0)
      lines[kind] = lines[kind]!.replace(
        /"?kind"?:\s*"?\w*"?/,
        pick([
          'kind: ""',
          'Kind: Secret',
          'kind: secret',
          'kind: !!binary U2VjcmV0',
          '"k\\x69nd": Secret',
          'kind: !!str Secret',
          'kind: &k Secret',
        ]),
      )
    else lines.splice(at, 0, 'kind: Secret')
  },
  merge: (lines, at, pick) =>
    lines.splice(
      at,
      0,
      pick([
        '<<: {kind: Secret}',
        '<<: [{kind: Secret}, \n{apiVersion: v1}]',
        '? !!merge <<\n: {kind: Secret}',
        '<<: *x',
      ]),
    ),
  items: (lines, at, pick) =>
    lines.splice(
      at,
      0,
      pick([
        'items:\n- kind: ""\n  stringData: {password: %v}',
        'items:\n- {metadata: {name: i}, stringData: {password: %v}}',
        'Items:\n- {kind: Secret, stringData: {password: %v}}',
      ]),
    ),
  // A line written twice, or gone, or set in or out.
  line: (lines, at, pick) => {
    const how = pick(['twice', 'gone', 'in', 'out'])
    if (how === 'twice') lines.splice(at, 0, lines[at]!)
    else if (how === 'gone') lines.splice(at, 1)
    else if (how === 'in') lines[at] = ` ${lines[at]}`
    else lines[at] = lines[at]!.replace(/^ /, '')
  },
  // A value with a name's shape on a line of its own, or escaped.
  value: (lines, at, pick) =>
    lines.splice(
      at,
      0,
      pick([
        'stringData: {password: "abc\nkind: %v\n"}',
        'stringData:\n  password: "m\\x61de"',
        'stringData: {password: &v %v}\nmetadata: {name: *v}',
      ]),
    ),
}

/** What the cluster makes of what it read: a list's items, each with its list's kind if none. */
function made(read: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (read === null || typeof read !== 'object' || Array.isArray(read)) return into
  const object = read as Record<string, unknown>
  if (!('items' in object)) return [...into, object]
  if (!Array.isArray(object.items)) return into
  for (const item of object.items as Record<string, unknown>[]) {
    const kindless = item && typeof item === 'object' && !item.kind && !item.apiVersion
    made(
      kindless
        ? {
            ...item,
            kind: String(object.kind ?? '').replace(/List$/, ''),
            apiVersion: object.apiVersion,
          }
        : item,
      into,
    )
  }
  return into
}

/** The values a Secret holds, as the cluster read them. */
const valuesOf = (secret: Record<string, unknown>) => [
  ...Object.values((secret.data ?? {}) as object),
  ...Object.values((secret.stringData ?? {}) as object),
  ((secret.metadata as { annotations?: Record<string, unknown> } | undefined)?.annotations ?? {})[
    'kubectl.kubernetes.io/last-applied-configuration'
  ],
]

withHelm(
  'no value of anything helm or the cluster reads as a Secret is shown, however its manifest is cut, broken or written',
  async ({ helm }) => {
    test.setTimeout(300_000)
    const random = seeded(343)
    const pick = <T>(of: readonly T[]) => of[Math.floor(random() * of.length)]!
    const names = Object.keys(PROBES)
    // Each probe's manifest, its made-up value, and what was done to it.
    const probes = Array.from({ length: 2400 }, (_, i) => {
      const value = `madeUp${i}Value`
      const done = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(names))
      const lines = pick(PROBED).split('\n')
      for (const name of done) PROBES[name]!(lines, Math.floor(random() * lines.length), pick)
      const text = lines
        .join('\n')
        .replaceAll('%v', value)
        .replaceAll('%b', Buffer.from(value).toString('base64'))
      return { text, value, done }
    })
    // Each document helm's split and the cluster's make of each, read by helm itself (fromYaml:
    // sigs.k8s.io/yaml, merge keys and all), in one rendering.
    const files: Record<string, string> = {
      'templates/read.yaml':
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: read\ndata:\n' +
        '{{- range $path, $_ := .Files.Glob "documents/*" }}\n' +
        '  {{ base $path }}: {{ $.Files.Get $path | fromYaml | toJson | b64enc }}\n' +
        '{{- end }}\n',
    }
    probes.forEach(({ text }, i) => {
      // Helm 4's pieces and Helm 3's, and the cluster's reader's documents, now and before 0.21.
      for (const [cut, pieces] of [
        ['h', helmManifests],
        ['g', helm3Manifests],
      ] as const) {
        pieces(text).forEach(
          ([from, to], j) => (files[`documents/p${i}-${cut}${j}`] = text.slice(from, to)),
        )
      }
      const lines = text.split('\n')
      for (const [cut, documents] of [
        ['k', kubernetesDocuments],
        ['o', olderKubernetesDocuments],
      ] as const) {
        documents(text)?.forEach(
          ([first, last], j) =>
            (files[`documents/p${i}-${cut}${j}`] = lines.slice(first, last + 1).join('\n')),
        )
      }
    })
    const rendered = helm.rendered(helm.chart(files))!
    const read = new Map<number, unknown[]>()
    for (const [, i, encoded] of rendered.matchAll(/^ {2}p(\d+)-[hgko]\d+: (\S+)$/gm)) {
      const documents = read.get(Number(i)) ?? []
      read.set(Number(i), [
        ...documents,
        JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8')),
      ])
    }
    let secrets = 0
    const shown: string[] = []
    const caught = new Map<string, number>()
    probes.forEach(({ text, value, done }, i) => {
      const base64 = Buffer.from(value).toString('base64')
      const held = (read.get(i) ?? [])
        .flatMap((document) => made(document))
        .filter((object) => object.kind === 'Secret')
        .flatMap(valuesOf)
        .filter((held): held is string => typeof held === 'string')
      const tokens = [value, base64].filter((token) => held.some((one) => one.includes(token)))
      if (tokens.length === 0) return
      secrets++
      for (const name of done) caught.set(name, (caught.get(name) ?? 0) + 1)
      const masked = maskedManifest(text).replaceAll('\u0000', '')
      if (tokens.some((token) => masked.includes(token))) shown.push(`${i} (${done.join(', ')})`)
    })
    // Shown: none. And the probe has teeth: many of them read as Secrets, after each kind of change.
    expect(shown).toEqual([])
    expect(secrets).toBeGreaterThan(probes.length / 3)
    for (const name of names) expect(caught.get(name) ?? 0, name).toBeGreaterThan(30)
  },
)

test('Helm 3’s split of a manifest, and the cluster’s reader’s before apimachinery 0.21, are as their sources have them', () => {
  // (Each text cut by Helm 3.22.1's SplitManifests and apimachinery 0.20.1's YAMLReader, run as
  // they are: tests/web/older-splits.)
  const splits = JSON.parse(
    readFileSync(join(import.meta.dirname, 'older-splits', 'splits.json'), 'utf8'),
  ) as { text: string; helm3: string[]; cluster: string[] | null }[]
  expect(splits.length).toBeGreaterThan(80)
  for (const { text, helm3, cluster } of splits) {
    const said = JSON.stringify(text)
    expect(
      helm3Manifests(text).map(([from, to]) => text.slice(from, to)),
      said,
    ).toEqual(helm3)
    // (One that starts with `{` its decoder reads as JSON, not with this reader.)
    if (text.startsWith('{')) continue
    // (Its reader reads a line at a time: each line's end, `\r\n` or `\n`, written as `\n`.)
    const lines = text.split('\n')
    const ended = (line: string, at: number) =>
      `${at < lines.length - 1 ? line.replace(/\r$/, '') : line}\n`
    const ours = olderKubernetesDocuments(text)?.map(([first, last]) =>
      lines
        .slice(first, last + 1)
        .map((line, i) => ended(line, first + i))
        .join(''),
    )
    expect(ours ?? null, said).toEqual(cluster)
  }
})

test('a manifest without a Secret is as it was', () => {
  const plain = MANIFEST.split('---\n# Source: api/templates/deployment.yaml')[1]!
  expect(maskedManifest(plain)).toBe(plain)
})

test('the values a rollback changes, by key alone: changed, added and removed, as --set writes them', () => {
  const running = {
    image: { tag: '2.4.2' },
    replicaCount: 3,
    resources: { limits: { memory: '512Mi' } },
    database: { password: 'old' },
    metrics: { enabled: true },
    ingress: { hosts: [{ host: 'a.example' }] },
  }
  const back = {
    image: { tag: '2.4.0' },
    replicaCount: 3,
    resources: { limits: { memory: '384Mi' } },
    database: { password: 'older' },
    ingress: { hosts: [{ host: 'b.example' }, { host: 'c.example' }] },
    debug: false,
  }
  const keys = valueKeys(running, back)
  expect(keys).toEqual({
    changed: ['image.tag', 'resources.limits.memory', 'database.password', 'ingress.hosts[0].host'],
    added: ['ingress.hosts[1].host', 'debug'],
    removed: ['metrics.enabled'],
  })
  // Never a value.
  expect(JSON.stringify(keys)).not.toMatch(/old|2\.4|Mi|example/)
  expect(valueKeys(running, running)).toEqual({ changed: [], added: [], removed: [] })
})

test('what Helm did after a failure, where its message says so', () => {
  expect(
    undoneBy(
      'UPGRADE FAILED: release payments-api failed, and has been rolled back due to rollback-on-failure being set: context deadline exceeded',
    ),
  ).toBe('rolled-back')
  expect(
    undoneBy(
      'INSTALLATION FAILED: release orders failed, and has been uninstalled due to rollback-on-failure being set: context deadline exceeded',
    ),
  ).toBe('uninstalled')
  expect(undoneBy('UPGRADE FAILED: another operation is in progress')).toBeUndefined()
})
