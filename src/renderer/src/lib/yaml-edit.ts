/**
 * Edits to YAML text that leave the rest of it as it was written: a form beside an editor
 * changes one value, and whoever wrote the YAML keeps their comments, their order, their
 * quoting and every key the form knows nothing of.
 *
 * Three kinds of edit, each touching as little as it can:
 * - a value that's there is replaced in place: only its own characters change;
 * - a key or a list's item that isn't there is written on lines of its own, among the lines
 *   of the block it joins, and no line that was there changes;
 * - one that's removed takes its own lines with it (and the key above, if that leaves it
 *   with nothing);
 * - a key that's renamed has its own characters replaced, and its value isn't touched.
 *
 * Where a block isn't written the plain way (`{ a: 1 }` on one line, a value over several
 * lines), the block the edit is in is written again by `yaml`, which keeps its comments and
 * its meaning but not its spacing; no line outside that block changes. Whatever the way, the
 * result is read back and must mean what was asked. An edit that couldn't be made without
 * writing the whole document again isn't made: `null` comes back in place of a text, and
 * what the form does then is step back and say so. Text that doesn't parse gets the same.
 *
 * Every edit reads the text it's given, there and then: positions are never kept from one
 * text to the next. What's written new is quoted wherever an older YAML (1.1, which kubectl
 * reads) would take it for something else: `on`, `yes`, `no`, `~`. New lines end as the
 * text's own do.
 *
 * A path that's an alias, carries an anchor, or comes through a merge key isn't one value in
 * one place, and isn't edited here: `elsewhere` says so, for whoever asks before editing.
 */
import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'

/** Where something is in an object: keys, and indexes into lists. */
export type Path = readonly (string | number)[]

