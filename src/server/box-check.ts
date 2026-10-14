/**
 * The server's half of Lumovi's check of a plugin's box in a browser: it starts a check for a
 * session, catches what reaches it of one, and judges. A check's nonce is good once, for its
 * session, for a short while; what reaches the catcher with any other nonce is let go and not
 * counted, so nobody can fill the server through it, nor fail someone else's check. What reaches
 * it after the check is judged, while the nonce lives, still fails it. A check has a second
 * nonce, the control's, which no box is told: a sealed frame of Lumovi's own asks the catcher
 * with it, and a check whose control didn't arrive in every shape a box's request has can't be
 * judged (a catcher nothing so shaped reaches sees no box let anything out). A result is kept per
 * session, for the box's policy as it is: a server that changes the box's headers checks every
 * browser again. Nothing is kept on disk: a restart asks again.
 */
import { randomBytes } from 'node:crypto'
import {
  BOX_CHECK_CONTROLS,
  BOX_CHECK_LIMITS,
  BOX_CHECK_ROLES,
  BOX_CHECK_WAYS,
  boxCheckCode,
  judgeReport,
  PAGE_SEES,
  type BoxCheckControl,
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
  /**
   * Where a look couldn't be made (Lumovi's own page's, or a box's): a check that couldn't look
   * didn't finish, whatever else it found nothing of. (Unfinished for this alone, it isn't offered
   * again: the same browser couldn't look again.)
   */
  unlooked: string[]
  /**
   * The shapes Lumovi's own request (the control) didn't arrive in, where the check didn't
   * finish: with one missing, nothing is known of what a box lets out, since a box's request so
   * shaped may not reach the catcher at all. (It isn't offered again as it is: the same browser,
   * behind the same things, would reach it no better.)
   */
  unreached: BoxCheckControl[]
  /**
   * The boxes whose reports came back in a form Lumovi couldn't read, where that alone failed it:
   * nothing is known to have got out, and nothing says it did.
   */
  unreadable?: BoxCheckRole[]
}

/** What a page hands back of a check: each box's report, or nothing where one didn't answer. */
export type BoxReports = Partial<Record<BoxCheckRole, string | null>>

/**
 * The shape a request to the catcher has, if it's one a box's could have: told by what it
 * carried, never by its address. A box, and the check's own sealed frame, ask from an origin
 * that's nobody's: a request of theirs says `Origin: null` or no origin at all, a socket of
 * theirs `Origin: null`, and where a browser says what site a request is from, theirs says
 * another site's (measured in the three engines; one leaves it off a socket). Anything else
 * (Lumovi's own page asking, say) has no box's shape, and stands in for none.
 *
 * (A browser that says nothing of sites at all could have its own page stand in for the one
 * shape that says no origin, and for no other. Such a browser's session isn't one the server
 * holds to coming from Lumovi's page, so it's handed no code whatever its check says: the two
 * rules are read together.)
 */
export function controlShape(
  headers: { origin?: string | undefined; 'sec-fetch-site'?: string | string[] | undefined },
  upgrade: boolean,
): BoxCheckControl | undefined {
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'cross-site') return undefined
  if (upgrade) return headers.origin === 'null' ? 'socket' : undefined
  return headers.origin === undefined
    ? 'http-without-origin'
    : headers.origin === 'null'
      ? 'http-with-origin'
      : undefined
}

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
  /** Its control's nonce: what Lumovi's own sealed frame asks the catcher with, and no box knows. */
  control: string
  /** How its control arrived, so far. */
  arrived: Set<BoxCheckControl>
  /** What reached the catcher of it: each way by its name, and anything else as `other`. */
  caught: Set<string>
  /** Once judged: who's told if something still reaches the catcher of it. */
  late?: (judged: Judged) => void
}

export class BoxChecks {
  readonly #now: () => number
  /** Checks going, or judged a moment ago, by their nonce. */
  readonly #checks = new Map<string, Check>()
  /** The same checks by their control's nonce. */
  readonly #controls = new Map<string, Check>()
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

