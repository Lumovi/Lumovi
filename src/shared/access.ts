/**
 * Who may do what through Lumovi, on a server: what everyone signed in may
 * do; what groups are granted on top of it, as profiles, where grants say
 * (someone in several gets the most any of them gives); and limits, which
 * win over every grant. Always within what Kubernetes RBAC allows: Lumovi
 * never lets anyone do more than the cluster would.
 *
 * People are in groups as their identity provider says (the groups they
 * sign in with), or by name. Lumovi's groups never reach the cluster: they
 * decide what Lumovi lets people do, nothing else.
 */
import {
  aiRank,
  parseMatcher,
  whereTest,
  type AiAccess,
  type AiDecision,
  type AiSetting,
  type AiTarget,
} from './ai-permissions'

/** Each capability's levels, from the least to the most it allows. */
export const CAPABILITIES = {
  changes: ['read', 'write'],
  shells: ['off', 'on'],
  nodeShells: ['off', 'on'],
  logs: ['off', 'on'],
  secrets: ['hidden', 'keys', 'values'],
  helm: ['off', 'upgrade', 'install'],
  assistants: ['off', 'ask', 'self'],
  audit: ['own', 'all'],
} as const

export type Capability = keyof typeof CAPABILITIES
export type Levels = { -readonly [K in Capability]: (typeof CAPABILITIES)[K][number] }
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[]

/**
 * Where each is decided: in a namespace (and, for a cluster's own objects, the cluster);
 * on a cluster's nodes; or anywhere at all.
 */
export const SCOPES: Record<Capability, 'namespace' | 'cluster' | 'anywhere'> = {
  changes: 'namespace',
  shells: 'namespace',
  nodeShells: 'cluster',
  logs: 'namespace',
  secrets: 'namespace',
  helm: 'namespace',
  assistants: 'namespace',
  audit: 'anywhere',
}

/** How each reads: what it's called, what it's about, and each level's words. */
export const CAPABILITY_TEXT: Record<
  Capability,
  { label: string; hint: string; levels: Record<string, string> }
> = {
  changes: {
    label: 'Changes',
    hint: 'Edit, scale, restart, delete',
    levels: { read: 'Read-only', write: 'Make changes' },
  },
  shells: { label: 'Shells', hint: 'Into containers', levels: { off: 'Off', on: 'Open them' } },
  nodeShells: {
    label: 'Node shells',
    hint: 'As root, on a node',
    levels: { off: 'Off', on: 'Open them' },
  },
  logs: { label: 'Logs', hint: 'Containers’ output', levels: { off: 'Off', on: 'Read them' } },
  secrets: {
    label: 'Secrets',
    hint: 'What they hold',
    levels: { hidden: 'Hidden', keys: 'Keys only', values: 'Values' },
  },
  helm: {
    label: 'Helm',
    hint: 'Releases and charts',
    levels: { off: 'Off', upgrade: 'Upgrade, roll back', install: 'Install, uninstall' },
  },
  assistants: {
    label: 'AI assistants',
    hint: 'Connecting them, and their changes',
    levels: { off: 'Off', ask: 'Changes ask first', self: 'As they set them' },
  },
  audit: {
    label: 'Audit log',
    hint: 'Whose events',
    levels: { own: 'Their own', all: 'Everyone’s' },
  },
}

/** What shows Secret values, runs code on nodes, installs charts, or reads everyone's events. */
export const SENSITIVE: Partial<Levels> = {
  nodeShells: 'on',
  secrets: 'values',
  helm: 'install',
  assistants: 'self',
  audit: 'all',
}

/** All RBAC allows (bar everyone's audit events): what everyone gets, until an admin says less. */
export const EVERYTHING: Levels = {
  changes: 'write',
  shells: 'on',
  nodeShells: 'on',
  logs: 'on',
  secrets: 'values',
  helm: 'install',
  assistants: 'self',
  audit: 'own',
}

export const rankOf = <K extends Capability>(key: K, level: Levels[K]) =>
  (CAPABILITIES[key] as readonly string[]).indexOf(level)

/** Set by the Helm chart (or the server's settings): changed there, never here. */
interface Lockable {
  locked?: boolean
}

