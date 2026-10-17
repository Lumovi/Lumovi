import { createContext, useContext } from 'react'

export interface ClusterState {
  /** The kubeconfig context this view is connected to. */
  context: string
  /** The namespaces picked, in the order they were picked, or `null` for all namespaces. */
  namespaces: readonly string[] | null
  /**
   * The one namespace picked, where one is: `null` for all of them, and for several. What has a
   * namespace of its own to start in (a new terminal, an object to create) starts in it.
   */
  namespace: string | null
  /** How many namespaces the link this visit came by named, where that's more than are picked. */
  linkNamed?: number
  /** Picks these namespaces: `null`, or none, for all of them. */
  setNamespaces: (namespaces: readonly string[] | null) => void
  /** Picks one namespace, or `null` for all of them. */
  setNamespace: (namespace: string | null) => void
  /**
   * One of several clusters on the page (a page of several clusters'): what's shown of it, and
   * done on it, names it.
   */
  oneOfSeveral?: boolean
}

export const ClusterContext = createContext<ClusterState | null>(null)

export function useCluster(): ClusterState {
  return useContext(ClusterContext)!
}
