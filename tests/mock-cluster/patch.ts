/**
 * The three patch formats the API server accepts, implemented as far as the
 * app and the tests need them.
 */
import type { Json } from './types.ts'

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Keys a patch may not set: they'd reach the prototype rather than the object. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

/** RFC 7386 JSON merge patch: objects merge, `null` removes, everything else replaces. */
export function mergePatch(target: Json, patch: Json): Json {
  if (!isObject(patch)) return structuredClone(patch)
  const result: Record<string, Json> = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE.has(key)) continue
    if (value === null) delete result[key]
    else result[key] = mergePatch(result[key], value)
  }
  return result
}

/**
 * Strategic merge patch, simplified: like a merge patch, except that lists of
 * named objects (containers, ports, env…) merge item by item on `name`.
 */
export function strategicMergePatch(target: Json, patch: Json): Json {
  if (
    Array.isArray(patch) &&
    Array.isArray(target) &&
    patch.every((item) => isObject(item) && 'name' in item)
  ) {
    const result = structuredClone(target) as Json[]
    for (const item of patch as Record<string, Json>[]) {
      const index = result.findIndex(
        (existing) => isObject(existing) && existing.name === item.name,
      )
      if (index === -1) result.push(structuredClone(item))
      else result[index] = strategicMergePatch(result[index], item)
    }
    return result
  }
  if (!isObject(patch)) return structuredClone(patch)
  const result: Record<string, Json> = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE.has(key)) continue
    if (value === null) delete result[key]
    else result[key] = strategicMergePatch(result[key], value)
  }
  return result
}

class PatchError extends Error {}
export { PatchError }

function pointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new PatchError(`invalid JSON pointer "${path}"`)
  return path
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** RFC 6902 JSON patch: `add`, `replace`, `remove` and `test`. */
export function jsonPatch(target: Json, operations: Json[]): Json {
  let document = structuredClone(target)
  for (const operation of operations) {
    const parts = pointer(operation.path)
    if (parts.length === 0) {
      if (operation.op === 'test') continue
      document = structuredClone(operation.value)
      continue
    }
    const key = parts.at(-1)!
    let parent: Json = document
    for (const part of parts.slice(0, -1)) {
      parent = Array.isArray(parent) ? parent[Number(part)] : parent?.[part]
      if (parent === undefined || parent === null) {
        throw new PatchError(`doc is missing path: "${operation.path}"`)
      }
    }
    switch (operation.op) {
      case 'add':
        if (Array.isArray(parent)) {
          parent.splice(
            key === '-' ? parent.length : Number(key),
            0,
            structuredClone(operation.value),
          )
        } else parent[key] = structuredClone(operation.value)
        break
      case 'replace':
        if (!(key in parent)) throw new PatchError(`doc is missing key: "${operation.path}"`)
        parent[key] = structuredClone(operation.value)
        break
      case 'remove':
        if (!(key in parent)) throw new PatchError(`doc is missing key: "${operation.path}"`)
        if (Array.isArray(parent)) parent.splice(Number(key), 1)
        else delete parent[key]
        break
      case 'test':
        if (JSON.stringify(parent[key]) !== JSON.stringify(operation.value)) {
          throw new PatchError(`testing value ${operation.path} failed`)
        }
        break
      default:
        throw new PatchError(`unexpected kind of operation "${operation.op}"`)
    }
  }
  return document
}
