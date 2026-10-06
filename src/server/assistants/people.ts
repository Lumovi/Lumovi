/**
 * The people a server's AI assistants act for: each person's changes waiting
 * for approval, and their open pages, which show them, and are told what
 * became of them. A change one of their assistants asks for is theirs alone.
 */
import { IPC } from '@shared/api'
import { Approvals } from '@backend/mcp/approvals'

/** One of a person's pages: told of their assistants' changes, and of their assistants. */
export interface PersonsPage {
  emit(channel: string, ...args: unknown[]): void
  /** Their assistants changed (one was allowed, or let go): the page asks again. */
  changed(): void
}

export class People {
  readonly #approvals = new Map<string, Approvals>()
  /** Everyone's open pages, with whose each is. */
  readonly #pages = new Set<{ person: string; page: PersonsPage }>()

  /** `person`'s changes waiting for approval, shown on their pages. */
  approvals(person: string): Approvals {
    let theirs = this.#approvals.get(person)
    if (!theirs) {
      theirs = new Approvals((proposal) => this.tell(person, IPC.assistantsProposal, proposal))
      this.#approvals.set(person, theirs)
    }
    return theirs
  }

  /** A page of `person`'s, until it closes (what this returns detaches it). */
  attach(person: string, page: PersonsPage): () => void {
    const entry = { person, page }
    this.#pages.add(entry)
    return () => void this.#pages.delete(entry)
  }

  /** Tells each of `person`'s open pages. */
  tell(person: string, channel: string, ...args: unknown[]): void {
    for (const entry of this.#pages) if (entry.person === person) entry.page.emit(channel, ...args)
  }

  /** `person`'s assistants changed. */
  changed(person: string): void {
    for (const entry of this.#pages) if (entry.person === person) entry.page.changed()
  }
}
