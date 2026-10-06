/**
 * Who may do what through a Lumovi server: the policy its admins set on the
 * Access page (over what the chart says, which they can't change there),
 * kept where AI rules are; who's an admin (LUMOVI_ADMINS); who's signed in
 * lately, with the groups their provider sent; and, for each person, a
 * guard that Lumovi's services ask before they act.
 */
import { createHash } from 'node:crypto'
import type { AccessGuard } from '@shared/access'
import type { Handler } from '@backend/handlers'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import type { KubeService } from '@backend/kube/service'
import { NamespaceLabels } from '@backend/mcp/access'
import {
  accessDecider,
  allows,
  because,
  canonical,
  changesOf,
  checkedPolicy,
  mergedPolicy,
  OPEN_POLICY,
  ownPart,
  policyFor,
  samePerson,
  SCOPES,
  usesLabels,
  type AccessDecision,
  type AccessPolicy,
  type AdminAccess,
  type BasePolicy,
  type MyAccess,
  type SeenPerson,
} from '@shared/access'
import type { AiTarget } from '@shared/ai-permissions'
import { IPC, type Result } from '@shared/api'
import type { AuditActor } from '@shared/audit'
import type { SessionUser } from '@shared/server'
import { SERVER_ACTOR } from './audit'
import { ConfigError, type AccessConfig, type AuthConfig } from './config'
import { keeper, MAX_KEPT_BYTES, type Keeper, type Kept } from './kept'
import { log } from './log'

/** How far back the people seen are found, when the server starts: in its audit history. */
const SEEN_DAYS = 30
/** How many people are remembered as seen, at most (the least recently seen go first). */
const MAX_SEEN = Number(process.env.LUMOVI_ACCESS_SEEN_MAX) || 2_000
/** How often what's kept is read again: another replica (or someone, by hand) may change it. */
const REFRESH_MS = Number(process.env.LUMOVI_ACCESS_REFRESH_MS) || 15_000

/** What a policy holds, by kind. */
type Part = 'groups' | 'profiles' | 'grants' | 'limits'

/**
 * What was kept, with what the chart says now: what names something the chart no longer has
 * goes (a grant of a profile it took away; a group it took away, from who a grant's for), and
 * the log says so. A grant or limit for no group left is for nobody: it goes too.
 */
function pruned(
  given: unknown,
  base: BasePolicy | undefined,
  said: (dropped: string[]) => void,
): unknown {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return given
  const kept = given as Record<string, unknown>
  // What isn't made as it should be is the check's to say.
  const parts: Part[] = ['groups', 'profiles', 'grants', 'limits']
  const malformed = (list: unknown) =>
    list !== undefined &&
    (!Array.isArray(list) ||
      list.some((item) => typeof item !== 'object' || item === null || Array.isArray(item)))
  if (parts.some((key) => malformed(kept[key]))) return given
  const items = (key: Part) => (kept[key] as Record<string, unknown>[] | undefined) ?? []
  const mine = (key: Part): Record<string, unknown>[] => {
    const theirs = (base?.policy[key] ?? []) as unknown as Record<string, unknown>[]
    const ids = new Set(theirs.map((x) => x.id))
    return [...theirs, ...items(key).filter((x) => !ids.has(x.id as string))]
  }
  const groups = mine('groups')
  const profiles = mine('profiles')
  const groupIds = new Set(groups.map((g) => g.id))
  const profileIds = new Set(profiles.map((p) => p.id))
  const dropped: string[] = []
  const forSomeone = (key: 'grants' | 'limits') =>
    mine(key).flatMap((item) => {
      if (item.who !== undefined && !Array.isArray(item.who)) return [item]
      const named = (item.who as unknown[] | undefined) ?? []
      const who = named.filter((id) => groupIds.has(id as string))
      const gone =
        (who.length === 0 && named.length > 0) ||
        (key === 'grants' && !profileIds.has(item.profile as string))
      if (gone) dropped.push(`the ${key === 'grants' ? 'grant' : 'limit'} “${String(item.name)}”`)
      return gone ? [] : [{ ...item, who }]
    })
  const grants = forSomeone('grants')
  const limits = forSomeone('limits')
  said(dropped)
  return { ...kept, groups, profiles, grants, limits }
}

