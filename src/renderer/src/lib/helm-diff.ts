/**
 * What a Helm rollback changes, as its dialog shows it (LMV-353): the values by key alone, and a
 * manifest with each Secret's data masked as the YAML tab masks it, line for line, so that a
 * diff worked out on the real text can be shown through it.
 */

import {
  isMap,
  isScalar,
  parse,
  parseAllDocuments,
  visit,
  type Document,
  type Node,
  type Pair,
} from 'yaml'

/** What a masked value shows. */
export const MASK = '••••••••'

/** How a manifest is read: as Helm's and the cluster's readers read it, aliases bounded. */
const READ = { maxAliasCount: 100, uniqueKeys: false } as const

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
 * names it. A document it can't read shows nothing of its own. A Secret's values are first masked
 * line by line, where reading the result back shows every one masked; otherwise the document is
 * masked whole but for what names it. Last, every line one of its values is written on must show
 * nothing of it, or the document shows nothing of its own at all.
 */
export function maskedManifest(manifest: string): string {
  const lines = manifest.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const source: Source = { text: manifest, lines, starts }
  const documents = parseAllDocuments(manifest, READ)
  // (Nothing but comments and markers: no document, nothing to mask.)
  if (!Array.isArray(documents)) return manifest
  const shown = [...lines]
  for (const document of documents) {
    const [from, , to] = document.range
    const first = lineOf(source, from)
    const last = lineOf(source, Math.max(from, to - 1))
    shown.splice(first, last - first + 1, ...maskedDocument(source, document, first, last))
  }
  return shown.join('\n')
}

/** One document's lines, as `maskedManifest` masks them. */
function maskedDocument(
  source: Source,
  document: Document.Parsed,
  first: number,
  last: number,
): string[] {
  const own = source.lines.slice(first, last + 1)
  const nothing = () => nothingShown(source, document, first, last)
  if (document.errors.length > 0) return nothing()
  let read: unknown
  try {
    read = document.toJS(READ)
  } catch {
    return nothing()
  }
  const secrets = secretsIn(read)
  if (secrets.length === 0) return own
  const values = secretValues(document)
  // (A Secret read that its nodes don't show, as one an alias makes: nothing of it is shown.)
  if (values === undefined || values.secrets !== secrets.length) return nothing()
  const masked =
    (!aliased(document) && lineMaskedRead(own, secrets)) || named(source, document, first, last)
  return values.nodes.every((node) => maskedWhere(source, node, first, masked)) ? masked : nothing()
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
      if (map.get('kind') !== 'Secret') return
      secrets++
      for (const field of ['data', 'stringData']) {
        const values = map.get(field, true) as Node | null | undefined
        if (values === undefined || values === null) continue
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
  if (isMap(contents)) {
    for (const pair of contents.items) {
      const key = keyOf(pair)
      if (key === 'apiVersion' || key === 'kind') keepAlone(source, pair, keep)
      if (key === 'metadata' && isMap(pair.value)) {
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

/** A pair's key, where it's a plain one. */
const keyOf = (pair: Pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined)

/** Its line kept, where a pair of a key and a plain value (no anchor) is all that's on it. */
function keepAlone(source: Source, pair: Pair, keep: Set<number>) {
  const [key, value] = [pair.key as Node, pair.value as Node | null]
  if (!isScalar(value) || value.anchor || !key.range || !value.range) return
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

/** Whether a document names anything by an alias (`*x`, a merge's `<<: *x` too). */
function aliased(document: Document.Parsed): boolean {
  let found = false
  visit(document, {
    Alias: () => {
      found = true
      return visit.BREAK
    },
  })
  return found
}

/** Every Secret in what a document reads as, however deep (a List's items, say). */
function secretsIn(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const each of value) secretsIn(each, found)
  else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (object.kind === 'Secret') found.push(object)
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
