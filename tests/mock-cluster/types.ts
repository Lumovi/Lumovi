/** Shapes shared by the mock API server and its fixtures. */

// Fixture objects are free-form Kubernetes JSON; typing every kind would add nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any

export interface OwnerReference {
  apiVersion: string
  kind: string
  name: string
  uid: string
  controller?: boolean
  blockOwnerDeletion?: boolean
}

export interface ObjectMeta {
  name: string
  namespace?: string
  uid?: string
  resourceVersion?: string
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: OwnerReference[]
  [key: string]: unknown
}

export interface KubeObject {
  apiVersion: string
  kind: string
  metadata: ObjectMeta
  spec?: Json
  status?: Json
  [key: string]: unknown
}

/** Live usage: CPU in cores, memory in bytes. The server formats them like metrics-server. */
export interface NodeUsage {
  name: string
  cpu: number
  memory: number
}

export interface ContainerUsage {
  name: string
  cpu: number
  memory: number
}

export interface PodUsage {
  namespace: string
  name: string
  containers: ContainerUsage[]
}

export interface ClusterFixture {
  objects: KubeObject[]
  /** Omit to simulate a cluster without metrics-server. */
  metrics?: { nodes: NodeUsage[]; pods: PodUsage[] }
  /** Log lines (without timestamps) for a container; the server adds timestamps and tailing. */
  logs?: (pod: KubeObject, container: string, previous: boolean) => string[]
}
