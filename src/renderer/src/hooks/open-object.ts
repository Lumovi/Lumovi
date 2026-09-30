import type { ResourceKind } from '@shared/resources'
import { formatRef } from '@renderer/lib/routes'
import { useUpdateParams } from './update-params'

export type OpenObject = (kind: ResourceKind, name: string, namespace?: string) => void

/** Opens an object in the detail panel, keeping the rest of the URL (list filters, page…). */
export function useOpenObject(): OpenObject {
  const updateParams = useUpdateParams()
  return (kind, name, namespace) =>
    updateParams((params) => params.set('open', formatRef({ kind, name, namespace })))
}
