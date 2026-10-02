import {
  ArrowUpDown,
  Ban,
  Bug,
  Cable,
  Box,
  CirclePause,
  CirclePlay,
  FileCode2,
  HardDrive,
  History,
  LogOut,
  PackageMinus,
  Play,
  RotateCw,
  SlidersHorizontal,
  SquareTerminal,
  Tags,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { AccessCheck, KubeObject } from '@shared/api'
import { isBuiltinKind, kindFor, type ResourceKind } from '@shared/resources'
import type { ChangeMeta, ClusterChange } from '@renderer/hooks/change'
import { resourceFor } from '@renderer/hooks/resources'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { holds, viewFor } from '@renderer/lib/views'
import { api } from '@renderer/lib/api'
import { kindOf, target, type ActionProps } from './common'
import { EvictDialog, RestartDialog, RestartPodDialog, RunNowDialog } from './ConfirmDialogs'
import { DeleteDialog } from './DeleteDialog'
import { DrainDialog } from './DrainDialog'
import { LabelsDialog } from './LabelsDialog'
import { AutoscalerDialog, ExpandVolumeDialog } from './LimitDialogs'
import { RollbackDialog } from './RollbackDialog'
import { ScaleDialog } from './ScaleDialog'
import { SetImageDialog } from './SetImageDialog'
import { DebugDialog, PortForwardDialog } from './StreamDialogs'
import { viewActionIcon, ViewActionDialog, viewChange } from './view-actions'

/** A change that runs at once, with its undo, instead of opening a dialog. */
export interface InstantChange {
  change: ClusterChange
  meta: ChangeMeta
}

export interface Action {
  id: string
  label: string
  icon: LucideIcon
  /** The kinds it's for, or a test for kinds that aren't built in. */
  kinds: readonly ResourceKind[] | ((kind: ResourceKind) => boolean)
  /** Hidden when false, e.g. "Uncordon" on a node that isn't cordoned. */
  when?: (object: KubeObject) => boolean
  /** What the user must be allowed to do, checked with a SelfSubjectAccessReview. */
  access: (object: KubeObject) => AccessCheck
  /** Shown as a button in the detail panel, not only in the menu. */
  primary?: boolean
  danger?: boolean
  dialog?: ComponentType<ActionProps>
  instant?: (object: KubeObject, context: string) => InstantChange
  /** Opens the object in the detail panel's YAML editor instead of a dialog. */
  editor?: boolean
  /** Opens this tab of the detail panel instead of a dialog. */
  tab?: string
  /** Doesn't change the cluster (port forwarding), so it works on read-only clusters too. */
  safe?: boolean
}

const WORKLOADS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const
/** Every kind but events, which aren't edited or deleted by hand. */
const EVERYTHING = (kind: ResourceKind) => kind !== 'Event'

const can =
  (verb: AccessCheck['verb'], subresource?: string, kind?: ResourceKind) =>
  (object: KubeObject): AccessCheck => ({
    verb,
    kind: kind ?? kindOf(object),
    namespace: object.metadata.namespace,
    name: kind ? undefined : object.metadata.name,
    subresource,
  })

const running = (pod: KubeObject) =>
  pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp

const controlled = (object: KubeObject) =>
  (object.metadata.ownerReferences ?? []).some((ref) => ref.controller)

/** A merge patch of `spec` that `undo` takes back. */
function toggle(
  object: KubeObject,
  context: string,
  on: Record<string, unknown>,
  off: Record<string, unknown>,
  titles: { done: string; undone: string },
  verb: (patch: Record<string, unknown>) => string[],
): InstantChange {
  const patchOf = (spec: Record<string, unknown>) => ({
    ...target(object),
    change: { action: 'patch' as const, patchType: 'merge' as const, patch: { spec } },
  })
  const command = (spec: Record<string, unknown>) =>
    kubectl(context, object.metadata.namespace, ...verb(spec))
  return {
    change: patchOf(on),
    meta: {
      title: titles.done,
      command: command(on),
      undo: { change: patchOf(off), meta: { title: titles.undone, command: command(off) } },
    },
  }
}

const patchArgs = (object: KubeObject) => (spec: Record<string, unknown>) => [
  'patch',
  objectArg(kindOf(object), object.metadata.name),
  '--type=merge',
  '-p',
  JSON.stringify({ spec }),
]

export const ACTIONS: readonly Action[] = [
  {
    id: 'scale',
    label: 'Scale',
    icon: ArrowUpDown,
    kinds: ['Deployment', 'StatefulSet', 'ReplicaSet'],
    access: can('patch'),
    primary: true,
    dialog: ScaleDialog,
  },
  {
    // Custom workloads (Argo Rollouts, say) that serve the scale subresource, like kubectl scale.
    id: 'scale-custom',
    label: 'Scale',
    icon: ArrowUpDown,
    kinds: (kind) =>
      !isBuiltinKind(kind) && Boolean(resourceFor(kind)?.subresources?.includes('scale')),
    access: can('patch', 'scale'),
    primary: true,
    dialog: ScaleDialog,
  },
  {
    id: 'restart',
    label: 'Restart',
    icon: RotateCw,
    kinds: WORKLOADS,
    access: can('patch'),
    primary: true,
    dialog: RestartDialog,
  },
  {
    id: 'shell',
    label: 'Shell',
    icon: SquareTerminal,
    kinds: ['Pod'],
    when: running,
    access: can('create', 'exec'),
    primary: true,
    tab: 'shell',
  },
  {
    id: 'restart-pod',
    label: 'Restart',
    icon: RotateCw,
    kinds: ['Pod'],
    when: (pod) => controlled(pod) && !pod.metadata.deletionTimestamp,
    access: can('delete'),
    primary: true,
    dialog: RestartPodDialog,
  },
  {
    id: 'run-now',
    label: 'Run now',
    icon: Play,
    kinds: ['CronJob'],
    access: can('create', undefined, 'Job'),
    primary: true,
    dialog: RunNowDialog,
  },
  {
    id: 'cordon',
    label: 'Cordon',
    icon: Ban,
    kinds: ['Node'],
    when: (node) => !node.spec.unschedulable,
    access: can('patch'),
    primary: true,
    instant: (node, context) =>
      toggle(
        node,
        context,
        { unschedulable: true },
        { unschedulable: null },
        { done: `Cordoned ${node.metadata.name}`, undone: `Uncordoned ${node.metadata.name}` },
        (spec) => [spec.unschedulable ? 'cordon' : 'uncordon', node.metadata.name],
      ),
  },
  {
    id: 'uncordon',
    label: 'Uncordon',
    icon: CirclePlay,
    kinds: ['Node'],
    when: (node) => Boolean(node.spec.unschedulable),
    access: can('patch'),
    primary: true,
    instant: (node, context) =>
      toggle(
        node,
        context,
        { unschedulable: null },
        { unschedulable: true },
        { done: `Uncordoned ${node.metadata.name}`, undone: `Cordoned ${node.metadata.name}` },
        (spec) => [spec.unschedulable ? 'cordon' : 'uncordon', node.metadata.name],
      ),
  },
  {
    id: 'drain',
    label: 'Drain…',
    icon: PackageMinus,
    kinds: ['Node'],
    access: can('patch'),
    dialog: DrainDialog,
  },
  {
    id: 'edit-range',
    label: 'Edit replica range',
    icon: SlidersHorizontal,
    kinds: ['HorizontalPodAutoscaler'],
    access: can('patch'),
    primary: true,
    dialog: AutoscalerDialog,
  },
  {
    id: 'set-image',
    label: 'Change image…',
    icon: Box,
    kinds: [...WORKLOADS, 'CronJob'],
    access: can('patch'),
    dialog: SetImageDialog,
  },
  {
    id: 'rollback',
    label: 'Roll back…',
    icon: History,
    kinds: WORKLOADS,
    access: can('patch'),
    dialog: RollbackDialog,
  },
  {
    id: 'pause',
    label: 'Pause rollout',
    icon: CirclePause,
    kinds: ['Deployment'],
    when: (d) => !d.spec.paused,
    access: can('patch'),
    instant: (d, context) =>
      toggle(
        d,
        context,
        { paused: true },
        { paused: null },
        {
          done: `Paused the rollout of ${d.metadata.name}`,
          undone: `Resumed the rollout of ${d.metadata.name}`,
        },
        (spec) => [
          'rollout',
          spec.paused ? 'pause' : 'resume',
          objectArg('Deployment', d.metadata.name),
        ],
      ),
  },
  {
    id: 'resume',
    label: 'Resume rollout',
    icon: CirclePlay,
    kinds: ['Deployment'],
    when: (d) => Boolean(d.spec.paused),
    access: can('patch'),
    primary: true,
    instant: (d, context) =>
      toggle(
        d,
        context,
        { paused: null },
        { paused: true },
        {
          done: `Resumed the rollout of ${d.metadata.name}`,
          undone: `Paused the rollout of ${d.metadata.name}`,
        },
        (spec) => [
          'rollout',
          spec.paused ? 'pause' : 'resume',
          objectArg('Deployment', d.metadata.name),
        ],
      ),
  },
  {
    id: 'suspend',
    label: 'Suspend',
    icon: CirclePause,
    kinds: ['CronJob', 'Job'],
    when: (o) => !o.spec.suspend && !(o.kind === 'Job' && o.status?.completionTime),
    access: can('patch'),
    instant: (o, context) =>
      toggle(
        o,
        context,
        { suspend: true },
        { suspend: false },
        { done: `Suspended ${o.metadata.name}`, undone: `Resumed ${o.metadata.name}` },
        patchArgs(o),
      ),
  },
  {
    id: 'resume-schedule',
    label: 'Resume',
    icon: CirclePlay,
    kinds: ['CronJob', 'Job'],
    when: (o) => Boolean(o.spec.suspend),
    access: can('patch'),
    primary: true,
    instant: (o, context) =>
      toggle(
        o,
        context,
        { suspend: false },
        { suspend: true },
        { done: `Resumed ${o.metadata.name}`, undone: `Suspended ${o.metadata.name}` },
        patchArgs(o),
      ),
  },
  {
    id: 'debug',
    label: 'Debug…',
    icon: Bug,
    kinds: ['Pod'],
    when: running,
    access: can('patch', 'ephemeralcontainers'),
    dialog: DebugDialog,
  },
  // To a port on this computer: only the desktop app has one.
  ...(api.forwards
    ? [
        {
          id: 'forward',
          label: 'Forward a port…',
          icon: Cable,
          kinds: ['Pod', 'Service'],
          when: (o: KubeObject) => (o.kind === 'Pod' ? running(o) : Boolean(o.spec.selector)),
          access: can('create', 'portforward', 'Pod'),
          safe: true,
          dialog: PortForwardDialog,
        } satisfies Action,
      ]
    : []),
  {
    id: 'evict',
    label: 'Evict…',
    icon: LogOut,
    kinds: ['Pod'],
    when: (pod) => !pod.metadata.deletionTimestamp,
    access: can('create', 'eviction'),
    dialog: EvictDialog,
  },
  {
    id: 'expand',
    label: 'Expand volume…',
    icon: HardDrive,
    kinds: ['PersistentVolumeClaim'],
    when: (claim) => claim.status?.phase === 'Bound',
    access: can('patch'),
    dialog: ExpandVolumeDialog,
  },
  {
    id: 'labels',
    label: 'Edit labels…',
    icon: Tags,
    kinds: EVERYTHING,
    access: can('patch'),
    dialog: LabelsDialog,
  },
  {
    id: 'edit-yaml',
    label: 'Edit YAML',
    icon: FileCode2,
    kinds: EVERYTHING,
    access: can('update'),
    editor: true,
  },
  {
    id: 'delete',
    label: 'Delete…',
    icon: Trash2,
    kinds: EVERYTHING,
    access: can('delete'),
    danger: true,
    dialog: DeleteDialog,
  },
]

/**
 * A view's actions, as actions: they patch what the view says, or create what
 * it says, asking first if it says to, has questions, or creates something.
 */
function viewActions(kind: ResourceKind): Action[] {
  return (viewFor(kind)?.actions ?? []).map((action, i) => {
    const asks = Boolean(action.confirm || action.inputs || action.create)
    return {
      id: `view:${i}`,
      label: asks ? `${action.name}…` : action.name,
      icon: viewActionIcon(action),
      kinds: [kind],
      when: action.when && ((object: KubeObject) => holds(action.when!, object)),
      access: action.create
        ? can(
            'create',
            undefined,
            kindFor(action.create.apiVersion as string, action.create.kind as string),
          )
        : can('patch', action.subresource),
      primary: action.primary,
      danger: action.danger,
      ...(asks
        ? { dialog: ViewActionDialog }
        : {
            instant: (object: KubeObject, context: string) => viewChange(action, object, context),
          }),
    }
  })
}

const appliesTo = (action: Action, kind: ResourceKind) =>
  typeof action.kinds === 'function' ? action.kinds(kind) : action.kinds.includes(kind)

/** The actions that apply to `object`, in menu order: its view's first. */
export function actionsFor(object: KubeObject): Action[] {
  const kind = kindOf(object)
  return [...viewActions(kind), ...ACTIONS].filter(
    (action) => appliesTo(action, kind) && (action.when?.(object) ?? true),
  )
}

/** The action with `id` for `object`, whose dialog is open. */
export function actionById(id: string, object: KubeObject): Action {
  return [...viewActions(kindOf(object)), ...ACTIONS].find((action) => action.id === id)!
}
