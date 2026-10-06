/**
 * What the Access pages show, worked out: who's in a group (as they last
 * signed in), which provider groups have been seen, what a grant or limit
 * does, in words, and where it reaches.
 */
import {
  accessDecider,
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TEXT,
  inGroup,
  rankOf,
  SENSITIVE,
  type AccessDecision,
  type AccessGrant,
  type AccessGroup,
  type AccessLimit,
  type AccessPolicy,
  type AccessSource,
  type Capability,
  type Levels,
  type SeenPerson,
} from '@shared/access'
import { whereTest } from '@shared/ai-permissions'
import type { IndexedNamespace } from '../assistants/namespaces'

export const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** A level, as people read it: "Keys only". */
export const levelLabel = <K extends Capability>(key: K, level: Levels[K]) =>
  CAPABILITY_TEXT[key].levels[level]!

/** Whether a level shows Secret values, runs code on nodes, installs charts, or reads everyone's. */
export const isSensitive = (key: Capability, level: string) => SENSITIVE[key] === level

/** Everyone signed in is in it: it says nothing about anyone. */
const NOISE = new Set(['system:authenticated'])

/** Groups as Entra ID sends them: IDs, which mean nothing until they're named. */
export const isGuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** What a provider group is called here: the name an admin gave it, or its own. */
export const groupTitle = (policy: AccessPolicy, id: string) => policy.names[id] || id

/** A new id, for something an admin adds: its kind, and eight random hex digits. */
export const newId = (kind: string) => `${kind}-${crypto.randomUUID().slice(0, 8)}`

/** The people seen who are in a group, as they last signed in. */
export const membersOf = (group: AccessGroup, seen: SeenPerson[]) =>
  seen.filter((person) => inGroup(group, person))

/** The provider's groups seen at sign-in, the most people first, with who's in each. */
export function providerGroups(seen: SeenPerson[]): { id: string; people: SeenPerson[] }[] {
  const groups = new Map<string, SeenPerson[]>()
  for (const person of seen) {
    for (const id of person.groups) {
      if (NOISE.has(id)) continue
      groups.set(id, [...(groups.get(id) ?? []), person])
    }
  }
  return [...groups]
    .map(([id, people]) => ({ id, people }))
    .sort((a, b) => b.people.length - a.people.length || a.id.localeCompare(b.id))
}

/** The groups someone's provider sent, but those that say nothing. */
export const sentGroups = (groups: string[]) => groups.filter((g) => !NOISE.has(g))

/** What a limit says, a few words each: "No node shells", "Secret keys only". */
const LIMIT_WORDS: { [K in Capability]?: Partial<Record<Levels[K], string>> } = {
  changes: { read: 'Read-only' },
  shells: { off: 'No shells' },
  nodeShells: { off: 'No node shells' },
  logs: { off: 'No logs' },
  secrets: { hidden: 'Secrets hidden', keys: 'Secret keys only' },
  helm: { off: 'No Helm', upgrade: 'No Helm installs' },
  assistants: { off: 'No AI assistants', ask: 'Assistants’ changes ask' },
  audit: { own: 'Own events only' },
}

export function limitEffects(limit: AccessLimit): string[] {
  // (Each level a limit can say has its words: the most there is limits nothing.)
  return (Object.entries(limit.caps) as [Capability, string][]).map(
    ([key, level]) => (LIMIT_WORDS[key] as Record<string, string>)[level]!,
  )
}

/** What a profile gives beyond what everyone gets: "helm upgrade, roll back", "shells open them". */
export function beyondEveryone(policy: AccessPolicy, values: Levels): string[] {
  return CAPABILITY_KEYS.filter(
    (key) => rankOf(key, values[key] as never) > rankOf(key, policy.everyone[key] as never),
  ).map((key) => `${CAPABILITY_TEXT[key].label}: ${levelLabel(key, values[key] as never)}`)
}

/** "env=production, env=staging / all namespaces". */
export const whereOf = (rule: { clusters: string[]; namespaces: string[] }) =>
  `${rule.clusters.length ? rule.clusters.join(', ') : 'all clusters'}  /  ${rule.namespaces.length ? rule.namespaces.join(', ') : 'all namespaces'}`

