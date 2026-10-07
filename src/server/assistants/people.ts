/**
 * The people a server's AI assistants act for: each person's changes waiting
 * for approval, and their open pages, which show them, and are told what
 * became of them. A change one of their assistants asks for is theirs alone.
 */
import { isDeepStrictEqual } from 'node:util'
import { IPC } from '@shared/api'
import { Approvals } from '@backend/mcp/approvals'
import type { ServerState } from '../state'

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
  /**
   * The clusters each person made read-only for themselves, as their latest page said: kept,
   * so that after a restart their assistants hold to it before their page says it again.
   */
  readonly #readOnly = new Map<string, string[]>()

  constructor(private readonly state?: ServerState) {
    for (const [person, contexts] of state?.entries<string[]>('readOnly') ?? []) {
      if (Array.isArray(contexts) && contexts.every((context) => typeof context === 'string')) {
        this.#readOnly.set(person, contexts)
      }
    }
  }

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

  /** Whether `person` made `context` read-only for themselves: their assistants change nothing there. */
  isReadOnly(person: string, context: string): boolean {
    return this.#readOnly.get(person)?.includes(context) === true
  }

  /** What `person`'s page says they made read-only (each page says it as it opens, and as it changes). */
  setReadOnly(person: string, contexts: string[]): void {
    if (isDeepStrictEqual(this.#readOnly.get(person) ?? [], contexts)) return
    this.#readOnly.set(person, contexts)
    if (contexts.length) this.state?.set('readOnly', person, contexts)
    else this.state?.delete('readOnly', person)
  }

  /** `person`'s assistants changed. */
  changed(person: string): void {
    for (const entry of this.#pages) if (entry.person === person) entry.page.changed()
  }
}
