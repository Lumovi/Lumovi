/**
 * What a Helm rollback's dialog shows of what it changes (src/renderer/src/lib/helm-diff.ts): a
 * Secret's values masked line for line, the values by key alone, and what Helm did after a failure.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../temp-folders.ts'
import { fetchHelm } from '../../scripts/helm.ts'
import {
  HIDDEN_WHOLE,
  MASK,
  maskedManifest,
  maskedPair,
  masking,
  undoneBy,
  valueKeys,
} from '../../src/renderer/src/lib/helm-diff.ts'

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
  // And what isn't a Secret is as it was.
  const map = `--- {apiVersion: v1, kind: ConfigMap, metadata: {name: c}, data: {a: b}}\n`
  expect(maskedManifest(map)).toBe(map)
})

/** A made-up value, as stringData holds it and as data does (base64): whether a text shows it. */
const VALUE = 'madeUpValue42'
const shows = (text: string) =>
  [VALUE, Buffer.from(VALUE).toString('base64')].some((value) =>
    text.replaceAll('\u0000', '').includes(value),
  )

/** A template's text, as a template file saved in UTF-16 holds it, with its byte-order mark. */
const utf16 = (text: string, order: 'le' | 'be') => {
  const bytes = Buffer.from(text, 'utf16le')
  if (order === 'be') bytes.swap16()
  return Buffer.concat([Buffer.from(order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), bytes])
}

/** A template, and where helm puts it in its install order. */
interface Form {
  name: string
  template: Buffer
  helm: 'secret' | 'elsewhere' | 'refused'
}

/**
 * Templates that Kubernetes reads as a Secret holding the made-up value (or, where its kind is
 * Pod or isn't one, as something else), each as a chart's template file holds it, and where helm
 * 4.3.0 puts it in its install order: a Secret's place, elsewhere (a kind it doesn't sort as one,
 * a List's included, whose items are installed each as itself), or nowhere (it refuses the chart).
 */
const FORMS: Form[] = (
  [
    [
      'anchor-kind',
      'apiVersion: v1\nkind: &k Secret\nmetadata: {name: z, labels: {a: *k}}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'bom-kind-first',
      '\ufeffkind: Secret\napiVersion: v1\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'bom-start',
      '\ufeffapiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'directive-11',
      '%YAML 1.1\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'refused',
    ],
    [
      'dup-last-secret',
      'apiVersion: v1\nkind: Pod\nkind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'dup-stringdata',
      'apiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData: {a: b}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'json-dup',
      '{"apiVersion":"v1","kind":"Pod","kind":"Secret","metadata":{"name":"z"},"stringData":{"password":"%v"}}\n',
      'secret',
    ],
    [
      'json',
      '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"z"},"stringData":{"password":"%v"}}\n',
      'secret',
    ],
    [
      'key-escaped',
      'apiVersion: v1\n"k\\x69nd": Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'key-tagged',
      'apiVersion: v1\n!!str kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-binary',
      'apiVersion: v1\nkind: !!binary U2VjcmV0\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-block-scalar',
      'apiVersion: v1\nkind: >-\n  Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-escaped',
      'apiVersion: v1\n"kind": "Secr\\x65t"\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-explicit-key',
      'apiVersion: v1\n? kind\n: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-local-tag',
      'apiVersion: v1\nkind: !x Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-quoted',
      'apiVersion: v1\n"kind": "Secret"\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-str',
      'apiVersion: v1\nkind: !!str Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-verbatim-tag',
      'apiVersion: v1\nkind: !<tag:yaml.org,2002:str> Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'list',
      'apiVersion: v1\nkind: List\nitems:\n- {apiVersion: v1, kind: Secret, metadata: {name: z}, stringData: {password: %v}}\n',
      'elsewhere',
    ],
    [
      'merge-flow',
      '<<: {apiVersion: v1, kind: Secret}\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'merge-block',
      '<<:\n  apiVersion: v1\n  kind: Secret\nmetadata:\n  name: z\ndata:\n  password: %b\n',
      'secret',
    ],
    [
      'merge-in-data',
      'apiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData:\n  <<: {password: %v}\n',
      'secret',
    ],
    [
      'merge-list',
      '<<: [{apiVersion: v1}, {kind: Secret}]\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'merge-quoted',
      '"<<": {apiVersion: v1, kind: Secret}\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'elsewhere',
    ],
    [
      'merge-tag',
      '? !!merge <<\n: {apiVersion: v1, kind: Secret}\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'merge-then-kind',
      '<<: {apiVersion: v1, kind: Secret}\nkind: Pod\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'elsewhere',
    ],
    [
      'value-binary',
      'apiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData: {password: !!binary bWFkZVVwVmFsdWU0Mg==}\n',
      'secret',
    ],
    [
      'line-separator',
      'apiVersion: v1\nkind: ConfigMap # c\u2028kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'paragraph-separator',
      'apiVersion: v1\nkind: ConfigMap # c\u2029kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'carriage-return',
      'apiVersion: v1\nkind: ConfigMap # c\rkind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'carriage-return-value',
      'apiVersion: v1\nkind: ConfigMap\rkind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'line-separator-value',
      'apiVersion: v1\nkind: ConfigMap\u2028kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'next-line',
      'apiVersion: v1\nkind: ConfigMap # c\u0085kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'items-any-case',
      'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: z}\nItems:\n- {apiVersion: v1, kind: Secret, metadata: {name: y}, stringData: {password: %v}}\n',
      'elsewhere',
    ],
    [
      'kind-key-case',
      'apiVersion: v1\nKind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'kind-case',
      'apiVersion: v1\nkind: secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'elsewhere',
    ],
    [
      'typed-list',
      'apiVersion: v1\nkind: SecretList\nitems:\n- metadata: {name: y}\n  stringData: {password: %v}\n',
      'secret',
    ],
  ] as const
)
  .map(([name, text, helm]): Form => ({
    name,
    template: Buffer.from(
      text.replaceAll('%v', VALUE).replaceAll('%b', Buffer.from(VALUE).toString('base64')),
    ),
    helm,
  }))
  .concat(
    (['le', 'be'] as const).map((order) => ({
      name: `utf16${order}-bom`,
      template: utf16(
        `apiVersion: v1\nkind: Secret\nmetadata: {name: z}\nstringData: {password: ${VALUE}}\n`,
        order,
      ),
      helm: 'secret',
    })),
  )

