/**
 * What a Helm rollback changes, as its dialog shows it (LMV-353): the values by key alone, and a
 * manifest with each Secret's data masked as the YAML tab masks it, line for line, so that a
 * diff worked out on the real text can be shown through it.
 */

import {
  isMap,
  isScalar,
  isSeq,
  parse,
  parseAllDocuments,
  visit,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
} from 'yaml'

/** What a masked value shows. */
export const MASK = '••••••••'

/** How a manifest is read: as Helm's and the cluster's readers read it, aliases bounded. */
const READ = { maxAliasCount: 100, uniqueKeys: false, merge: true } as const

/** Characters that readers can't all be counted on to read alike (a line's own end aside). */
const UNREADABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufffd-\uffff]|\r(?!$)/

/** What a document masked whole for how it reads says of it, on its first masked line. */
export const HIDDEN_WHOLE = 'Hidden whole: Lumovi can’t tell what’s secret here.'

/** What a masked manifest hides: Secrets' values, and how many documents whole. */
export interface Hidden {
  values: boolean
  documents: number
}

/** A manifest masked, and what of it is hidden. */
export interface Masked {
  text: string
  hidden: Hidden
}

/** One document's lines, masked, and whether it's masked whole for how it reads. */
interface Shown {
  lines: string[]
  whole?: true
}

/** kubectl's annotation of what it applied: the whole object, values and all. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/** A manifest's text, and where each of its lines starts in it. */
interface Source {
  text: string
  lines: string[]
  starts: number[]
}

/** The line a place in the text is on. */
function lineOf(source: Source, at: number): number {
  let low = 0
  let high = source.starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (source.starts[middle]! <= at) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * A manifest (YAML documents, as Helm keeps them) with every Secret's data and stringData values,
 * and its last-applied annotation, masked: the same lines, each where it was, so that what a diff
 * of the real text says of a line is said of the masked one.
 *
 * It fails closed, and goes by what the YAML reader reads, never by how a line looks: the
 * documents are where it says they are, and what's kept of one masked whole is what its nodes say
 * names it. A document it can't read shows nothing of its own. One that isn't plainly something
 * other than a Secret, read as every reader reads it, is read as one, and masked whole but for what
 * names it. A Secret's values are first masked line by line, where reading the result back shows
 * every one masked; otherwise the document is masked whole but for what names it. Last, every line
 * one of its values is written on must show nothing of it, or the document shows nothing of its
 * own at all.
 */
export function maskedManifest(manifest: string): string {
  return masking(manifest).text
}

/** Two manifests masked, as a diff of them shows them, and what's hidden of either. */
export function maskedPair(
  before: string,
  after: string,
): { before: string; after: string; hidden: Hidden } {
  const [a, b] = [masking(before), masking(after)]
  return {
    before: a.text,
    after: b.text,
    hidden: {
      values: a.hidden.values || b.hidden.values,
      documents: Math.max(a.hidden.documents, b.hidden.documents),
    },
  }
}

/** A manifest masked as `maskedManifest` masks it, and what of it is hidden. */
export function masking(manifest: string): Masked {
  const lines = manifest.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const source: Source = { text: manifest, lines, starts }
  const parsed = parseAllDocuments(manifest, READ)
  // (Nothing but comments and markers: no document.)
  const documents = Array.isArray(parsed) ? parsed : []
  const spans = documents.map(({ range: [from, , to] }): Span => [
    lineOf(source, from),
    lineOf(source, Math.max(from, to - 1)),
  ])
  const unsure = unsureLines(source, spans)
  const hidden: Hidden = { values: false, documents: 0 }
  const shown = [...lines]
  documents.forEach((document, at) => {
    const [first, last] = spans[at]!
    const own = lines.slice(first, last + 1)
    const masked = own.some((_, i) => unsure[first + i])
      ? noted(own, nothingShown(source, document, first, last))
      : maskedDocument(source, document, first, last)
    if (masked.whole) hidden.documents++
    else if (masked.lines.some((line, i) => line !== own[i])) hidden.values = true
    shown.splice(first, own.length, ...masked.lines)
  })
  // What's in no document of the library's, where it's unsure: masked, and said once a run.
  const covered = new Set(spans.flatMap(([first, last]) => linesOf(first, last)))
  let said = false
  lines.forEach((text, line) => {
    if (covered.has(line) || !unsure[line]) {
      said = false
      return
    }
    shown[line] = looseMasked(text)
    if (said || !shown[line].endsWith(MASK)) return
    shown[line] = `${shown[line]} # ${HIDDEN_WHOLE}`
    hidden.documents++
    said = true
  })
  return { text: shown.join('\n'), hidden }
}

/** A run of lines, the first and the last. */
type Span = [number, number]

/** Every line from the first to the last. */
const linesOf = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i)

