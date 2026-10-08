/**
 * A fleet's clusters' settings on its Fleet page: the name each is shown by, its labels, and its
 * groups (who sees it, besides admins). Lumovi's admins alone see and change them, and each
 * change is recorded.
 *
 * What a cluster's source sets (a Secret's lumovi.dev/* annotations or labels, a kubeconfig's
 * lumovi.dev extension, the server's settings) is its source's: shown, with where to change it,
 * never changed nor overridden here. The page sets only what its source leaves unset, in
 * Lumovi's own state (cluster-settings.ts), never in the source: the hub writes no Secrets.
 */
import type { AuditActor } from '@shared/audit'
import {
  groupError,
  labelKeyError,
  labelValueError,
  MAX_GROUPS,
  originKey,
  placesText,
  titleError,
  type FleetClusterSettings,
  type FleetSetting,
} from '@shared/fleet'
import type { SessionUser } from '@shared/server'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import type { ServerAccess } from '../access'
import type { Hosted } from '../cluster'
import { SERVER_ACTOR } from '../audit'
import type { ClusterSettings } from '../cluster-settings'
import type { FleetCluster } from './clusters'

const invalid = (message: string) => new KubeRequestError('invalid', message)

/** Labels as given, checked as Kubernetes checks them. */
export function checkedLabels(labels: unknown): Record<string, string> {
  if (
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.values(labels).some((value) => typeof value !== 'string')
  ) {
    throw invalid('Its labels must be a map of text, like { env: production }.')
  }
  for (const [key, value] of Object.entries(labels as Record<string, string>)) {
    const error = labelKeyError(key) ?? labelValueError(value)
    if (error) throw invalid(`Its label ${key}: ${error}.`)
  }
  return { ...(labels as Record<string, string>) }
}

/** Groups as given, checked, each once. */
export function checkedGroups(groups: unknown): string[] {
  if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string')) {
    throw invalid('Its groups must be a list of text, like [platform, sre].')
  }
  if (groups.length > MAX_GROUPS) throw invalid(`Up to ${MAX_GROUPS} groups may see it.`)
  for (const group of groups as string[]) {
    const error = groupError(group)
    if (error) throw invalid(`Its group “${group}”: ${error}.`)
  }
  return [...new Set(groups as string[])]
}

/** Who sees a cluster, in words, for the audit log. */
const seenByText = (groups: string[] | undefined) =>
  groups?.length ? groups.join(', ') : 'everyone signed in'

export class FleetSettings {
  constructor(
    private readonly hosted: Hosted,
    private readonly clusters: ClusterSettings,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
  ) {}

  /** Why `user` may not see or change clusters' settings, or nothing when they may. */
  whyNot(user: SessionUser): string | undefined {
    if (!this.access.administered) {
      return 'A cluster’s settings are changed on this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).'
    }
    return this.access.isAdmin(user)
      ? undefined
      : 'Only Lumovi’s admins change a cluster’s settings on the Fleet page.'
  }

  /** An admin's: a cluster's settings, each with what sets it, where that isn't the page. */
  get(name: unknown, user: SessionUser): FleetClusterSettings {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
    const cluster = this.#cluster(name)
    const set = this.#setFor(cluster)
    const { managed } = cluster
    return {
      name: cluster.name,
      title: { value: set.title },
      labels: managed?.labels
        ? { value: cluster.labels, managed: managed.labels }
        : { value: set.labels ?? cluster.labels },
      groups: managed?.groups
        ? { value: cluster.groups ?? [], managed: managed.groups }
        : { value: set.groups ?? cluster.groups ?? [] },
      origin: cluster.origin ?? { kind: 'this' },
      ...(set.adminsOnly && !managed?.groups ? { adminsOnly: true as const } : {}),
      removable: cluster.origin?.kind === 'agent' && Boolean(cluster.origin.joined),
    }
  }

