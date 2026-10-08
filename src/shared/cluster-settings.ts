/**
 * The desktop app's own settings for each cluster: how it shows in Lumovi, kept in Lumovi's
 * settings (never in the kubeconfig). Checked where they're set and where they're read.
 */

/** How a cluster shows in Lumovi, by its context. */
export interface ClusterSettings {
  /** The name it goes by in Lumovi (the context's, unless set). */
  name?: string
  /** One of the eight data colors (`--series-n`), 1 to 8; none, gray. */
  color?: number
  /** The group it's in, on the clusters page. */
  group?: string
  /** Labels to search and group by, as `key=value` (env=production…). */
  labels?: Record<string, string>
  /** The namespace it opens in (the context's, unless set). */
  namespace?: string
  /**
   * Set by hand: deleting and draining ask for its name, and its rows say Production. Unset,
   * Lumovi guesses from its name.
   */
  production?: boolean
  /** Left out of the clusters page's list, which counts it (shown from its footer). */
  hidden?: boolean
}

/** The data colors there are. */
export const CLUSTER_COLORS = 8

const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/** A label as written, `key=value`, if it's one: Kubernetes' rules for each. */
export function parseLabel(text: string): [string, string] | undefined {
  const at = text.indexOf('=')
  if (at <= 0) return undefined
  const key = text.slice(0, at).trim()
  const value = text.slice(at + 1).trim()
  return LABEL_KEY.test(key) && LABEL_VALUE.test(value) ? [key, value] : undefined
}

/**
 * A cluster's settings, as kept: what's unset left out, the rest checked. Throws, saying what,
 * when something isn't one.
 */
export function checkedClusterSettings(value: unknown): ClusterSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A cluster’s settings are an object')
  }
  const given = value as Record<string, unknown>
  const kept: ClusterSettings = {}
  const text = (key: string, max: number): string | undefined => {
    const field = given[key]
    if (field === undefined || field === null) return undefined
    if (typeof field !== 'string') throw new Error(`Its ${key} is text`)
    const trimmed = field.trim()
    if (trimmed.length > max) throw new Error(`Its ${key} is at most ${max} characters`)
    return trimmed || undefined
  }
  const name = text('name', 100)
  if (name) kept.name = name
  const group = text('group', 60)
  if (group) kept.group = group
  const namespace = text('namespace', 63)
  if (namespace) {
    if (!NAMESPACE.test(namespace)) throw new Error(`“${namespace}” isn’t a namespace’s name`)
    kept.namespace = namespace
  }
  if (given.color !== undefined && given.color !== null) {
    if (
      typeof given.color !== 'number' ||
      !Number.isInteger(given.color) ||
      given.color < 1 ||
      given.color > CLUSTER_COLORS
    ) {
      throw new Error(`Its color is one of 1 to ${CLUSTER_COLORS}`)
    }
    kept.color = given.color
  }
  if (given.labels !== undefined && given.labels !== null) {
    if (typeof given.labels !== 'object' || Array.isArray(given.labels)) {
      throw new Error('Its labels are keys and values')
    }
    const labels = Object.entries(given.labels as Record<string, unknown>)
    if (labels.length > 32) throw new Error('It has at most 32 labels')
    for (const [key, labelValue] of labels) {
      if (typeof labelValue !== 'string' || !parseLabel(`${key}=${labelValue}`)) {
        throw new Error(`“${key}=${String(labelValue)}” isn’t a label`)
      }
    }
    if (labels.length > 0) kept.labels = Object.fromEntries(labels) as Record<string, string>
  }
  for (const key of ['production', 'hidden'] as const) {
    const flag = given[key]
    if (flag === undefined || flag === null) continue
    if (typeof flag !== 'boolean') throw new Error(`Whether it’s ${key} is true or false`)
    // Hidden only when it is; production either way (set by hand, over the guess).
    if (key === 'production' || flag) kept[key] = flag
  }
  return kept
}