/** Go's white space, as its strings.TrimSpace trims it (unicode.IsSpace). */
const GO_SPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const GO_LEADING = new RegExp(`^[${GO_SPACE}]+`)
const GO_TRAILING = new RegExp(`[${GO_SPACE}]+$`)
const goTrimmed = (text: string) => text.replace(GO_LEADING, '').replace(GO_TRAILING, '')

/**
 * Where Helm cuts a manifest into its documents (SplitManifests, in its release util): the white
 * space before the first trimmed, then cut at each line that starts with `---`, the `---` and the
 * spaces and tabs after it going; each piece's white space before it trimmed, and none blank. As
 * places in the text.
 */
export function helmManifests(text: string): Span[] {
  const start = text.length - text.replace(GO_LEADING, '').length
  const body = text.slice(start)
  const cuts = [...body.matchAll(/(?<=^|\n)---[ \t]*/g)]
  const ends = [0, ...cuts.flatMap((cut) => [cut.index, cut.index + cut[0].length]), body.length]
  const pieces: Span[] = []
  for (let i = 0; i < ends.length; i += 2) {
    const piece = body.slice(ends[i], ends[i + 1])
    if (goTrimmed(piece) === '') continue
    const from = ends[i]! + piece.length - piece.replace(GO_LEADING, '').length
    pieces.push([start + from, start + ends[i + 1]!])
  }
  return pieces
}

/**
 * Where Helm 3 cuts a manifest into its documents (its releaseutil's SplitManifests, by which a
 * release installed with it was cut): the whole trimmed, then cut at each `---` that starts a line,
 * with the white space (Go's `\s`) before the line's end ahead of it and after the `---`; each piece
 * trimmed, none that was empty before (one that's empty only after, kept as nothing). As places in
 * the text.
 */
export function helm3Manifests(text: string): Span[] {
  const start = text.length - text.replace(GO_LEADING, '').length
  const body = goTrimmed(text)
  const cuts = [...body.matchAll(/(?:^|[\t\n\f\r ]*\n)---[\t\n\f\r ]*/g)]
  const ends = [0, ...cuts.flatMap((cut) => [cut.index, cut.index + cut[0].length]), body.length]
  const pieces: Span[] = []
  for (let i = 0; i < ends.length; i += 2) {
    const piece = body.slice(ends[i], ends[i + 1])
    if (piece === '') continue
    const from = ends[i]! + piece.length - piece.replace(GO_LEADING, '').length
    pieces.push([start + from, start + from + goTrimmed(piece).length])
  }
  return pieces
}

/**
 * Where the cluster's reader (apimachinery's util/yaml, which Helm's kube client and kubectl read
 * a manifest with) cuts it into documents, as runs of lines: at each line that starts with `---`
 * and has nothing after it but white space (Go's) or a comment, the line itself in none (or, where
 * no document has begun, the first of the next). None at all where it refuses the manifest: such a
 * line with anything else after the `---`, or a manifest that starts with `{` (which it reads as
 * JSON) other than a single JSON value.
 */
