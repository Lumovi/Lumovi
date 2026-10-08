/**
 * Clusters connected from the Fleet page: an admin says what the fleet calls the cluster, its
 * labels and who sees it, and the hub makes a join token for its agent. The token is shown once,
 * works once, and for an hour; only its SHA-256 is kept, with what a restart mustn't lose
 * (state.ts), read again every few seconds (its agent may reach another replica). Made,
 * cancelled, used, and tried once it no longer works: each is recorded.
 *
 * The join token isn't the agent's credential: it's exchanged for one. Given it, the hub makes
 * the agent a credential of its own (its SHA-256 alone kept), which the agent keeps in its
 * Secret, in its cluster, and connects with. Only that first connection spends the join token,
 * so an agent that stopped half way can join again with it, within its hour. What was shown on
 * the page, copied, and kept in Helm's history is no use then; the credential never left the
 * cluster but to the hub.
 *
 * Only Lumovi's admins connect clusters, so a server without admins connects none; nor one that
 * keeps nothing, which would forget them when it restarts.
 *
 * Whoever can write where state is kept can't make a join (entries are sealed), but can put back
 * an older copy of one, from before its token was used. A replica that saw it used never takes
 * it again, and it stops working when it would have, an hour after it was made.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuditActor } from '@shared/audit'
import {
  clusterNameError,
  groupError,
  labelKeyError,
  labelValueError,
  MAX_GROUPS,
  type FleetJoin,
  type FleetJoinRequest,
  type FleetJoins,
  type NewFleetJoin,
} from '@shared/fleet'
import type { SessionUser } from '@shared/server'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import type { ServerAccess } from '../access'
import { SERVER_ACTOR } from '../audit'
import { log } from '../log'
import type { ServerState } from '../state'
import { prefix } from './agents'

/** How long a join's token works (LUMOVI_FLEET_JOIN_SECONDS, for tests). */
const JOIN_MS = (Number(process.env.LUMOVI_FLEET_JOIN_SECONDS) || 3600) * 1000
/** How long a join is kept once its token no longer works: to say so, to an agent that tries it. */
const KEPT_MS = 24 * 3_600_000
/** How often what's kept is read again. */
const REFRESH_MS = 10_000
/**
 * The least time between reads of what's kept for a token this replica doesn't know: tokens that
 * never were can't have it read again and again.
 */
const REREAD_MS = 2_000
/** How often a token that no longer works is recorded, for each join, as it's tried. */
const REFUSED_EVERY_MS = 60_000
/** What a join's token starts with: one found where it shouldn't be says what it is. */
const TOKEN_PREFIX = 'lumovi_join_'
/** What an agent's credential, made for it as it joins, starts with. */
const CREDENTIAL_PREFIX = 'lumovi_agent_'

/** A join, as kept (by the cluster's name): the cluster's, once its agent joined. */
interface Kept extends FleetJoinRequest {
  /** Which join it is: the cluster's, once joined (another of its name is another). */
  id: string
  /** Its token's SHA-256 (hex): the token itself is shown once, never kept. */
  tokenSha256: string
  by: string
  at: string
  /** When its token stops working (ms). */
  until: number
  /** The credential made for its agent (its SHA-256), until the agent connects with it. */
  pending?: { credentialSha256: string; at: string }
  /** When its agent first connected with its credential, and which replica's that was. */
  used?: { at: string; by: string }
  /** Its agent's credential (its SHA-256), once it joined. */
  credentialSha256?: string
  refused?: string
  /** When it's let go (state.ts deletes what's expired); none, once joined. */
  expires?: number
}

/** An agent that joined from the Fleet page: as LUMOVI_FLEET_AGENTS would name it. */
export interface JoinedAgent {
  name: string
  /** Its credential's SHA-256 (hex). */
  tokenSha256: string
  labels: Record<string, string>
  groups?: string[]
  forwardToken: false
  joined: { id: string; at: string; by: string }
}

/** Why an agent's join token was refused: a token that never was this cluster's, or no longer works. */
export type JoinRefusal = 'unknown' | 'expired' | 'used'

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex')

