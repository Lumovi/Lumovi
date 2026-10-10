/**
 * What a phone may change. On a screen under 640 px, Lumovi's page reads, and does a few
 * things: it answers an assistant's change, restarts and scales workloads, restarts a pod, and
 * cordons and uncordons a node. Everything else that changes a cluster, or Lumovi's own
 * settings, waits for a larger screen.
 *
 * That's decided here, once, where every call the page makes of its server goes out (the
 * connection asks `refusedOnAPhone` before it sends one): a call is let through only if it's
 * listed as reading, or as one of the changes a phone makes. One that isn't listed at all is
 * taken for a change, so whatever is added to Lumovi later is closed on a phone until someone
 * lists it here on purpose. What the page shows follows the same list (`ON_A_PHONE`, for an
 * object's actions): but it's this that holds, whatever a page shows, by a key, the palette or
 * an address.
 *
 * It's a rule of the phone's interface, not a wall: the server can't know how wide a screen
 * is, and what protects a cluster is what always does (its RBAC, Lumovi's access and read-only
 * mode). Nothing on a phone is laxer than on a larger screen: only narrower.
 */
import { IPC, type ChangeRequest } from '@shared/api'
import { LAYOUT_WIDTHS } from '@renderer/lib/layout'

/** The actions of an object that a phone offers, by their ids in the catalog. */
export const ON_A_PHONE: ReadonlySet<string> = new Set([
  'scale',
  'scale-custom',
  'restart',
  'restart-pod',
  'cordon',
  'uncordon',
])

/** Calls that read, and change nothing. */
const READS: readonly string[] = [
  IPC.appInfo,
  IPC.settings,
  IPC.views,
  IPC.contexts,
  IPC.version,
  IPC.resources,
  IPC.schema,
  IPC.list,
  IPC.get,
  IPC.metrics,
  IPC.can,
  IPC.history,
  IPC.usageSource,
  IPC.usageTest,
  IPC.usageRange,
  IPC.usageInstant,
  IPC.metricsStackStatus,
  IPC.fleetSummary,
  IPC.fleetAgents,
  IPC.fleetJoins,
  IPC.fleetSettings,
  IPC.assistantsPending,
  IPC.sponsorCard,
  IPC.aiPermissionsGet,
  IPC.auditInfo,
  IPC.auditQuery,
  IPC.auditVerify,
  IPC.auditWatch,
  IPC.accessMine,
  IPC.accessAdmin,
  IPC.accessHistory,
  IPC.serverAssistantsStatus,
  IPC.helmReleases,
  IPC.helmRelease,
  IPC.helmCli,
  IPC.helmDefaults,
  IPC.helmVersions,
  IPC.helmSearch,
  IPC.logsStart,
  IPC.logsStop,
  // A shell is never opened from a phone; closing one that somehow is harms nothing.
  IPC.terminalClose,
]

const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'

/** Whether an object has exactly these keys, and no other. */
const only = (value: unknown, ...keys: string[]): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value)

/**
 * Whether a change to an object is one a phone makes, by what it is (not by what asked for it):
 * a scale, a workload's restart, a pod deleted to restart it, a node cordoned or uncordoned.
 */
export function phoneMakes(request: unknown): boolean {
  const { kind, change } = (request ?? {}) as Partial<ChangeRequest>
  if (!change) return false
  // A pod restarted: deleted, for its controller to make another.
  if (change.action === 'delete') return kind === 'Pod'
  if (change.action !== 'patch' || !only(change.patch, 'spec')) return false
  const { spec } = change.patch
  // Scaled: its replicas, through the scale subresource or its own spec.
  if (only(spec, 'replicas')) return typeof spec.replicas === 'number'
  if (change.subresource !== undefined) return false
  // A node cordoned (true) or uncordoned (null).
  if (kind === 'Node' && only(spec, 'unschedulable')) {
    return spec.unschedulable === true || spec.unschedulable === null
  }
  // A workload restarted, as kubectl rollout restart does it.
  return (
    only(spec, 'template') &&
    only(spec.template, 'metadata') &&
    only(spec.template.metadata, 'annotations') &&
    only(spec.template.metadata.annotations, RESTARTED_AT)
  )
}

/** Calls that change something, and are made from a phone: each says whether this one is. */
const PHONE_CHANGES: Record<string, (args: unknown[]) => boolean> = {
  [IPC.change]: ([request]) => phoneMakes(request),
  // An assistant's change, approved or rejected.
  [IPC.assistantsDecide]: () => true,
}

/** Every call a phone lets through: the test of this holds it to the server's own list. */
export const PHONE_CALLS = { reads: READS, changes: Object.keys(PHONE_CHANGES) }

export const NOT_ON_A_PHONE =
  'This isn’t done from a phone. Open Lumovi on a larger screen to do it.'

/** Whether the page is a phone's now: narrower than 640 px. */
const onAPhone = () => window.matchMedia(`(width < ${LAYOUT_WIDTHS.phone}px)`).matches

/**
 * Why a call isn't sent from a phone, if it isn't: it would change something a phone doesn't.
 * Asked of every call, before it goes.
 */
export function refusedOnAPhone(channel: string, args: unknown[]): string | undefined {
  if (!onAPhone() || READS.includes(channel)) return undefined
  return PHONE_CHANGES[channel]?.(args) ? undefined : NOT_ON_A_PHONE
}
