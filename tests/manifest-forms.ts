import { kubernetesDocuments } from '../src/renderer/src/lib/helm-diff.ts'

/**
 * Manifests in the shapes Secrets' masking has to read as every reader does (src/renderer/src/lib/
 * helm-diff.ts), each with a made-up value: for its tests, in-process and through the app.
 */

/** A made-up value, as stringData holds it and as data does (base64): whether a text shows it. */
export const VALUE = 'madeUpValue42'
export const shows = (text: string) =>
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
export interface Form {
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
export const FORMS: Form[] = (
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
    [
      'list-empty-kind',
      'apiVersion: v1\nkind: List\nitems:\n- kind: ""\n  metadata: {name: z}\n  stringData: {password: %v}\n',
      'elsewhere',
    ],
    [
      'secret-with-items',
      'apiVersion: v1\nkind: Secret\nmetadata: {name: x}\nitems:\n- kind: ""\n  metadata: {name: z}\n  stringData: {password: %v}\n',
      'secret',
    ],
    [
      'secretlist-empty-both',
      'apiVersion: v1\nkind: SecretList\nitems:\n- {kind: "", apiVersion: "", metadata: {name: z}, stringData: {password: %v}}\n',
      'secret',
    ],
    [
      'secretlist-empty-kind-data',
      'apiVersion: v1\nkind: SecretList\nitems:\n- kind: ""\n  metadata: {name: z}\n  data:\n    password: %b\n',
      'secret',
    ],
    [
      'secretlist-empty-kind',
      'apiVersion: v1\nkind: SecretList\nitems:\n- kind: ""\n  metadata: {name: z}\n  stringData: {password: %v}\n',
      'secret',
    ],
    [
      'glued-marker',
      'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: y}\n---kind: Secret\nmetadata: {name: z}\nstringData: {password: %v}\n',
      'secret',
    ],
    [
      'errored-merge',
      '<<: [{kind: Secret}, \n{apiVersion: v1}]\nstringData: {password: %v}\n',
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
export const asHelmKeeps = (template: Buffer) =>
  `---\n# Source: probe/templates/z.yaml\n${template.toString('utf8')}\n---\n# Source: probe/templates/c.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n\n`

/**
 * Lines that may cut a manifest into documents, as Helm's splitter, the cluster's reader or the
 * YAML library may take them, each set among documents named for which they are.
 */
export const SEPARATORS = [
  '---',
  '--- ',
  '---\t',
  '--- # c',
  '---# c',
  '---\t# c',
  '---x: y',
  '---\u00a0',
  '---\u00a0# c',
  '---\f',
  '---\v',
  '---\r',
  '---\u0085',
  '---\u2028',
  '---\ufeff',
  ' ---',
  '...',
  '',
]
export const separated = (separator: string) => [
  `apiVersion: v1\nmetadata:\n  name: Doc_A\nkind: ConfigMap\n${separator}\napiVersion: v1\nmetadata:\n  name: Doc_B\nkind: ConfigMap\n`,
  `${separator}\napiVersion: v1\nmetadata:\n  name: Doc_A\nkind: ConfigMap\n\n${separator}\n\napiVersion: v1\nmetadata:\n  name: Doc_B\nkind: ConfigMap\n${separator}\n`,
  `\n  \n${separator}\n${separator}\napiVersion: v1\nmetadata:\n  name: Doc_A\nkind: ConfigMap\n`,
]

/** Go's white space, as its strings.TrimSpace trims it (unicode.IsSpace). */
const GO_SPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const GO_LEADING = new RegExp(`^[${GO_SPACE}]+`)
const goTrimmed = (text: string) =>
  text.replace(GO_LEADING, '').replace(new RegExp(`[${GO_SPACE}]+$`), '')

/**
 * Where the cluster's reader as it was before apimachinery 0.21 (in Helm 3.0 to 3.5, and kubectl
 * then) cuts a manifest: as now, but only at a line that has nothing after the `---` but white space
 * (Go's), and refusing none of them; a manifest that starts with `{` is one JSON value, or refused.
 * The first document of each run of lines is all it reads of it.
 */
export function olderKubernetesDocuments(text: string): [number, number][] | undefined {
  // (Each line, as Go reads it: an empty manifest has none, and the end of the last one no other.)
  const lines = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (text.replace(GO_LEADING, '').startsWith('{')) return kubernetesDocuments(text)
  const documents: [number, number][] = []
  let from: number | undefined
  for (const [at, line] of lines.entries()) {
    if (line.startsWith('---') && goTrimmed(line.slice(3)) === '' && from !== undefined) {
      documents.push([from, at - 1])
      from = undefined
      continue
    }
    from ??= at
  }
  if (from !== undefined) documents.push([from, lines.length - 1])
  return documents
}

/**
 * Manifests that reach the rest of what the masking does: what it fails closed on, and how it
 * masks what it reads plainly; each with the made-up value where a Secret holds it.
 */
export const MORE_SHAPES: string[] = [
  '# nothing but a comment\n',
  '%YAML 1.2\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: %v}\n',
  '{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "j"}, "stringData": {"password": "%v"}}\n',
  '{"kind": "ConfigMap"}\n{"kind": "Secret", "stringData": {"password": "%v"}}\n',
  '- a\n- b\n',
  'just a word\n',
  '!!map {apiVersion: v1, kind: Secret, stringData: {password: %v}}\n',
  'apiVersion: !!str v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: %v}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: !!map {name: a}\nstringData: {password: %v}\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n  Name: b\nstringData: {password: %v}\n',
  '? [a, b]\n: c\napiVersion: v1\nkind: Secret\nstringData: {password: %v}\n',
  'apiVersion: v1\nkind: 7\nstringData: {password: %v}\n',
  'apiVersion: v1\nkind: ConfigMapList\nitems: ~\n',
  'apiVersion: v1\nkind: ConfigMapList\nitems:\n',
  'apiVersion: v1\nkind: List\nitems: {a: b}\n',
  'apiVersion: v1\nkind: List\nitems: !!seq [{kind: ConfigMap}]\n',
  'apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: ConfigMap\n  metadata: {name: c}\n- apiVersion: v1\n  kind: Secret\n  metadata: {name: s}\n  stringData:\n    password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\ndata: %b\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\ndata:\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\ndata: [%b]\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n  namespace: n\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: \'{"stringData":{"password":"%v"}}\'\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {"stringData": {"password": "%v"}}\n    other: kept\nstringData:\n  password: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\nstringData:\n  config: |\n    user: admin\n    password: %v\n  short: >-\n    %v\n  empty:\n  blank: ""\n  password: %v # said\ntype: Opaque\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData:\n  "quoted key": %v\n  \'single\': %v\n  plain key: %v\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: %v, other: %v}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData:\n  password: "%v\n    continued"\n',
  '<<: {kind: Secret}\napiVersion: v1\nmetadata:\n  name: a\n  namespace: n\nstringData:\n  password: %v\n',
  '<<: {kind: Secret}\napiVersion: v1 # its version\nmetadata: # its names\n  name: a # its name\n  ? {namespace: n}\n  : x\nstringData:\n  password: %v\n',
  '<<: {kind: Secret}\n? metadata\n:\n  name: a\nstringData: {password: %v}\n',
  'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata:\n  ? {kind: Secret, stringData: {password: %v}}\n  : x\n',
  'apiVersion: v1\nkind: Wrapped\nmetadata: {name: w}\nspec:\n  secret:\n    kind: Secret\n    ? [k]\n    : v\n    stringData: {password: %v}\n',
  'apiVersion: v1\nkind: Wrapped\nmetadata: {name: w}\nspec: {kind: Secret, data, stringData: {password: %v}}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: %v, other}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData:\n  password:%v\n',
  '<<: {kind: Secret}\nmetadata: {name: a}\nstringData: {password: %v}\n',
  '&r {apiVersion: v1, kind: Secret, metadata: {name: a}, stringData: {password: %v}}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: &m\n  name: a\nstringData: *m\ndata: {password: %b}\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: [%v\n',
  'apiVersion: v1\nkind: Secret\nstringData: {password: %v}\n...\n---\nkind: ConfigMap\n',
  'kind: ConfigMap\n---\n<<: [{kind: Secret}, \n{apiVersion: v1}]\nstringData: {password: %v}\n--- # after\nkind: ConfigMap\n',
  'apiVersion: v1\nkind: Secret\nmetadata: {name: a}\nstringData: {password: %v}\n \n',
  'apiVersion: v1\r\nkind: Secret\r\nmetadata:\r\n  name: a\r\nstringData:\r\n  password: %v\r\n',
  'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\nspec:\n  template:\n    kind: Secret\n    stringData:\n      password: %v\n',
  'apiVersion: example.com/v1\nkind: Wrapper\nmetadata: {name: w}\nspec:\n  secret: {kind: Secret, stringData: {password: %v}}\n',
].map((text) =>
  text.replaceAll('%v', VALUE).replaceAll('%b', Buffer.from(VALUE).toString('base64')),
)
