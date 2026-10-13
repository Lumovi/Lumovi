/**
 * CloudNativePG's databases as its plugin's own sample has them (Lumovi-plugins 1.2.0's
 * src/cloudnative-pg/sample.json, its objects copied beside this file), their times moved to now:
 * four clusters (failed, switching over, two healthy) with their instances, backups, schedules
 * and poolers. Its Overview is a split, a pick list beside the picked one's page: in the long
 * cluster, so every page's long-text walk meets one, and for tests that ask for it.
 */
import { readFileSync } from 'node:fs'
import { clusterBuilder, DAY, uidFor } from '../builders.ts'
import type { ClusterFixture, Json, KubeObject } from '../types.ts'
import { crd } from './custom.ts'
import { demoCluster } from './demo.ts'

type Builder = ReturnType<typeof clusterBuilder>

const SAMPLE = JSON.parse(
  readFileSync(new URL('./cloudnative-pg.sample.json', import.meta.url), 'utf8'),
) as { now: string; objects: Record<string, KubeObject[]> }

const KINDS = [
  ['Cluster', 'clusters'],
  ['Backup', 'backups'],
  ['ScheduledBackup', 'scheduledbackups'],
  ['Pooler', 'poolers'],
  ['Database', 'databases'],
] as const

/** Adds CloudNativePG's kinds, and the sample's objects and namespaces, to `b`. */
export function cloudNativePg(b: Builder, now: number): void {
  // Each of the sample's times, as far before now as it was before the sample's own.
  const by = now - Date.parse(SAMPLE.now)
  const moment = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
  const moved = (value: Json): Json =>
    typeof value === 'string' && moment.test(value)
      ? new Date(Date.parse(value) + by).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : Array.isArray(value)
        ? value.map(moved)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, moved(v)]))
          : value
  for (const [kind, plural] of KINDS) {
    crd(b, 60 * DAY, {
      group: 'postgresql.cnpg.io',
      kind,
      plural,
      status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    })
  }
  const all = Object.entries(SAMPLE.objects).flatMap(([key, objects]) =>
    objects.map((object) => [key, moved(object as Json) as unknown as KubeObject] as const),
  )
  // (Its namespaces, but the ones the cluster has already.)
  for (const namespace of new Set(all.map(([, o]) => o.metadata.namespace!))) {
    if (namespace !== 'shop') b.namespace(namespace, 40 * DAY)
  }
  for (const [key, o] of all) {
    const id = `${key}/${o.metadata.namespace}/${o.metadata.name}`
    const metadata = { ...o.metadata, uid: uidFor(id), resourceVersion: '1' }
    b.add(
      key === '/Pod'
        ? ({
            ...o,
            apiVersion: 'v1',
            kind: 'Pod',
            metadata,
            spec: {
              ...o.spec,
              containers: [
                { name: 'postgres', image: 'ghcr.io/cloudnative-pg/postgresql:16.4-bookworm' },
              ],
            },
            status: { phase: 'Running', ...o.status },
          } as KubeObject)
        : { ...o, metadata },
    )
  }
}

/** The demo cluster, with CloudNativePG's databases in it. */
export function demoWithCloudNativePg(now = Date.now()): ClusterFixture {
  const demo = demoCluster(now)
  const b = clusterBuilder(now)
  cloudNativePg(b, now)
  return { ...demo, objects: [...demo.objects, ...b.build().objects] }
}
