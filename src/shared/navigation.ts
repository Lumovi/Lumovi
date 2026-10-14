/**
 * Navigation shortcuts shared by the renderer's hotkeys and the native menu,
 * so the two always agree.
 */
import { resourceByKind, type BuiltinKind } from './resources'

export type NavTarget = 'overview' | 'workloads' | 'metrics' | 'alerts' | 'helm' | BuiltinKind

const PAGE_LABELS: Record<string, string> = {
  overview: 'Overview',
  workloads: 'Workloads',
  metrics: 'Metrics',
  alerts: 'Alerts',
  helm: 'Helm releases',
}

/** What a view is called in menus and the shortcut sheet. */
export function navLabel(target: NavTarget): string {
  return PAGE_LABELS[target] ?? resourceByKind(target as BuiltinKind).label
}

/** Press g, then a letter, to jump to a page. */
export const GO_KEYS: { key: string; target: NavTarget }[] = [
  { key: 'o', target: 'overview' },
  { key: 'w', target: 'workloads' },
  { key: 'u', target: 'metrics' },
  { key: 'h', target: 'helm' },
  { key: 'n', target: 'Node' },
  { key: 'm', target: 'Namespace' },
  { key: 'e', target: 'Event' },
  // (z: the last free letter that reads as alerts.)
  { key: 'z', target: 'alerts' },
  { key: 'p', target: 'Pod' },
  { key: 'd', target: 'Deployment' },
  { key: 's', target: 'StatefulSet' },
  { key: 'a', target: 'DaemonSet' },
  { key: 'j', target: 'Job' },
  { key: 'c', target: 'CronJob' },
  { key: 'v', target: 'Service' },
  { key: 'i', target: 'Ingress' },
  { key: 'f', target: 'ConfigMap' },
  { key: 'x', target: 'Secret' },
  { key: 'l', target: 'PersistentVolumeClaim' },
  { key: 'r', target: 'Role' },
  { key: 'k', target: 'ClusterRole' },
  { key: 'b', target: 'RoleBinding' },
  { key: 'g', target: 'ClusterRoleBinding' },
  { key: 't', target: 'ServiceAccount' },
]

/** ⌘/Ctrl + 1…6, also listed in the Go menu. */
export const QUICK_NAV: NavTarget[] = ['overview', 'workloads', 'Pod', 'Service', 'Node', 'Event']

export type AppCommand =
  | 'palette'
  | 'filter'
  | 'shortcuts'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'clusters'
  | 'create'
  | 'terminal'
  | 'new-terminal'
  | 'close-terminal'
  | 'clear-terminal'
  | 'assistants'
  | `go:${NavTarget}`
  /** A place in Lumovi, by its path: where a notification was about. */
  | `open:${string}`
