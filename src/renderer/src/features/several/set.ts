/**
 * Several clusters in one list: the set (in the page's address), which page of it, and which
 * cluster each listed object came from. An object is told apart by its cluster as well as its
 * namespace and name: two clusters' objects of one name are two rows.
 */
import type { KubeObject } from '@shared/api'
import { objectKey } from '@renderer/hooks/queries'

/** The pages of several clusters: the kinds they merge. */
export const SEVERAL_PAGES = {
  workloads: { title: 'Workloads', noun: 'workloads' },
  pods: { title: 'Pods', noun: 'pods', kind: 'Pod' },
  nodes: { title: 'Nodes', noun: 'nodes', kind: 'Node' },
  events: { title: 'Events', noun: 'events', kind: 'Event' },
} as const

export type SeveralPage = keyof typeof SEVERAL_PAGES

export const isSeveralPage = (page: string | undefined): page is SeveralPage =>
  page !== undefined && Object.hasOwn(SEVERAL_PAGES, page)

/** What the address names each cluster of the set by: `?c=…`, once each. */
export const SET_PARAM = 'c'
/** The cluster of the object open in the panel, beside `open`. */
export const OPEN_CLUSTER_PARAM = 'oc'
/** The cluster a list narrows to, its chip pressed. */
export const ONLY_PARAM = 'only'

/** The set the address names, each once, in its order. */
export function setOf(params: URLSearchParams): string[] {
  return [...new Set(params.getAll(SET_PARAM).filter(Boolean))]
}

/**
 * Those of a set that sign in when opened, opened by the press that opened the set: the page
 * reads them at once, and takes them out of its address (a set opened again, or remembered,
 * opens none of them by itself).
 */
export const OPENED_PARAM = 'o'

/**
 * A page of several clusters: `page`, over `contexts`; `opening`, those of them that sign in
 * and that the press opening it opens.
 */
export function severalPath(
  page: SeveralPage,
  contexts: readonly string[],
  opening: readonly string[] = [],
): string {
  const params = new URLSearchParams()
  for (const context of contexts) params.append(SET_PARAM, context)
  for (const context of opening) params.append(OPENED_PARAM, context)
  return `/clusters/${page}?${params}`
}

/** Which cluster each object listed here came from: set as each cluster's list arrives. */
const clusters = new WeakMap<KubeObject, string>()

/** The objects a cluster listed, each marked as its. */
export function fromCluster<T extends KubeObject>(context: string, objects: readonly T[]): T[] {
  for (const object of objects) clusters.set(object, context)
  return [...objects]
}

/** The cluster an object listed here came from. */
export const clusterOf = (object: KubeObject): string => clusters.get(object) ?? ''

/** An object's row: by its cluster, its kind, its namespace and its name. */
export const severalKey = (object: KubeObject): string =>
  `${clusterOf(object)}\u0000${object.kind ?? ''}\u0000${objectKey(object)}`
