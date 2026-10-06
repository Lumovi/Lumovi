/**
 * The audit log as one actor records to it: a page's person (and where
 * they're connected from), or an AI assistant acting as them. What's
 * recorded says who without each place that records having to.
 */
import type { AuditActor, AuditInput } from '@shared/audit'
import type { AuditLog } from './log'

/** What's recorded, but who: the recorder knows. */
export type Recorded = Omit<AuditInput, 'actor'>

export interface Recorder {
  /** Who it records as: the person (the one an assistant acts as). */
  readonly user: string
  record(input: Recorded): void
  /**
   * A read (logs, a Secret), recorded once a while for the same thing: a page reads it again
   * as it refreshes, and that isn't anyone reading it again.
   */
  read(key: string, input: Recorded): void
}

/** Reads of the same thing within this long are one; and the most recent this many, at most. */
const READ_WINDOW_MS = 10 * 60_000
const READS_KEPT = 1000

export function recorder(
  log: AuditLog,
  /** Who: for a cluster, in the desktop app, with its kubeconfig's user. */
  actor: (cluster: string | undefined) => AuditActor,
): Recorder {
  const reads = new Map<string, number>()
  const record = (input: Recorded) => log.record({ ...input, actor: actor(input.cluster) })
  return {
    // Asked when it's needed: who acts can be known only later (an assistant, once it says).
    get user() {
      return actor(undefined).user
    },
    record,
    read(key, input) {
      const at = Date.now()
      const last = reads.get(key)
      if (last !== undefined && at - last < READ_WINDOW_MS) return
      // The newest last: the oldest are let go first, so it stays small however much is read.
      reads.delete(key)
      reads.set(key, at)
      while (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!)
      record(input)
    },
  }
}
