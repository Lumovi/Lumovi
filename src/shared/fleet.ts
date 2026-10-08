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
  /** Whether clusters may be added by kubeconfig or token here (the chart's fleet.addFromPage). */
  addFromPage: boolean
  /** The clusters added that way, which the page may remove. */
  added: string[]
}

/** A cluster to add from the Fleet page: a kubeconfig of one context, or a server, token and CA. */
export type FleetAddSource = { kubeconfig: string } | { server: string; token: string; ca: string }

/** A cluster to add from the Fleet page, as it'll be called, labelled and shared. */
export interface FleetAddRequest extends FleetJoinRequest {
  source: FleetAddSource
}

/** One of the checks a cluster to add goes through. */
export interface FleetCheck {
  /** Passed; failed, so it can't be added; or passed, with something to know. */
  result: 'ok' | 'bad' | 'warn'
  title: string
  /** What was found, in a line: a context, a host, a command. */
  detail?: string
  /** What to do about it. */
  hint?: string
  /** It signs in by running a program, which this server can't. */
  plugin?: true
}

/** A cluster to add, checked: whether it may be, and what it'd be called. */
export interface FleetChecked {
  checks: FleetCheck[]
  /** Every check passed (some, maybe, with something to know): it may be added. */
  passed: boolean
  /** What its kubeconfig's context calls it, as a cluster's name. */
  name?: string
}

/** How long a cluster's name, as the fleet shows it, may be. */
export const MAX_TITLE = 100

/** Why a cluster's name, as the fleet shows it, is invalid, or undefined (none: its own). */
export const titleError = (title: string): string | undefined =>
  title.length > MAX_TITLE
    ? `Up to ${MAX_TITLE} characters`
    : /[\p{Cc}\p{Cf}]/u.test(title)
      ? 'No control characters'
      : undefined

/** What the Fleet page sets for a cluster: what its source leaves unset. */
export interface FleetSetting {
  /**
   * Admins alone see it, until one saves its settings: what the page set restricted who sees a
   * cluster of its name, and was let go (another cluster came by it).
   */
  adminsOnly?: true
  /**
   * The cluster it was set for, by where it comes from (originKey): another of the same name,
   * from elsewhere, doesn't take it.
   */
  origin?: string
  /** The name it's shown by (its own stays, in URLs and its context). */
  title?: string
  labels?: Record<string, string>
  /** Who sees it, besides admins; none: everyone signed in. */
  groups?: string[]
}

/** Where a cluster in a fleet comes from. */
export type ClusterOrigin =
  /** A kubeconfig's context: the fleet's setting (LUMOVI_FLEET_KUBECONFIG), or a file. */
  | { kind: 'kubeconfig'; where: string; context: string; server?: string }
  /** A Secret of the cluster Lumovi runs in, each tool's way. */
  | {
      kind: 'secret'
      tool: 'lumovi' | 'cluster-api' | 'argocd'
      secret: string
      namespace: string
      /** Its API server: one made again for the same is the same cluster, for another isn't. */
      server?: string
    }
  /** The cluster Lumovi runs in. */
  | { kind: 'this' }
  /** An agent that dials the hub: LUMOVI_FLEET_AGENTS names it, or it was connected from the page. */
  | { kind: 'agent'; joined?: { id: string; at: string; by: string } }

/** Where a cluster comes from, as one key: what the page sets for it is for that cluster alone. */
export function originKey(origin: ClusterOrigin): string {
  switch (origin.kind) {
    case 'kubeconfig':
      return `kubeconfig:${origin.where}:${origin.context}:${origin.server ?? ''}`
    case 'secret':
      return `secret:${origin.tool}:${origin.namespace}/${origin.secret}:${origin.server ?? ''}`
    case 'this':
      return 'this'
    case 'agent':
      return `agent:${origin.joined?.id ?? ''}`
  }
}

/** A setting its source sets, which the page doesn't change: where, to change it there. */
export interface Managed {
  /** What sets it: "its Secret, cluster-production". */
  by: string
  /**
   * Where in that: a key ("lumovi.dev/labels"), or a kubeconfig context's extension (`lumovi.dev`,
   * of its context); more than one where they're merged.
   */
  in: { key: string; context?: string }[]
}

/** Where in its source a setting is set, in words: "lumovi.dev/labels". */
export const placesText = (managed: Managed): string =>
  managed.in
    .map(({ key, context }) =>
      context === undefined ? key : `the ${key} extension of context ${context}`,
    )
    .join(' and ')

/** A field of a cluster's settings: its value, and what sets it, where it isn't the page. */
export interface SettingField<T> {
  value: T
  managed?: Managed
}

/** A cluster's settings, as an admin sees them on the Fleet page. */
export interface FleetClusterSettings {
  name: string
  title: SettingField<string | undefined>
  labels: SettingField<Record<string, string>>
  groups: SettingField<string[]>
  origin: ClusterOrigin
  /** Whether it can be removed from the page: it was added there. */
  removable: boolean
  /** Added from the page by kubeconfig or token: when, and by whom. */
  added?: { at: string; by: string }
  /** Admins alone see it, until one saves its settings (see FleetSetting). */
  adminsOnly?: true
}
