/**
 * The server's half of Lumovi's check of a plugin's box in a browser: it starts a check for a
 * session, catches what reaches it of one, and judges. A check's nonce is good once, for its
 * session, for a short while; what reaches the catcher with any other nonce is let go and not
 * counted, so nobody can fill the server through it, nor fail someone else's check. What reaches
 * it after the check is judged, while the nonce lives, still fails it. A result is kept per
 * session, for the box's policy as it is: a server that changes the box's headers checks every
 * browser again. Nothing is kept on disk: a restart asks again.
 */
import { randomBytes } from 'node:crypto'
import {
  BOX_CHECK_LIMITS,
  BOX_CHECK_ROLES,
  BOX_CHECK_WAYS,
  boxCheckCode,
  judgeReport,
  PAGE_SEES,
  type BoxCheckRole,
  type Look,
  type Reported,
} from '@shared/box-check'

/** How a check came out: passed, failed (something got out), or didn't finish. */
export type BoxCheckResult = 'passed' | 'failed' | 'unfinished'

/** What's said of a check once judged: its result, and which ways got out, where any did. */
export interface Judged {
  result: BoxCheckResult
  /**
   * The ways that got out: what reached the catcher, what a box saw reach, what the page heard,
   * and what one box found of another's.
   */
  out: string[]
  /** Whether it's the session's first such result for the box's walls as they are: said once. */
  first: boolean
}

/** What a page hands back of a check: each box's report, or nothing where one didn't answer. */
export type BoxReports = Partial<Record<BoxCheckRole, string | null>>

/** Results kept at once, at most: one a session. */
const RESULTS_KEPT = 10_000
/** A session's checks at once, at most (a page in two tabs checks in both): the oldest goes first. */
const CHECKS_A_KEY = 4

/** What one box found of another's, as a way out is named. */
const FOUND: Record<'beside' | 'later', Record<Look, string>> = {
  beside: {
    'broadcast-channel': 'broadcast-channel shared between boxes',
    caches: 'caches shared between boxes',
    'indexed-db': 'indexed-db shared between boxes',
  },
  later: {
    'broadcast-channel': 'broadcast-channel kept after its box closed',
    caches: 'caches kept after its box closed',
    'indexed-db': 'indexed-db kept after its box closed',
  },
}

interface Check {
  key: string
  started: number
  /** What reached the catcher of it: each way by its name, and anything else as `other`. */
  caught: Set<string>
  /** Once judged: who's told if something still reaches the catcher of it. */
  late?: (judged: Judged) => void
}

export class BoxChecks {
  readonly #now: () => number
  /** Checks going, or judged a moment ago, by their nonce. */
  readonly #checks = new Map<string, Check>()
  /** Each session's last result, and the box's policy it was for. */
  readonly #results = new Map<string, { policy: string; judged: Judged }>()
  /** Who's told when a session's check fails after it was judged: its pages, which then end. */
  readonly #watching = new Map<string, Set<() => void>>()

  /** `policy`: what the box's walls are now (their headers' digest): a result holds for it alone. */
  constructor(
    private readonly policy: string,
    now: () => number = () => Date.now(),
  ) {
    this.#now = now
  }