/** A form's manifest, as Helm keeps it: each template's documents after its `# Source:`. */
const asHelmKeeps = (template: Buffer) =>
  `---\n# Source: probe/templates/z.yaml\n${template.toString('utf8')}\n---\n# Source: probe/templates/c.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n\n`

test('a Secret’s values are masked in every form a template can give it', () => {
  for (const form of FORMS) {
    const manifest = asHelmKeeps(form.template)
    const masked = maskedManifest(manifest)
    expect.soft(shows(masked), form.name).toBe(false)
    expect(masked.split('\n'), form.name).toHaveLength(manifest.split('\n').length)
    // (What's after it, plainly a ConfigMap, is as it was.)
    expect(
      masked.endsWith('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n\n'),
      form.name,
    ).toBe(true)
  }
})

test('everything helm installs as a Secret is masked, and an ordinary chart’s manifest reads as it was', async () => {
  test.setTimeout(180_000)
  // The helm Lumovi ships (its checksum checked), with homes of its own.
  const root = mkdtempSync(join(tmpdir(), 'charts-'))
  const helm = await fetchHelm(process.platform, process.arch, join(root, 'helm'))
  const env = {
    ...process.env,
    HELM_CACHE_HOME: join(root, 'cache'),
    HELM_CONFIG_HOME: join(root, 'config'),
    HELM_DATA_HOME: join(root, 'data'),
    KUBECONFIG: join(root, 'kubeconfig'),
  }
  const run = (...args: string[]) =>
    execFileSync(helm, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  const rendered = (chart: string) => {
    try {
      return run('template', 'probe', chart)
    } catch {
      return undefined
    }
  }
  for (const form of FORMS) {
    // Beside a ServiceAccount, which helm installs before a Secret, and a ConfigMap, after one.
    const chart = join(root, form.name)
    mkdirSync(join(chart, 'templates'), { recursive: true })
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: probe\nversion: 0.1.0\n')
    writeFileSync(
      join(chart, 'templates', 'a.yaml'),
      'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: a\n',
    )
    writeFileSync(
      join(chart, 'templates', 'c.yaml'),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n',
    )
    writeFileSync(join(chart, 'templates', 'z.yaml'), form.template)
    const manifest = rendered(chart)
    const order = [...(manifest ?? '').matchAll(/^# Source: probe\/templates\/(\w)\.yaml$/gm)]
      .map((source) => source[1])
      .join('')
    const place = manifest === undefined ? 'refused' : order === 'azc' ? 'secret' : 'elsewhere'
    expect(place, form.name).toBe(form.helm)
    if (manifest === undefined) continue
    const masked = maskedManifest(manifest)
    expect.soft(shows(masked), form.name).toBe(false)
    expect(masked.split('\n'), form.name).toHaveLength(manifest.split('\n').length)
  }
  // An ordinary chart's, as `helm create` makes one, and Lumovi's own (but for its Secrets).
  run('create', join(root, 'ordinary'))
  const ordinary = rendered(join(root, 'ordinary'))!
  expect(ordinary).toContain('kind: Deployment')
  expect(maskedManifest(ordinary)).toBe(ordinary)
  const ours = rendered(join(import.meta.dirname, '..', '..', 'charts', 'lumovi'))!
  const pieces = (text: string) => text.split(/^---$/m)
  const [before, after] = [pieces(ours), pieces(maskedManifest(ours))]
  expect(after).toHaveLength(before.length)
  const kept = before.filter((piece, i) => !/^kind: Secret$/m.test(piece) && after[i] === piece)
  expect(kept).toHaveLength(before.filter((piece) => !/^kind: Secret$/m.test(piece)).length)
  expect(kept.length).toBeGreaterThan(5)
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
