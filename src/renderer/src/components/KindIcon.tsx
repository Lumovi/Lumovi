import { createElement } from 'react'
import {
  Activity,
  Archive,
  Bell,
  Box,
  Boxes,
  Bug,
  CalendarClock,
  Camera,
  Cloud,
  Copy,
  Cpu,
  Database,
  FileCheck,
  FileCode2,
  Flame,
  Gauge,
  GitBranch,
  GitMerge,
  Globe,
  HardDrive,
  Hexagon,
  KeyRound,
  Layers,
  Link,
  Link2,
  LayoutGrid,
  Lock,
  Network,
  Package,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Rocket,
  Route,
  Scaling,
  Server,
  ServerCog,
  Shapes,
  Shield,
  ShieldCheck,
  ShieldPlus,
  Signpost,
  Square,
  SquareStack,
  Timer,
  UserCog,
  Waves,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { apiGroupOf, isCustomGroup, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { viewFor, type ListedPlugin, type ViewIconName } from '@renderer/lib/plugins'

export const KIND_ICONS: Record<BuiltinKind, LucideIcon> = {
  Node: Server,
  Namespace: LayoutGrid,
  Event: Activity,
  Pod: Box,
  Deployment: Layers,
  StatefulSet: Database,
  DaemonSet: Cpu,
  ReplicaSet: Copy,
  Job: Play,
  CronJob: CalendarClock,
  HorizontalPodAutoscaler: Gauge,
  Service: Network,
  Ingress: Globe,
  NetworkPolicy: ShieldCheck,
  ConfigMap: FileCode2,
  Secret: KeyRound,
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: SquareStack,
  StorageClass: Archive,
  Role: Shield,
  ClusterRole: ShieldPlus,
  RoleBinding: Link2,
  ClusterRoleBinding: Link,
  ServiceAccount: UserCog,
}

/** The icons views can choose from. */
export const VIEW_ICONS: Record<ViewIconName, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  bell: Bell,
  box: Box,
  boxes: Boxes,
  bug: Bug,
  camera: Camera,
  cloud: Cloud,
  database: Database,
  'file-check': FileCheck,
  flame: Flame,
  gauge: Gauge,
  'git-branch': GitBranch,
  'git-merge': GitMerge,
  globe: Globe,
  hexagon: Hexagon,
  'key-round': KeyRound,
  layers: Layers,
  lock: Lock,
  network: Network,
  package: Package,
  play: Play,
  puzzle: Puzzle,
  radar: Radar,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  route: Route,
  scaling: Scaling,
  server: Server,
  'server-cog': ServerCog,
  'shield-check': ShieldCheck,
  signpost: Signpost,
  square: Square,
  timer: Timer,
  waves: Waves,
  waypoints: Waypoints,
  workflow: Workflow,
}

/** A kind's icon: its own, its view's, or one for custom resources or Kubernetes' others. */
export function kindIcon(kind: ResourceKind): LucideIcon {
  const builtin = KIND_ICONS[kind as BuiltinKind]
  if (builtin) return builtin
  const icon = viewFor(kind)?.icon
  if (icon) return VIEW_ICONS[icon]
  return isCustomGroup(apiGroupOf(kind)) ? Puzzle : Shapes
}

/** A plugin's icon: its own, or the one for custom resources. */
export function pluginIcon(plugin: Pick<ListedPlugin, 'icon'>): LucideIcon {
  return VIEW_ICONS[plugin.icon ?? 'puzzle']
}

/** A kind's icon, as an element. */
export function KindIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  return createElement(kindIcon(kind), { className, 'aria-hidden': true })
}

/** A plugin's icon, as an element. */
export function PluginIcon({
  plugin,
  className,
}: {
  plugin: Pick<ListedPlugin, 'icon'>
  className?: string
}) {
  return createElement(pluginIcon(plugin), { className, 'aria-hidden': true })
}