  /**
   * A new check for the session `key`: its nonce, which its boxes aim at, and its control's,
   * which Lumovi's own sealed frame does. Past a few of the session's, the oldest ends.
   */
  start(key: string): { nonce: string; control: string } {
    this.#sweep()
    const mine = [...this.#checks].filter(([, check]) => check.key === key)
    while (mine.length >= CHECKS_A_KEY) this.#drop(mine.shift()![0])
    const nonce = randomBytes(16).toString('base64url')
    const control = randomBytes(16).toString('base64url')
    const check = {
      key,
      started: this.#now(),
      control,
      arrived: new Set<BoxCheckControl>(),
      caught: new Set<string>(),
    }
    this.#checks.set(nonce, check)
    this.#controls.set(control, check)
    return { nonce, control }
  }

  /**
   * Something reached the catcher, said to be `way` of check `nonce`, in the shape `shape` (what
   * it carried, as `controlShape` reads it; none, where it has no box's shape): counted only for
   * a live check. With a check's own nonce it's a box's: counted by a way's name or as `other`,
   * and of one already judged, it fails it. With its control's it says only that the catcher can
   * be reached in that shape, and nothing where it has none.
   */
  caught(nonce: string, way: string, shape?: BoxCheckControl): void {
    const live = (check: Check | undefined): check is Check =>
      check !== undefined && this.#now() - check.started <= BOX_CHECK_LIMITS.nonceLiveMs
    const controlled = this.#controls.get(nonce)
    if (live(controlled)) {
      if (shape) controlled.arrived.add(shape)
      return
    }
    const check = this.#checks.get(nonce)
    if (!live(check)) return
    const named = (BOX_CHECK_WAYS as readonly string[]).includes(way) ? way : 'other'
    if (check.late) this.#lateOut(check, named)
    else check.caught.add(named)
  }

  /**
   * Judges the session's check `nonce`: what its boxes reported (nothing, for one that didn't
   * answer), which ways Lumovi's own page found under the check's names, as it never should, and
   * where that page couldn't look. Nothing, for a nonce that isn't the session's check going: it's
   * judged once. `late` is told if something reaches the catcher of it afterwards, while the nonce
   * lives.
   */
  end(
    key: string,
    nonce: string,
    reports: unknown,
    pageHeard: readonly string[],
    pageUnlooked: readonly string[] = [],
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
    // Where a look couldn't be made: Lumovi's own page's (only the ways it looks for), and a box's
    // where the box it looked for kept something. (A box's store refused, as a box's walls refuse
    // it, is one no box kept in: nothing to find there, and nothing can reach a box through it.)
    const kept = (role: 'first' | 'second', look: Look) => judged[role]?.ways?.[look] === 'sent'
    const unlooked = [
      ...new Set([
        ...PAGE_SEES.filter((way) => pageUnlooked.includes(way)),
        ...(judged.first?.unlooked ?? []).filter((look) => kept('second', look)),
        ...(judged.second?.unlooked ?? []).filter((look) => kept('first', look)),
        ...(judged.later?.unlooked ?? []).filter(
          (look) => kept('first', look) || kept('second', look),
        ),
      ]),
    ]
    // The control: the shapes Lumovi's own request didn't arrive in. With one missing, an empty
    // catcher says nothing of the boxes: it may be that nothing so shaped reaches it.
    const unreached = BOX_CHECK_CONTROLS.filter((by) => !check.arrived.has(by))
    const result: BoxCheckResult =
      // What got out fails it, whatever was or wasn't said; silence (from any box), lateness or a
      // look that couldn't be made is unfinished; a report that isn't whole (a way left out)
      // fails. And what would have passed passes only if the control arrived, in every shape:
      // without it, it's unfinished too.
      out.length > 0
        ? 'failed'
        : reports === undefined ||
            reports === null ||
            overdue ||
            (whole && BOX_CHECK_ROLES.some(missing)) ||
            unlooked.length > 0
          ? 'unfinished'
          : !(judged.first && judged.second && judged.later)
            ? 'failed'
            : unreached.length > 0
              ? 'unfinished'
              : 'passed'
    // (Failed with nothing out: a report it couldn't read, which is said as that.)
    const unreadable = whole
      ? BOX_CHECK_ROLES.filter((role) => !missing(role) && !judged[role])
      : [...BOX_CHECK_ROLES]
    return this.#keep(key, {
      result,
      out,
      unlooked: result === 'unfinished' ? unlooked : [],
      unreached: result === 'unfinished' ? unreached : [],
      ...(result === 'failed' && out.length === 0 && { unreadable }),
    })
  }

  /**
   * Whether the session's last result, for the box's walls as they are now, didn't finish because
   * Lumovi's own request didn't reach the catcher: a check that's no use running again from the
   * same page.
   */
  unreached(key: string): boolean {
    const kept = this.#results.get(key)
    return kept?.policy === this.policy && kept.judged.unreached.length > 0
  }

  /**
   * Whether the session's last result, for the box's walls as they are now, didn't finish because
   * a look couldn't be made: a check that's no use running again in the same browser.
   */
  unlooked(key: string): boolean {
    const kept = this.#results.get(key)
    return kept?.policy === this.policy && kept.judged.unlooked.length > 0
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
    for (const [nonce, check] of this.#checks) if (check.key === key) this.#drop(nonce)
  }

  /**
   * Something reached the catcher of a check already judged: it got out after all. A session
   * whose last result is a failure already is told nothing new; any other's fails now, is said
   * as any failure is, and its pages are told.
   */
  #lateOut(check: Check, way: string): void {
    const kept = this.#results.get(check.key)
    if (kept?.policy === this.policy && kept.judged.result === 'failed') return
    const judged = this.#keep(check.key, {
      result: 'failed',
      out: [way],
      unlooked: [],
      unreached: [],
    })
    check.late!(judged)
    for (const failed of [...(this.#watching.get(check.key) ?? [])]) failed()
  }

  #keep(
    key: string,
    { result, out, unlooked, unreached, unreadable }: Omit<Judged, 'first'>,
  ): Judged {
    const before = this.#results.get(key)
    // A browser that let something out stays failed for its session: no later check, not even
    // one that started before the failure, makes it pass again.
    if (
      before?.policy === this.policy &&
      before.judged.result === 'failed' &&
      result !== 'failed'
    ) {
      return { ...before.judged, first: false }
    }
    // (Couldn't look, or couldn't be reached, or not as before, is a result of its own: said
    // once, too.)
    const first =
      before?.policy !== this.policy ||
      before.judged.result !== result ||
      before.judged.unlooked.join() !== unlooked.join() ||
      before.judged.unreached.join() !== unreached.join()
    const done = { result, out, first, unlooked, unreached, ...(unreadable && { unreadable }) }
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
      if (now - check.started > BOX_CHECK_LIMITS.nonceLiveMs) this.#drop(nonce)
    }
  }

  /** Lets a check go, with its control. */
  #drop(nonce: string): void {
    const check = this.#checks.get(nonce)
    if (check) this.#controls.delete(check.control)
    this.#checks.delete(nonce)
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