/** `spec.template.spec.containers[0].image`. */
export const pathText = (path: Path): string =>
  path.reduce<string>(
    (text, part) =>
      typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${part}` : part,
    '',
  )

const WRITING = { lineWidth: 0, indent: 2 } as const

type Ranged = Node & { range: [number, number, number] }

const parsed = (text: string) => parseDocument(text, { keepSourceTokens: false })

/** The node at `path`, if the document has one. */
export function nodeAt(doc: Document, path: Path): Ranged | undefined {
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true)
  return node && typeof node === 'object' && 'range' in node && node.range
    ? (node as Ranged)
    : undefined
}

/** The pair whose key is the last of `path`, in the map above it. */
function pairAt(doc: Document, path: Path): Pair<Node, Node | null> | undefined {
  const key = path.at(-1)
  const parent = nodeAt(doc, path.slice(0, -1))
  if (typeof key !== 'string' || !isMap(parent)) return undefined
  return parent.items.find((pair) => isScalar(pair.key) && pair.key.value === key) as
    Pair<Node, Node | null> | undefined
}

/** Where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

/** The line (from 0) that `offset` is on. */
function lineOf(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/** Where a node's own text ends: not the comment or the blank lines after it. */
const endOf = (node: Ranged) => Math.max(node.range[0], node.range[1])

/**
 * The lines (from 1, both counted) of what's at `path`: a key with its value, or a list's item.
 * Undefined where the text has nothing there.
 */
export function linesAt(text: string, path: Path): [number, number] | undefined {
  const doc = parsed(text)
  const span = spanAt(doc, path)
  if (!span) return undefined
  const starts = lineStarts(text)
  return [lineOf(starts, span[0]) + 1, lineOf(starts, Math.max(span[0], span[1] - 1)) + 1]
}

/** From where a key (or an item) starts to where its value ends, in the text. */
function spanAt(doc: Document, path: Path): [number, number] | undefined {
  if (path.length === 0) return undefined
  const key = path.at(-1)!
  if (typeof key === 'string') {
    const pair = pairAt(doc, path)
    if (!pair) return undefined
    const from = (pair.key as Ranged).range[0]
    const value = pair.value as Ranged | null
    return [from, value?.range ? Math.max(endOf(value), (pair.key as Ranged).range[1]) : from]
  }
  const item = nodeAt(doc, path)
  if (!item) return undefined
  return [item.range[0], endOf(item)]
}

/**
 * What YAML 1.1 reads as a boolean, nothing, or a number, where 1.2 reads a string: written
 * plain, kubectl would take it for the other.
 */
const READ_OTHERWISE =
  /^(y|n|yes|no|on|off|true|false|null|~|[-+]?(0[0-7_]+|[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?|\.inf|\.nan))$/i

/** A node for `value`, with every string in it quoted that would otherwise be misread. */
function fresh(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node
  visit(node, {
    Scalar(_key, scalar) {
      if (typeof scalar.value === 'string' && READ_OTHERWISE.test(scalar.value)) {
        scalar.type = 'QUOTE_DOUBLE'
      }
    },
  })
  return node
}

/** `value` as YAML text of its own. */
function written(value: unknown): string {
  const doc = new Document()
  doc.contents = fresh(doc, value) as Document['contents']
  return doc.toString(WRITING)
}

/** A value as YAML writes it on one line; undefined if it takes more than one. */
function inline(value: string | number | boolean): string | undefined {
  const text = written(value).replace(/\n$/, '')
  return text.includes('\n') ? undefined : text
}

/**
 * Why what's at `path` isn't one value in one place, if it isn't: it's an alias, or it (or
 * something above it) is anchored for others to repeat, or a map above it merges another in.
 */
export function elsewhere(text: string, path: Path): 'alias' | 'anchor' | 'merge' | undefined {
  const doc = parsed(text)
  for (let depth = 0; depth <= path.length; depth++) {
    const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true)
    if (node === undefined || node === null) return undefined
    if (isAlias(node)) return 'alias'
    if (depth > 0 && (node as Node & { anchor?: string }).anchor) return 'anchor'
    if (isMap(node) && node.items.some((pair) => isScalar(pair.key) && pair.key.value === '<<')) {
      return 'merge'
    }
  }
  return undefined
}

/** A value with its keys in one order, whatever order they were written in. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value

/** Whether two values mean the same, as YAML reads them: a map's keys in any order. */
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))

/** What the text would mean with `edit` made, by the document's own tree. */
function meaning(text: string, edit: (doc: Document) => void): unknown {
  const doc = parsed(text)
  edit(doc)
  return doc.toJS()
}

/** `next`, if it reads as `wanted`; undefined otherwise. */
function checked(next: string, wanted: unknown): string | undefined {
  const doc = parsed(next)
  return doc.errors.length === 0 && same(doc.toJS(), wanted) ? next : undefined
}

/**
 * The text with the block at `block` written again by `yaml`, after `edit`: every line
 * outside that block is as it was. The whole document, where even that can't be done.
 */
function rewritten(text: string, block: Path, edit: (doc: Document) => void): string | null {
  const doc = parsed(text)
  const old = parsed(text)
  edit(doc)
  const whole = doc.toString(WRITING)
  const fresh = parsed(whole)
  const wanted = doc.toJS()
  const ending = text.includes('\r\n') ? '\r' : ''
  const olds = lineStarts(text)
  const news = lineStarts(whole)
  const oldLines = text.split('\n')
  // What's before a block on its first line is spaces, or a list's dash (its item is a
  // map, whose first key follows the dash): that's kept as it was, and the rest laid under.
  const LEADS = /^\s*(-\s+)*$/
  // The block the edit is in, or the nearest one above it that can be laid over line by line.
  for (let depth = block.length; depth >= 0; depth--) {
    const before = nodeAt(old, block.slice(0, depth))
    const after = nodeAt(fresh, block.slice(0, depth))
    if (!before || !after || !(isMap(before) || isSeq(before))) continue
    if (!(isMap(after) || isSeq(after)) || before.flow !== after.flow) continue
    // A map or a list written in brackets is its own characters, wherever on a line it is:
    // those are written again, and nothing else.
    if (before.flow) {
      const again = whole.slice(after.range[0], endOf(after))
      const next = text.slice(0, before.range[0]) + again + text.slice(endOf(before))
      const kept = checked(ending ? next.replace(/\r?\n/g, '\r\n') : next, wanted)
      if (kept !== undefined) return kept
      continue
    }
    // The document's own top block is the whole document: that's not a block's worth.
    if (depth === 0) break
    const [oldFrom, oldTo] = [lineOf(olds, before.range[0]), lineOf(olds, endOf(before) - 1)]
    const [newFrom, newTo] = [lineOf(news, after.range[0]), lineOf(news, endOf(after) - 1)]
    const newLines = whole.split('\n').slice(newFrom, newTo + 1)
    // Both start where their block's first key (or dash) does: the old one's indent is kept.
    const oldIndent = before.range[0] - olds[oldFrom]!
    const newIndent = after.range[0] - news[newFrom]!
    const head = oldLines[oldFrom]!.slice(0, oldIndent)
    if (!LEADS.test(head) || !LEADS.test(newLines[0]!.slice(0, newIndent))) continue
    // Nothing but the block is on its lines (a comment after it stays where it was).
    const tail = text.slice(endOf(before), olds[oldTo + 1] ?? text.length).replace(/\r?\n$/, '')
    const shifted = newLines.map(
      (line, i) =>
        (line.trim() === ''
          ? line
          : (i === 0 ? head : ' '.repeat(oldIndent)) + line.slice(newIndent)) + ending,
    )
    shifted[shifted.length - 1] = shifted.at(-1)!.replace(/\r$/, '') + tail.replace(/\r$/, '')
    // The block's last line ends as the line it replaces did.
    if (oldLines[oldTo]!.endsWith('\r')) shifted[shifted.length - 1] += '\r'
    const next = [...oldLines.slice(0, oldFrom), ...shifted, ...oldLines.slice(oldTo + 1)].join(
      '\n',
    )
    const kept = checked(next, wanted)
    if (kept !== undefined) return kept
  }
  // Nothing short of writing the whole document again would do it: that's more than an edit's
  // own, so it isn't made, and whoever asked is told so.
  return null
}

/** The column a block's keys (or a list's dashes) start at; undefined if it isn't a plain block. */
function column(text: string, starts: number[], block: Ranged): number | undefined {
  if ((!isMap(block) && !isSeq(block)) || block.flow || block.items.length === 0) return undefined
  const first = isMap(block)
    ? ((block.items[0]!.key as Ranged | null)?.range?.[0] ?? -1)
    : ((block.items[0] as Ranged | null)?.range?.[0] ?? -1)
  if (first < 0) return undefined
  const start = starts[lineOf(starts, first)]!
  // (A text's first line may start with a byte-order mark, which is no column.)
  const line = start === 0 && text.charCodeAt(0) === 0xfeff ? 1 : start
  if (isMap(block)) return first - line
  // An item starts after its dash: the dash is what's lined up.
  const dash = text.lastIndexOf('-', first)
  return dash >= line && /^\s*$/.test(text.slice(line, dash)) ? dash - line : undefined
}

/** `lines` put in `text` after the line `offset` is on (or as its first lines, for -1). */
function inserted(text: string, starts: number[], after: number, lines: string[]): string {
  const all = text.split('\n')
  const at = after < 0 ? 0 : lineOf(starts, after) + 1
  const ending = text.includes('\r\n') ? '\r' : ''
  // The line it follows may be the text's last, with no ending of its own yet.
  const before = all.slice(0, at)
  if (ending && before.length > 0 && !before.at(-1)!.endsWith('\r')) {
    before[before.length - 1] += ending
  }
  const added = lines.map((line, i) =>
    // The last line added, at the very end of a text that ends without a newline, has none.
    i === lines.length - 1 && at === all.length ? line : line + ending,
  )
  return [...before, ...added, ...all.slice(at)].join('\n')
}

const indented = (block: string, by: number) =>
  block
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line === '' ? line : ' '.repeat(by) + line))

/**
 * Whatever `edit` comes to, or `null` where it can't be done at all: a path that leads through
 * something that isn't a map or a list (the document is one word, a key's value is, or it's an
 * alias of what's written elsewhere), which `yaml` says by throwing.
 */
function orNot(edit: () => string | null): string | null {
  try {
    return edit()
  } catch {
    return null
  }
}

/**
 * Sets the value at `path`, making what's above it if it isn't there. `order` says where a new
 * key goes among a map's own: after the last of those listed before it that's there. `null`
 * if it can't be done here (see the top of this file).
 */
export function setAt(
  text: string,
  path: Path,
  value: unknown,
  order: readonly string[] = [],
): string | null {
  return orNot(() => setting(text, path, value, order))
}

function setting(
  text: string,
  path: Path,
  value: unknown,
  order: readonly string[],
): string | null {
  const doc = parsed(text)
  // (A document with nothing in it, or only a comment, has no block for anything to join.)
  if (doc.errors.length > 0 || path.length === 0 || doc.contents === null) return null
  // A key above it with nothing after it (`resources:`), or with an empty map or list
  // (`containers: []`), takes what's below as its value.
  for (let depth = 1; depth < path.length; depth++) {
    const above = nodeAt(doc, path.slice(0, depth))
    const nothing =
      above &&
      ((isScalar(above) && above.value === null) ||
        ((isMap(above) || isSeq(above)) && above.items.length === 0))
    if (nothing && pairAt(doc, path.slice(0, depth))) {
      const within = path
        .slice(depth)
        .reduceRight<unknown>(
          (inner, part) => (typeof part === 'number' ? [inner] : { [part]: inner }),
          value,
        )
      return setting(text, path.slice(0, depth), within, order)
    }
  }
  const wanted = meaning(text, (d) => d.setIn([...path], fresh(d, value)))
  const starts = lineStarts(text)

  // Nothing, for a key that's there: its value's characters go, and the key stays (`name:`).
  if (value === null) {
    const there = nodeAt(doc, path)
    const key = pairAt(doc, path)?.key as Ranged | undefined
    if (key && (!there || isScalar(there))) {
      const source = there ? text.slice(there.range[0], endOf(there)) : ''
      if (source === '') return text
      if (!source.includes('\n') && !/^[|>]/.test(source)) {
        const colon = text.indexOf(':', key.range[1])
        const kept = checked(text.slice(0, colon + 1) + text.slice(endOf(there!)), wanted)
        if (kept !== undefined) return kept
      }
    }
  }

  // There already: a value on one line is replaced by another, and nothing else moves.
  const node = nodeAt(doc, path)
  const pair = pairAt(doc, path)
  const simple = ['string', 'number', 'boolean'].includes(typeof value)
    ? inline(value as string)
    : undefined
  if (simple !== undefined && (node ? isScalar(node) : pair !== undefined)) {
    const key = pair?.key as Ranged | undefined
    let next: string | undefined
    const source = node ? text.slice(node.range[0], endOf(node)) : ''
    if (node && source !== '' && !source.includes('\n') && !/^[|>]/.test(source)) {
      next = text.slice(0, node.range[0]) + simple + text.slice(endOf(node))
    } else if (key && source === '') {
      // A key with nothing after it (`name:`): the value goes after its colon.
      const colon = text.indexOf(':', key.range[1])
      const rest = text.slice(colon + 1)
      const gap = /^[ \t]*/.exec(rest)![0].length
      next = `${text.slice(0, colon + 1)} ${simple}${rest.slice(gap).replace(/^(?=#)/, ' ')}`
    }
    const kept = next === undefined ? undefined : checked(next, wanted)
    if (kept !== undefined) return kept
  }

  // Not there: the nearest thing above it that is takes what's missing, on lines of its own.
  let depth = path.length - 1
  while (depth > 0 && !nodeAt(doc, path.slice(0, depth))) depth -= 1
  const above = path.slice(0, depth)
  const parent = nodeAt(doc, above)
  const key = path[depth]!
  // What goes in under `key`: the value, wrapped in the maps and lists between.
  const within = path
    .slice(depth + 1)
    .reduceRight<unknown>(
      (inner, part) => (typeof part === 'number' ? [inner] : { [part]: inner }),
      value,
    )
  if (!node && !pair && parent) {
    const at = column(text, starts, parent)
    if (at !== undefined && isMap(parent) && typeof key === 'string') {
      const keys = parent.items.map((item) => (isScalar(item.key) ? String(item.key.value) : ''))
      const place = order.indexOf(key)
      const before = place < 0 ? [] : order.slice(0, place)
      // After the last key that's meant to come before it; at the end, if none is named.
      let after = -1
      keys.forEach((name, i) => {
        if (before.includes(name)) after = i
      })
      if (place < 0 || (after < 0 && !keys.some((name) => order.indexOf(name) > place))) {
        after = keys.length - 1
      }
      // Before a map's first key: on the line above it, where that key starts its own line
      // (a list's dash may share it, and then it's left to below).
      const head = (parent.items[0]!.key as Ranged).range[0]
      const top = lineOf(starts, head)
      if (after < 0 && /^\s*$/.test(text.slice(starts[top]!, head).replace(/^\ufeff/, ''))) {
        const lines = indented(written({ [key]: within }), at)
        const kept = checked(inserted(text, starts, starts[top]! - 1, lines), wanted)
        if (kept !== undefined) return kept
      }
      if (after >= 0) {
        const last = parent.items[after]!
        const end = last.value
          ? Math.max(endOf(last.value as Ranged), (last.key as Ranged).range[1])
          : (last.key as Ranged).range[1]
        const lines = indented(written({ [key]: within }), at)
        const kept = checked(inserted(text, starts, end - 1, lines), wanted)
        if (kept !== undefined) return kept
      }
    }
    if (at !== undefined && isSeq(parent) && key === parent.items.length) {
      const end = endOf(parent.items.at(-1) as Ranged)
      const lines = indented(written([within]), at)
      const kept = checked(inserted(text, starts, end - 1, lines), wanted)
      if (kept !== undefined) return kept
    }
  }
  // There, but not to be replaced in place (it takes several lines, or will): its key's lines
  // are written again, and no others.
  const holder = nodeAt(doc, path.slice(0, -1))
  const span = pair ? spanAt(doc, path) : undefined
  const name = path.at(-1)
  if (span && typeof name === 'string' && holder && column(text, starts, holder) !== undefined) {
    const from = lineOf(starts, span[0])
    const to = lineOf(starts, Math.max(span[0], span[1] - 1))
    const all = text.split('\n')
    const lead = all[from]!.slice(0, span[0] - starts[from]!)
    // A comment that's the value's own is kept: after it on its last line, or, for one
    // written as a block (`|`), after that mark on its first.
    const after = text.slice(span[1], starts[to + 1] ?? text.length)
    const first = node ? text.slice(node.range[0], starts[from + 1] ?? text.length) : ''
    const comment = (/^[ \t]*(#[^\r\n]*)/.exec(after) ??
      /^[|>][-+\d]*[ \t]+(#[^\r\n]*)/.exec(first))?.[1]
    if (/^\s*$/.test(lead) && (comment !== undefined || !after.includes('#'))) {
      const ending = text.includes('\r\n') ? '\r' : ''
      const fresh = indented(written({ [name]: value }), lead.length)
      if (comment !== undefined) {
        // Where the new one is a block, that's after its mark too: its lines are all value.
        const at = /:\s+[|>][-+\d]*$/.test(fresh[0]!) ? 0 : fresh.length - 1
        fresh[at] += ` ${comment}`
      }
      const lines = fresh.map((line) => line + ending)
      if (ending && !all[to]!.endsWith('\r')) lines[lines.length - 1] = lines.at(-1)!.slice(0, -1)
      const kept = checked(
        [...all.slice(0, from), ...lines, ...all.slice(to + 1)].join('\n'),
        wanted,
      )
      if (kept !== undefined) return kept
    }
  }
  return rewritten(text, node || pair ? path.slice(0, -1) : above, (d) =>
    d.setIn([...path], fresh(d, value)),
  )
}

/**
 * Removes what's at `path`: its lines go, and so does each key above it that's left with
 * nothing, as far up as `upTo` allows (the number of parts of the path that always stay).
 */
export function removeAt(text: string, path: Path, upTo = 1): string | null {
  return orNot(() => removing(text, path, upTo))
}

function removing(text: string, path: Path, upTo: number): string | null {
  const doc = parsed(text)
  if (doc.errors.length > 0 || path.length === 0) return null
  if (!doc.hasIn([...path])) return text
  // As far up as taking it away leaves nothing behind.
  let target = [...path]
  while (target.length > upTo) {
    const parent = nodeAt(doc, target.slice(0, -1))
    const alone = (isMap(parent) || isSeq(parent)) && parent.items.length === 1
    if (!alone) break
    target = target.slice(0, -1)
  }
  const wanted = meaning(text, (d) => d.deleteIn(target))
  const span = spanAt(doc, target)
  const parent = nodeAt(doc, target.slice(0, -1)) as (YAMLMap | YAMLSeq) & Ranged
  const starts = lineStarts(text)
  if (span && column(text, starts, parent) !== undefined) {
    const from = lineOf(starts, span[0])
    const to = lineOf(starts, Math.max(span[0], span[1] - 1))
    const lines = text.split('\n')
    // Its lines are its own only if nothing else starts on its first (a list's dash, with a
    // map's first key after it) or goes on after its last.
    const own =
      /^\s*(- )?$/.test(lines[from]!.slice(0, span[0] - starts[from]!)) &&
      !(typeof target.at(-1) === 'string' && /-\s*$/.test(text.slice(starts[from]!, span[0])))
    if (own) {
      const next = [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n')
      // The last thing a key held leaves the key with nothing (`env:`), which reads the same
      // to Kubernetes as an empty one.
      const emptied =
        parent.items.length === 1 && target.length > 1
          ? meaning(text, (d) => d.setIn(target.slice(0, -1), null))
          : wanted
      const kept = checked(next, wanted) ?? checked(next, emptied)
      if (kept !== undefined) return kept
    }
  }
  return rewritten(text, target.slice(0, -1), (d) => void d.deleteIn(target))
}

/**
 * Renames the key at `path` to `name`, where it is: its value, and what's around it, stay as
 * they were. `null` if it can't be (there's no such key, or one called `name` is there too).
 */
export function renameAt(text: string, path: Path, name: string): string | null {
  return orNot(() => {
    const doc = parsed(text)
    const pair = pairAt(doc, path)
    const old = path.at(-1)
    if (doc.errors.length > 0 || !pair || typeof old !== 'string') return null
    if (name === old) return text
    // A map has each key once.
    if (pairAt(doc, [...path.slice(0, -1), name])) return null
    const key = pair.key as Ranged
    const said = inline(name)
    if (said === undefined) return null
    const wanted = meaning(text, (d) => {
      ;(pairAt(d, path)!.key as Scalar).value = name
    })
    return checked(text.slice(0, key.range[0]) + said + text.slice(endOf(key)), wanted) ?? null
  })
}
