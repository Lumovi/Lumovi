/**
 * What points at an object, as plugins say it: objects of a kind whose view has a link that's
 * listed where it leads (`listedThere`), found there by the labels the link's kind and name are.
 *
 * What's pointed at is the object, and what runs it or it runs where a tool says so of them: its
 * controllers up the chain (a Pod's ReplicaSet and its Deployment, a Pod's Job and its CronJob),
 * and a Deployment's ReplicaSets that run Pods (Trivy reports on those, never the Deployment).
 */
import type { KubeObject } from '@shared/api'
import type { Health, Status } from '@shared/health'
import type { LinkLabels, View, ViewLink } from '@shared/plugins'
import { kindFor, kindOf, type ResourceKind } from '@shared/resources'

/** An object something may point at, by its kind and name. */
export interface Target {
  kind: ResourceKind
  name: string
}

/** A link of a view in use that's listed where it leads, with the labels it's found by. */
export interface Listed {
  /** The kind of what points. */
  kind: ResourceKind
  view: View
  link: ViewLink
  labels: LinkLabels
}

/** A list to read for what points at an object, by labels. */
export interface PointingList extends Listed {
  /** `null` for every namespace (or none, for a kind without them). */
  namespace: string | null
  labelSelector: string
  targets: Target[]
}

/** What controls an object, if anything does. (Not lib/workloads': this is read where routes aren't.) */
const controllerOf = (object: KubeObject) =>
  object.metadata.ownerReferences?.find((ref) => ref.controller)

/** A value a label can hold, which a selector can ask for: a name longer is never a label's. */
const LABEL_VALUE = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/

const targetOf = (ref: { apiVersion?: string; kind: string; name: string }): Target => ({
  kind: kindFor(ref.apiVersion ?? 'v1', ref.kind),
  name: ref.name,
})

/**
 * What may be pointed at, for `object`: itself; its controller, and that one's (`owner`, where
 * it's been read); and, for a Deployment, the ReplicaSets of `replicaSets` it controls that run
 * Pods (one kept for its history can still have a tool's old word about it).
 */
export function targetsOf(
  object: KubeObject,
  owner: KubeObject | undefined,
  replicaSets: readonly KubeObject[],
): Target[] {
  const targets: Target[] = [{ kind: kindOf(object), name: object.metadata.name }]
  const controller = controllerOf(object)
  if (controller) {
    targets.push(targetOf(controller))
    const above = owner && owner.metadata.uid === controller.uid ? controllerOf(owner) : undefined
    if (above) targets.push(targetOf(above))
  }
  if (kindOf(object) === 'Deployment') {
    for (const set of replicaSets) {
      const runs = Number(set.spec?.replicas ?? 0) > 0
      if (runs && controllerOf(set)?.uid === object.metadata.uid) {
        targets.push({ kind: 'ReplicaSet', name: set.metadata.name })
      }
    }
  }
  return targets
}

/**
 * The lists to read for what points at `targets` (in `namespace`, where they have one): a list
 * of each listed link's kind, by labels, for the targets it can name. Where what's pointed at has
 * a namespace, what points there is in it; where it hasn't, what points there is anywhere. None
 * of a kind that isn't served (`namespaced` says nothing of it).
 */
export function pointingLists(
  listed: readonly Listed[],
  targets: readonly Target[],
  namespace: string | undefined,
  namespaced: (kind: ResourceKind) => boolean | undefined,
): PointingList[] {
  return listed.flatMap((each) => {
    const { kind, labels } = each
    const pointsFrom = namespaced(kind)
    // (A kind without namespaces can't point at an object in one: its link would lose it.)
    if (pointsFrom === undefined || (namespace !== undefined && !pointsFrom)) return []
    const named = targets.filter(
      (target) =>
        LABEL_VALUE.test(target.name) &&
        ('written' in labels.kind
          ? target.kind === labels.kind.written
          : LABEL_VALUE.test(target.kind)),
    )
    if (named.length === 0) return []
    const among = (values: string[]) => [...new Set(values)].join(',')
    const selector = [
      `${labels.name} in (${among(named.map((target) => target.name))})`,
      ...('label' in labels.kind
        ? [`${labels.kind.label} in (${among(named.map((target) => target.kind))})`]
        : []),
    ]
    return [
      {
        ...each,
        namespace: namespace ?? null,
        labelSelector: selector.join(','),
        targets: named,
      },
    ]
  })
}

/**
 * Whether `object`, of a list's kind, points at one of its targets: its labels name that one, its
 * kind and its name both. (A selector asks for any name with any kind.)
 */
export function pointsAtOne(object: KubeObject, list: PointingList): boolean {
  const labels = object.metadata.labels ?? {}
  const name = labels[list.labels.name]
  const kind =
    'label' in list.labels.kind ? labels[list.labels.kind.label] : list.labels.kind.written
  return list.targets.some((target) => target.name === name && target.kind === kind)
}

/** How bad each health is: the worst first. */
const RANK: Record<Health, number> = {
  critical: 0,
  warning: 1,
  progressing: 2,
  neutral: 3,
  healthy: 4,
}

/** The number a status's words start with ("9 critical"), if they start with one. */
const leading = (label: string) => {
  const found = /^\s*(\d+)/.exec(label)
  return found ? Number(found[1]) : undefined
}

/** The largest number a status's words are ordered by: past it, they're alike. */
const MOST_SAID = 999_999

/**
 * How bad a status is, as one number, lower the worse: by health, then by the larger number its
 * words start with ("9 critical" before "2 critical"). None is last.
 */
export function severity(status: Status | null): number {
  if (!status) return Infinity
  const number = Math.min(leading(status.label) ?? 0, MOST_SAID)
  return RANK[status.health] * (MOST_SAID + 1) + (MOST_SAID - number)
}

/**
 * Worst first, and the same each time, whatever order they came in: by `severity`, then by name.
 */
export function worstFirst(
  a: { status: Status | null; name: string },
  b: { status: Status | null; name: string },
): number {
  const x = severity(a.status)
  const y = severity(b.status)
  return x === y ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : x < y ? -1 : 1
}
