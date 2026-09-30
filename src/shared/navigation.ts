/**
 * Navigation shortcuts shared by the renderer's hotkeys and the native menu,
 * so the two always agree.
 */
import type { ResourceKind } from './resources'

export type NavTarget = 'overview' | ResourceKind

/** Press g, then a letter, to jump to a view. */
export const GO_KEYS: { key: string; target: NavTarget }[] = [
  { key: 'o', target: 'overview' },
  { key: 'n', target: 'Node' },
  { key: 'm', target: 'Namespace' },
  { key: 'e', target: 'Event' },
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
]

/** ⌘/Ctrl + 1…6, also listed in the Go menu. */
export const QUICK_NAV: NavTarget[] = ['overview', 'Pod', 'Deployment', 'Service', 'Node', 'Event']

export type AppCommand =
  | 'palette'
  | 'filter'
  | 'shortcuts'
  | 'refresh'
  | 'back'
  | 'forward'
  | 'clusters'
  | `go:${NavTarget}`
