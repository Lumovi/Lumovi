/**
 * A node's taints: changed as one JSON patch that touches only what's changed. Each taint removed
 * is tested first, where it was read, to be the one read; each added goes at the end. So a taint
 * that changed or moved meanwhile has the change refused, and one Kubernetes (or anyone) added
 * meanwhile is kept, never dropped. A node that had none has its list made, and then the node
 * itself is tested as read (its resourceVersion): JSON Patch tests values, not absence. Such a
 * change is said in the same words in the page, the audit log and an assistant's approval.
 */

export const EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const
export type Effect = (typeof EFFECTS)[number]

/** A taint as the API has it (NoExecute's carry when they were added, set by the server). */
export interface Taint {
  key: string
  value?: string
  effect: Effect
  timeAdded?: string
}

type Operation =
  | { op: 'test'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }

/** As kubectl taint writes it: key=value:Effect, or key:Effect without a value. */
export const taintText = (taint: Pick<Taint, 'key' | 'value' | 'effect'>) =>
  `${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect}`

/** The same taint: key, value and effect (not when it was added). */
export const sameTaint = (a: Taint, b: Taint) =>
  a.key === b.key && (a.value ?? '') === (b.value ?? '') && a.effect === b.effect

/** One a node has once at most: a key and an effect (another value replaces it). */
export const sameSlot = (a: Taint, b: Taint) => a.key === b.key && a.effect === b.effect

/** Whether a value is a taint: a key, and an effect there is. */
export const isTaint = (value: unknown): value is Taint =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Taint).key === 'string' &&
  EFFECTS.includes((value as Taint).effect)

/** A taint as it's added: its key, value and effect alone (the server stamps NoExecute's time). */
const plain = (taint: Taint): Taint => ({
  key: taint.key,
  ...(taint.value ? { value: taint.value } : {}),
  effect: taint.effect,
})

/**
 * The patch that removes the taints at `removed` (places in `now`, as read) and adds `added`. A
 * node that had none (`now` undefined) is tested by its `resourceVersion` as its list is made.
 */
export function changeTaints(
  now: readonly Taint[] | undefined,
  removed: readonly number[],
  added: readonly Taint[],
  resourceVersion: string,
): Operation[] {
  if (!now) {
    return [
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      { op: 'add', path: '/spec/taints', value: added.map(plain) },
    ]
  }
  const places = [...new Set(removed)].sort((a, b) => b - a)
  return [
    // Each as read, before any is taken out (from the last, so the others keep their places).
    ...places.map((at) => ({ op: 'test' as const, path: `/spec/taints/${at}`, value: now[at] })),
    ...places.map((at) => ({ op: 'remove' as const, path: `/spec/taints/${at}` })),
    ...added.map((taint) => ({ op: 'add' as const, path: '/spec/taints/-', value: plain(taint) })),
  ]
}

/**
 * What a JSON patch does to a node's taints, if it's exactly one changeTaints makes: taints tested
 * where they are, then removed from those very places, the last first, then new ones appended;
 * or a list made where a node had none, its resourceVersion tested (`set`: what it set them to,
 * since it can't say what it replaced). Anything else is no taints change it can say.
 */
export function taintsChange(
  patch: unknown,
):
  | { kind: 'change'; added: Taint[]; removed: Taint[] }
  | { kind: 'set'; taints: Taint[] }
  | undefined {
  if (!Array.isArray(patch) || patch.length === 0) return undefined
  const ops = patch as { op?: unknown; path?: unknown; value?: unknown }[]
  const [first, second] = ops
  if (first?.op === 'test' && first.path === '/metadata/resourceVersion') {
    return ops.length === 2 &&
      typeof first.value === 'string' &&
      second?.op === 'add' &&
      second.path === '/spec/taints' &&
      Array.isArray(second.value) &&
      second.value.every(isTaint)
      ? { kind: 'set', taints: second.value }
      : undefined
  }
  const place = (op: { path?: unknown }) => {
    const found = typeof op.path === 'string' && /^\/spec\/taints\/(\d+)$/.exec(op.path)
    return found ? Number(found[1]) : undefined
  }
  // Tests first, then as many removes, then appends: nothing else, in no other order.
  const tests = ops.filter((op) => op.op === 'test')
  const removes = ops.slice(tests.length, tests.length * 2)
  const adds = ops.slice(tests.length * 2)
  const tested = tests.map(place)
  const removedAt = removes.map(place)
  if (
    ops.slice(0, tests.length).some((op) => op.op !== 'test') ||
    tested.some((at) => at === undefined) ||
    new Set(tested).size !== tested.length ||
    removes.length !== tests.length ||
    removes.some((op) => op.op !== 'remove') ||
    // The same places, the last first.
    removedAt.some((at, index) => at !== [...tested].sort((a, b) => b! - a!)[index]) ||
    adds.some((op) => op.op !== 'add' || op.path !== '/spec/taints/-' || !isTaint(op.value)) ||
    tests.some((op) => !isTaint(op.value)) ||
    tests.length + adds.length === 0
  ) {
    return undefined
  }
  return {
    kind: 'change',
    added: adds.map((op) => op.value as Taint),
    removed: tests.map((op) => op.value as Taint),
  }
}

