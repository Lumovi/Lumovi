import { create } from 'zustand'
import type { ChangeProposal } from '@shared/assistants'

interface ApprovalsState {
  /** Changes AI assistants asked for, waiting for an answer, oldest first. */
  queue: ChangeProposal[]
  /** The one shown. */
  shown?: string
  /** Put aside (Escape): the window shows that changes wait, until they're looked at again. */
  hidden: boolean
  add(proposal: ChangeProposal): void
  remove(id: string): void
  show(id?: string): void
  hide(): void
}

/** The changes AI assistants wait for the person to approve (the desktop app). */
export const useApprovals = create<ApprovalsState>((set) => ({
  queue: [],
  hidden: false,
  // A new one is shown, unless one's being looked at: it waits its turn, in the queue. (Once:
  // one that's come already, as the window asked what's waiting, keeps its place.)
  add: (proposal) =>
    set((state) => ({
      queue: [...new Map([...state.queue, proposal].map((p) => [p.id, p])).values()],
      shown: state.hidden || !state.shown ? proposal.id : state.shown,
      hidden: false,
    })),
  // The next one takes the place of one that's answered (or the one before, at the end).
  remove: (id) =>
    set((state) => {
      const at = state.queue.findIndex((p) => p.id === id)
      if (at < 0) return state
      const queue = state.queue.filter((p) => p.id !== id)
      const shown = state.shown === id ? (queue[at] ?? queue[at - 1])?.id : state.shown
      return { queue, shown }
    }),
  show: (id) => set((state) => ({ hidden: false, shown: id ?? state.shown })),
  hide: () => set({ hidden: true }),
}))