export interface AccessGroup extends Lockable {
  id: string
  name: string
  description?: string
  /** The identity provider's groups whose people are in it. */
  provider: string[]
  /** People by name, as they sign in (an email, say). */
  people: string[]
}

export interface AccessProfile extends Lockable {
  id: string
  name: string
  values: Levels
}

export interface AccessGrant extends Lockable {
  id: string
  name: string
  /** Lumovi's groups it's for. */
  who: string[]
  profile: string
  clusters: string[]
  namespaces: string[]
}

export interface AccessLimit extends Lockable {
  id: string
  name: string
  /** Lumovi's groups it holds back; none: everyone. */
  who: string[]
  clusters: string[]
  namespaces: string[]
  caps: Partial<Levels>
}

export interface AccessPolicy {
  /** What everyone signed in gets, wherever no grant gives more. */
  everyone: Levels
  everyoneLocked?: boolean
  groups: AccessGroup[]
  profiles: AccessProfile[]
  grants: AccessGrant[]
  limits: AccessLimit[]
  /** What the identity provider's groups are called here (Entra ID sends IDs). */
  names: Record<string, string>
}

export const OPEN_POLICY: AccessPolicy = {
  everyone: EVERYTHING,
  groups: [],
  profiles: [],
  grants: [],
  limits: [],
  names: {},
}

/** Someone, as they signed in: their name, and their identity provider's groups. */
export interface Person {
  name: string
  groups: string[]
}

/** Why someone may do what they may somewhere. */
export type AccessSource =
  | { kind: 'everyone' }
  | { kind: 'grant'; name: string; profile: string }
  | { kind: 'limit'; name: string }

export type AccessDecision = {
  [K in Capability]: {
    value: Levels[K]
    from: AccessSource
    /** What grants alone would give: more than `value` where a limit holds it back. */
    granted: Levels[K]
  }
}

/** Whether someone's in a group: by one of its provider groups, or by name. */
export const inGroup = (group: AccessGroup, person: Person) =>
  group.people.includes(person.name) || group.provider.some((id) => person.groups.includes(id))

/** The ids of Lumovi's groups someone's in. */
export const groupsOf = (policy: AccessPolicy, person: Person) =>
  policy.groups.filter((group) => inGroup(group, person)).map((group) => group.id)

/**
 * A policy for someone, compiled once: what they may do anywhere. A grant counts only where
 * it surely applies; a limit wherever it may (its labels can't be read): so what's decided
 * is never more than what's so.
 */
export function accessDecider(
  policy: AccessPolicy,
  person: Person,
): (target: AiTarget) => AccessDecision {
  const mine = new Set(groupsOf(policy, person))
  const profiles = new Map(policy.profiles.map((p) => [p.id, p]))
  const grants = policy.grants
    .filter((g) => g.who.some((id) => mine.has(id)) && profiles.has(g.profile))
    .map((g) => ({
      g,
      profile: profiles.get(g.profile)!,
      applies: whereTest(g.clusters, g.namespaces),
    }))
  const limits = policy.limits
    .filter((l) => l.who.length === 0 || l.who.some((id) => mine.has(id)))
    .map((l) => ({ l, applies: whereTest(l.clusters, l.namespaces) }))
  return (target) => {
    const atCluster = { cluster: target.cluster }
    const decision = {} as Record<Capability, AccessDecision[Capability]>
    for (const key of CAPABILITY_KEYS) {
      const scope = SCOPES[key]
      const where = scope === 'cluster' ? atCluster : target
      const reaches = (applies: (t: AiTarget) => boolean | null) =>
        scope === 'anywhere' ? true : applies(where)
      let value: string = policy.everyone[key]
      let from: AccessSource = { kind: 'everyone' }
      for (const { g, profile, applies } of grants) {
        const given = profile.values[key]
        if (
          reaches(applies) === true &&
          rankOf(key, given as never) > rankOf(key, value as never)
        ) {
          value = given
          from = { kind: 'grant', name: g.name, profile: profile.name }
        }
      }
      const granted = value
      for (const { l, applies } of limits) {
        const cap = l.caps[key]
        if (
          cap !== undefined &&
          reaches(applies) !== false &&
          rankOf(key, cap as never) < rankOf(key, value as never)
        ) {
          value = cap
          from = { kind: 'limit', name: l.name }
        }
      }
      decision[key] = { value, from, granted } as never
    }
    return decision as AccessDecision
  }
}

