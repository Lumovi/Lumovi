import { createContext, useContext } from 'react'

export interface ClusterState {
  /** The kubeconfig context this view is connected to. */
  context: string
  /** The selected namespace, or `null` for all namespaces. */
  namespace: string | null
  setNamespace: (namespace: string | null) => void
}

export const ClusterContext = createContext<ClusterState | null>(null)

export function useCluster(): ClusterState {
  return useContext(ClusterContext)!
}
