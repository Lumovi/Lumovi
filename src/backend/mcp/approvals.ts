/**
 * Changes AI assistants ask for, waiting for the person's answer: shown in
 * Lumovi with their diff, approved or rejected there. Nobody answers in time,
 * and one expires; the assistant gives up on it, and it's withdrawn.
 *
 * An assistant's call waits for the answer a while at most (many give a call a
 * minute), then hears it's still waiting, and asks again: what became of the
 * change is kept for it meanwhile.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ChangeProposal, ProposalDecision } from '@shared/assistants'

/** How long a change waits for an answer (LUMOVI_APPROVAL_TIMEOUT_MS, for tests). */
export const APPROVAL_TIMEOUT_MS = Number(process.env.LUMOVI_APPROVAL_TIMEOUT_MS) || 5 * 60_000

/**
 * How long one call waits for it: under the minute the MCP SDK gives a call
 * unless told otherwise (LUMOVI_APPROVAL_SLICE_MS, for tests).
 */
export const WAIT_SLICE_MS = Number(process.env.LUMOVI_APPROVAL_SLICE_MS) || 50_000

/** That long, in words: "5 minutes". */
export const approvalTime = (ms = APPROVAL_TIMEOUT_MS) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`

export type Answer = ProposalDecision | { expired: true } | { withdrawn: true }

/** A page's answer, checked: a change's id, whether it's approved, and maybe a note. */
export function checkedDecision(id: unknown, decision: unknown): [string, ProposalDecision] {
  const { approved, note } = Object(decision) as { approved?: unknown; note?: unknown }
  if (
    typeof id !== 'string' ||
    typeof approved !== 'boolean' ||
    (note !== undefined && (typeof note !== 'string' || note.length > 2_000))
  ) {
    throw new Error('Expected a change’s id, whether it’s approved, and a note')
  }
  return [id, approved ? { approved } : { approved, ...(note ? { note } : {}) }]
}

export class Approvals {
  readonly #waiting = new Map<string, { proposal: ChangeProposal; answer: (a: Answer) => void }>()
  /** What became of each change, for the calls that wait for it (forgotten when it expires). */
  readonly #results = new Map<string, Promise<CallToolResult>>()

  /** `proposed` shows a change, for the person to answer. */
  constructor(private readonly proposed: (proposal: ChangeProposal) => void) {}

  /** Shows `proposal`; `settle` makes it, or doesn't, once it's answered, and says how that went. */
  ask(proposal: ChangeProposal, settle: (answer: Answer) => Promise<CallToolResult>): void {
    const { id, expiresAt } = proposal
    const answered = new Promise<Answer>((resolve) => {
      // Once: whichever comes first clears the others.
      const answer = (given: Answer) => {
        this.#waiting.delete(id)
        clearTimeout(timer)
        resolve(given)
      }
      const timer = setTimeout(() => answer({ expired: true }), Math.max(0, expiresAt - Date.now()))
      this.#waiting.set(id, { proposal, answer })
    })
    this.#results.set(id, answered.then(settle))
    // An assistant asks soon after it's answered, if at all: no later than it would have expired.
    setTimeout(
      () => this.#results.delete(id),
      Math.max(0, expiresAt - Date.now()) + WAIT_SLICE_MS,
    ).unref()
    this.proposed(proposal)
  }

  /**
   * What became of change `id`, once it's answered and done; "waiting" if it
   * isn't within a slice of time, or undefined if there's no such change.
   * `signal` withdraws it (the assistant gave up).
   */
  wait(id: string, signal: AbortSignal): Promise<CallToolResult | 'waiting' | undefined> {
    const result = this.#results.get(id)
    if (!result) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const done = (outcome: CallToolResult | 'waiting') => {
        clearTimeout(slice)
        signal.removeEventListener('abort', withdraw)
        resolve(outcome)
      }
      const slice = setTimeout(() => done('waiting'), WAIT_SLICE_MS)
      const withdraw = () => this.#waiting.get(id)?.answer({ withdrawn: true })
      signal.addEventListener('abort', withdraw, { once: true })
      void result.then(done)
    })
  }

  /** The person's answer; one to a change no longer waiting (it expired, say) is dropped. */
  decide(id: string, decision: ProposalDecision): void {
    this.#waiting.get(id)?.answer(decision)
  }

  /** Withdraws everything waiting: assistants may no longer ask (they were turned off, say). */
  withdrawAll(): void {
    for (const id of [...this.#waiting.keys()]) this.withdraw(id)
  }

  /** Withdraws one, if it's still waiting: its assistant may no longer ask (it was let go, say). */
  withdraw(id: string): void {
    this.#waiting.get(id)?.answer({ withdrawn: true })
  }

  /** What's waiting now, oldest first. */
  pending(): ChangeProposal[] {
    return [...this.#waiting.values()].map(({ proposal }) => proposal)
  }
}