  /** A new check for the session `key`: its nonce. Past a few of the session's, the oldest ends. */
  start(key: string): string {
    this.#sweep()
    const mine = [...this.#checks].filter(([, check]) => check.key === key)
    while (mine.length >= CHECKS_A_KEY) this.#checks.delete(mine.shift()![0])
    const nonce = randomBytes(16).toString('base64url')
    this.#checks.set(nonce, { key, started: this.#now(), caught: new Set() })
    return nonce
  }

  /**
   * Something reached the catcher, said to be `way` of check `nonce`: counted only for a live one,
   * by a way's name or as `other`. Of one already judged, it fails it.
   */
  caught(nonce: string, way: string): void {
    const check = this.#checks.get(nonce)
    if (!check || this.#now() - check.started > BOX_CHECK_LIMITS.nonceLiveMs) return
    const named = (BOX_CHECK_WAYS as readonly string[]).includes(way) ? way : 'other'
    if (check.late) this.#lateOut(check, named)
    else check.caught.add(named)
  }

  /**
   * Judges the session's check `nonce`: what its boxes reported (nothing, for one that didn't
   * answer), and which ways Lumovi's own page found under the check's names, as it never should.
   * Nothing, for a nonce that isn't the session's check going: it's judged once. `late` is told if
   * something reaches the catcher of it afterwards, while the nonce lives.
   */
  end(
    key: string,
    nonce: string,
    reports: unknown,
    pageHeard: readonly string[],
    late: (judged: Judged) => void = () => {},
  ): Judged | undefined {
    const check = this.#checks.get(nonce)
    if (!check || check.key !== key || check.late) return undefined
    check.late = late
    const overdue = this.#now() - check.started > BOX_CHECK_LIMITS.answerWithinMs
    // (A page hands back an object of the boxes' reports; anything else isn't a report at all.)
    const whole = typeof reports === 'object' && reports !== null && !Array.isArray(reports)
    const said: Partial<Record<BoxCheckRole, unknown>> = whole
      ? (reports as Record<string, unknown>)
      : {}
    const missing = (role: BoxCheckRole) => said[role] === undefined || said[role] === null
    const judged = {
      first: judgeReport(said.first, nonce, 'first'),
      second: judgeReport(said.second, nonce, 'second'),
      later: judgeReport(said.later, nonce, 'later'),
    } satisfies Record<BoxCheckRole, Reported | undefined>
    const out = [
      ...new Set([
        ...check.caught,
        ...(judged.first?.reached ?? []),
        ...(judged.second?.reached ?? []),
        // (What Lumovi's own page found under the check's names: only the ways it can see.)
        ...PAGE_SEES.filter((way) => pageHeard.includes(way)),
        ...[...(judged.first?.found ?? []), ...(judged.second?.found ?? [])].map(
          (look) => FOUND.beside[look],
        ),
        ...(judged.later?.found ?? []).map((look) => FOUND.later[look]),
      ]),
    ]
    const result: BoxCheckResult =
      // What got out fails it, whatever was or wasn't said; silence (from any box), or lateness,
      // is unfinished; a report that isn't whole (a way left out) fails.
      out.length > 0
        ? 'failed'
        : reports === undefined ||
            reports === null ||
            overdue ||
            (whole && BOX_CHECK_ROLES.some(missing))
          ? 'unfinished'
          : judged.first && judged.second && judged.later
            ? 'passed'
            : 'failed'
    return this.#keep(key, { result, out })
  }

  /** The session's last result, if there's one for the box's walls as they are now. */
  result(key: string): BoxCheckResult | undefined {
    const kept = this.#results.get(key)
    return kept?.policy === this.policy ? kept.judged.result : undefined
  }

  /** Tells `failed` when the session's check fails after it was judged; what stops telling it. */
  watch(key: string, failed: () => void): () => void {
    let watching = this.#watching.get(key)
    if (!watching) this.#watching.set(key, (watching = new Set()))
    watching.add(failed)
    return () => {
      watching.delete(failed)
      if (watching.size === 0 && this.#watching.get(key) === watching) this.#watching.delete(key)
    }
  }

  /** The session is gone: nothing of it is kept. */
  forget(key: string): void {
    this.#results.delete(key)
    this.#watching.delete(key)
    for (const [nonce, check] of this.#checks) if (check.key === key) this.#checks.delete(nonce)
  }

  /**
   * Something reached the catcher of a check already judged: it got out after all. A session
   * whose last result is a failure already is told nothing new; any other's fails now, is said
   * as any failure is, and its pages are told.
   */
  #lateOut(check: Check, way: string): void {
    const kept = this.#results.get(check.key)
    if (kept?.policy === this.policy && kept.judged.result === 'failed') return
    const judged = this.#keep(check.key, { result: 'failed', out: [way] })
    check.late!(judged)
    for (const failed of [...(this.#watching.get(check.key) ?? [])]) failed()
  }

  #keep(key: string, { result, out }: Omit<Judged, 'first'>): Judged {
    const before = this.#results.get(key)
    const first = before?.policy !== this.policy || before.judged.result !== result
    const done = { result, out, first }
    this.#results.delete(key)
    this.#results.set(key, { policy: this.policy, judged: done })
    // (Sessions come and go: the oldest results are let go first, so it stays small.)
    while (this.#results.size > RESULTS_KEPT)
      this.#results.delete(this.#results.keys().next().value!)
    return done
  }

  #sweep(): void {
    const now = this.#now()
    for (const [nonce, check] of this.#checks) {
      if (now - check.started > BOX_CHECK_LIMITS.nonceLiveMs) this.#checks.delete(nonce)
    }
  }
}

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

/**
 * The box's headers as they're served: its walls. In the tests' build alone,
 * `LUMOVI_TEST_BOX_WALL_OFF=connect-src` takes one of them away on purpose, so that a test sees
 * the check fail and no code handed over. A release build has no such switch: nothing of it is
 * built into one.
 */
export function boxWalls(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return LUMOVI_TEST_BUILD && env.LUMOVI_TEST_BOX_WALL_OFF === 'connect-src'
    ? {
        ...headers,
        'Content-Security-Policy': headers['Content-Security-Policy']!.replace(
          "connect-src 'none'",
          'connect-src *',
        ),
      }
    : headers
}

/**
 * The code each of a check's boxes runs. In the tests' build alone, `LUMOVI_TEST_BOX_CHECK=silent`
 * makes them boxes that never answer, so a test sees silence fail. (Nothing of it is in a release.)
 */
export function checkCode(
  catcher: string,
  nonce: string,
  env: NodeJS.ProcessEnv,
): Record<BoxCheckRole, string> {
  const silent = LUMOVI_TEST_BUILD && env.LUMOVI_TEST_BOX_CHECK === 'silent'
  return Object.fromEntries(
    BOX_CHECK_ROLES.map((role) => [
      role,
      silent ? 'box.then(() => {})' : boxCheckCode(catcher, nonce, role),
    ]),
  ) as Record<BoxCheckRole, string>
}
