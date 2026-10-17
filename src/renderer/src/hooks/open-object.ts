import { useContext } from 'react'
import type { ResourceKind } from '@shared/resources'
import { formatRef } from '@renderer/lib/routes'
import { ClusterContext } from '@renderer/state/cluster'
import { OPEN_CLUSTER_PARAM } from '@renderer/features/several/set'
import { useUpdateParams } from './update-params'

export type OpenObject = (kind: ResourceKind, name: string, namespace?: string) => void

/**
 * Opens an object in the detail panel, keeping the rest of the URL (list filters, page…). On a
 * page of several clusters, on the cluster it's on: the panel reads it there alone.
 */
export function useOpenObject(): OpenObject {
  const updateParams = useUpdateParams()
  const cluster = useContext(ClusterContext)
  return (kind, name, namespace) =>
    updateParams((params) => {
      params.set('open', formatRef({ kind, name, namespace }))
      if (cluster?.oneOfSeveral) params.set(OPEN_CLUSTER_PARAM, cluster.context)
    })
}