/** Whether a decision allows a level of a capability (or more). */
export const allows = <K extends Capability>(decision: AccessDecision, key: K, level: Levels[K]) =>
  rankOf(key, decision[key].value) >= rankOf(key, level)

/** Why not, in words: "the limit “Production” says so", "no grant of yours gives it there". */
export function because(source: AccessSource): string {
  return source.kind === 'limit'
    ? `the limit “${source.name}” says so`
    : source.kind === 'grant'
      ? `“${source.name}” gives ${source.profile}, and no more`
      : 'no grant of yours gives it there'
}

/** Whether namespaces' labels could change what a policy decides: a rule names one. */
export const usesLabels = (policy: AccessPolicy) =>
  [...policy.grants, ...policy.limits].some((rule) => rule.namespaces.some((m) => m.includes('=')))

/** Why someone may not, in a few words: "the limit “Production” holds it back". */
export function reasonOf(source: AccessSource): string {
  return source.kind === 'limit'
    ? `the limit “${source.name}” holds it back`
    : source.kind === 'grant'
      ? `your grant “${source.name}” gives ${source.profile}, and no more`
      : 'none of your grants gives it here'
}

// ——— The server's ———

/**
 * What a server's access lets its person do, as Lumovi's services ask it
 * before they act: the server decides, whatever a page shows. The desktop
 * app has none (its person is the computer's).
 */
export interface AccessGuard {
  /**
   * Refuses (a not-allowed error, saying why) unless they may: `level` of `cap`, or more, where
   * it is (a namespace; none: the cluster's own, or its nodes). `doing` says what, as in "make
   * changes".
   */
  require<K extends Capability>(
    context: string,
    cap: K,
    level: Levels[K],
    namespace: string | undefined,
    doing: string,
  ): Promise<void>
  /** What a namespace's Secrets show them: values, keys only, or nothing. */
  secrets(context: string, namespace: string): Promise<Levels['secrets']>
}

// ——— Changes ———

/** JSON with each object's keys in order: two the same say so, however they were built. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  )

const levelText = (key: Capability, level: string | undefined, unset: string) =>
  level === undefined ? unset : CAPABILITY_TEXT[key].levels[level]!

/** "Helm: Off → Upgrade, roll back", for each capability that differs. */
function levelChanges(a: Partial<Levels>, b: Partial<Levels>, unset = '—'): string[] {
  return CAPABILITY_KEYS.filter((key) => a[key] !== b[key]).map(
    (key) =>
      `${CAPABILITY_TEXT[key].label}: ${levelText(key, a[key], unset)} → ${levelText(key, b[key], unset)}`,
  )
}

/** "added k8s-sre-oncall, took out rik@acme.dev". */
function listChanges(a: string[], b: string[], name: (item: string) => string = (x) => x) {
  return [
    ...b.filter((x) => !a.includes(x)).map((x) => `added ${name(x)}`),
    ...a.filter((x) => !b.includes(x)).map((x) => `took out ${name(x)}`),
  ]
}

const whereText = (matchers: string[], all: string) => (matchers.length ? matchers.join(', ') : all)

/**
 * What a change to a policy did, in sentences: "Added the grant “On-call”", "Changed the
 * profile “Developer”: Helm Off → Upgrade, roll back". The audit log keeps them, and an
 * admin reads them before saving.
 */
