/**
 * What AI assistants may do, and where: the person's defaults, and rules that
 * say otherwise for some clusters and namespaces (by name, pattern or label),
 * under the rules a server's administrator sets, which nothing loosens. Where
 * rules overlap, the strictest wins, setting by setting.
 *
 * The page and the tools decide with this same code, so what the page says
 * an assistant may do is what it may do.
 */

/** Each setting's values, from the loosest to the strictest. */
export const AI_SETTINGS = {
  visibility: ['visible', 'hidden'],
  changes: ['allow', 'ask', 'never'],
  secrets: ['values', 'keys', 'hidden'],
  env: ['show', 'sensitive', 'all'],
  logs: ['read', 'off'],
} as const

export type AiSetting = keyof typeof AI_SETTINGS
export type AiAccess = { -readonly [K in AiSetting]: (typeof AI_SETTINGS)[K][number] }
/** What assistants may do wherever no rule says otherwise: they see every namespace. */
export type AiDefaults = Omit<AiAccess, 'visibility'>

export const AI_SETTING_KEYS = Object.keys(AI_SETTINGS) as AiSetting[]

export const AI_DEFAULTS: AiDefaults = {
  changes: 'ask',
  secrets: 'keys',
  env: 'sensitive',
  logs: 'read',
}

/**
 * Where a rule applies, and what it says there. Clusters and namespaces are
 * each named (staging), matched by a pattern (pr-*) or a label (env=production),
 * or left out with "!" first (!kube-system); none: all of them. A rule that
 * names namespaces is about what's in them, not about the cluster's own objects.
 */
export interface AiRule {
  /** The person's own have one, to edit them by; an administrator's don't. */
  id?: string
  name: string
  clusters: string[]
  namespaces: string[]
  set: Partial<AiAccess>
}

/** A person's own: their defaults, and their rules. */
export interface AiPermissions {
  defaults: AiDefaults
  rules: AiRule[]
}

/** What decides what someone's assistants may do: their own, under the administrator's. */
export interface AiPolicy {
  mine: AiPermissions
  /** Limits nothing loosens (a server's LUMOVI_ASSISTANT_RULES); none in the desktop app. */
  admin: AiRule[]
}

/** Where a person's own are kept: the desktop app's settings, or a server's. */
export type AiPermissionsKept = 'settings' | 'configmap' | 'file' | 'memory'

/** What a page shows and edits. */
export interface AiPermissionsView extends AiPolicy {
  kept: AiPermissionsKept
}

export const NO_PERMISSIONS: AiPermissions = { defaults: AI_DEFAULTS, rules: [] }

/** Limits on what a person keeps: enough for any real use, and a stored document's size. */
export const MAX_RULES = 200
export const MAX_MATCHERS = 50
export const MAX_NAME = 100

// ——— Matching ———

export interface Matcher {
  /** "!": leaves out what it matches. */
  not: boolean
  kind: 'name' | 'pattern' | 'label'
  /** For a label: its key; the value is `value`. */
  key?: string
  value: string
}

const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/

/**
 * What one of a rule's matchers says, or why it can't be one: a name has no
 * spaces, "*" or "="; a pattern has "*"s; a label is key=value, as Kubernetes
 * spells them.
 */
export function parseMatcher(text: string): Matcher | string {
  const not = text.startsWith('!')
  const body = not ? text.slice(1) : text
  if (!body) return 'It’s empty.'
  if (body.length > 253) return 'It’s longer than 253 characters.'
  if (/\s/.test(body)) return 'It has a space.'
  if (body.startsWith('!')) return 'It has more than one “!”.'
  const equals = body.indexOf('=')
  if (equals >= 0) {
    const key = body.slice(0, equals)
    const value = body.slice(equals + 1)
    if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
      return 'A label is key=value, as Kubernetes spells them (team=payments).'
    }
    return { not, kind: 'label', key, value }
  }
  return { not, kind: body.includes('*') ? 'pattern' : 'name', value: body }
}

