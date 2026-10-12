/**
 * YAML read against the cluster's schemas, as it's typed: what's wrong in it, where (unknown
 * fields, values of the wrong type or not among a field's values, required fields not there,
 * and YAML that doesn't parse), and, at a place in it, which field that is: what it may hold,
 * for completion, and what it says of itself, for hover.
 *
 * Each document is checked by the schema of the kind it says it is (its `apiVersion` and
 * `kind`); one whose schema isn't known yet, or that the cluster publishes none for, is checked
 * as YAML only. Nothing here touches the page, so it can run off the page's own thread.
 *
 * Every line it writes has one form: where (the field's path), then what's wrong in plain words,
 * then what would be right where that's short to say.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  type Node,
  type YAMLError,
} from 'yaml'
import type { FieldSchema } from '@shared/api'
import { pathText, type Path } from './yaml-edit'

/**
 * Something wrong in the text, between two of its offsets: what the cluster would refuse (an
 * error), or take and drop without a word (a warning). A document's own problems say which
 * field, and its type, apart from the sentence.
 */
export interface Problem {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
  path?: string
  type?: string
}

/**
 * A kind's schema, and the kind as a sentence says it ("pod", "NodePool"): the schema null where
 * the cluster publishes none, and undefined while it isn't known.
 */
export type SchemaOf = (
  apiVersion: string,
  kind: string,
) => { schema: FieldSchema | null | undefined; words: string }

/** What a document says it is, and where. */
export interface DocumentKind {
  apiVersion: string
  kind: string
}

/** How long a value is shown in a line about it, at most. */
const SHOWN = 40
/** The most of a field's values a line names; past it, the hover card has them. */
const NAMED_VALUES = 5

/** The documents of a text, as `yaml` reads them (as Lumovi reads them to send them). */
function documentsOf(text: string) {
  const lines = new LineCounter()
  const documents = parseAllDocuments(text, { lineCounter: lines })
  return { documents: Array.isArray(documents) ? documents : [], lines }
}

/** The kinds a text's documents say they are, each once, for fetching their schemas. */
export function kindsIn(text: string): DocumentKind[] {
  const kinds = new Map<string, DocumentKind>()
  for (const document of documentsOf(text).documents) {
    const kind = kindOf(document.contents)
    if (kind) kinds.set(`${kind.apiVersion}/${kind.kind}`, kind)
  }
  return [...kinds.values()]
}

function kindOf(root: unknown): DocumentKind | undefined {
  if (!isMap(root)) return undefined
  const value = (key: string) => {
    const node = root.get(key, true)
    return isScalar(node) && typeof node.value === 'string' ? node.value : undefined
  }
  const apiVersion = value('apiVersion')
  const kind = value('kind')
  return apiVersion && kind ? { apiVersion, kind } : undefined
}

/** The problems in a text: its YAML's, then each document's by its kind's schema. */
export function problemsIn(text: string, schemaOf: SchemaOf): Problem[] {
  const { documents } = documentsOf(text)
  const problems: Problem[] = []
  for (const document of documents) {
    problems.push(...parseProblems(text, document.errors))
    // (A document that doesn't parse is said once, as YAML: its fields wait till it does.)
    if (document.errors.length > 0) continue
    const kind = kindOf(document.contents)
    const known = kind && schemaOf(kind.apiVersion, kind.kind)
    const first = isMap(document.contents) ? rangeOf(document.contents.items[0]?.key) : undefined
    if (known?.schema && first) {
      check(document.contents, known.schema, [], first, known.words, problems)
    }
  }
  return problems
}

// ——— YAML that doesn't parse ———

const lineAt = (text: string, offset: number) => {
  const from = text.lastIndexOf('\n', offset - 1) + 1
  const end = text.indexOf('\n', offset)
  return { from, to: end === -1 ? text.length : end }
}