/** The names of the groups a rule names. */
export const whoOf = (policy: AccessPolicy, rule: AccessGrant | AccessLimit) =>
  rule.who.map((id) => policy.groups.find((g) => g.id === id)!.name)

/** The people a grant or limit names (a limit naming nobody holds everyone back). */
export function namedBy(policy: AccessPolicy, rule: AccessGrant | AccessLimit, seen: SeenPerson[]) {
  const limit = !('profile' in rule)
  if (limit && rule.who.length === 0) return seen
  const groups = policy.groups.filter((g) => rule.who.includes(g.id))
  return seen.filter((person) => groups.some((g) => inGroup(g, person)))
}

/** The namespaces a rule reaches (labels known, as they're listed). */
export function reachedBy(
  rule: { clusters: string[]; namespaces: string[] },
  all: IndexedNamespace[],
) {
  const applies = whereTest(rule.clusters, rule.namespaces)
  return all.filter(
    (ns) =>
      applies({
        cluster: { name: ns.cluster.name, labels: ns.cluster.labels },
        namespace: { name: ns.name, labels: ns.labels },
      }) === true,
  )
}

/** Who decided it, as a chip says: everyone's, a grant, or a limit. */
export function sourceParts(source: AccessSource): {
  kind: 'Everyone' | 'Grant' | 'Limit'
  text: string
} {
  return source.kind === 'limit'
    ? { kind: 'Limit', text: source.name }
    : source.kind === 'grant'
      ? { kind: 'Grant', text: `${source.name} (${source.profile})` }
      : { kind: 'Everyone', text: 'What everyone signed in gets' }
}

/** What someone may do in each namespace given, and on each cluster's nodes. */
export function decideAll(
  policy: AccessPolicy,
  person: { name: string; groups: string[] },
  namespaces: IndexedNamespace[],
) {
  const decide = accessDecider(policy, person)
  return namespaces.map((ns) => ({
    ns,
    decision: decide({
      cluster: { name: ns.cluster.name, labels: ns.cluster.labels },
      namespace: { name: ns.name, labels: ns.labels },
    }),
  }))
}

/** Why it's so in one place: the limit, the grant, or what everyone gets (`none`: nothing). */
const noteOf = (from: AccessSource, none: boolean) =>
  from.kind === 'limit'
    ? `limit: ${from.name}`
    : from.kind === 'grant'
      ? from.name
      : none
        ? 'no grant gives it here'
        : 'everyone gets it'

/** How a capability's level reads in a summary cell: its value, and where it isn't so. */
export interface Summary {
  value: string
  note: string
  /** Its lowest: shown quieter. */
  none: boolean
  sensitive: boolean
}

/**
 * A capability over a cluster's namespaces: the most it's allowed anywhere there, and how
 * many allow it (with what holds the rest back, when one limit does).
 */
export function summarize<K extends Capability>(key: K, decisions: AccessDecision[]): Summary {
  const levels = CAPABILITIES[key] as unknown as readonly Levels[K][]
  const counts = new Map<Levels[K], AccessDecision[]>()
  for (const d of decisions) counts.set(d[key].value, [...(counts.get(d[key].value) ?? []), d])
  const top = [...counts.keys()].sort((a, b) => levels.indexOf(b) - levels.indexOf(a))[0]!
  // One limit that holds all of them back is named; anything else, not.
  const reasons = (ds: AccessDecision[]) => {
    const why = new Set(ds.map(({ [key]: { from } }) => (from.kind === 'limit' ? from.name : '')))
    const [only] = why
    return why.size === 1 && only ? `: ${only}` : ''
  }
  const note =
    counts.size === 1
      ? decisions.length === 1
        ? noteOf(decisions[0]![key].from, levels.indexOf(top) === 0)
        : 'everywhere'
      : [
          `in ${counts.get(top)!.length} of ${decisions.length}`,
          ...[...counts.entries()]
            .filter(([level]) => level !== top)
            .sort(([a], [b]) => levels.indexOf(b) - levels.indexOf(a))
            .map(
              ([level, ds]) =>
                `${levelLabel(key, level).toLowerCase()} in ${ds.length}${reasons(ds)}`,
            ),
        ].join('; ')
  return {
    value: levelLabel(key, top),
    note,
    none: levels.indexOf(top) === 0,
    sensitive: isSensitive(key, top),
  }
}