export function kubernetesDocuments(text: string): Span[] | undefined {
  // (Each line, as Go reads it: an empty manifest has none, and the end of the last one no other.)
  const lines = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (text.replace(GO_LEADING, '').startsWith('{')) {
    try {
      JSON.parse(text)
    } catch {
      return undefined
    }
    return [[0, lines.length - 1]]
  }
  const documents: Span[] = []
  let from: number | undefined
  for (const [at, line] of lines.entries()) {
    if (line.startsWith('---')) {
      const after = goTrimmed(line.slice(3))
      if (after !== '' && !after.startsWith('#')) return undefined
      if (from !== undefined) {
        documents.push([from, at - 1])
        from = undefined
        continue
      }
    }
    from ??= at
  }
  if (from !== undefined) documents.push([from, lines.length - 1])
  return documents
}

/**
 * Where the cluster's reader as it was before apimachinery 0.21 (in Helm 3.0 to 3.5, and kubectl
 * then) cuts a manifest: as now, but only at a line that has nothing after the `---` but white space
 * (Go's), and refusing none of them; a manifest that starts with `{` is one JSON value, or refused.
 * The first document of each run of lines is all it reads of it.
 */
export function olderKubernetesDocuments(text: string): Span[] | undefined {
  // (Each line, as Go reads it: an empty manifest has none, and the end of the last one no other.)
  const lines = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (text.replace(GO_LEADING, '').startsWith('{')) return kubernetesDocuments(text)
  const documents: Span[] = []
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

/** A line no reader reads anything in: blank, a comment, or a bare document marker. */
const IDLE = /^(---(?=[ \t]|\r?$))?[ \t]*(#.*)?\r?$/

/**
 * The lines that aren't surely where every reader reads them: each line that holds anything must
 * lie in one document under every split (Helm 4's, Helm 3's, the cluster's, the YAML library's),
 * the same one under each; where it doesn't, or the cluster's refuses the manifest, or it holds what readers
 * can't be counted on to read alike, every document that holds it, under any split, is unsure
 * whole.
 */
function unsureLines(source: Source, library: Span[]): boolean[] {
  const { lines } = source
  const owners = (spans: Span[]) => {
    const owner = lines.map(() => -1)
    spans.forEach(([first, last], at) => linesOf(first, last).forEach((line) => (owner[line] = at)))
    return owner
  }
  // (A piece of nothing holds no line.)
  const pieces = (cut: (text: string) => Span[]) =>
    cut(source.text).flatMap(([from, to]): Span[] =>
      to > from ? [[lineOf(source, from), lineOf(source, to - 1)]] : [],
    )
  const cluster = kubernetesDocuments(source.text)
  const splits = [
    owners(library),
    owners(pieces(helmManifests)),
    owners(pieces(helm3Manifests)),
    owners(cluster ?? []),
  ]
  const holds = lines.map((line) => !IDLE.test(line))
  const unsure = lines.map(
    (line, at) =>
      UNREADABLE.test(line) ||
      (holds[at]! && (cluster === undefined || splits.some((owner) => owner[at]! < 0))),
  )
  // The same document under every split: where one holds lines the others split, all unsure.
  const key = (at: number) => splits.map((owner) => owner[at]).join('/')
  for (const owner of splits) {
    const keys = new Map<number, Set<string>>()
    lines.forEach((_, at) => {
      if (holds[at] && owner[at]! >= 0) {
        keys.set(owner[at]!, (keys.get(owner[at]!) ?? new Set()).add(key(at)))
      }
    })
    lines.forEach((_, at) => {
      if ((keys.get(owner[at]!)?.size ?? 0) > 1) unsure[at] = true
    })
  }
  // And every document, under any split, that holds an unsure line: unsure whole.
  for (let settled = false; !settled;) {
    settled = true
    for (const owner of splits) {
      const touched = new Set(lines.flatMap((_, at) => (unsure[at] ? [owner[at]] : [])))
      lines.forEach((_, at) => {
        if (unsure[at] || owner[at]! < 0 || !touched.has(owner[at])) return
        unsure[at] = true
        settled = false
      })
    }
  }
  return unsure
}

/** A line in no document masked, as nothing of it is shown: a marker as it's always written. */
function looseMasked(text: string): string {
  if (text.trim() === '') return text
  if (/^---([ \t]|\r?$)/.test(text)) return /^---[ \t]*\r?$/.test(text) ? '---' : `--- ${MASK}`
  return `${' '.repeat(text.length - text.trimStart().length)}${MASK}`
}

/** One document's lines, as `maskedManifest` masks them. */
function maskedDocument(
  source: Source,
  document: Document.Parsed,
  first: number,
  last: number,
): Shown {
  const own = source.lines.slice(first, last + 1)
  const nothing = () => noted(own, nothingShown(source, document, first, last))
  if (document.errors.length > 0 || own.some((line) => UNREADABLE.test(line))) return nothing()
  let read: unknown
  try {
    read = document.toJS(READ)
  } catch {
    return nothing()
  }
  // (Nothing but comments, or nothing at all, as an empty template's: nothing of its own.)
  const contents = document.contents
  if (contents === null || (isScalar(contents) && contents.value === null)) return { lines: own }
  const whole = () => named(source, document, first, last)
  if (!plainlyRead(document)) return noted(own, whole())
  const secrets = secretsIn(read)
  const values = secretValues(document)
  if (values === undefined || values.secrets !== secrets.length) return nothing()
  if (secrets.length === 0) return { lines: own }
  for (const masked of [lineMaskedRead(own, secrets), whole()]) {
    if (masked && values.nodes.every((node) => maskedWhere(source, node, first, masked))) {
      return { lines: masked }
    }
  }
  return nothing()
}

/** A document's lines masked whole for how it reads, saying so after the first line's mask. */
function noted(own: string[], masked: string[]): Shown {
  const at = masked.findIndex((line, i) => line !== own[i] && line.endsWith(MASK))
  if (at < 0) return { lines: masked }
  masked[at] = `${masked[at]} # ${HIDDEN_WHOLE}`
  return { lines: masked, whole: true }
}

/** A kind that may be a Secret's, as the cluster may read it. */
const secretKind = (kind: unknown) =>
  typeof kind === 'string' && kind.trim().toLowerCase() === 'secret'

/**
 * Whether a document reads alike to every reader that matters (Lumovi's, Helm's, the cluster's):
 * nothing in it written once and read in another place, and an object as `plainObject` says.
 */
function plainlyRead(document: Document.Parsed): boolean {
  let plain = true
  visit(document, {
    Alias: () => {
      plain = false
      return visit.BREAK
    },
    Node: (_, node) => {
      if (!node.anchor) return
      plain = false
      return visit.BREAK
    },
    Pair: (_, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'symbol') return
      plain = false
      return visit.BREAK
    },
  })
  return plain && plainObject(document.contents)
}

/**
 * Whether a node is plainly an object: a mapping, untagged, each of its keys a string written once,
 * with a kind that's an untagged string, not empty, an untagged apiVersion and metadata (whose keys
 * are the same), and, where it holds items, a kind that isn't a Secret's or a list of them, and
 * items each the same.
 */
function plainObject(node: unknown): boolean {
  if (!isMap(node) || node.tag) return false
  const keys = plainKeys(node)
  const kind = node.get('kind', true)
  if (!keys || !isScalar(kind) || kind.tag || typeof kind.value !== 'string') return false
  if (kind.value.trim() === '') return false
  const apiVersion = node.get('apiVersion', true) as Node | null | undefined
  const metadata = node.get('metadata', true) as Node | null | undefined
  if (apiVersion?.tag || metadata?.tag || (isMap(metadata) && !plainKeys(metadata))) return false
  const items = keys.get('items')?.value as Node | null | undefined
  if (items === undefined || items === null || (isScalar(items) && items.value === null)) {
    return true
  }
  // (A list's items are made one by one; one with no kind of its own takes its list's.)
  const listed = kind.value.trim().toLowerCase()
  if (listed === 'secret' || listed === 'secretlist') return false
  return isSeq(items) && !items.tag && items.items.every(plainObject)
}

/** A mapping's keys, by name, where each is an untagged string written once. */
function plainKeys(map: YAMLMap): Map<string, Pair> | undefined {
  const keys = new Map<string, Pair>()
  for (const pair of map.items) {
    const key = pair.key
    if (!isScalar(key) || key.tag || typeof key.value !== 'string') return undefined
    const name = key.value.toLowerCase()
    if (keys.has(name)) return undefined
    keys.set(name, pair as Pair)
  }
  return keys
}

/** The line-by-line masking, where reading it back shows every value masked. */
function lineMaskedRead(own: string[], secrets: Record<string, unknown>[]): string[] | undefined {
  const masked = lineMasked(own)
  let back: unknown
  try {
    back = parse(masked.join('\n'), READ)
  } catch {
    return undefined
  }
  const after = secretsIn(back)
  return after.length === secrets.length && after.every(allMasked) ? masked : undefined
}

/**
 * Every Secret's value nodes in a document (its data's and stringData's, and its last-applied
 * annotation's), and how many Secrets that's of; none where a Secret's are past telling.
 */
function secretValues(document: Document.Parsed): { nodes: Node[]; secrets: number } | undefined {
  const nodes: Node[] = []
  let secrets = 0
  let unknown = false
  visit(document, {
    Map: (_, map) => {
      if (!secretKind(map.get('kind'))) return
      secrets++
      for (const field of map.items) {
        const name = isScalar(field.key) ? String(field.key.value).toLowerCase() : ''
        if (name !== 'data' && name !== 'stringdata') continue
        const values = field.value as Node | null
        if (values === null) continue
        if (isMap(values)) {
          for (const pair of values.items) if (pair.value) nodes.push(pair.value as Node)
        } else nodes.push(values)
      }
      const metadata = map.get('metadata', true)
      const annotations = isMap(metadata) ? metadata.get('annotations', true) : undefined
      const applied = isMap(annotations) ? (annotations.get(LAST_APPLIED, true) as Node) : undefined
      if (applied) nodes.push(applied)
      if (nodes.some((node) => !node.range)) unknown = true
    },
  })
  return unknown ? undefined : { nodes, secrets }
}

/**
 * Whether every line a value's node is written on shows nothing of it: masked whole, or (where
 * it's masked line by line) its key as it was and the mask after it. A block scalar's first line
 * has its indicator alone (`|`), none of its value.
 */
function maskedWhere(source: Source, node: Node, first: number, masked: string[]): boolean {
  const [from, to] = [node.range![0], node.range![1]]
  const block = isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')
  const start = lineOf(source, from)
  for (let line = start; line <= lineOf(source, Math.max(from, to - 1)); line++) {
    if (block && line === start) continue
    const text = source.lines[line]!
    const lineStart = source.starts[line]!
    const column = Math.max(from, lineStart) - lineStart
    if (text.slice(column, Math.min(to, lineStart + text.length) - lineStart).trim() === '')
      continue
    const out = masked[line - first]!
    const whole = out.trim() === MASK || out === `--- ${MASK}`
    const keyed =
      out.slice(0, column) === text.slice(0, column) && out.slice(column).trim() === MASK
    if (!whole && !keyed) return false
  }
  return true
}

/**
 * A document masked whole but for what names it, as its nodes say: the lines before its first
 * node (its marker and the comments there, as Helm's `# Source:`), and the lines that hold its
 * apiVersion, its kind, its metadata's key, and its metadata's name and namespace, each with
 * nothing else on it. Nothing is kept for how it looks.
 */
function named(source: Source, document: Document.Parsed, first: number, last: number): string[] {
  const keep = new Set<number>()
  const contents = document.contents as Node | null
  const opens = contents?.range ? lineOf(source, contents.range[0]) : last + 1
  for (let line = first; line < opens; line++) keep.add(line)
  // (Never inside a mapping an alias may name: its names may be what a Secret holds.)
  if (isMap(contents) && !contents.anchor) {
    for (const pair of contents.items) {
      const key = keyOf(pair)
      if (key === 'apiVersion' || key === 'kind') keepAlone(source, pair, keep)
      if (key === 'metadata' && isMap(pair.value) && !pair.value.anchor) {
        keepKeyAlone(source, pair, keep)
        for (const inner of pair.value.items) {
          if (['name', 'namespace'].includes(keyOf(inner) ?? '')) keepAlone(source, inner, keep)
        }
      }
    }
  }
  return source.lines
    .slice(first, last + 1)
    .map((text, i) => (keep.has(first + i) ? text : maskedLine(source, document, first + i)))
}

/** A pair's key, where it's a plain one: a string, with no tag or anchor. */
const keyOf = (pair: Pair) =>
  isScalar(pair.key) && !pair.key.tag && !pair.key.anchor && typeof pair.key.value === 'string'
    ? pair.key.value
    : undefined

/** Its line kept, where a pair of a key and a plain value (no tag or anchor) is all that's on it. */
function keepAlone(source: Source, pair: Pair, keep: Set<number>) {
  const [key, value] = [pair.key as Node, pair.value as Node | null]
  if (!isScalar(value) || value.tag || value.anchor || !key.range || !value.range) return
  const line = lineOf(source, key.range[0])
  if (line !== lineOf(source, Math.max(value.range[0], value.range[1] - 1))) return
  const text = source.lines[line]!
  const lineStart = source.starts[line]!
  if (text.slice(0, key.range[0] - lineStart).trim() !== '') return
  if (text.slice(value.range[1] - lineStart).trim() !== '') return
  keep.add(line)
}

/** A key's line kept, where the key and its colon are all that's on it (its value is below). */
function keepKeyAlone(source: Source, pair: Pair, keep: Set<number>) {
  const [key, value] = [pair.key as Node, pair.value as Node]
  if (!key.range || !value.range) return
  const line = lineOf(source, key.range[0])
  if (lineOf(source, value.range[0]) === line) return
  const text = source.lines[line]!
  const lineStart = source.starts[line]!
  if (text.slice(0, key.range[0] - lineStart).trim() !== '') return
  if (text.slice(key.range[1] - lineStart).trim() !== ':') return
  keep.add(line)
}

/**
 * A line masked, as nothing of it is shown: the document's marker, where the document starts on
 * the line, as it's always written; its value's place, the mask.
 */
function maskedLine(source: Source, document: Document.Parsed, line: number): string {
  const text = source.lines[line]!
  if (text.trim() === '') return text
  const from = document.range[0]
  const marked = lineOf(source, from) === line && source.text.startsWith('---', from)
  if (marked)
    return text.slice(from - source.starts[line]! + 3).trim() === '' ? '---' : `--- ${MASK}`
  return `${' '.repeat(text.length - text.trimStart().length)}${MASK}`
}

/** A document of which nothing is shown but its marker: every line masked. */
function nothingShown(
  source: Source,
  document: Document.Parsed,
  first: number,
  last: number,
): string[] {
  const lines: string[] = []
  for (let line = first; line <= last; line++) lines.push(maskedLine(source, document, line))
  return lines
}

/** Every Secret in what a document reads as, however deep (a List's items, say). */
function secretsIn(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const each of value) secretsIn(each, found)
  else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (secretKind(object.kind)) found.push(object)
    for (const each of Object.values(object)) secretsIn(each, found)
  }
  return found
}

