/**
 * A fleet's clusters as the Fleet page names, labels and shares them: checked alike on the page
 * and by the server.
 */

/** A label's name (after its prefix), or its value: as Kubernetes has them. */
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_PREFIX =
  /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
const LABEL_RULE =
  'Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit'

/** Why a label's key is invalid, as the API server would say, or undefined. */
export function labelKeyError(key: string): string | undefined {
  if (key === '') return 'Enter a key'
  const slash = key.lastIndexOf('/')
  if (slash >= 0 && !LABEL_PREFIX.test(key.slice(0, slash))) {
    return 'The prefix must be a DNS subdomain, like example.com'
  }
  return LABEL_NAME.test(key.slice(slash + 1)) ? undefined : LABEL_RULE
}

/** Why a label's value is invalid, or undefined (it may be empty). */
export const labelValueError = (value: string): string | undefined =>
  value === '' || LABEL_NAME.test(value) ? undefined : LABEL_RULE

/**
 * What the fleet calls a cluster connected from its page: its agent joins by it, and it's its
 * chart's clusterName.
 */
const CLUSTER_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/** Why a cluster's name is invalid, or undefined. */
export const clusterNameError = (name: string): string | undefined =>
  name === ''
    ? 'Enter a name'
    : CLUSTER_NAME.test(name)
      ? undefined
      : 'Up to 63 lowercase letters, digits or “-”, starting and ending with a letter or digit'

/** How many groups may see a cluster, and how long each one's name may be. */
export const MAX_GROUPS = 50
const MAX_GROUP = 256

/** Why a group's name is invalid, or undefined: what a provider sends (an ID, say) goes. */
export const groupError = (group: string): string | undefined =>
  group.trim() === ''
    ? 'Enter a group'
    : group.length > MAX_GROUP
      ? `Up to ${MAX_GROUP} characters`
      : /[\p{Cc}\p{Cf}]/u.test(group)
        ? 'No control characters'
        : undefined

/** A cluster to connect from the Fleet page: what the fleet calls it, its labels, who sees it. */
export interface FleetJoinRequest {
  name: string
  labels: Record<string, string>
  /** Who sees it, besides admins; none: everyone signed in. */
  groups: string[]
}

/** A cluster being connected from the Fleet page, as its admins see it. */
export interface FleetJoin extends FleetJoinRequest {
  /** Who asked for it, and when. */
  by: string
  at: string
  /** When its token stops working, if it isn't used before. */
  until: string
  /** When its agent used it: it works once. */
  used?: string
  /** When a token of it that no longer works was last tried. */
  refused?: string
}

/** A join, with its token: shown once, and not kept (only its SHA-256 is). */
export interface NewFleetJoin {
  join: FleetJoin
  token: string
}

/** The clusters being connected from the Fleet page, and why none may be, if they can't. */
export interface FleetJoins {
  joins: FleetJoin[]
  whyNot?: string
}