export function changesOf(before: AccessPolicy, after: AccessPolicy): string[] {
  const said: string[] = []
  const everyone = levelChanges(before.everyone, after.everyone)
  if (everyone.length) said.push(`Changed what everyone may do: ${everyone.join('; ')}`)
  // A group or profile by its name: as it is now, or (taken away) as it was.
  const groupName = (id: string) =>
    [...after.groups, ...before.groups].find((g) => g.id === id)!.name
  const profileName = (id: string) =>
    [...after.profiles, ...before.profiles].find((p) => p.id === id)!.name
  const kinds = [
    ['groups', 'group'],
    ['profiles', 'profile'],
    ['grants', 'grant'],
    ['limits', 'limit'],
  ] as const
  for (const [key, word] of kinds) {
    const was = new Map<string, { id: string; name: string; locked?: boolean }>(
      before[key].map((x) => [x.id, x]),
    )
    const now = new Map<string, { id: string; name: string; locked?: boolean }>(
      after[key].map((x) => [x.id, x]),
    )
    for (const [id, item] of now) {
      const old = was.get(id)
      if (!old) {
        said.push(`Added the ${word} “${item.name}”`)
        continue
      }
      const { locked: _a, ...oldItem } = old
      const { locked: _b, ...newItem } = item
      if (canonical(oldItem) === canonical(newItem)) continue
      const parts: string[] = old.name === item.name ? [] : [`renamed it from “${old.name}”`]
      if (key === 'groups') {
        const [o, n] = [old as AccessGroup, item as AccessGroup]
        if ((o.description ?? '') !== (n.description ?? '')) parts.push('described it')
        parts.push(...listChanges(o.provider, n.provider, (x) => after.names[x] ?? x))
        parts.push(...listChanges(o.people, n.people))
      } else if (key === 'profiles') {
        parts.push(...levelChanges((old as AccessProfile).values, (item as AccessProfile).values))
      } else {
        const [o, n] = [old as AccessGrant | AccessLimit, item as AccessGrant | AccessLimit]
        const who = listChanges(o.who, n.who, (id) => `“${groupName(id)}”`)
        if (who.length) parts.push(`who: ${who.join(', ')}`)
        if (canonical(o.clusters) !== canonical(n.clusters)) {
          parts.push(`clusters ${whereText(o.clusters, 'all')} → ${whereText(n.clusters, 'all')}`)
        }
        if (canonical(o.namespaces) !== canonical(n.namespaces)) {
          parts.push(
            `namespaces ${whereText(o.namespaces, 'all')} → ${whereText(n.namespaces, 'all')}`,
          )
        }
        if (key === 'grants' && (o as AccessGrant).profile !== (n as AccessGrant).profile) {
          parts.push(
            `profile ${profileName((o as AccessGrant).profile)} → ${profileName((n as AccessGrant).profile)}`,
          )
        }
        if (key === 'limits') {
          parts.push(
            ...levelChanges((o as AccessLimit).caps, (n as AccessLimit).caps, 'not limited'),
          )
        }
      }
      said.push(`Changed the ${word} “${item.name}”${parts.length ? `: ${parts.join('; ')}` : ''}`)
    }
    for (const [id, item] of was) if (!now.has(id)) said.push(`Removed the ${word} “${item.name}”`)
  }
  const ids = new Set([...Object.keys(before.names), ...Object.keys(after.names)])
  for (const id of ids) {
    const [o, n] = [before.names[id], after.names[id]]
    if (o === n) continue
    said.push(n ? `Named ${id} “${n}”` : `Took the name “${o}” from ${id}`)
  }
  return said
}

// ——— AI assistants ———

/** The grant or limit a source names, for an assistant's refusal (none: no grant gives it). */
const namesOf = (source: AccessSource) => (source.kind === 'everyone' ? [] : [source.name])

/**
 * What an assistant acting as someone may do, under their access: never more than they may
 * themselves. With assistants off, it doesn't see there; set to ask, its changes ask first.
 * A cluster's own objects, where assistants are off but on in some of its namespaces, it sees
 * (the cluster is there) and doesn't change.
 */
export function cappedByAccess(
  ai: AiDecision,
  access: AccessDecision,
  ownObjects: boolean,
): AiDecision {
  const out = { ...ai }
  const cap = <K extends AiSetting>(key: K, value: AiAccess[K], from: AccessSource) => {
    if (aiRank(key, value) > aiRank(key, out[key].value as AiAccess[K])) {
      out[key] = { value, from: { kind: 'access', names: namesOf(from) } } as AiDecision[K]
    }
  }
  if (access.assistants.value === 'off') {
    if (ownObjects) cap('changes', 'never', access.assistants.from)
    else cap('visibility', 'hidden', access.assistants.from)
  }
  if (access.changes.value === 'read') cap('changes', 'never', access.changes.from)
  else if (access.assistants.value === 'ask') cap('changes', 'ask', access.assistants.from)
  if (access.secrets.value !== 'values') cap('secrets', access.secrets.value, access.secrets.from)
  if (access.logs.value === 'off') cap('logs', 'off', access.logs.from)
  return out
}