/** Whether a value reads as masked: nothing but the mask (a block scalar's lines, each one). */
const isMasked = (value: unknown) =>
  typeof value === 'string' && value.replaceAll(MASK, '').trim() === '' && value.includes(MASK)

/** Whether a Secret read back has every value of its data, stringData and annotation masked. */
function allMasked(secret: Record<string, unknown>): boolean {
  for (const field of ['data', 'stringData']) {
    const values = secret[field]
    if (values === undefined || values === null) continue
    if (typeof values !== 'object' || Array.isArray(values)) return false
    for (const value of Object.values(values)) {
      if (value !== null && value !== '' && !isMasked(value)) return false
    }
  }
  const annotations = (secret.metadata as { annotations?: Record<string, unknown> } | undefined)
    ?.annotations
  const applied = annotations?.[LAST_APPLIED]
  return applied === undefined || applied === null || applied === '' || isMasked(applied)
}

/**
 * A document's lines with a Secret's data, stringData and last-applied annotation masked where
 * they're written in block style (as Helm's templates mostly write them); anything else as it is,
 * for maskedManifest to read back.
 */
function lineMasked(own: string[]): string[] {
  const lines = [...own]
  const start = 0
  const end = lines.length
  if (!lines.some((line) => /^kind:\s*['"]?Secret['"]?\s*(#.*)?$/.test(line))) return lines
  // Where a masked block began (data: or stringData:), and where a value's own lines did (a
  // block scalar's, or the annotation's): each by its key's indentation.
  let section: number | undefined
  let value: number | undefined
  for (let i = start; i < end; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    // A value's own lines (more indented than its key): masked whole.
    if (value !== undefined) {
      if (indent > value) {
        lines[i] = `${' '.repeat(indent)}${MASK}`
        continue
      }
      value = undefined
    }
    if (section !== undefined && indent <= section) section = undefined
    if (section !== undefined) {
      // A key of its, and its value on the line (masked), or below it (a block scalar's).
      const pair = /^(\s*(?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:)(\s*)(\S.*)?$/.exec(line)
      if (pair) {
        const [, key, space, rest] = pair
        if (rest === undefined || /^[|>][-+0-9]*\s*(#.*)?$/.test(rest)) value = indent
        else lines[i] = `${key}${space || ' '}${MASK}`
      } else {
        lines[i] = `${' '.repeat(indent)}${MASK}`
      }
      continue
    }
    if (/^(data|stringData):\s*(#.*)?$/.test(line)) {
      section = indent
      continue
    }
    // The annotation kubectl keeps of what was applied: the whole object, values and all.
    const applied =
      /^(\s*["']?kubectl\.kubernetes\.io\/last-applied-configuration["']?\s*:)(\s*)(\S.*)?$/.exec(
        line,
      )
    if (applied) {
      const [, key, , rest] = applied
      if (rest === undefined || /^[|>][-+0-9]*\s*$/.test(rest)) value = indent
      else lines[i] = `${key} ${MASK}`
    }
  }
  return lines
}

/** A value's path as Helm's --set writes it: `image.tag`, `ingress.hosts[0].host`. */
function paths(value: unknown, at: string, into: Map<string, string>): Map<string, string> {
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((each, i) => paths(each, `${at}[${i}]`, into))
  } else if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
    for (const [key, each] of Object.entries(value)) {
      paths(each, at ? `${at}.${key}` : key, into)
    }
  } else if (at) {
    into.set(at, JSON.stringify(value))
  }
  return into
}

/**
 * What going from one revision's values to another's changes, by key alone (never a value: a
 * values file often holds passwords): changed, added (only in the one gone to), removed.
 */
export function valueKeys(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): { changed: string[]; added: string[]; removed: string[] } {
  const before = paths(from, '', new Map())
  const after = paths(to, '', new Map())
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(key)
    else if (before.get(key) !== value) changed.push(key)
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key)
  return { changed, added, removed }
}

/**
 * What Helm did after a deploy failed, where its message says: rolled the upgrade back, or
 * uninstalled the install. Nothing where it says neither.
 */
export function undoneBy(message: string): 'rolled-back' | 'uninstalled' | undefined {
  if (/has been rolled back/i.test(message)) return 'rolled-back'
  if (/(has been|was) uninstalled/i.test(message)) return 'uninstalled'
  return undefined
}
