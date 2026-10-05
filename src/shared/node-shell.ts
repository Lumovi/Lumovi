/** What makes a node shell setting: a namespace's name, and an image. */
import type { NodeShellSetting } from './api'

/** A namespace's name: a DNS label. */
export const NAMESPACE_NAME = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
/** An image reference, as a pod's spec takes it: anything without spaces. */
export const IMAGE_REFERENCE = /^\S{1,255}$/

/** A stored or requested node shell setting: a namespace's name, and an image. */
export function isNodeShellSetting(value: unknown): value is NodeShellSetting {
  const { namespace, image } = Object(value) as Record<string, unknown>
  return (
    typeof namespace === 'string' &&
    typeof image === 'string' &&
    NAMESPACE_NAME.test(namespace) &&
    IMAGE_REFERENCE.test(image)
  )
}
