import { create } from 'zustand'
import type { ResourceKind } from '@shared/resources'

export interface ActivityEntry {
  id: number
  at: number
  context: string
  /** What happened, in the past tense: "Scaled storefront to 5 replicas". */
  title: string
  /** The kubectl command that does the same. */
  command: string
  status: 'running' | 'done' | 'failed'
  error?: string
  /** The object the change was about, to open it from the log. */
  target?: { kind: ResourceKind; name: string; namespace?: string }
}

interface ActivityState {
  entries: ActivityEntry[]
  /** Changes since the log was last opened. */
  unseen: number
  start(entry: Omit<ActivityEntry, 'id' | 'at' | 'status'>): number
  finish(id: number, status: 'done' | 'failed', error?: string): void
  markSeen(): void
  clear(): void
}

let nextId = 1

/** Every change made from KubeStacks in this session, newest first. */
export const useActivity = create<ActivityState>((set) => ({
  entries: [],
  unseen: 0,
  start(entry) {
    const id = nextId++
    set((state) => ({
      entries: [{ ...entry, id, at: Date.now(), status: 'running' }, ...state.entries],
      unseen: state.unseen + 1,
    }))
    return id
  },
  finish(id, status, error) {
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.id === id ? { ...entry, status, error } : entry,
      ),
    }))
  },
  markSeen: () => set({ unseen: 0 }),
  clear: () => set({ entries: [], unseen: 0 }),
}))
