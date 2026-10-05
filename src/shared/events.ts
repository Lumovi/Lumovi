/** Events, as Kubernetes reports them: when they last happened, and how often. */
import type { KubeObject } from './api'

/** When an event last happened; events.k8s.io's give an eventTime instead of a lastTimestamp. */
export function lastSeen(event: KubeObject): string {
  return (event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp) as string
}

/** How many times it happened: once, unless it says otherwise. */
export const eventCount = (event: KubeObject): number => (event.count as number | undefined) ?? 1