/** Matches a pattern's "*" with anything (none too), and nothing else specially. */
const patternOf = (pattern: string) => new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`)
const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** Whether something is so: true, false, or unknown (its labels can't be read). */
type Maybe = boolean | null

const or = (values: Maybe[]): Maybe =>
  values.includes(true) ? true : values.includes(null) ? null : false
const and = (a: Maybe, b: Maybe): Maybe =>
  a === false || b === false ? false : a === null || b === null ? null : true

/** A compiled matcher: whether it matches a name with these labels (null: they're unknown). */
type Test = (name: string, labels: Record<string, string> | null) => Maybe

function test(matcher: Matcher): Test {
  if (matcher.kind === 'label') {
    return (_name, labels) => (labels === null ? null : labels[matcher.key!] === matcher.value)
  }
  if (matcher.kind === 'pattern') {
    const pattern = patternOf(matcher.value)
    return (name) => pattern.test(name)
  }
  return (name) => name === matcher.value
}

/** Whether a list of matchers takes in a name: any of what it names (all if none), none it leaves out. */
function listTest(texts: string[]): Test {
  const matchers = texts.map(parseMatcher).filter((m): m is Matcher => typeof m !== 'string')
  const named = matchers.filter((m) => !m.not).map(test)
  const left = matchers.filter((m) => m.not).map(test)
  return (name, labels) => {
    const taken = named.length === 0 ? true : or(named.map((t) => t(name, labels)))
    const leftOut = or(left.map((t) => t(name, labels)))
    return and(taken, leftOut === null ? null : !leftOut)
  }
}

/** What's asked about: a cluster's own objects, or what's in one of its namespaces. */
export interface AiTarget {
  cluster: { name: string; labels?: Record<string, string> }
  /** For what's in a namespace: it, with its labels (null when they can't be read). */
  namespace?: { name: string; labels: Record<string, string> | null }
}

interface Compiled {
  rule: AiRule
  admin: boolean
  applies(target: AiTarget): Maybe
}

function compile(rule: AiRule, admin: boolean): Compiled {
  const clusters = listTest(rule.clusters)
  const namespaces = listTest(rule.namespaces)
  const aboutNamespaces = rule.namespaces.length > 0
  return {
    rule,
    admin,
    applies: ({ cluster, namespace }) => {
      const inCluster = clusters(cluster.name, cluster.labels ?? {})
      if (!aboutNamespaces) return inCluster
      if (!namespace) return false
      return and(inCluster, namespaces(namespace.name, namespace.labels))
    },
  }
}

/** Whether a rule applies somewhere (null: maybe, its labels unknown). */
export const ruleTest = (rule: AiRule): ((target: AiTarget) => boolean | null) =>
  compile(rule, false).applies

/** Why a setting is what it is somewhere. */
export type AiSource =
  | { kind: 'default' }
  /** The person's rules that say so (some may only possibly apply: their labels are unknown). */
  | { kind: 'rule'; names: string[] }
  | { kind: 'admin'; names: string[] }

export type AiDecision = { [K in AiSetting]: { value: AiAccess[K]; from: AiSource } }

const rank = <K extends AiSetting>(key: K, value: AiAccess[K]) =>
  (AI_SETTINGS[key] as readonly string[]).indexOf(value)

/**
 * A policy, compiled once: what it decides for any target. Where its labels
 * can't be read, a rule that might apply counts when it's stricter, and not
 * when it's looser: what's decided then is never looser than what's so.
 */
export function decider(policy: AiPolicy): (target: AiTarget) => AiDecision {
  const own = policy.mine.rules.map((rule) => compile(rule, false))
  const admin = policy.admin.map((rule) => compile(rule, true))
  return (target) => {
    const ownHits = own.map((c) => ({ c, applies: c.applies(target) }))
    const adminHits = admin.map((c) => ({ c, applies: c.applies(target) }))
    const decision = {} as Record<AiSetting, { value: string; from: AiSource }>
    for (const key of AI_SETTING_KEYS) {
      const fallback = key === 'visibility' ? 'visible' : policy.mine.defaults[key]
      const setting = (hits: typeof ownHits) =>
        hits.filter(({ c, applies }) => applies !== false && c.rule.set[key] !== undefined)
      const sure = setting(ownHits).filter(({ applies }) => applies === true)
      const maybe = setting(ownHits).filter(({ applies }) => applies === null)
      const strictest = (hits: typeof ownHits) =>
        hits.reduce(
          (top, { c }) =>
            rank(key, c.rule.set[key] as never) > rank(key, top as never)
              ? (c.rule.set[key] as string)
              : top,
          (AI_SETTINGS[key] as readonly string[])[0]!,
        )
      let value: string = fallback
      let from: AiSource = { kind: 'default' }
      // The rules that surely apply decide (the maybes only make it stricter); none: the default,
      // unless a maybe is stricter.
      const candidates = sure.length ? [...sure, ...maybe] : maybe
      const top = strictest(candidates)
      if (sure.length || rank(key, top as never) > rank(key, fallback as never)) {
        value = top
        from = {
          kind: 'rule',
          names: candidates.filter(({ c }) => c.rule.set[key] === top).map(({ c }) => c.rule.name),
        }
      }
      const limits = setting(adminHits)
      const limit = strictest(limits)
      if (limits.length && rank(key, limit as never) > rank(key, value as never)) {
        value = limit
        from = {
          kind: 'admin',
          names: limits.filter(({ c }) => c.rule.set[key] === limit).map(({ c }) => c.rule.name),
        }
      }
      decision[key] = { value, from }
    }
    return decision as AiDecision
  }
}

/** The stricter of two decisions, setting by setting (somewhere seen two ways: as it is, and as it would be). */
export function stricter(a: AiDecision, b: AiDecision): AiDecision {
  return Object.fromEntries(
    AI_SETTING_KEYS.map((key) => [
      key,
      rank(key, b[key].value as never) > rank(key, a[key].value as never) ? b[key] : a[key],
    ]),
  ) as AiDecision
}

/** One setting's values in words, as the page and assistants read them. */
export const AI_VALUE_LABELS: { [K in AiSetting]: Record<AiAccess[K], string> } = {
  visibility: { visible: 'Visible', hidden: 'Hidden' },
  changes: { ask: 'Ask you', allow: 'Without asking', never: 'Never' },
  secrets: { values: 'Values', keys: 'Keys only', hidden: 'Hidden' },
  env: { show: 'Show', sensitive: 'Hide sensitive', all: 'Hide all' },
  logs: { read: 'Read', off: 'Don’t read' },
}

/**
 * What an assistant is told about a cluster as it starts (list_clusters): what
 * it may do with the cluster itself, and the rules that say otherwise for some
 * of its namespaces. Rules that hide namespaces aren't told: what's hidden, an
 * assistant doesn't learn exists.
 */
export function describeForAssistant(
  policy: AiPolicy,
  cluster: AiTarget['cluster'],
): { access: Omit<AiAccess, 'visibility'>; exceptions: Record<string, string>[] } {
  const decision = decider(policy)({ cluster })
  const { visibility: _visibility, ...access } = Object.fromEntries(
    AI_SETTING_KEYS.map((key) => [key, decision[key].value]),
  ) as AiAccess
  const exceptions = [
    ...policy.admin.map((rule) => compile(rule, true)),
    ...policy.mine.rules.map((rule) => compile(rule, false)),
  ]
    .filter(({ rule }) => rule.namespaces.length > 0 && rule.set.visibility !== 'hidden')
    .filter(({ rule }) => listTest(rule.clusters)(cluster.name, cluster.labels ?? {}) !== false)
    .filter(({ rule }) => Object.keys(rule.set).length > 0)
    .map(({ rule, admin }) => ({
      namespaces: rule.namespaces.join(', '),
      ...Object.fromEntries(
        AI_SETTING_KEYS.filter((key) => rule.set[key] !== undefined).map((key) => [
          key,
          `${admin ? 'at most ' : ''}${rule.set[key]}`,
        ]),
      ),
    }))
  return { access, exceptions }
}

/**
 * A cluster as list_clusters tells an assistant about it, and as the page
 * shows it: where it is, and what it may do there (read-only takes no changes).
 */
export function clusterForAssistant(
  policy: AiPolicy,
  context: { name: string; server?: string; namespace?: string; labels?: Record<string, string> },
  readOnly: boolean,
): Record<string, unknown> {
  const { access, exceptions } = describeForAssistant(policy, context)
  return {
    name: context.name,
    server: context.server,
    ...(context.namespace ? { namespace: context.namespace } : {}),
    changes: readOnly ? 'read-only' : access.changes,
    secrets: access.secrets,
    env: access.env,
    logs: access.logs,
    ...(exceptions.length ? { inSomeNamespaces: exceptions } : {}),
  }
}

// ——— Checking what's given ———

const isValue = <K extends AiSetting>(key: K, value: unknown): value is AiAccess[K] =>
  (AI_SETTINGS[key] as readonly unknown[]).includes(value)

/** The matchers a rule names, checked: why one isn't, if one isn't. */
function checkedMatchers(given: unknown, where: string): string[] {
  if (given === undefined) return []
  const list = typeof given === 'string' ? [given] : given
  if (!Array.isArray(list) || list.length > MAX_MATCHERS) {
    throw new Error(`${where} must be a list of up to ${MAX_MATCHERS} names, patterns or labels.`)
  }
  return list.map((text, i) => {
    if (typeof text !== 'string') throw new Error(`${where}[${i}] must be text.`)
    const parsed = parseMatcher(text.trim())
    if (typeof parsed === 'string') throw new Error(`${where}[${i}] (“${text}”): ${parsed}`)
    return text.trim()
  })
}

/** A rule as given (a page's, a stored one, an administrator's YAML), checked. */
export function checkedRule(given: unknown, where: string, own: boolean): AiRule {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new Error(`${where} must be a rule: a name, where, and what it says.`)
  }
  const { id, name, clusters, namespaces, set } = given as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) {
    throw new Error(`${where} needs a name, of up to ${MAX_NAME} characters.`)
  }
  if (own && (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))) {
    throw new Error(`${where} needs an id.`)
  }
  if (typeof set !== 'object' || set === null || Array.isArray(set)) {
    throw new Error(`${where} must say what assistants may do where it applies.`)
  }
  const settings: Partial<AiAccess> = {}
  for (const [key, value] of Object.entries(set)) {
    if (!(key in AI_SETTINGS)) {
      throw new Error(
        `${where} says “${key}”, which isn’t a setting: ${AI_SETTING_KEYS.join(', ')}.`,
      )
    }
    if (!isValue(key as AiSetting, value)) {
      throw new Error(
        `${where}’s ${key} must be ${AI_SETTINGS[key as AiSetting].join(', ')}, not “${String(value)}”.`,
      )
    }
    Object.assign(settings, { [key]: value })
  }
  return {
    ...(own ? { id: id as string } : {}),
    name: name.trim(),
    clusters: checkedMatchers(clusters, `${where}’s clusters`),
    namespaces: checkedMatchers(namespaces, `${where}’s namespaces`),
    set: settings,
  }
}

/** A person's own, as a page sends them or as they were kept, checked. */
export function checkedPermissions(given: unknown): AiPermissions {
  if (typeof given !== 'object' || given === null) throw new Error('Expected AI permissions.')
  const { defaults, rules } = given as Record<string, unknown>
  if (typeof defaults !== 'object' || defaults === null) {
    throw new Error('AI permissions need their defaults.')
  }
  const checked = { ...AI_DEFAULTS }
  for (const key of AI_SETTING_KEYS.filter((k) => k !== 'visibility') as (keyof AiDefaults)[]) {
    const value = (defaults as Record<string, unknown>)[key]
    if (!isValue(key, value)) {
      throw new Error(`The default for ${key} must be ${AI_SETTINGS[key].join(', ')}.`)
    }
    Object.assign(checked, { [key]: value })
  }
  if (!Array.isArray(rules) || rules.length > MAX_RULES) {
    throw new Error(`AI permissions have up to ${MAX_RULES} rules.`)
  }
  const list = rules.map((rule, i) => checkedRule(rule, `Rule ${i + 1}`, true))
  if (new Set(list.map((rule) => rule.id)).size < list.length) {
    throw new Error('Two rules have the same id.')
  }
  return { defaults: checked, rules: list }
}