/** The parser's errors, in Lumovi's words for the common ones, and one line for the rest. */
function parseProblems(text: string, errors: readonly YAMLError[]): Problem[] {
  const problems: Problem[] = []
  const said = new Set<number>()
  const say = (at: { from: number; to: number }, message: string) => {
    if (said.has(at.from)) return
    said.add(at.from)
    problems.push({ ...at, severity: 'error', message })
  }
  // A line indented past its own is read as the line above going on over two: the parser says
  // so of the line above, but it's the line further in that's wrong.
  const over = errors.filter((error) => error.code === 'MULTILINE_IMPLICIT_KEY')
  for (const error of over) {
    say(lineAt(text, error.pos[1]), 'This line is indented more than the lines it belongs with.')
  }
  for (const error of errors) {
    const [from] = error.pos
    if (error.code === 'MULTILINE_IMPLICIT_KEY') continue
    if (
      error.code === 'BLOCK_AS_IMPLICIT_KEY' &&
      over.some((each) => each.pos[0] === error.pos[0])
    ) {
      continue
    }
    if (error.code === 'TAB_AS_INDENT') {
      say(lineAt(text, from), 'A tab can’t indent YAML: use spaces.')
    } else if (error.code === 'DUPLICATE_KEY') {
      const line = lineAt(text, from)
      const key = /^([^:#]*?)\s*:/.exec(text.slice(from, line.to))?.[1] ?? ''
      say(
        { from, to: from + Math.max(1, key.length) },
        `${key.replace(/^["']|["']$/g, '')} is set twice in this object.`,
      )
    } else {
      say(lineAt(text, from), 'This isn’t YAML Lumovi can read here.')
    }
  }
  return problems
}

// ——— A document by its schema ———

type Ranged = Node & { range: [number, number, number] }
const rangeOf = (node: unknown): { from: number; to: number } | undefined => {
  const range = (node as Partial<Ranged> | null)?.range
  return range ? { from: range[0], to: range[1] } : undefined
}

/** What a value is, in a line that says it's not what goes there: "text", "a list", 2.5. */
function whatItIs(node: unknown): string {
  if (isMap(node)) return 'an object'
  if (isSeq(node)) return 'a list'
  const value = isScalar(node) ? node.value : node
  if (typeof value === 'string') return 'text'
  if (typeof value === 'boolean') return 'true or false'
  return 'a number'
}

/** A value as a line quotes it: text quoted and cut, a number or true/false as it is. */
function quoted(value: unknown): string {
  if (typeof value !== 'string') return String(value)
  const characters = [...value]
  return `“${characters.length > SHOWN ? `${characters.slice(0, SHOWN - 1).join('')}…` : value}”`
}

/** "Always, IfNotPresent and Never". */
function named(values: readonly unknown[]): string {
  const words = values.map(String)
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** Whether a field's description says it's not to be used any more. */
export const isDeprecated = (schema: FieldSchema | undefined) =>
  /\bdeprecated\b/i.test(schema?.description?.split(/\n|\.\s/)[0] ?? '')

/** Of `names`, the one a step or two from `typed` by spelling, if there's exactly one. */
function meant(typed: string, names: readonly string[]): string | undefined {
  const near = names.filter((name) => {
    const distance = editDistance(typed.toLowerCase(), name.toLowerCase())
    return distance > 0 && distance <= 2
  })
  return near.length === 1 ? near[0] : undefined
}

/** Steps from one word to another: a letter added, taken away, changed, or two swapped. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1)
      }
    }
  }
  return rows[a.length]![b.length]!
}

/**
 * A field of an object, by a name the YAML gives: only the schema's own (a key such as
 * `constructor` or `__proto__` is no field of any schema, whatever an object of the language
 * has by that name).
 */
export const fieldOf = (schema: FieldSchema, name: string): FieldSchema | undefined =>
  schema.properties && Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined

const typeOf = (schema: FieldSchema) =>
  schema.type ?? (schema.properties || schema.additionalProperties ? 'object' : undefined)

/** A field's type, as the schema says it: "integer", "list", "map", "integer or string". */
export function typeName(schema: FieldSchema): string {
  if (schema.numberOrText) return 'integer or string'
  const type = typeOf(schema)
  if (type === 'array') return 'list'
  if (type === 'object' && !schema.properties && schema.additionalProperties) return 'map'
  return type ?? ''
}

/** What goes in a field, as a line says it: "A whole number", "Text". */
function whatGoes(schema: FieldSchema): string {
  if (schema.numberOrText) return 'A number or text'
  switch (typeOf(schema)) {
    case 'integer':
      return 'A whole number'
    case 'number':
      return 'A number'
    case 'string':
      return 'Text'
    case 'boolean':
      return 'True or false'
    case 'array':
      return 'A list'
    default:
      return 'An object'
  }
}

/**
 * Whose object it is, in a line about a field it hasn't: by the name of its type in the schema
 * ("PodSpec": "A pod’s spec"; "Container": "A container"), by its kind where it's a kind's own
 * spec or status, and otherwise "This object". (`kind` is the kind as a sentence says it.)
 */
export function ownerWords(schema: FieldSchema, path: Path, kind: string): string {
  const part = (word: string) => (word === 'Meta' ? 'metadata' : word.toLowerCase())
  const article = (words: string) => (/^[aeiou]/i.test(words) ? 'An' : 'A')
  if (schema.named) {
    const words = schema.named.split(/(?<=[a-z0-9])(?=[A-Z])/)
    const last = words.at(-1)!
    if (words.length > 1 && ['Spec', 'Status', 'Meta'].includes(last)) {
      const owner = words.slice(0, -1).join(' ').toLowerCase()
      return `${article(owner)} ${owner}’s ${part(last)}`
    }
    const whole = words.join(' ').toLowerCase()
    return `${article(whole)} ${whole}`
  }
  if (path.length === 1 && (path[0] === 'spec' || path[0] === 'status')) {
    return `${article(kind)} ${kind}’s ${path[0]}`
  }
  return 'This object'
}

/**
 * Checks a value by its schema, and what's in it. `key` is where the field's own key is (a
 * missing required field is marked there): a document's first key, at its root.
 */
function check(
  node: unknown,
  schema: FieldSchema,
  path: Path,
  key: { from: number; to: number },
  kind: string,
  problems: Problem[],
): void {
  // Nothing (`field:`, `null`) is a field left out; an alias is checked where it's defined.
  if (node === null || node === undefined || isAlias(node)) return
  if (isScalar(node) && node.value === null) return
  const at = rangeOf(node) ?? key
  const field = { path: pathText(path), type: typeName(schema) }
  const refused = (message: string, where = at) => {
    problems.push({ ...where, severity: 'error', message, ...field })
  }
  const wrong = () => refused(`${whatGoes(schema)} goes here, not ${whatItIs(node)}.`)

  if (schema.numberOrText) {
    if (isMap(node) || isSeq(node)) wrong()
    return
  }
  const type = typeOf(schema)
  if (type === 'object') {
    if (!isMap(node)) return wrong()
    const keys = new Set<string>()
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue
      const name = String(pair.key.value)
      keys.add(name)
      const keyAt = rangeOf(pair.key) ?? at
      const inner = fieldOf(schema, name) ?? schema.additionalProperties
      if (inner) {
        check(pair.value, inner, [...path, name], keyAt, kind, problems)
      } else if (schema.properties && !schema.open) {
        // (The cluster takes it, and drops it without a word: a warning, not an error.)
        const close = meant(name, Object.keys(schema.properties))
        problems.push({
          ...keyAt,
          severity: 'warning',
          message: `${ownerWords(schema, path, kind)} has no field ${quoted(name)}.${close ? ` Did you mean ${close}?` : ''}`,
          path: pathText([...path, name]),
          type: '',
        })
      }
    }
    for (const name of schema.required ?? []) {
      if (!keys.has(name)) refused(`This needs ${name}.`, key)
    }
    return
  }
  if (type === 'array') {
    if (!isSeq(node)) return wrong()
    if (schema.items) {
      for (const [index, item] of node.items.entries()) {
        check(item, schema.items, [...path, index], rangeOf(item) ?? at, kind, problems)
      }
    }
    return
  }
  if (!isScalar(node)) {
    if (type) wrong()
    return
  }
  const value = node.value
  if (type === 'string' && typeof value !== 'string') return wrong()
  if ((type === 'integer' || type === 'number') && typeof value !== 'number') return wrong()
  if (type === 'integer' && !Number.isInteger(value)) {
    return refused(`A whole number goes here, not ${String(value)}.`)
  }
  if (type === 'boolean' && typeof value !== 'boolean') return wrong()
  if (schema.enum?.length && !schema.enum.includes(value)) {
    refused(
      schema.enum.length > NAMED_VALUES
        ? `This is one of the values the schema lists, not ${quoted(value)}.`
        : `This is one of ${named(schema.enum)}, not ${quoted(value)}.`,
    )
  }
}

// ——— A place in the text: which field, for completion and hover ———

/** A field at a place in the text: where it is, and what holds it. */
export interface Place {
  /** The kind the place's document says it is. */
  kind?: DocumentKind
  /** The path of the object (or list's item) the place is in. */
  parent: (string | number)[]
  /** The key typed there so far, or under the pointer, and where it is. */
  key: { text: string; from: number; to: number }
  /** Past "key:" on the key's line: what's typed of its value so far, and where it starts. */
  value?: { text: string; from: number }
  /** The keys the object has besides the one at the place, and where each starts. */
  siblings: { name: string; at: number }[]
}

/** A line's start: its indent, the dashes of list items it begins, and where its key starts. */
function leadOf(line: string) {
  const lead = /^( *)((?:- +)*)/.exec(line)!
  return { indent: lead[1]!.length, items: lead[2]!.length > 0, column: lead[0].length }
}

/** The key a line starts with, past its lead, if it has one ("name" of "  - name: web"). */
function keyOf(line: string, column: number): string | undefined {
  const keyed = /^("[^"]*"|'[^']*'|[^\s#:'"{[][^:#]*?)\s*:(?=\s|$)/.exec(line.slice(column))
  return keyed?.[1]!.replace(/^["']|["']$/g, '')
}

const skipped = (line: string) => /^\s*(#.*)?$/.test(line)

/**
 * The place at `offset`, read from the lines around it by their indentation, so it's found in a
 * document as it's being typed, whole or not. Plain block YAML: a place inside `{ }` or `[ ]`, or
 * in a value that goes on over lines, isn't one.
 */
export function placeAt(text: string, offset: number): Place | undefined {
  const lines = text.split('\n')
  const starts: number[] = []
  for (let i = 0, at = 0; i < lines.length; at += lines[i]!.length + 1, i++) starts.push(at)
  let row = 0
  let start = 0
  while (row < lines.length - 1 && start + lines[row]!.length < offset) {
    start += lines[row]!.length + 1
    row++
  }
  const line = lines[row]!
  const before = line.slice(0, offset - start)
  if (/[{}[\]#]/.test(before) || /^(---|\.\.\.)/.test(line)) return undefined

  // The document it's in: from the `---` above it to the next.
  let first = row
  while (first > 0 && !/^---/.test(lines[first - 1]!)) first--
  let last = row
  while (last < lines.length - 1 && !/^---/.test(lines[last + 1]!)) last++
  const top = (name: string) => {
    for (let i = first; i <= last; i++) {
      const found = new RegExp(`^${name}:\\s*["']?([^\\s"'#]+)`).exec(lines[i]!)
      if (found) return found[1]
    }
    return undefined
  }
  const apiVersion = top('apiVersion')
  const kindName = top('kind')
  const kind = apiVersion && kindName ? { apiVersion, kind: kindName } : undefined

  // The key at the place, and its value if the place is past the key's colon.
  const { indent, items, column } = leadOf(line)
  if (offset - start < column) return undefined
  const named = keyOf(line, column)
  const colon = named === undefined ? -1 : line.indexOf(':', column + named.length)
  let key: Place['key']
  let value: Place['value']
  if (named !== undefined && offset - start > colon) {
    const from = start + colon + 1 + /^ */.exec(line.slice(colon + 1))![0].length
    if (offset < from) return undefined
    key = { text: named, from: start + column, to: start + colon }
    value = { text: text.slice(from, offset), from }
  } else {
    const word = /^[\w.\-/"']*/.exec(line.slice(column))![0]
    if (offset - start > column + word.length) return undefined
    key = {
      text: word.replace(/^["']|["']$/g, ''),
      from: start + column,
      to: start + column + word.length,
    }
  }

  // What it's in: the keys further out above it, and the list items it's in.
  const parent: (string | number)[] = []
  const siblings: Place['siblings'] = []
  /** Where a key must start, at most, to hold what's found so far. */
  let under = column
  /** Where keys line up at the level being read (where an item holding them has its first). */
  let level = column
  /** Where the dashes are of the list whose item is being counted (its index, `parent[0]`). */
  let item: number | undefined
  if (items) {
    parent.unshift(0)
    item = indent
    under = indent + 1
    level = indent
  }
  for (let i = row - 1; i >= first; i--) {
    const above = lines[i]!
    if (skipped(above)) continue
    const lead = leadOf(above)
    const name = keyOf(above, lead.column)
    if (item !== undefined && lead.items && lead.indent === item) {
      // Another item of the same list, above this one.
      parent[0] = (parent[0] as number) + 1
      continue
    }
    if (lead.items && lead.column === level && lead.indent < under) {
      // The item that holds the place's level: its first key is one of theirs.
      if (parent.length === 0 && name !== undefined)
        siblings.push({ name, at: starts[i]! + lead.column })
      parent.unshift(0)
      item = lead.indent
      under = lead.indent + 1
      level = lead.indent
      continue
    }
    if (lead.column >= under) {
      if (parent.length === 0 && lead.column === column && name !== undefined && !lead.items) {
        siblings.push({ name, at: starts[i]! + lead.column })
      }
      continue
    }
    if (name === undefined) return undefined
    parent.unshift(name)
    item = undefined
    under = lead.column
    level = lead.column
    if (under === 0) break
  }
  // The keys after it, at its level, are the object's too.
  if (!items) {
    for (let i = row + 1; i <= last; i++) {
      const below = lines[i]!
      if (skipped(below)) continue
      const lead = leadOf(below)
      if (lead.column < column || (lead.items && lead.indent < column)) break
      const name = keyOf(below, lead.column)
      if (lead.column === column && !lead.items && name !== undefined)
        siblings.push({ name, at: starts[i]! + lead.column })
    }
  }
  return { kind, parent, key, value, siblings: siblings.filter((each) => each.name !== key.text) }
}

/** The schema of what's at `path` in a document of `schema`'s kind, if it says. */
export function schemaAt(schema: FieldSchema, path: readonly (string | number)[]) {
  let at: FieldSchema | undefined = schema
  for (const part of path) {
    if (!at) return undefined
    at = typeof part === 'number' ? at.items : (fieldOf(at, part) ?? at.additionalProperties)
  }
  return at
}