/** Whether `token` is the one `sha256Hex` is of: compared in constant time. */
const isOf = (token: string, sha256Hex: string | undefined) =>
  sha256Hex !== undefined &&
  timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(sha256Hex, 'hex'))

/** A join as its admins see it. */
const shown = (kept: Kept): FleetJoin => ({
  name: kept.name,
  labels: kept.labels,
  groups: kept.groups,
  by: kept.by,
  at: kept.at,
  until: new Date(kept.until).toISOString(),
  ...(kept.used ? { used: kept.used.at } : {}),
  ...(kept.refused ? { refused: kept.refused } : {}),
})

/** A request, checked: what the fleet calls the cluster, its labels and its groups. */
function checked(request: unknown): FleetJoinRequest {
  const { name, labels, groups } = (request ?? {}) as Partial<Record<string, unknown>>
  const invalid = (message: string) => new KubeRequestError('invalid', message)
  if (typeof name !== 'string') throw invalid('Give the cluster a name.')
  const nameError = clusterNameError(name)
  if (nameError) throw invalid(`Its name: ${nameError}.`)
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
  if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string')) {
    throw invalid('Its groups must be a list of text, like [platform, sre].')
  }
  if (groups.length > MAX_GROUPS) throw invalid(`Up to ${MAX_GROUPS} groups may see it.`)
  for (const group of groups as string[]) {
    const error = groupError(group)
    if (error) throw invalid(`Its group “${group}”: ${error}.`)
  }
  return {
    name,
    labels: { ...(labels as Record<string, string>) },
    groups: [...new Set(groups as string[])],
  }
}

export class Joins {
  readonly #refresher?: NodeJS.Timeout
  /** The tokens this replica saw used: never taken again, whatever's put back where it's kept. */
  readonly #spent = new Set<string>()
  /** When each join's refused token was last recorded. */
  readonly #refusedAt = new Map<string, number>()
  /** What's kept, being read again for a token this replica doesn't know; and when it last was. */
  #rereading?: Promise<unknown>
  #rereadAt = 0
  /** Told when joined agents may have changed: one joined, or removed, here or on a replica. */
  readonly #listeners = new Set<() => void>()

  constructor(
    private readonly state: ServerState,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
    /** Whether the fleet already has a cluster by that name (one connected from here too). */
    private readonly taken: (name: string) => boolean,
  ) {
    this.#saw()
    if (state.kept !== 'memory') {
      this.#refresher = setInterval(() => void this.#read(), REFRESH_MS)
      this.#refresher.unref()
    }
  }

  /** Why `user` may not connect clusters, or nothing when they may. */
  whyNot(user: SessionUser): string | undefined {
    if (!this.access.administered) {
      return 'Clusters are connected from this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).'
    }
    if (!this.access.isAdmin(user)) return 'Only Lumovi’s admins connect clusters to the fleet.'
    return undefined
  }

