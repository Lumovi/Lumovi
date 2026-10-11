/**
 * What a terminal sends its shell: what's typed, and the answers the terminal gives by itself
 * when a shell (or the console it runs in) asks it something as it starts: where the cursor is,
 * what kind of terminal this is. A shell may wait for such an answer before it says anything.
 *
 * So nothing is dropped while the shell is still being opened: it's kept, and sent in order,
 * once, when the shell is open. The two can't be told apart as they come, so what's typed in
 * that moment is kept as well, as any terminal keeps it. What's sent after the shell has ended
 * goes nowhere.
 */
export class ShellInput {
  #kept: string[] = []
  #held = 0
  #full = false
  #state: 'connecting' | 'open' | 'over' = 'connecting'
  readonly #send: (data: string) => void

  constructor(send: (data: string) => void) {
    this.#send = send
  }

  /**
   * Something for the shell: sent now if it's open, kept if it's still being opened. Once
   * something doesn't fit in what's kept, it and everything after it is dropped: what's sent on
   * opening is what came first, whole, with no gap in it. (Half a line with its middle gone
   * would be worse than none of it.)
   */
  take(data: string): void {
    if (this.#state === 'open') this.#send(data)
    else if (this.#state === 'connecting' && !this.#full) {
      if (this.#held + data.length > KEPT_AT_MOST) {
        this.#full = true
        return
      }
      this.#kept.push(data)
      this.#held += data.length
    }
  }

  /** The shell is open: what was kept goes to it, in the order it came, and never again. */
  opened(): void {
    if (this.#state !== 'connecting') return
    this.#state = 'open'
    const kept = this.#kept
    this.#kept = []
    for (const data of kept) this.#send(data)
  }

  /** The shell failed to open, or ended: nothing more is sent, and what was kept is forgotten. */
  over(): void {
    this.#state = 'over'
    this.#kept = []
  }
}

/** The most kept for a shell that isn't open yet: answers are a few characters each, and a
 *  moment's typing a few more. */
const KEPT_AT_MOST = 4096
