import type { NavTarget } from '@shared/navigation'
import { builtinResource, resourceByPlural, type ResourceKind } from '@shared/resources'
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

/** What a list at one object names in its address: the name, its namespace, and whose page. */
export const AT_ONE = { name: 'name', namespace: 'ns', plugin: 'plugin' } as const

/**
 * A kind's list, filtered as a list keeps its filters in the address (`?health=critical,warning`,
 * `?labels=karpenter.sh/nodepool`, `?name=storefront&ns=shop&plugin=argo-cd`): what a part of a
 * plugin's page opens, from what the door made.
 */
export function listPath(
  context: string,
  list: {
    kind: ResourceKind
    health?: readonly string[]
    labels?: readonly string[]
    name?: string
    namespace?: string
    /** Whose page opened it: said beside a list at one object. */
    plugin?: string
  },
): string {
  const filters = new URLSearchParams()
  if (list.health) filters.set('health', list.health.join(','))
  if (list.labels) filters.set('labels', list.labels.join(','))
  if (list.name !== undefined) {
    filters.set(AT_ONE.name, list.name)
    if (list.namespace !== undefined) filters.set(AT_ONE.namespace, list.namespace)
    if (list.plugin !== undefined) filters.set(AT_ONE.plugin, list.plugin)
  }
  const query = filters.toString()
  return query ? `${kindPath(context, list.kind)}?${query}` : kindPath(context, list.kind)
}

/** The kind whose list a page of `context` is (`pathname` as the address has it), if it's one. */
export function listedKind(context: string, pathname: string): ResourceKind | undefined {
  const base = `${clusterPath(context)}/`
  if (!pathname.startsWith(base)) return undefined
  const [first, second] = pathname.slice(base.length).split('/')
  if (first === 'r') return second ? (decodeURIComponent(second) as ResourceKind) : undefined
  return resourceByPlural(first!)?.kind
}

/** Every workload, whatever its kind. */
export function workloadsPath(context: string): string {
  return `${clusterPath(context)}/workloads`
}

export function metricsPath(context: string): string {
  return `${clusterPath(context)}/metrics`
}

/** The alerts the cluster's Prometheus holds, firing and pending. */
export function alertsPath(context: string): string {
  return `${clusterPath(context)}/alerts`
}

/** What workloads should request, from their usage history: a tab of Metrics. */
export function rightsizingPath(context: string): string {
  return `${metricsPath(context)}/right-sizing`
}

/** The map of everything in the namespaces picked (LMV-172). */
export function mapPath(context: string): string {
  return `${clusterPath(context)}/map`
}

/** The cluster's Helm releases. */
export function helmPath(context: string): string {
  return `${clusterPath(context)}/helm`
}

/** Every plugin there is: what's in use, what isn't and why, and what each asks for. */
export function pluginsPath(context: string): string {
  return `${clusterPath(context)}/plugins`
}

/** What links to a plugin's row on the page of every plugin name it by, in the address. */
export const ASKED_PLUGIN = 'plugin'

/** The page of every plugin, with this one's row opened: what it asks for. */
export function pluginAsksPath(context: string, name: string): string {
  return `${pluginsPath(context)}?${ASKED_PLUGIN}=${encodeURIComponent(name)}`
}

/** That the plugin's row opens at its switch, focused: where "Open Plugins" goes from its page. */
export const AT_SWITCH = 'switch'

/** The page of every plugin, with this one's row opened and its "Run its code" switch focused. */
export function pluginSwitchPath(context: string, name: string): string {
  return `${pluginAsksPath(context, name)}&${AT_SWITCH}=1`
}

/** Where the Plugins page's Developer mode switch is focused (the desktop app's). */
export const AT_DEVELOPER_MODE = 'developer-mode'

/** The page of every plugin, its Developer mode switch focused. */
export function developerModePath(context: string): string {
  return `${pluginsPath(context)}?${AT_DEVELOPER_MODE}=1`
}

/** A plugin's page: its kinds, all together and a tab each. */
export function pluginPath(context: string, name: string): string {
  return `${clusterPath(context)}/plugins/${encodeURIComponent(name)}`
}

/**
 * One of a plugin's own pages: the only way its address is made. A plugin's own address alone
 * (`pluginPath`) is its first page where it has pages, and its page of its kinds where it hasn't;
 * a page id it doesn't have is Lumovi's "no such page".
 */
export function pluginPagePath(context: string, name: string, page: string): string {
  return `${pluginPath(context, name)}/${encodeURIComponent(page)}`
}

/** One side of a comparison: an object (`formatRef`'s) in a cluster. */
export interface CompareSide {
  context: string
  ref: string
}

/** What the address of a comparison names each side by. (A context's name may hold / or :.) */
export const COMPARED = { left: 'lc', leftRef: 'l', right: 'rc', rightRef: 'r' } as const

/** Two objects compared, on `context`'s page: each by its cluster and its kind, namespace and name. */
export function comparePath(context: string, left: CompareSide, right: CompareSide): string {
  const params = new URLSearchParams({
    [COMPARED.left]: left.context,
    [COMPARED.leftRef]: left.ref,
    [COMPARED.right]: right.context,
    [COMPARED.rightRef]: right.ref,
  })
  return `${clusterPath(context)}/compare?${params}`
}

/** Every kind the cluster serves, and the views that show them. */
export function apiResourcesPath(context: string): string {
  return `${clusterPath(context)}/api-resources`
}

const PAGES: Partial<Record<NavTarget, (context: string) => string>> = {
  overview: clusterPath,
  workloads: workloadsPath,
  map: mapPath,
  metrics: metricsPath,
  alerts: alertsPath,
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
