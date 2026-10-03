import type { NavTarget } from '@shared/navigation'
import { builtinResource, type ResourceKind } from '@shared/resources'
import { basename } from '@renderer/web/session'
import { api } from './api'

/** Where the app is now, as its router sees it: the hash on the desktop, the address when served. */
export function currentPath(): string {
  const { hash, pathname, search } = window.location
  return api.host === 'desktop' ? hash.slice(1) || '/' : pathname.slice(basename().length) + search
}

export function clusterPath(context: string): string {
  return `/cluster/${encodeURIComponent(context)}`
}

/** A kind's list: built-in kinds by their plural, others by their name (`r/Certificate.cert-manager.io`). */
export function kindPath(context: string, kind: ResourceKind): string {
  const builtin = builtinResource(kind)
  return builtin
    ? `${clusterPath(context)}/${builtin.plural}`
    : `${clusterPath(context)}/r/${encodeURIComponent(kind)}`
}

/** Every workload, whatever its kind. */
export function workloadsPath(context: string): string {
  return `${clusterPath(context)}/workloads`
}

export function metricsPath(context: string): string {
  return `${clusterPath(context)}/metrics`
}

/** What workloads should request, from their usage history: a tab of Metrics. */
export function rightsizingPath(context: string): string {
  return `${metricsPath(context)}/right-sizing`
}

/** The cluster's Helm releases. */
export function helmPath(context: string): string {
  return `${clusterPath(context)}/helm`
}

/** An add-on's page: its kinds, all together and a tab each. */
export function addOnPath(context: string, name: string): string {
  return `${clusterPath(context)}/add-ons/${encodeURIComponent(name)}`
}

/** Every kind the cluster serves, and the views that show them. */
export function apiResourcesPath(context: string): string {
  return `${clusterPath(context)}/api-resources`
}

const PAGES: Partial<Record<NavTarget, (context: string) => string>> = {
  overview: clusterPath,
  workloads: workloadsPath,
  metrics: metricsPath,
  helm: helmPath,
}

/** The route for a page, or a resource list. */
export function targetPath(context: string, target: NavTarget): string {
  return (PAGES[target] ?? ((c: string) => kindPath(c, target)))(context)
}

export interface ObjectRef {
  kind: ResourceKind
  name: string
  namespace?: string
}

/** Serialises an object reference for the `?open=` search param: `Kind/namespace/name`. */
export function formatRef({ kind, name, namespace = '' }: ObjectRef): string {
  return `${kind}/${namespace}/${name}`
}

export function parseRef(value: string): ObjectRef {
  const [kind, namespace, name] = value.split('/') as [ResourceKind, string, string]
  return { kind, name, namespace: namespace || undefined }
}
