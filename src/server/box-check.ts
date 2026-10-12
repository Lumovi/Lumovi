/**
 * The server's half of Lumovi's check of a plugin's box in a browser: it starts a check for a
 * session, catches what reaches it of one, and judges. A check's nonce is good once, for its
 * session, for a short while; what reaches the catcher with any other nonce is let go and not
 * counted, so nobody can fill the server through it, nor fail someone else's check. A result
 * is kept per session, for the box's policy as it is: a server that changes the box's headers
 * checks every browser again. Nothing is kept on disk: a restart asks again.
 */
import { randomBytes } from 'node:crypto'
import {
  BOX_CHECK_LIMITS,
  boxCheckCode,
  judgeReport,
  PAGE_SEES,
  type BoxCheckWay,
} from '@shared/box-check'

/** How a check came out: passed, failed (something got out), or didn't finish. */
export type BoxCheckResult = 'passed' | 'failed' | 'unfinished'

/** What's said of a check once judged: its result, and which ways got out, where any did. */
export interface Judged {
  result: BoxCheckResult
  /** The ways that got out: what reached the catcher, what the worker saw reach, the page heard. */
  out: string[]
  /** Whether it's the session's first such result for the box's walls as they are: said once. */
  first: boolean
}

/** Results kept at once, at most: one a session. */
const RESULTS_KEPT = 10_000

export class BoxChecks {
  readonly #now: () => number
  /** Checks going, by their nonce: whose, since when, what reached the catcher. */
  readonly #live = new Map<string, { key: string; started: number; caught: Set<string> }>()
  /** Each session's last result, and the box's policy it was for. */
  readonly #results = new Map<string, { policy: string; judged: Judged }>()

  /** `policy`: what the box's walls are now (their headers' digest): a result holds for it alone. */
  constructor(
    private readonly policy: string,
    now: () => number = () => Date.now(),
  ) {
    this.#now = now
  }

  /** A new check for the session `key`: its nonce. Any check of the session's still going ends. */
  start(key: string): string {
    this.#sweep()
    for (const [nonce, live] of this.#live) if (live.key === key) this.#live.delete(nonce)
    const nonce = randomBytes(16).toString('base64url')
    this.#live.set(nonce, { key, started: this.#now(), caught: new Set() })
    return nonce
  }

  /** Something reached the catcher, said to be `way` of check `nonce`: counted only for a live one. */
  caught(nonce: string, way: string): void {
    const live = this.#live.get(nonce)
    if (!live || this.#now() - live.started > BOX_CHECK_LIMITS.nonceLiveMs) return
    if (live.caught.size < BOX_CHECK_LIMITS.hitsANonce) live.caught.add(way.slice(0, 40))
  }

  /**
   * Judges the session's check `nonce`: what its worker reported (nothing, if it didn't answer),
   * and which ways Lumovi's own page found under the check's name, as it never should. Nothing, for a nonce that isn't
   * the session's live check: it's taken back once judged.
   */
  end(
    key: string,
    nonce: string,
    report: unknown,
    pageHeard: readonly string[],
  ): Judged | undefined {
    const live = this.#live.get(nonce)
    if (!live || live.key !== key) return undefined
    this.#live.delete(nonce)
    const late = this.#now() - live.started > BOX_CHECK_LIMITS.answerWithinMs
    const judged = judgeReport(report, nonce)
    const out = [
      ...live.caught,
      ...(judged?.reached ?? []).filter((way: BoxCheckWay) => !live.caught.has(way)),
      // (What Lumovi's own page found under the check's name: only the ways it can see.)
      ...PAGE_SEES.filter((way) => pageHeard.includes(way) && !live.caught.has(way)),
    ]
    const result: BoxCheckResult =
      // What got out fails it, whatever was or wasn't said; silence, or lateness, is unfinished;
      // a report that isn't whole (a way left out) fails.
      out.length > 0
        ? 'failed'
        : report === undefined || report === null || late
          ? 'unfinished'
          : judged
            ? 'passed'
            : 'failed'
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

  /** The session's last result, if there's one for the box's walls as they are now. */
  result(key: string): BoxCheckResult | undefined {
    const kept = this.#results.get(key)
    return kept?.policy === this.policy ? kept.judged.result : undefined
  }

  /** The session is gone: nothing of it is kept. */
  forget(key: string): void {
    this.#results.delete(key)
    for (const [nonce, live] of this.#live) if (live.key === key) this.#live.delete(nonce)
  }

  #sweep(): void {
    const now = this.#now()
    for (const [nonce, live] of this.#live) {
      if (now - live.started > BOX_CHECK_LIMITS.nonceLiveMs) this.#live.delete(nonce)
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
 * The code a box runs for a check. In the tests' build alone, `LUMOVI_TEST_BOX_CHECK=silent`
 * makes it one that never answers, so a test sees silence fail. (Nothing of it is in a release.)
 */
export function checkCode(catcher: string, nonce: string, env: NodeJS.ProcessEnv): string {
  return LUMOVI_TEST_BUILD && env.LUMOVI_TEST_BOX_CHECK === 'silent'
    ? 'box.then(() => {})'
    : boxCheckCode(catcher, nonce)
}