/**
 * Whether someone may use AI assistants somewhere in a cluster: what everyone gets, or a grant
 * of theirs there, lets them, and no limit says off in the whole of it.
 */
export function assistantsIn(
  policy: AccessPolicy,
  person: Person,
): (cluster: AiTarget['cluster']) => boolean {
  const mine = policyFor(policy, person)
  const on = (level: Levels['assistants']) => rankOf('assistants', level) > 0
  return (cluster) => {
    const covers = (rule: { clusters: string[] }) => whereTest(rule.clusters, [])({ cluster })
    if (
      mine.limits.some(
        (l) => l.caps.assistants === 'off' && l.namespaces.length === 0 && covers(l) !== false,
      )
    ) {
      return false
    }
    return (
      on(mine.everyone.assistants) ||
      mine.grants.some(
        (g) =>
          covers(g) === true &&
          on(mine.profiles.find((p) => p.id === g.profile)!.values.assistants),
      )
    )
  }
}

/**
 * Whether someone may use AI assistants anywhere: what everyone gets, or a grant of theirs,
 * lets them, and no limit everywhere says off.
 */
export function mayUseAssistants(policy: AccessPolicy, person: Person): boolean {
  const mine = policyFor(policy, person)
  const most = Math.max(
    rankOf('assistants', mine.everyone.assistants),
    ...mine.grants.map((g) => {
      // (Someone's share holds the profiles their grants give.)
      const profile = mine.profiles.find((p) => p.id === g.profile)!
      return rankOf('assistants', profile.values.assistants)
    }),
  )
  const everywhereOff = mine.limits.some(
    (l) => l.caps.assistants === 'off' && l.clusters.length === 0 && l.namespaces.length === 0,
  )
  return most > 0 && !everywhereOff
}

// ——— Someone's own ———

/** What someone's own access is made of: just what applies to them, for their pages to decide with. */
export interface MyAccess {
  person: Person
  /** Only the groups they're in, grants for those, the profiles they give, limits that hold them. */
  policy: AccessPolicy
  /** Who decides it: admins by name, and groups whose people are. */
  admins: string[]
  /** How they signed in: the provider that sent their groups. */
  provider: string
  /** Whether they're one of the admins: they change it. */
  admin: boolean
}

/** Someone's share of a policy: what decides for them, and nothing about anyone else. */
export function policyFor(policy: AccessPolicy, person: Person): AccessPolicy {
  const mine = new Set(groupsOf(policy, person))
  const grants = policy.grants.filter((g) => g.who.some((id) => mine.has(id)))
  return {
    everyone: policy.everyone,
    groups: policy.groups
      .filter((g) => mine.has(g.id))
      .map(({ id, name, description }) => ({ id, name, description, provider: [], people: [] })),
    profiles: policy.profiles.filter((p) => grants.some((g) => g.profile === p.id)),
    grants: grants.map((g) => ({ ...g, who: g.who.filter((id) => mine.has(id)) })),
    limits: policy.limits
      .filter((l) => l.who.length === 0 || l.who.some((id) => mine.has(id)))
      .map((l) => ({ ...l, who: l.who.filter((id) => mine.has(id)) })),
    names: {},
  }
}

/**
 * Someone's own, as their policy share decides it: groups are matched by id, as the share
 * holds no members (theirs are known).
 */
export function myDecider(mine: MyAccess): (target: AiTarget) => AccessDecision {
  const ids = mine.policy.groups.map((g) => g.id)
  return accessDecider(
    {
      ...mine.policy,
      groups: mine.policy.groups.map((g) => ({ ...g, people: [mine.person.name] })),
    },
    { ...mine.person, groups: ids },
  )
}

// ——— What an admin sees ———

/** Someone who signed in lately, with the groups their provider sent. */
export interface SeenPerson {
  name: string
  groups: string[]
  /** When they were last seen (ISO). */
  seen: string
  /** How they signed in: single sign-on, a proxy, or a token. */
  via: 'oidc' | 'proxy' | 'token'
}

export interface AdminAccess {
  policy: AccessPolicy
  /** The version it was read at: saving says it, so one admin's change never undoes another's. */
  version: string
  seen: SeenPerson[]
  /** Who's an admin (LUMOVI_ADMINS), as it says. */
  admins: string[]
  /** How people sign in: what sends their groups (in an ID token's claim, or a proxy's header). */
  provider: { mode: 'oidc' | 'proxy' | 'token'; name: string; claim?: string }
  /** Where it's kept. */
  kept: 'configmap' | 'file' | 'memory'
}

