/**
 * The page's side of the YAML check: a text sent to the worker, its problems back. Each schema
 * goes over once; an answer naming a kind whose schema has since become known is asked again,
 * with it. Where a worker can't be started, the same check runs on the page (a parse and a walk,
 * as long as the text). A check the worker doesn't answer in time is given up, with no marks,
 * and the worker is let go of for a new one: never run on the page, which it would hold.
 */
import type { FieldSchema } from '@shared/api'
import { kindsIn, problemsIn, type DocumentKind, type Problem } from './yaml-schema'

/** How long a check may take in the worker before it's given up. */
const PATIENCE = 5_000
/**
 * The most lines checked on the page, where no worker started: about 10 ms of a check, measured
 * at 25 ms for 5,000 (so it never holds typing, which it waits half a second for anyway).
 */
const ON_THE_PAGE = 2_000

/** A kind's schema as the check needs it, and the kind in a sentence. */
export interface Known {
  schema: FieldSchema | null
  words: string
}

export interface CheckAsk {
  id: number
  text: string
  /** Schemas not sent before, by `apiVersion/kind`. */
  known: Record<string, Known>
}

export interface CheckAnswer {
  id: number
  problems: Problem[]
  kinds: DocumentKind[]
  /** Not checked: too long to check on the page, where no worker started. */
  unchecked?: true
}

export interface Checker {
  /** A text's problems, by the schemas `known` gives (undefined: not known yet). */
  check(text: string, known: (kind: DocumentKind) => Known | undefined): Promise<CheckAnswer>
  close(): void
}

const keyOf = (kind: DocumentKind) => `${kind.apiVersion}/${kind.kind}`

/** A checker of its own, for one editor. */
export function createChecker(): Checker {
  const sent = new Set<string>()
  /** The checks the worker has yet to answer: each answered, or given up (with no marks). */
  const waiting = new Map<number, { answer: (answer: CheckAnswer) => void; giveUp: () => void }>()
  let next = 0
  let worker: Worker | undefined
  const start = () => {
    try {
      worker = new Worker(new URL('./yaml-check.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      worker = undefined
      return
    }
    sent.clear()
    worker.addEventListener('message', (event: MessageEvent<CheckAnswer>) => {
      waiting.get(event.data.id)?.answer(event.data)
      waiting.delete(event.data.id)
    })
    // A worker that fails to load is let go of: what's waiting is checked here, and all after.
    worker.addEventListener('error', () => {
      worker = undefined
      for (const each of waiting.values()) each.answer({ id: -1, problems: [], kinds: [] })
      waiting.clear()
    })
  }
  start()

  const here = (text: string, known: (kind: DocumentKind) => Known | undefined): CheckAnswer => {
    if (text.split('\n').length > ON_THE_PAGE) {
      return { id: -1, problems: [], kinds: [], unchecked: true }
    }
    return checked(text, known)
  }
  const checked = (text: string, known: (kind: DocumentKind) => Known | undefined) => ({
    id: -1,
    problems: problemsIn(text, (apiVersion, kind) => {
      const each = known({ apiVersion, kind })
      return { schema: each?.schema, words: each?.words ?? kind }
    }),
    kinds: kindsIn(text),
  })

  const ask = (
    text: string,
    known: (kind: DocumentKind) => Known | undefined,
    kinds: DocumentKind[],
  ) =>
    new Promise<CheckAnswer>((resolve) => {
      if (!worker) return resolve(here(text, known))
      const fresh: Record<string, Known> = {}
      for (const kind of kinds) {
        const each = known(kind)
        if (each && !sent.has(keyOf(kind))) {
          fresh[keyOf(kind)] = each
          sent.add(keyOf(kind))
        }
      }
      const id = next++
      // Unanswered in time: every check waiting is given up at once, and the worker replaced,
      // so one slow check costs one new worker (and no other check's timer stops the new one).
      const late = setTimeout(() => {
        if (!waiting.has(id)) return
        for (const each of waiting.values()) each.giveUp()
        waiting.clear()
        worker?.terminate()
        start()
      }, PATIENCE)
      waiting.set(id, {
        answer: (answer) => {
          clearTimeout(late)
          resolve(answer.id === -1 ? here(text, known) : answer)
        },
        giveUp: () => {
          clearTimeout(late)
          resolve({ id, problems: [], kinds: [] })
        },
      })
      worker.postMessage({ id, text, known: fresh } satisfies CheckAsk)
    })

  return {
    async check(text, known) {
      const answer = await ask(text, known, [])
      // Its documents' kinds, now that they're read: one whose schema could be sent is.
      const unsent = answer.kinds.filter((kind) => known(kind) && !sent.has(keyOf(kind)))
      return unsent.length > 0 && worker ? ask(text, known, unsent) : answer
    },
    close() {
      worker?.terminate()
      worker = undefined
    },
  }
}
