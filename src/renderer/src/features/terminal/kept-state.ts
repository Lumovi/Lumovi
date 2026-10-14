/** What became of a kept object: when it was found deleted, and since when its cluster's away. */
export interface KeptState {
  deletedAt?: number
  unreachableSince?: number
}

/**
 * A kept object's state, as its last read says it (`code`, the read's error, if any; `read`,
 * whether it was ever read): deleted where it was read and is now not found, out of reach where
 * its cluster doesn't answer, each kept from when it was first found so; neither once it's read
 * again. Never read at all, it's neither: it says why where it would be shown.
 */
export function keptState(
  was: KeptState,
  { read, code }: { read: boolean; code?: string },
  now: number,
): KeptState {
  const gone = read && code === 'not-found'
  const away = read && (code === 'unreachable' || code === 'timeout')
  return {
    deletedAt: gone ? (was.deletedAt ?? now) : undefined,
    unreachableSince: away ? (was.unreachableSince ?? now) : undefined,
  }
}
