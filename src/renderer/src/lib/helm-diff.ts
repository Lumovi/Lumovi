/**
 * What a Helm rollback changes, as its dialog shows it (LMV-353): the values by key alone, and a
 * manifest with each Secret's data masked as the YAML tab masks it, line for line, so that a
 * diff worked out on the real text can be shown through it.
 */

import { parse, parseDocument, visit } from 'yaml'

/** What a masked value shows. */
export const MASK = '••••••••'

/**
 * A manifest (YAML documents, as Helm keeps them) with every Secret's data and stringData values,
 * and its last-applied annotation, masked: the same lines, each where it was, so that what a diff
 * of the real text says of a line is said of the masked one. It fails closed: each document is
 * read as YAML (JSON too), and a Secret in it anywhere (a List's item, say) has its values masked
 * line by line only where that's seen to have masked every one of them, read back; otherwise, or
 * where a document can't be read, or holds an alias (a value written elsewhere in it, `&x`, and
 * named in a Secret's, `*x`), the whole document is, but for what names it.
 */
export function maskedManifest(manifest: string): string {
  const lines = manifest.split('\n')
  // Each document's lines: from one `---` to the next.
  const starts = [0, ...lines.flatMap((line, i) => (/^---(\s|$)/.test(line) ? [i + 1] : []))]
  starts.forEach((start, d) => {
    const end = d + 1 < starts.length ? starts[d + 1]! - 1 : lines.length
    const own = lines.slice(start, end)
    let read: unknown
    try {
      read = parse(own.join('\n'), { maxAliasCount: 100, uniqueKeys: false })
    } catch {
      lines.splice(start, own.length, ...wholeMasked(own))
      return
    }
    const secrets = secretsIn(read)
    if (secrets.length === 0) return
    // (An alias's value is written where its anchor is, which masking a Secret's lines can't
    // reach, and reading back can't tell from its own.)
    if (aliased(own.join('\n'))) {
      lines.splice(start, own.length, ...wholeMasked(own))
      return
    }
    const masked = lineMasked(own)
    let back: unknown
    try {
      back = parse(masked.join('\n'), { maxAliasCount: 100, uniqueKeys: false })
    } catch {
      back = undefined
    }
    const after = secretsIn(back)
    const whole = after.length === secrets.length && after.every(allMasked)
    lines.splice(start, own.length, ...(whole ? masked : wholeMasked(own)))
  })
  return lines.join('\n')
}

/** Whether a document names anything by an alias (`*x`, a merge's `<<: *x` too). */
function aliased(text: string): boolean {
  let found = false
  visit(parseDocument(text, { uniqueKeys: false }), {
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
  const applied = annotations?.['kubectl.kubernetes.io/last-applied-configuration']
  return applied === undefined || applied === null || applied === '' || isMasked(applied)
}

/**
 * A document masked whole but for what names it: its first line where that's a comment (Helm's
 * `# Source:`), its apiVersion and kind, and its metadata's name and namespace. The same lines.
 */
function wholeMasked(own: string[]): string[] {
  let metadata = false
  let under: number | undefined
  return own.map((line, i) => {
    if (line.trim() === '') return line
    const indent = line.length - line.trimStart().length
    if (i === 0 && line.trimStart().startsWith('#')) return line
    if (indent === 0) {
      metadata = /^["']?metadata["']?\s*:\s*$/.test(line)
      under = undefined
      if (metadata || /^["']?(apiVersion|kind)["']?\s*:\s*["']?[\w./-]+["']?\s*$/.test(line)) {
        return line
      }
      return MASK
    }
    if (metadata) {
      under ??= indent
      if (
        indent === under &&
        /^\s*["']?(name|namespace)["']?\s*:\s*["']?[\w.-]*["']?\s*$/.test(line)
      ) {
        return line
      }
    }
    return `${' '.repeat(indent)}${MASK}`
  })
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
