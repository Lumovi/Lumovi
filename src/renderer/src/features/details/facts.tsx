import type { ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { age, formatDateTime } from '@renderer/lib/format'
import { replicaCounts } from '@renderer/lib/health'
import {
  externalAddress,
  isDefaultStorageClass,
  lastSeen,
  loadBalancerAddress,
} from '../resources/columns'
import { Meter } from '@renderer/components/Meter'
import { ObjectLink } from './ObjectLink'
import { Labels } from './sections'

export interface Fact {
  label: string
  value: ReactNode
}

/** A labelled value; missing values are dropped rather than shown as blanks. */
function fact(label: string, value: ReactNode): Fact | null {
  return value === undefined || value === null || value === '' ? null : { label, value }
}

const labels = (selector?: Record<string, string>) =>
  Object.entries(selector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

/** A label selector as chips, like the Labels section. */
const selector = (matchLabels?: Record<string, string>) =>
  matchLabels && Object.keys(matchLabels).length > 0 ? <Labels labels={matchLabels} /> : undefined

const when = (timestamp?: string) =>
  timestamp && `${formatDateTime(timestamp)} (${age(timestamp)} ago)`

const join = (values?: string[]) => values?.join(', ')

/** Ready vs desired replicas as a small bar, e.g. "1 of 3 ready". */
function replicas(o: KubeObject): ReactNode {
  const { ready, desired } = replicaCounts(o)
  return (
    <span className="flex items-center gap-3">
      <Meter value={desired ? ready / desired : 1} label="Ready replicas" className="w-24" />
      <span className="tabular-nums">
        {ready} of {desired} ready
      </span>
    </span>
  )
}

function hpaMetrics(hpa: KubeObject): string {
  type Metric = {
    resource?: {
      name: string
      target?: { averageUtilization?: number }
      current?: { averageUtilization?: number }
    }
  }
  const current: Metric[] = hpa.status.currentMetrics ?? []
  return (hpa.spec.metrics as Metric[])
    .map((metric, i) => {
      const name = metric.resource!.name
      return `${name} ${current[i]?.resource?.current?.averageUtilization ?? '?'}% / ${metric.resource!.target!.averageUtilization}%`
    })
    .join(', ')
}

const FACTS: Record<ResourceKind, (o: KubeObject) => (Fact | null)[]> = {
  Pod: (o) => [
    fact('Node', o.spec.nodeName && <ObjectLink kind="Node" name={o.spec.nodeName} />),
    fact('Pod IP', o.status.podIP),
    fact('Host IP', o.status.hostIP),
    fact('QoS class', o.status.qosClass),
    fact('Service account', o.spec.serviceAccountName),
    fact('Restart policy', o.spec.restartPolicy),
  ],
  Node: (o) => [
    fact(
      'Internal IP',
      o.status.addresses?.find((a: { type: string }) => a.type === 'InternalIP')?.address,
    ),
    fact('OS image', o.status.nodeInfo.osImage),
    fact('Kernel', o.status.nodeInfo.kernelVersion),
    fact('Container runtime', o.status.nodeInfo.containerRuntimeVersion),
    fact('Kubelet', o.status.nodeInfo.kubeletVersion),
    fact('Architecture', o.status.nodeInfo.architecture),
    fact('Pod CIDR', o.spec.podCIDR),
    fact('Schedulable', o.spec.unschedulable ? 'No (cordoned)' : 'Yes'),
  ],
  Namespace: (o) => [fact('Phase', o.status.phase)],
  Event: (o) => [
    fact('Type', o.type as string),
    fact('Reason', o.reason as string),
    fact(
      'Object',
      <ObjectLink
        kind={(o.involvedObject as { kind: ResourceKind }).kind}
        name={(o.involvedObject as { name: string }).name}
        namespace={(o.involvedObject as { namespace?: string }).namespace}
      />,
    ),
    fact('Message', o.message as string),
    fact('Source', (o.source as { component?: string } | undefined)?.component),
    fact('Count', o.count as number | undefined),
    fact('Last seen', when(lastSeen(o))),
  ],
  Deployment: (o) => [
    fact('Replicas', replicas(o)),
    fact('Updated', o.status.updatedReplicas),
    fact('Available', o.status.availableReplicas),
    fact('Strategy', o.spec.strategy?.type),
    fact('Selector', selector(o.spec.selector.matchLabels)),
  ],
  StatefulSet: (o) => [
    fact('Replicas', replicas(o)),
    fact('Service', o.spec.serviceName),
    fact('Update strategy', o.spec.updateStrategy?.type),
    fact('Selector', selector(o.spec.selector.matchLabels)),
  ],
  DaemonSet: (o) => [
    fact('Scheduled', replicas(o)),
    fact('Update strategy', o.spec.updateStrategy?.type),
    fact('Selector', selector(o.spec.selector.matchLabels)),
  ],
  ReplicaSet: (o) => [
    fact('Replicas', replicas(o)),
    fact('Selector', selector(o.spec.selector.matchLabels)),
  ],
  Job: (o) => [
    fact('Completions', `${o.status.succeeded ?? 0} / ${o.spec.completions}`),
    fact('Parallelism', o.spec.parallelism),
    fact('Backoff limit', o.spec.backoffLimit),
    fact('Started', when(o.status.startTime)),
    fact('Completed', when(o.status.completionTime)),
  ],
  CronJob: (o) => [
    fact('Schedule', o.spec.schedule),
    fact('Suspended', o.spec.suspend ? 'Yes' : 'No'),
    fact('Concurrency', o.spec.concurrencyPolicy),
    fact('Last scheduled', when(o.status.lastScheduleTime)),
    fact('Last successful', when(o.status.lastSuccessfulTime)),
  ],
  HorizontalPodAutoscaler: (o) => [
    fact(
      'Target',
      <ObjectLink
        kind={o.spec.scaleTargetRef.kind}
        name={o.spec.scaleTargetRef.name}
        namespace={o.metadata.namespace}
      />,
    ),
    fact('Replicas', `${o.status.currentReplicas} current · ${o.status.desiredReplicas} desired`),
    fact('Range', `${o.spec.minReplicas}–${o.spec.maxReplicas}`),
    fact('Metrics', hpaMetrics(o)),
  ],
  Service: (o) => [
    fact('Type', o.spec.type),
    fact('Cluster IP', o.spec.clusterIP),
    fact('External', externalAddress(o)),
    fact('Session affinity', o.spec.sessionAffinity),
    fact('Selector', selector(o.spec.selector)),
  ],
  Ingress: (o) => [
    fact('Class', o.spec.ingressClassName),
    fact('Address', loadBalancerAddress(o)),
    fact('TLS hosts', join(o.spec.tls?.flatMap((t: { hosts: string[] }) => t.hosts))),
  ],
  NetworkPolicy: (o) => [
    fact('Pod selector', labels(o.spec.podSelector.matchLabels) || 'All pods in namespace'),
    fact('Policy types', join(o.spec.policyTypes)),
    fact('Ingress rules', o.spec.ingress?.length),
    fact('Egress rules', o.spec.egress?.length),
  ],
  ConfigMap: () => [],
  Secret: (o) => [fact('Type', o.type as string)],
  PersistentVolumeClaim: (o) => [
    fact('Capacity', o.status.capacity?.storage),
    fact('Requested', o.spec.resources.requests.storage),
    fact('Access modes', join(o.spec.accessModes)),
    fact(
      'Storage class',
      o.spec.storageClassName && <ObjectLink kind="StorageClass" name={o.spec.storageClassName} />,
    ),
    fact(
      'Volume',
      o.spec.volumeName && <ObjectLink kind="PersistentVolume" name={o.spec.volumeName} />,
    ),
    fact('Volume mode', o.spec.volumeMode),
  ],
  PersistentVolume: (o) => [
    fact('Capacity', o.spec.capacity.storage),
    fact('Access modes', join(o.spec.accessModes)),
    fact('Reclaim policy', o.spec.persistentVolumeReclaimPolicy),
    fact(
      'Storage class',
      o.spec.storageClassName && <ObjectLink kind="StorageClass" name={o.spec.storageClassName} />,
    ),
    fact(
      'Claim',
      o.spec.claimRef && (
        <ObjectLink
          kind="PersistentVolumeClaim"
          name={o.spec.claimRef.name}
          namespace={o.spec.claimRef.namespace}
        />
      ),
    ),
  ],
  StorageClass: (o) => [
    fact('Default', isDefaultStorageClass(o) ? 'Yes' : 'No'),
    fact('Provisioner', o.provisioner as string),
    fact('Reclaim policy', o.reclaimPolicy as string),
    fact('Binding mode', o.volumeBindingMode as string),
    fact('Volume expansion', o.allowVolumeExpansion ? 'Allowed' : 'Not allowed'),
    fact('Parameters', labels(o.parameters as Record<string, string> | undefined)),
  ],
}

/** Namespace, age and owner, then the facts specific to the object's kind. */
export function factsFor(object: KubeObject): Fact[] {
  const owner = object.metadata.ownerReferences?.find((ref) => ref.controller)
  const common = [
    fact('Created', when(object.metadata.creationTimestamp)),
    fact(
      'Controlled by',
      owner && (
        <ObjectLink
          kind={owner.kind as ResourceKind}
          name={owner.name}
          namespace={object.metadata.namespace}
        />
      ),
    ),
  ]
  return [...common, ...FACTS[object.kind as ResourceKind](object)].filter(
    (f): f is Fact => f !== null,
  )
}
