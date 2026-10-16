/**
 * A tab below moved into a window of its own, as it crosses from one window to another (and is
 * kept for when Lumovi opens it again): checked as data wherever it arrives.
 */
import type { KubeContext, MovedTab } from './api'

/** The most of a terminal's last lines that go with it, in characters. */
const LINES_MOST = 400_000

const text = (value: unknown, most = 253) =>
  typeof value === 'string' && value.length > 0 && value.length <= most ? value : undefined

/** A moved tab, if `value` is one; else nothing. (`shell` only where `withShell`.) */
export function movedTabOf(value: unknown, withShell = true): MovedTab | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const given = value as Record<string, unknown>
  const context = text(given.context)
  if (!context) return undefined
  if (given.kind === 'kept') {
    const object = (given.object ?? {}) as Record<string, unknown>
    const kind = text(object.kind)
    const name = text(object.name)
    const namespace = text(object.namespace)
    if (!kind || !name) return undefined
    // (Never on a Shell, a pod's or a node's: shown in another page, that would start another
    // shell, or a node's debug pod. On its overview instead.)
    const tab = text(given.tab) ?? 'overview'
    return {
      kind: 'kept',
      context,
      object: { kind, name, ...(namespace ? { namespace } : {}) },
      tab: tab === 'shell' ? 'overview' : tab,
      ...(given.waiting === true ? { waiting: true } : {}),
    }
  }
  if (given.kind === 'terminal') {
    const namespace = text(given.namespace)
    const title = text(given.title)
    const shell = (given.shell ?? undefined) as Record<string, unknown> | undefined
    const id = text(shell?.id, 64)
    const lines = typeof shell?.lines === 'string' ? shell.lines.slice(-LINES_MOST) : undefined
    return {
      kind: 'terminal',
      context,
      ...(namespace ? { namespace } : {}),
      ...(title ? { title } : {}),
      ...(withShell && id && lines !== undefined ? { shell: { id, lines } } : {}),
    }
  }
  return undefined
}

/**
 * Whether a kept tab opened again as Lumovi did waits to be asked for before it's read: unless its
 * cluster is known not to sign in through a program (the contexts were read, and its own is there
 * without one). Reading such a cluster runs its program, which can open a browser or ask in a
 * terminal; where the contexts couldn't be read, it waits.
 */
export function waitsToBeRead(
  tab: MovedTab,
  restored: boolean,
  contexts: Pick<KubeContext, 'name' | 'signsInWith'>[] | undefined,
): boolean {
  if (tab.kind !== 'kept' || !restored) return false
  return !contexts || contexts.find((each) => each.name === tab.context)?.signsInWith !== undefined
}
