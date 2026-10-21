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

/**
 * An object's name as Kubernetes allows one for some kind: the loosest it allows (a path
 * segment's rule, as RBAC's names have colons), within the longest any kind takes. Never `.` or
 * `..`, which as a path are a list or what's above it, not one object; nor a slash or a percent
 * sign, which make more than one segment of it; nor a control or invisible character, or a line
 * or paragraph separator, which no name has, which would break a line of the history, or make
 * one name look like another.
 */
const OBJECT_NAME = /^(?!\.\.?$)[^/%\p{C}\p{Zl}\p{Zp}]{1,253}$/u
/**
 * A pod's, a node's or a Service's name, as Kubernetes holds them: a DNS subdomain. Never a
 * backslash, a `?`, a `#` or a space, which an address reads as something else: the WebSocket
 * client puts a pod's name in its path as it is.
 */
const DNS_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/
/** A namespace's name, as Kubernetes allows one: a DNS label. */
const NAMESPACE_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/

/**
 * The name of one object (`what`, as the refusal says it: "a pod’s name"), held to what
 * Kubernetes allows before the cluster is asked anything. Anything else, an empty one too, is
 * refused in Lumovi's words, which never repeat it.
 */
export function assertName(value: unknown, what = 'a name'): asserts value is string {
  if (typeof value !== 'string' || !OBJECT_NAME.test(value)) {
    throw invalid(`That isn’t ${what} Kubernetes allows.`)
  }
}

/** The name of a pod, a node or a Service (`what`, as the refusal says it), as `assertName`. */
export function assertDnsName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !DNS_NAME.test(value)) {
    throw invalid(`That isn’t ${what} Kubernetes allows.`)
  }
}

/** A namespace, held to what Kubernetes allows, as a name is. */
export function assertNamespace(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NAMESPACE_NAME.test(value)) {
    throw invalid('That isn’t a namespace Kubernetes allows.')
  }
}

export function optionalNamespace(value: unknown): void {
  if (value !== undefined) assertNamespace(value)
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