// ——— Checked ———

export const ACCESS_LIMITS = {
  groups: 200,
  profiles: 50,
  grants: 200,
  limits: 200,
  members: 500,
  matchers: 50,
  name: 100,
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A policy as given (a page's, or the chart's), checked: it says what's wrong, or it's sound. */
export function checkedPolicy(given: unknown, where: string): AccessPolicy {
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`)
  }
  const object = (value: unknown, at: string) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      fail(`${at} isn’t a map.`)
    return value as Record<string, unknown>
  }
  const list = (value: unknown, at: string, max: number) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) fail(`${at} isn’t a list.`)
    if ((value as unknown[]).length > max) fail(`${at} has more than ${max}.`)
    return value as unknown[]
  }
  const texts = (value: unknown, at: string, max: number) =>
    list(value, at, max).map((item, i) => {
      if (typeof item !== 'string' || item === '' || item.length > 256)
        fail(`${at}[${i}] isn’t a name.`)
      return item as string
    })
  const name = (value: unknown, at: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > ACCESS_LIMITS.name) {
      fail(`${at} needs a name of at most ${ACCESS_LIMITS.name} characters.`)
    }
    return (value as string).trim()
  }
  const levels = (value: unknown, at: string, partial: boolean): Partial<Levels> => {
    const map = object(value, at)
    const out: Partial<Levels> = {}
    for (const [key, level] of Object.entries(map)) {
      const allowed = (CAPABILITIES as Record<string, readonly string[]>)[key]
      if (!allowed) fail(`${at}.${key} isn’t something Lumovi lets people do.`)
      if (!allowed!.includes(level as string))
        fail(`${at}.${key} is ${allowed!.join(', ')}, not “${String(level)}”.`)
      ;(out as Record<string, unknown>)[key] = level
    }
    if (!partial) {
      for (const key of CAPABILITY_KEYS) if (!(key in out)) fail(`${at} doesn’t say ${key}.`)
    }
    return out
  }
  const matchers = (value: unknown, at: string) =>
    texts(value, at, ACCESS_LIMITS.matchers).map((text, i) => {
      const parsed = parseMatcher(text)
      if (typeof parsed === 'string') fail(`${at}[${i}] (“${text}”): ${parsed}`)
      return text
    })
  const ids = (kind: string) => {
    const seen = new Set<string>()
    return (value: unknown, at: string) => {
      if (typeof value !== 'string' || !ID.test(value))
        fail(`${at} needs an id: lowercase letters, digits and -.`)
      if (seen.has(value as string)) fail(`there are two ${kind} with the id “${String(value)}”.`)
      seen.add(value as string)
      return value as string
    }
  }

  const root = object(given, 'It')
  const everyone = levels(root.everyone ?? EVERYTHING, 'everyone', false) as Levels
  const groupId = ids('groups')
  const groups = list(root.groups, 'groups', ACCESS_LIMITS.groups).map((value, i) => {
    const at = `groups[${i}]`
    const g = object(value, at)
    return {
      id: groupId(g.id, `${at}.id`),
      name: name(g.name, `${at}.name`),
      ...(typeof g.description === 'string' && g.description.trim()
        ? { description: g.description.trim().slice(0, 200) }
        : {}),
      provider: texts(g.provider, `${at}.provider`, ACCESS_LIMITS.members),
      people: texts(g.people, `${at}.people`, ACCESS_LIMITS.members),
    }
  })
  const profileId = ids('profiles')
  const profiles = list(root.profiles, 'profiles', ACCESS_LIMITS.profiles).map((value, i) => {
    const at = `profiles[${i}]`
    const p = object(value, at)
    return {
      id: profileId(p.id, `${at}.id`),
      name: name(p.name, `${at}.name`),
      values: levels(p.values, `${at}.values`, false) as Levels,
    }
  })
  const known = (kind: string, all: { id: string }[]) => (id: string, at: string) => {
    if (!all.some((x) => x.id === id)) fail(`${at} names a ${kind} there isn’t: “${id}”.`)
    return id
  }
  const group = known('group', groups)
  const profile = known('profile', profiles)
  const grantId = ids('grants')
  const grants = list(root.grants, 'grants', ACCESS_LIMITS.grants).map((value, i) => {
    const at = `grants[${i}]`
    const g = object(value, at)
    return {
      id: grantId(g.id, `${at}.id`),
      name: name(g.name, `${at}.name`),
      who: texts(g.who, `${at}.who`, ACCESS_LIMITS.groups).map((id, j) =>
        group(id, `${at}.who[${j}]`),
      ),
      profile: profile(String(g.profile), `${at}.profile`),
      clusters: matchers(g.clusters, `${at}.clusters`),
      namespaces: matchers(g.namespaces, `${at}.namespaces`),
    }
  })
  const limitId = ids('limits')
  const limits = list(root.limits, 'limits', ACCESS_LIMITS.limits).map((value, i) => {
    const at = `limits[${i}]`
    const l = object(value, at)
    const caps = levels(l.caps ?? {}, `${at}.caps`, true)
    for (const [key, level] of Object.entries(caps) as [Capability, string][]) {
      if (rankOf(key, level as never) === CAPABILITIES[key].length - 1) {
        fail(`${at}.caps.${key} is ${level}, which limits nothing: it’s the most there is.`)
      }
    }
    return {
      id: limitId(l.id, `${at}.id`),
      name: name(l.name, `${at}.name`),
      who: texts(l.who, `${at}.who`, ACCESS_LIMITS.groups).map((id, j) =>
        group(id, `${at}.who[${j}]`),
      ),
      clusters: matchers(l.clusters, `${at}.clusters`),
      namespaces: matchers(l.namespaces, `${at}.namespaces`),
      caps,
    }
  })
  const names: Record<string, string> = {}
  for (const [key, value] of Object.entries(object(root.names ?? {}, 'names'))) {
    if (key.length > 256 || typeof value !== 'string' || value.length > ACCESS_LIMITS.name) {
      fail(`names.${key} isn’t a name of at most ${ACCESS_LIMITS.name} characters.`)
    }
    if ((value as string).trim()) names[key] = (value as string).trim()
  }
  return { everyone, groups, profiles, grants, limits, names }
}

/** What the chart (or the server's settings) sets: changed there, never here. */
export interface BasePolicy {
  policy: AccessPolicy
  /** Whether it says what everyone gets: then that's the chart's too. */
  setsEveryone: boolean
}

/** The chart's, locked, with what admins set here: never one of the chart's changed by them. */
export function mergedPolicy(base: BasePolicy | undefined, kept: AccessPolicy): AccessPolicy {
  if (!base) return kept
  const b = base.policy
  const lock = <T extends { id: string }>(items: T[]) =>
    items.map((item) => ({ ...item, locked: true }))
  const own = <T extends { id: string }>(items: T[], locked: T[]) =>
    items.filter((item) => !locked.some((l) => l.id === item.id))
  return {
    everyone: base.setsEveryone ? b.everyone : kept.everyone,
    ...(base.setsEveryone ? { everyoneLocked: true } : {}),
    groups: [...lock(b.groups), ...own(kept.groups, b.groups)],
    profiles: [...lock(b.profiles), ...own(kept.profiles, b.profiles)],
    grants: [...lock(b.grants), ...own(kept.grants, b.grants)],
    limits: [...lock(b.limits), ...own(kept.limits, b.limits)],
    names: { ...kept.names, ...b.names },
  }
}

/** What's kept of a policy as admins set it: all but the chart's (by its ids, whatever's sent). */
export function ownPart(policy: AccessPolicy, base: BasePolicy | undefined): AccessPolicy {
  const ids = (items: { id: string }[] | undefined) => new Set((items ?? []).map((x) => x.id))
  const b = base?.policy
  const without = <T extends { id: string }>(items: T[], locked: Set<string>) =>
    items.filter((item) => !locked.has(item.id))
  return {
    everyone: policy.everyone,
    groups: without(policy.groups, ids(b?.groups)),
    profiles: without(policy.profiles, ids(b?.profiles)),
    grants: without(policy.grants, ids(b?.grants)),
    limits: without(policy.limits, ids(b?.limits)),
    names: policy.names,
  }
}