  /**
   * An admin's: what the page sets for a cluster (its name as shown, and each of its labels and
   * groups that its source leaves unset); none set, its own. Recorded, refused tries too.
   */
  save(
    name: unknown,
    request: unknown,
    user: SessionUser,
    actor: AuditActor,
  ): FleetClusterSettings {
    const why = this.whyNot(user)
    if (why) {
      this.audit.record({
        action: 'cluster-settings.changed',
        outcome: 'refused',
        actor,
        ...(typeof name === 'string' ? { cluster: name } : {}),
        summary: 'Wasn’t let change a cluster’s settings on the Fleet page',
        error: why,
      })
      throw new KubeRequestError('not-allowed', why, 403)
    }
    const cluster = this.#cluster(name)
    const { title, labels, groups } = (request ?? {}) as Partial<Record<string, unknown>>
    // What's given, over what's set: a field not given is as it was; given empty, it's unset.
    // (Admins' alone stays so until its groups are given: then they say who sees it.)
    const { origin: _origin, ...setting }: FleetSetting = { ...this.#setFor(cluster) }
    if (groups !== undefined) delete setting.adminsOnly
    if (title !== undefined) {
      if (typeof title !== 'string') throw invalid('Its name must be text.')
      const error = titleError(title.trim())
      if (error) throw invalid(`Its name: ${error}.`)
      if (title.trim() && title.trim() !== cluster.name) setting.title = title.trim()
      else delete setting.title
    }
    for (const [field, given] of [
      ['labels', labels],
      ['groups', groups],
    ] as const) {
      const managed = cluster.managed?.[field]
      if (given === undefined) continue
      if (managed) {
        throw invalid(
          `Its ${field} are set by ${managed.by}, in ${placesText(managed)}: change them there.`,
        )
      }
      if (field === 'labels') {
        const checked = checkedLabels(given)
        if (Object.keys(checked).length) setting.labels = checked
        else delete setting.labels
      } else {
        const checked = checkedGroups(given)
        if (checked.length) setting.groups = checked
        else delete setting.groups
      }
    }
    // Its name as shown is its own: not another's name, nor what another is shown by.
    const shown = setting.title?.toLowerCase()
    const other = (this.hosted.allClusters?.() ?? []).find(
      (c) =>
        c.name !== cluster.name &&
        (c.name.toLowerCase() === shown || c.title?.toLowerCase() === shown),
    )
    if (shown && other) {
      throw invalid(
        `Its name: ${other.name.toLowerCase() === shown ? 'another cluster is called' : `${other.name} is shown as`} ${setting.title}. Give it a name of its own.`,
      )
    }
    const before = this.get(cluster.name, user)
    this.clusters.setFleet(cluster.name, { origin: originKey(cluster.origin!), ...setting }, user)
    const after = this.get(cluster.name, user)
    this.audit.record({
      action: 'cluster-settings.changed',
      outcome: 'success',
      actor,
      cluster: cluster.name,
      summary: `Changed ${cluster.name}’s settings on the Fleet page${
        before.groups.value.join() === after.groups.value.join()
          ? ''
          : `: seen by ${seenByText(after.groups.value)}, besides admins (was ${seenByText(before.groups.value)})`
      }`,
      details: {
        title: after.title.value ?? null,
        labels: Object.entries(after.labels.value).map(([key, value]) => `${key}=${value}`),
        groups: after.groups.value,
        groupsWere: before.groups.value,
      },
    })
    return after
  }

  /**
   * What the page set for a cluster that's another now (by its name, from elsewhere): let go, and
   * recorded. A cluster that's gone a while (its source unread) keeps its: it's the same cluster
   * if it comes back from the same place.
   */
  forget(name: string): void {
    const cluster = this.hosted.sourced?.(name)
    const set = this.clusters.fleetSettings()[name]
    if (!cluster?.origin || !set || set.origin === originKey(cluster.origin)) return
    // Who saw it was restricted: so it is still, to admins alone, until one of them says (it
    // fails closed). Its source's groups, if it sets them, say already.
    const closed = Boolean(set.groups?.length || set.adminsOnly) && !cluster.managed?.groups
    this.clusters.setFleetAsLumovi(
      name,
      closed ? { origin: originKey(cluster.origin), adminsOnly: true } : undefined,
    )
    this.audit.record({
      action: 'cluster-settings.changed',
      outcome: 'success',
      actor: SERVER_ACTOR,
      cluster: name,
      summary: `Let go of what the Fleet page set for ${name}: it was set for another cluster by that name, and this one comes from elsewhere${closed ? '. Only admins see it until one of them saves its settings' : ''}`,
      details: {
        title: set.title ?? null,
        labels: Object.entries(set.labels ?? {}).map(([key, value]) => `${key}=${value}`),
        groups: set.groups ?? [],
      },
    })
  }

  /** What the page set for a cluster: only if it's for this one (from where it comes from). */
  #setFor(cluster: FleetCluster): FleetSetting {
    const set = this.clusters.fleetSettings()[cluster.name]
    return set && cluster.origin && set.origin === originKey(cluster.origin) ? set : {}
  }

  /** A cluster of the fleet, as its source describes it. */
  #cluster(name: unknown) {
    const cluster = typeof name === 'string' ? this.hosted.sourced?.(name) : undefined
    if (!cluster) {
      throw new KubeRequestError(
        'not-found',
        `This server has no cluster called “${String(name)}”.`,
      )
    }
    return cluster
  }
}
