import type { KubeErrorCode, KubestacksApi, Result } from '@shared/api'
import { createWebApi } from '@renderer/web/api'

/**
 * What runs the page: the desktop app (through its preload script), or a
 * KubeStacks server. Either way it's window.kubestacks, as a page's scripts
 * (and the tests) find it.
 */
export const api: KubestacksApi = (window.kubestacks ??= createWebApi())

/** A failed cluster request, with the reason the main process reported. */
export class KubeApiError extends Error {
  readonly code: KubeErrorCode
  readonly status?: number

  constructor(error: { code: KubeErrorCode; message: string; status?: number }) {
    super(error.message)
    this.code = error.code
    this.status = error.status
  }
}

/** Turns a `Result` into a value, or throws a `KubeApiError` for React Query to catch. */
export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new KubeApiError(result.error)
  return result.data
}