  /**
   * Why no cluster may be connected here, whoever asks: where nothing keeps them, a restart would
   * forget them, and their agents with them.
   */
  get #unkept(): string | undefined {
    return this.state.kept === 'memory'
      ? 'This server keeps nothing when it restarts, so it would forget the clusters connected here: keep its state (the chart’s auth.keepSessions, or LUMOVI_DATA_DIR).'
      : undefined
  }

  /** An admin's: the clusters being connected (and those connected a little while ago). */
  list(user: SessionUser): FleetJoins {
    this.#allowed(user)
    const joins = this.state
      .entries<Kept>('joins')
      .map(([, kept]) => shown(kept))
      .sort((a, b) => b.at.localeCompare(a.at))
    const whyNot = this.#unkept
    return { joins, ...(whyNot ? { whyNot } : {}) }
  }

  /**
   * An admin's: a join for a cluster, with its token (shown once). One made again for a cluster
   * whose token wasn't used replaces it: the old token no longer works.
   */
  async create(request: unknown, user: SessionUser, actor: AuditActor): Promise<NewFleetJoin> {
    const why = this.whyNot(user)
    if (why) {
      this.audit.record({
        action: 'agent.join-created',
        outcome: 'refused',
        actor,
        ...(typeof (request as { name?: unknown })?.name === 'string'
          ? { cluster: (request as { name: string }).name }
          : {}),
        summary: 'Wasn’t let connect a cluster to the fleet',
        error: why,
      })
      throw new KubeRequestError('not-allowed', why, 403)
    }
    const unkept = this.#unkept
    if (unkept) throw new KubeRequestError('invalid', unkept)
    const wanted = checked(request)
    await this.#read()
    const before = this.state.get<Kept>('joins', wanted.name)
    // (A join not yet used isn't in the fleet: made again, it's replaced.)
    if (before?.used || this.taken(wanted.name)) {
      throw new KubeRequestError(
        'invalid',
        `The fleet has a cluster called ${wanted.name} already: give this one another name.`,
      )
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const now = Date.now()
    const until = now + JOIN_MS
    const kept: Kept = {
      ...wanted,
      id: randomUUID(),
      tokenSha256: sha256(token),
      by: user.name,
      at: new Date(now).toISOString(),
      until,
      expires: until + KEPT_MS,
    }
    // Over another replica's join of that name that its agent used meanwhile: that one's kept.
    this.state.set('joins', wanted.name, kept, (current) =>
      (current as Kept | undefined)?.used ? current : kept,
    )
    // Kept before it's shown: its agent may reach another replica, or this one restarted.
    await this.state.flush({ strict: true })
    await this.#read()
    if (this.state.get<Kept>('joins', wanted.name)?.id !== kept.id) {
      throw new KubeRequestError(
        'invalid',
        `${wanted.name} joined the fleet meanwhile, from another of Lumovi’s replicas: it’s in the fleet already.`,
      )
    }
    this.audit.record({
      action: 'agent.join-created',
      outcome: 'success',
      actor,
      cluster: wanted.name,
      summary: `Made a join token for ${wanted.name}’s agent, which works once`,
      details: {
        labels: Object.entries(wanted.labels).map(([key, value]) => `${key}=${value}`),
        groups: wanted.groups,
        until: new Date(until).toISOString(),
        token: prefix(kept.tokenSha256),
        ...(before ? { replaced: prefix(before.tokenSha256) } : {}),
      },
    })
    log(`${user.name} made a join token for ${wanted.name}’s agent (SHA-256 ${kept.tokenSha256})`)
    return { join: shown(kept), token }
  }

  /** An admin's: a join whose token wasn't used, let go (its token no longer works). */
  async cancel(name: unknown, user: SessionUser, actor: AuditActor): Promise<void> {
    this.#allowed(user)
    if (typeof name !== 'string') {
      throw new KubeRequestError('invalid', 'Expected a cluster’s name.')
    }
    await this.#read()
    const kept = this.state.get<Kept>('joins', name)
    if (!kept) {
      throw new KubeRequestError('not-found', `No cluster called ${name} is being connected.`)
    }
    if (kept.used) {
      throw new KubeRequestError(
        'invalid',
        `${name}’s agent used its token already: it’s in the fleet.`,
      )
    }
    // Over its agent's join, on another replica meanwhile: that's kept, and it's refused.
    this.state.delete('joins', name, (current) =>
      (current as Kept | undefined)?.used ? current : undefined,
    )
    await this.state.flush({ strict: true })
    await this.#read()
    if (this.state.get<Kept>('joins', name)?.used) {
      throw new KubeRequestError(
        'invalid',
        `${name}’s agent joined meanwhile, through another of Lumovi’s replicas: it’s in the fleet.`,
      )
    }
    this.audit.record({
      action: 'agent.join-cancelled',
      outcome: 'success',
      actor,
      cluster: name,
      summary: `Cancelled connecting ${name}: its join token no longer works`,
      details: { token: prefix(kept.tokenSha256) },
    })
  }

  /**
   * The join a name and token are, if the token works now; or why not. A join made on another
   * replica is read first. One that no longer works, tried, is recorded (now and then).
   */
  async check(
    name: string,
    token: string,
  ): Promise<{ join: FleetJoin } | { refused: JoinRefusal }> {
    let kept = this.state.get<Kept>('joins', name)
    if (!kept || !isOf(token, kept.tokenSha256)) {
      await this.#reread()
      kept = this.state.get<Kept>('joins', name)
    }
    if (!kept || !isOf(token, kept.tokenSha256)) return { refused: 'unknown' }
    const refused: JoinRefusal | undefined =
      kept.used || this.#spent.has(kept.tokenSha256)
        ? 'used'
        : kept.until < Date.now()
          ? 'expired'
          : undefined
    if (!refused) return { join: shown(kept) }
    this.#refused(kept, refused)
    return { refused }
  }

  /**
   * A credential for the agent that gives a join's token, while it works: kept (its SHA-256) as
   * the join's, until the agent connects with it. Given again, the token gets another, and the
   * one before no longer joins.
   */
  async issue(
    name: string,
    token: string,
  ): Promise<{ credential: string } | { refused: JoinRefusal }> {
    const checked = await this.check(name, token)
    if ('refused' in checked) return checked
    const credential = `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`
    const pending = { credentialSha256: sha256(credential), at: new Date().toISOString() }
    const tokenSha256 = sha256(token)
    const issued = (current: unknown) => {
      const kept = current as Kept | undefined
      return kept && kept.tokenSha256 === tokenSha256 && !kept.used && kept.until >= Date.now()
        ? { ...kept, pending }
        : kept
    }
    this.state.set('joins', name, issued(this.state.get('joins', name)), issued)
    // Kept before it's given: the agent may connect with it to another replica.
    await this.state.flush({ strict: true })
    await this.#read()
    if (
      this.state.get<Kept>('joins', name)?.pending?.credentialSha256 !== pending.credentialSha256
    ) {
      return { refused: 'used' }
    }
    log(`${name}’s agent was given its credential, for its join token`)
    return { credential }
  }

  /**
   * Whether `credential` is `name`'s joined agent's: as it is, or as it was given, its first
   * connection with it spending its join token (on any replica, the first written is the join).
   */
  async admit(name: string, credential: string): Promise<boolean> {
    let kept = this.state.get<Kept>('joins', name)
    const known = (k: Kept | undefined) =>
      isOf(credential, k?.credentialSha256) || isOf(credential, k?.pending?.credentialSha256)
    if (!known(kept)) {
      await this.#reread()
      kept = this.state.get<Kept>('joins', name)
    }
    if (!kept || !known(kept)) return false
    if (isOf(credential, kept.credentialSha256)) return true
    // A token this replica saw used, joining again (an older copy put back where it's kept):
    // refused before anything's written.
    if (this.#spent.has(kept.tokenSha256)) return false
    const credentialSha256 = kept.pending!.credentialSha256
    const use = { at: new Date().toISOString(), by: randomUUID() }
    // Joined only if its token works still, as it's written: unused, and not yet expired.
    const joined = (current: unknown) => {
      const kept = current as Kept | undefined
      if (
        !kept ||
        kept.used ||
        kept.until < Date.now() ||
        kept.pending?.credentialSha256 !== credentialSha256
      ) {
        return kept
      }
      const { pending: _pending, expires: _expires, ...rest } = kept
      return { ...rest, used: use, credentialSha256 }
    }
    this.state.set('joins', name, joined(kept), joined)
    await this.state.flush({ strict: true })
    await this.#read()
    const now = this.state.get<Kept>('joins', name)
    // Another replica's join, with this credential: it's in.
    if (now?.used?.by !== use.by) return isOf(credential, now?.credentialSha256)
    this.#spent.add(now.tokenSha256)
    // Its join, this one: a new cluster, whose certificate authority is the one it first sends,
    // not one kept by its name (only now: one that lost mustn't undo the winner's).
    this.state.delete('agents', name)
    await this.state.flush({ strict: true })
    this.audit.record({
      action: 'agent.joined',
      outcome: 'success',
      actor: SERVER_ACTOR,
      cluster: name,
      summary: `${name}’s agent joined the fleet, with the credential made for its join token`,
      details: { token: prefix(now.tokenSha256), credential: prefix(credentialSha256) },
    })
    log(`${name}’s agent joined the fleet`)
    this.#tell()
    return true
  }

  /** Why `name`'s agent's credential was refused, as this replica knows: for the log. */
  refusal(name: string, credential: string): JoinRefusal {
    const kept = this.state.get<Kept>('joins', name)
    if (kept && isOf(credential, kept.pending?.credentialSha256)) {
      return kept.used || this.#spent.has(kept.tokenSha256) ? 'used' : 'expired'
    }
    return 'unknown'
  }

  /** The agents that joined from the page, as the hub takes them. */
  joined(): JoinedAgent[] {
    return this.state.entries<Kept>('joins').flatMap(([, kept]) =>
      kept.used && kept.credentialSha256
        ? [
            {
              name: kept.name,
              tokenSha256: kept.credentialSha256,
              labels: kept.labels,
              ...(kept.groups.length ? { groups: kept.groups } : {}),
              forwardToken: false as const,
              joined: { id: kept.id, at: kept.used.at, by: kept.by },
            },
          ]
        : [],
    )
  }

  /**
   * An admin's: a cluster that joined from the page, removed: its agent's credential no longer
   * works (its agent is let go at once), and it's recorded.
   */
  async remove(name: unknown, user: SessionUser, actor: AuditActor): Promise<void> {
    this.#allowed(user)
    if (typeof name !== 'string') {
      throw new KubeRequestError('invalid', 'Expected a cluster’s name.')
    }
    await this.#read()
    const kept = this.state.get<Kept>('joins', name)
    if (!kept?.used) {
      throw new KubeRequestError(
        'not-found',
        `No cluster called ${name} was connected from this page.`,
      )
    }
    this.state.delete('joins', name)
    // What its certificate authority was trusted with goes too: it was this cluster's.
    this.state.delete('agents', name)
    await this.state.flush({ strict: true })
    this.audit.record({
      action: 'cluster.removed',
      outcome: 'success',
      actor,
      cluster: name,
      summary: `Removed ${name} from the fleet: its agent’s credential no longer works`,
      details: { credential: prefix(kept.credentialSha256 ?? '') },
    })
    this.#tell()
  }

  /** Tells `listener` whenever joined agents may have changed. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  close(): void {
    clearInterval(this.#refresher)
  }

  /** What's kept, read again (another replica's joins, and their uses): where something keeps it. */
  async #read(): Promise<void> {
    if (this.state.kept !== 'memory' && (await this.state.refresh('joins'))) {
      this.#saw()
      this.#tell()
    }
  }

  /** The join tokens seen used, as what's kept is read: never taken again here. */
  #saw(): void {
    for (const [, kept] of this.state.entries<Kept>('joins')) {
      if (kept.used) this.#spent.add(kept.tokenSha256)
    }
  }

  #tell(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Read again for a token this replica doesn't know, now and then: once at a time. */
  async #reread(): Promise<void> {
    if (!this.#rereading && Date.now() - this.#rereadAt < REREAD_MS) return
    this.#rereading ??= this.#read().finally(() => {
      this.#rereadAt = Date.now()
      this.#rereading = undefined
    })
    await this.#rereading
  }

  #allowed(user: SessionUser): void {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
  }

  /** A token that no longer works, tried: when, kept for the page, and recorded (now and then). */
  #refused(kept: Kept, why: 'expired' | 'used'): void {
    const now = Date.now()
    if (now - (this.#refusedAt.get(kept.name) ?? 0) < REFUSED_EVERY_MS) return
    this.#refusedAt.set(kept.name, now)
    const at = new Date(now).toISOString()
    const tried = (current: unknown) =>
      current && (current as Kept).tokenSha256 === kept.tokenSha256
        ? { ...(current as Kept), refused: at }
        : current
    this.state.set('joins', kept.name, tried(kept), tried)
    void this.state.flush()
    const said =
      why === 'used'
        ? `its agent used it ${kept.used ? `at ${kept.used.at}` : 'already'}`
        : `it stopped working at ${new Date(kept.until).toISOString()}`
    this.audit.record({
      action: 'agent.join-refused',
      outcome: 'refused',
      actor: SERVER_ACTOR,
      cluster: kept.name,
      summary: `Refused a join token for ${kept.name}: ${said}`,
      details: { why, token: prefix(kept.tokenSha256) },
    })
    log(`A join token for ${kept.name} was refused: ${said}`)
  }
}