/**
 * What's kept, as read: the policy, and whether Lumovi wrote it (a replica of it, through its
 * page) or someone changed it where it's kept, by hand: a seal of it says which.
 */
interface Stored {
  policy: AccessPolicy
  sealed: boolean
}

const seal = (policy: unknown) => createHash('sha256').update(canonical(policy)).digest('hex')

/** How what admins set is kept: as JSON, checked on its way in, with the chart's. */
function keptAs(base: BasePolicy | undefined): Kept<Stored> {
  // What the chart no longer has is said once, not each time it's read again.
  let told = ''
  const tell = (dropped: string[]) => {
    if (dropped.length && dropped.join() !== told) {
      log(
        `Access: ${dropped.join(', ')} named groups or profiles the chart no longer has, and no longer apply.`,
      )
    }
    told = dropped.join()
  }
  return {
    what: 'access settings',
    key: 'access.json',
    empty: { policy: ownPart(OPEN_POLICY, base), sealed: true },
    write: ({ policy }) => JSON.stringify({ version: 1, policy, seal: seal(policy) }),
    read: (text, where) => {
      let parsed: { policy?: unknown; seal?: unknown } | null
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new ConfigError(`${where} isn’t JSON: Lumovi can’t read who may do what, kept there.`)
      }
      try {
        const given = parsed?.policy
        return {
          policy: ownPart(checkedPolicy(pruned(given, base, tell), where), base),
          sealed: parsed?.seal === seal(given),
        }
      } catch (error) {
        throw new ConfigError((error as Error).message, { cause: error })
      }
    },
  }
}

/** A refusal that the person's access says: what they may not do, where, and why not. */
const notAllowed = (doing: string, where: string, decision: AccessDecision[keyof AccessDecision]) =>
  new KubeRequestError(
    'not-allowed',
    `Lumovi doesn’t let you ${doing} ${where}: ${because(decision.from)}.`,
    403,
  )

/** Something saved against what it read, when someone else saved since. */
export class AccessConflict extends Error {}

export class ServerAccess {
  #policy: AccessPolicy
  /** Which policy it is: guards decide afresh when it changes. */
  #generation = 0
  readonly #seen = new Map<string, SeenPerson>()
  readonly #listeners = new Set<() => void>()
  #refresher?: NodeJS.Timeout
  #refreshFailed = false

  private constructor(
    private readonly config: AccessConfig,
    private readonly keeper: Keeper<Stored>,
    private readonly audit: AuditLog,
    private readonly provider: AdminAccess['provider'],
    own: AccessPolicy,
  ) {
    this.#policy = mergedPolicy(config.base, own)
  }

  /** Reads what's kept: it can't be, or makes no sense, and the server doesn't start. */
  static async open(
    config: AccessConfig,
    auth: AuthConfig,
    env: NodeJS.ProcessEnv,
    audit: AuditLog,
  ): Promise<ServerAccess> {
    // With no admins, nobody sets anything: there's nothing to keep, nor say about it.
    const administered = config.admins.groups.length > 0 || config.admins.users.length > 0
    const kept = keeper(administered ? config.keep : { kind: 'memory' }, keptAs(config.base), env, {
      quiet: !administered,
    })
    const provider: AdminAccess['provider'] =
      auth.mode === 'oidc'
        ? { mode: 'oidc', name: auth.provider, claim: auth.groupsClaim }
        : auth.mode === 'proxy'
          ? { mode: 'proxy', name: 'your proxy', claim: auth.groupsHeader }
          : { mode: 'token', name: 'Kubernetes' }
    const access = new ServerAccess(config, kept, audit, provider, (await kept.read()).policy)
    await access.#seenLately()
    if (administered && kept.kept !== 'memory') {
      access.#refresher = setInterval(() => void access.#refresh(), REFRESH_MS)
      access.#refresher.unref()
    }
    return access
  }

  get policy(): AccessPolicy {
    return this.#policy
  }

  isAdmin(user: SessionUser): boolean {
    const { admins } = this.config
    return (
      admins.users.some((name) => samePerson(name, user.name)) ||
      user.groups.some((g) => admins.groups.includes(g))
    )
  }

