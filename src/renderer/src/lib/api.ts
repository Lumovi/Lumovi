import type { KubeErrorCode, Result } from '@shared/api'

export const api = window.kubestacks

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
