import { isResourceKind, type ResourceKind } from '@shared/resources'
import { KubeRequestError } from './errors'

// Everything that crosses IPC is untrusted input, so it is checked before use.

export const invalid = (message: string) => new KubeRequestError('invalid', message)

export function assertQuery<T>(value: unknown): T {
  if (typeof value !== 'object' || value === null) throw invalid('Expected a query object')
  return value as T
}

export function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '')
    throw invalid(`${field} must be a non-empty string`)
}

export function optionalString(value: unknown, field: string): void {
  if (value !== undefined) assertString(value, field)
}

export function assertKind(value: unknown): asserts value is ResourceKind {
  if (!isResourceKind(value)) throw invalid(`Unknown resource kind "${String(value)}"`)
}

export function assertIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`)
  }
}

export function assertObject(value: unknown, field: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object`)
  }
}

export function assertOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw invalid(`${field} must be one of ${allowed.join(', ')}`)
  }
}
