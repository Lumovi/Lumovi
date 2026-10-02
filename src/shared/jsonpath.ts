/**
 * The part of kubectl's JSONPath that CRD printer columns and views use:
 *
 *   .spec.secretName                        fields
 *   .metadata.labels['app.kubernetes.io/name']  keys with dots or slashes
 *   .metadata.labels.app\.kubernetes\.io/name   (the same, escaped)
 *   .spec.containers[0].image               indexes (negative from the end)
 *   .spec.hosts[*]                          every item
 *   .status.conditions[?(@.type=="Ready")].status   items that match
 *
 * A path can be wrapped in braces ({.spec.x}) and start with $. Filters
 * compare with == or != against strings, numbers, booleans and null, or just
 * test that a field is set: [?(@.ready)].
 */

type Literal = string | number | boolean | null

export interface Filter {
  path: Step[]
  op?: string
  value?: Literal
}

export type Step = { key: string } | { index: number } | { all: true } | { filter: Filter }

export class JsonPathError extends Error {}

const OPERATORS = ['==', '!=']

/** Every value `path` finds in `value`, in order. Throws JsonPathError for a malformed path. */
export function jsonPath(value: unknown, path: string): unknown[] {
  return evaluate(value, parse(path))
}

/** Checks a path without evaluating it; the error explains what's wrong. */
export function checkPath(path: string): void {
  parse(path)
}

const cache = new Map<string, Step[]>()

/** A path's steps: fields, indexes, every item, and filters. Throws JsonPathError when malformed. */
export function parse(path: string): Step[] {
  let steps = cache.get(path)
  if (!steps) {
    steps = parseSteps(path)
    cache.set(path, steps)
  }
  return steps
}

function parseSteps(source: string): Step[] {
  let text = source.trim()
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1).trim()
  if (text.startsWith('$')) text = text.slice(1)
  if (!text.startsWith('.') && !text.startsWith('[')) {
    throw new JsonPathError(`“${source}” should start with a dot, like .spec.replicas`)
  }
  const steps: Step[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '.') {
      i++
      let key = ''
      while (i < text.length && text[i] !== '.' && text[i] !== '[') {
        // A backslash keeps a dot in the key: labels.app\.kubernetes\.io/name.
        if (text[i] === '\\' && text[i + 1] === '.') i++
        key += text[i++]
      }
      if (!key) throw new JsonPathError(`“${source}” has an empty field name`)
      steps.push(key === '*' ? { all: true } : { key })
    } else if (text[i] === '[') {
      const end = closing(text, i, source)
      steps.push(bracket(text.slice(i + 1, end).trim(), source))
      i = end + 1
    } else {
      throw new JsonPathError(`“${source}” has “${text[i]}” where a . or [ should be`)
    }
  }
  return steps
}

/** Where the bracket opened at `start` closes, skipping quoted text and parentheses. */
function closing(text: string, start: number, source: string): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '[' || ch === '(') {
      depth++
    } else if (ch === ']' || ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new JsonPathError(`“${source}” has a [ without its ]`)
}

function bracket(inside: string, source: string): Step {
  if (inside === '*') return { all: true }
  if (/^-?\d+$/.test(inside)) return { index: Number(inside) }
  const quoted = /^(['"])(.*)\1$/.exec(inside)
  if (quoted) return { key: quoted[2]! }
  const filter = /^\?\((.*)\)$/s.exec(inside)
  if (filter) return { filter: parseFilter(filter[1]!.trim(), source) }
  throw new JsonPathError(`“${source}” has [${inside}], which isn’t an index, a key or a filter`)
}

function parseFilter(expression: string, source: string): Filter {
  if (!expression.startsWith('@')) {
    throw new JsonPathError(`“${source}”: a filter compares a field of each item, like @.type`)
  }
  for (const op of OPERATORS) {
    const at = operatorIndex(expression, op)
    if (at === -1) continue
    const field = expression.slice(1, at).trim()
    return {
      path: field ? parseSteps(field) : [],
      op,
      value: literal(expression.slice(at + op.length).trim(), source),
    }
  }
  const field = expression.slice(1).trim()
  return { path: field ? parseSteps(field) : [] }
}

/** Where `op` appears outside quotes, or -1. */
function operatorIndex(expression: string, op: string): number {
  let quote = ''
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (expression.startsWith(op, i)) {
      return i
    }
  }
  return -1
}

function literal(text: string, source: string): Literal {
  const quoted = /^(['"])(.*)\1$/s.exec(text)
  if (quoted) return quoted[2]!
  if (text === 'true' || text === 'false') return text === 'true'
  if (text === 'null') return null
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text)
  throw new JsonPathError(`“${source}” compares with ${text || 'nothing'}, which isn’t a value`)
}

function evaluate(value: unknown, steps: Step[]): unknown[] {
  let nodes: unknown[] = [value]
  for (const step of steps) {
    const next: unknown[] = []
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      if ('key' in step) {
        if (!Array.isArray(node) && step.key in node) {
          next.push((node as Record<string, unknown>)[step.key])
        }
      } else if ('index' in step) {
        if (Array.isArray(node)) {
          const item = node.at(step.index)
          if (item !== undefined) next.push(item)
        }
      } else if ('all' in step) {
        next.push(...(Array.isArray(node) ? node : Object.values(node)))
      } else if (Array.isArray(node)) {
        next.push(...node.filter((item) => matches(item, step.filter)))
      }
    }
    nodes = next
  }
  return nodes.filter((node) => node !== undefined)
}

function matches(item: unknown, filter: Filter): boolean {
  const [found] = evaluate(item, filter.path)
  if (!filter.op) return found !== undefined && found !== null && found !== false
  return filter.op === '==' ? found === filter.value : found !== filter.value
}
