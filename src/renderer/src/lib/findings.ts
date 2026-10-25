/**
 * What plugins' objects say of each workload, where a view's link that's listed where it leads
 * also `counts` against it: each such object whose status is critical or a warning, found by the
 * labels its link reads (as lib/pointing finds them for one object), worst first. A workload's
 * are those that point at it, and, for a Deployment, at the ReplicaSets it runs (where Trivy's
 * reports are).
 */
import type { KubeObject } from '@shared/api'
import type { Status } from '@shared/health'
import type { View } from '@shared/plugins'
import type { ResourceKind } from '@shared/resources'
import { renderWhole, viewStatus } from './plugins'
import { worstFirst, type Listed } from './pointing'

/** What one of a plugin's objects says of a workload. */
export interface Finding {
  status: Status
  /** The object's own name, and what it's about where its link says. */
  name: string
  about?: string
  view: View
}

/** What's said of each workload. */
export interface Findings {
  /** Worst first (see `worstFirst`); none where nothing that counts says anything wrong. */
  of: (object: KubeObject, kind: ResourceKind) => Finding[]
  /**
   * The counting kinds whose objects couldn't all be read (refused, failed, or past Lumovi's list
   * limit), each with the view that counts them: what's missing isn't counted, so a workload's
   * dash doesn't say nothing was found.
   */
  unread: { kind: ResourceKind; view: View }[]
}

/** The workloads' kinds a counting link may name: Lumovi's workload lists', and what they run. */
export const COUNTED_KINDS: readonly ResourceKind[] = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'ReplicaSet',
  'Pod',
]

const keyOf = (namespace: string | undefined, kind: string, name: string) =>
  `${namespace ?? ''}\n${kind}\n${name}`

/**
 * What each list's objects say, by what they point at; and `replicaSets`, to say a Deployment's
 * too (those it controls that run Pods).
 */
export function indexFindings(
  lists: { listed: Listed; items: readonly KubeObject[] }[],
  replicaSets: readonly KubeObject[],
  unread: Findings['unread'] = [],
): Findings {
  const said = new Map<string, { finding: Finding; id: string }[]>()
  for (const { listed, items } of lists) {
    const { labels, view, link } = listed
    for (const item of items) {
      const own = item.metadata.labels ?? {}
      const name = own[labels.name]
      const kind = 'label' in labels.kind ? own[labels.kind.label] : labels.kind.written
      if (!name || !kind) continue
      const status = viewStatus(view, item)
      // (Only what's wrong is said: fine, or nothing, is the column's quiet dash.)
      if (status?.health !== 'critical' && status?.health !== 'warning') continue
      const about = link.about ? renderWhole(link.about, item) : undefined
      const key = keyOf(item.metadata.namespace, kind, name)
      said.set(key, [
        ...(said.get(key) ?? []),
        {
          finding: { status, name: item.metadata.name, ...(about ? { about } : {}), view },
          id: `${listed.kind}/${item.metadata.uid ?? `${item.metadata.namespace}/${item.metadata.name}`}`,
        },
      ])
    }
  }
  // A Deployment's ReplicaSets that run Pods, by its namespace and uid: an owner is always in the
  // namespace of what it owns, so one that says otherwise is no Deployment's here.
  const runs = new Map<string, string[]>()
  const ownedBy = (namespace: string | undefined, uid: string) => `${namespace ?? ''}\n${uid}`
  for (const set of replicaSets) {
    const owner = set.metadata.ownerReferences?.find((ref) => ref.controller)
    if (owner?.kind !== 'Deployment' || !(Number(set.spec?.replicas ?? 0) > 0)) continue
    const key = ownedBy(set.metadata.namespace, owner.uid)
    runs.set(key, [...(runs.get(key) ?? []), set.metadata.name])
  }
  return {
    unread,
    of: (object, kind) => {
      const { namespace, name, uid } = object.metadata
      const keys = [
        keyOf(namespace, kind, name),
        ...(kind === 'Deployment' && uid
          ? (runs.get(ownedBy(namespace, uid)) ?? []).map((set) =>
              keyOf(namespace, 'ReplicaSet', set),
            )
          : []),
      ]
      // Each object once, where it's said of two of them.
      const found = new Map<string, Finding>()
      for (const key of keys) {
        for (const { finding, id } of said.get(key) ?? []) found.set(id, finding)
      }
      return [...found.values()].sort(worstFirst)
    },
  }
}