  /** Tells `listener` whenever the policy changes (here, or as kept by someone else). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Someone signed in: the groups their provider sent, now. */
  saw(user: SessionUser, via: SeenPerson['via'], at = new Date().toISOString()): void {
    this.#seen.delete(user.name)
    this.#seen.set(user.name, { name: user.name, groups: user.groups, seen: at, via })
    if (this.#seen.size > MAX_SEEN) this.#seen.delete(this.#seen.keys().next().value!)
  }

  /**
   * The people seen lately, when the server starts: who the audit history says signed in, or
   * did anything through the page (behind a proxy, nobody signs in to Lumovi itself).
   */
  async #seenLately(): Promise<void> {
    const from = new Date(Date.now() - SEEN_DAYS * 86_400_000).toISOString()
    const page = await this.audit.query({ from, via: ['ui'], limit: 1000 }, () => true)
    // The newest first: the oldest is seen first, so the newest is what's kept. (A sign-in
    // that failed is nobody's.)
    for (const event of [...page.events].reverse().filter((e) => e.outcome === 'success')) {
      const { user, groups } = event.actor
      this.saw({ name: user, groups: groups ?? [] }, this.provider.mode, event.time)
    }
  }

  /** What `user` may do anywhere, as the policy is now. */
  decider(user: SessionUser): (target: AiTarget) => AccessDecision {
    return accessDecider(this.#policy, user)
  }

  /** Whether `user`'s access lets them read everyone's audit events. */
  readsEveryone(user: SessionUser): boolean {
    return this.decider(user)({ cluster: { name: '' } }).audit.value === 'all'
  }

  /** What `user` may do, as Lumovi's services ask (with namespaces' labels as they may read them). */
  guard(user: SessionUser, kube: KubeService): AccessGuard {
    const labels = new NamespaceLabels(kube)
    let compiled: { generation: number; decide: (t: AiTarget) => AccessDecision; labels: boolean }
    const decide = () => {
      if (compiled?.generation !== this.#generation) {
        compiled = {
          generation: this.#generation,
          decide: accessDecider(this.#policy, user),
          // Labels are read only where they could change what's decided.
          labels: usesLabels(policyFor(this.#policy, user)),
        }
      }
      return compiled
    }
    const at = async (context: string, namespace: string | undefined) => {
      const { decide: d, labels: needed } = decide()
      const cluster = {
        name: context,
        labels: kube.contexts().contexts.find((c) => c.name === context)?.labels,
      }
      if (namespace === undefined) return d({ cluster })
      const found = needed ? await labels.of(context, namespace) : {}
      return d({ cluster, namespace: { name: namespace, labels: found } })
    }
    return {
      require: async (context, cap, level, namespace, doing) => {
        const where = SCOPES[cap] === 'namespace' ? namespace : undefined
        const decision = await at(context, where)
        if (allows(decision, cap, level)) return
        throw notAllowed(
          doing,
          where === undefined ? `on ${context}` : `in ${where}`,
          decision[cap],
        )
      },
      secrets: async (context, namespace) => (await at(context, namespace)).secrets.value,
    }
  }

  /** Someone's own: what applies to them, and nothing about anyone else. */
  /** (Whether they're an auditor is the page's connection's to say: LUMOVI_AUDITORS too.) */
  mine(user: SessionUser): Omit<MyAccess, 'auditor'> {
    return {
      person: user,
      policy: policyFor(this.#policy, user),
      admins: [...this.config.admins.groups, ...this.config.admins.users],
      provider: this.provider.name,
      admin: this.isAdmin(user),
    }
  }

  /** All of it, for an admin's page. */
  admin(): AdminAccess {
    return {
      policy: this.#policy,
      version: this.keeper.version(),
      seen: [...this.#seen.values()].reverse(),
      admins: [
        ...this.config.admins.groups,
        ...this.config.admins.users.map((user) => `user:${user}`),
      ],
      provider: this.provider,
      kept: this.keeper.kept,
    }
  }

  /**
   * Keeps an admin's change, checked, against the version they read: if someone else saved
   * since, it's refused (an AccessConflict), and theirs is what's kept.
   */
  async set(given: unknown, version: unknown, actor: AuditActor): Promise<AdminAccess> {
    if (version !== this.keeper.version()) {
      throw new AccessConflict(
        'Someone else changed access since you opened it. Theirs is shown now: make your change again.',
      )
    }
    const policy = checkedPolicy(given, 'Access')
    const own = ownPart(policy, this.config.base)
    if (
      Buffer.byteLength(keptAs(this.config.base).write({ policy: own, sealed: true })) >
      MAX_KEPT_BYTES
    ) {
      throw new Error('Lumovi can’t keep that much: who may do what would be over 1 MB.')
    }
    const before = this.#policy
    try {
      await this.keeper.write({ policy: own, sealed: true })
    } catch (error) {
      if (toKubeError(error).code === 'conflict') {
        await this.#refresh()
        throw new AccessConflict(
          'Someone else changed access since you opened it. Theirs is shown now: make your change again.',
        )
      }
      throw new Error(`Lumovi couldn’t keep who may do what: ${toKubeError(error).message}`, {
        cause: error,
      })
    }
    this.#use(own)
    this.#record(before, actor)
    return this.admin()
  }

  /** What changed since `before`, recorded: by an admin, or (`actor` the server's) by hand. */
  #record(before: AccessPolicy, actor: AuditActor): void {
    const changes = changesOf(before, this.#policy)
    if (!changes.length) return
    const outside = actor === SERVER_ACTOR
    this.audit.record({
      action: 'access.changed',
      outcome: 'success',
      actor,
      summary: `${outside ? 'Changed outside Lumovi: ' : ''}${changes[0]}${changes.length > 1 ? `, and ${changes.length - 1} more` : ''}`,
      details: { changes, ...(outside ? { outside: true } : {}) },
    })
  }

  #use(own: AccessPolicy): void {
    this.#policy = mergedPolicy(this.config.base, own)
    this.#generation++
    for (const listener of this.#listeners) listener()
  }

  /**
   * What's kept, read again: someone else's change applies here too. Another replica's was
   * recorded there; one made by hand, where it's kept, is recorded here.
   */
  async #refresh(): Promise<void> {
    const was = this.keeper.version()
    try {
      const stored = await this.keeper.read()
      if (this.#refreshFailed) log('Access: Lumovi reads who may do what again.')
      this.#refreshFailed = false
      if (this.keeper.version() !== was) {
        const before = this.#policy
        this.#use(stored.policy)
        if (!stored.sealed) this.#record(before, SERVER_ACTOR)
      }
    } catch (error) {
      // What it last read still holds.
      if (!this.#refreshFailed) {
        log(`Access: Lumovi can’t read who may do what again: ${(error as Error).message}`)
      }
      this.#refreshFailed = true
    }
  }

  close(): void {
    clearInterval(this.#refresher)
  }
}

/** What a page asks of access: its person's own, and (an admin) all of it. */
export function accessHandlers(
  access: ServerAccess,
  user: SessionUser,
  actor: AuditActor,
  audit: AuditLog,
  /** Whether they read everyone's events, LUMOVI_AUDITORS included. */
  auditor: () => boolean,
  emit: (channel: string, ...args: unknown[]) => void,
): { invoke: Record<string, Handler>; stop(): void } {
  const admin = () => {
    if (!access.isAdmin(user)) {
      throw new Error('Only Lumovi’s admins (LUMOVI_ADMINS) see who may do what.')
    }
  }
  const stop = access.onChange(() => emit(IPC.accessChanged))
  return {
    invoke: {
      [IPC.accessMine]: () => ({ ...access.mine(user), auditor: auditor() }),
      [IPC.accessAdmin]: () => {
        admin()
        return access.admin()
      },
      [IPC.accessSet]: async (policy, version): Promise<Result<AdminAccess>> => {
        admin()
        try {
          return { ok: true, data: await access.set(policy, version, actor) }
        } catch (error) {
          const conflict = error instanceof AccessConflict
          return {
            ok: false,
            error: { code: conflict ? 'conflict' : 'invalid', message: (error as Error).message },
          }
        }
      },
      [IPC.accessHistory]: (after) => {
        admin()
        if (after !== undefined && (typeof after !== 'string' || !/^\d+$/.test(after))) {
          throw new Error('Where the page ended isn’t one Lumovi gave.')
        }
        return audit.query({ actions: ['access.changed'], after, limit: 50 }, () => true)
      },
    },
    stop: () => void stop(),
  }
}