/** What such a patch does, said: a change as taintsSaid says it; a list set, as what it was set to. */
export function patchSaid(
  what: string,
  change: NonNullable<ReturnType<typeof taintsChange>>,
  past: boolean,
): string | undefined {
  if (change.kind === 'change') return taintsSaid(what, change, past)
  if (change.taints.length === 0) return `${past ? 'Removed' : 'Remove'} every taint from ${what}`
  return `Set ${what}’s taints to ${listed(change.taints.map(taintText))}`
}

/** What a node's taints going from one list to another (a manifest's) adds and removes. */
export function taintsDiff(before: unknown, after: unknown): { added: Taint[]; removed: Taint[] } {
  const was = Array.isArray(before) ? before.filter(isTaint) : []
  const now = Array.isArray(after) ? after.filter(isTaint) : []
  return {
    added: now.filter((taint) => !was.some((old) => sameTaint(old, taint))),
    removed: was.filter((old) => !now.some((taint) => sameTaint(old, taint))),
  }
}

/** A list as it's said: "a", "a and b", "a, b and c". */
const listed = (texts: string[]) =>
  texts.length <= 1 ? texts.join('') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}`

/**
 * A change to `what`'s taints (a node, as the sentence names it), done (`past`) or asked: one
 * added, one removed, or what was added and removed. Nothing for no change.
 */
export function taintsSaid(
  what: string,
  { added, removed }: { added: readonly Taint[]; removed: readonly Taint[] },
  past: boolean,
): string | undefined {
  const verb = (done: string, asked: string) => (past ? done : asked)
  if (added.length === 1 && removed.length === 0) {
    return `${verb('Tainted', 'Taint')} ${what} with ${taintText(added[0]!)}`
  }
  if (removed.length === 1 && added.length === 0) {
    return `${verb('Removed', 'Remove')} ${taintText(removed[0]!)} from ${what}`
  }
  if (added.length === 0 && removed.length === 0) return undefined
  const parts = [
    added.length > 0 && `${listed(added.map(taintText))} added`,
    removed.length > 0 && `${listed(removed.map(taintText))} removed`,
  ].filter(Boolean)
  return `${verb('Changed', 'Change')} ${what}’s taints: ${parts.join(', ')}`
}

/**
 * The `kubectl taint` arguments that make the same change, a line each: a removal ending in "-",
 * an addition, or (a new value for a key and effect it had) an overwrite.
 */
export function taintsArgs(
  node: string,
  { added, removed }: { added: readonly Taint[]; removed: readonly Taint[] },
): string[][] {
  const replaced = (taint: Taint) => added.some((each) => sameSlot(each, taint))
  return [
    ...removed
      .filter((taint) => !replaced(taint))
      .map((taint) => ['taint', 'nodes', node, `${taintText(taint)}-`]),
    ...added.map((taint) =>
      removed.some((each) => sameSlot(each, taint))
        ? ['taint', 'nodes', node, taintText(taint), '--overwrite']
        : ['taint', 'nodes', node, taintText(taint)],
    ),
  ]
}

/**
 * Whether a change's refusal is its test failing (the taints changed since they were read): the
 * API server answers 422, saying only that its patch didn't apply; a stand-in, which test.
 */
export function refusedAsChanged(error: { status?: number; message: string }): boolean {
  return (
    error.status === 422 &&
    /rejected our request due to an error in our request|testing value .* failed/i.test(
      error.message,
    )
  )
}
