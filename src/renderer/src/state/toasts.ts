import { create } from 'zustand'

/**
 * A sentence with a name in it: a few words in front that are never cut, then the rest, in
 * which the name is cut where the whole is too long.
 */
export interface Said {
  lead: string
  before: string
  name: string
  after: string
}

/**
 * What a sheet is, to a note shown in it: an assistant's change waiting for an answer
 * (`approval`), a change the person is about to make (`action`), or neither (`other`).
 */
export type SheetKind = 'approval' | 'action' | 'other'

export interface Toast {
  id: number
  /** Info: something that happened without the person (an AI assistant gave up waiting, say). */
  tone: 'success' | 'error' | 'info'
  title: string
  description?: string
  action?: { label: string; run: () => void }
  /**
   * What it says where it's shown inside an open sheet, if not its title, by what the sheet is
   * (`SheetKind`): a sheet that is itself about a change says this one is another, since a
   * cluster's name in it could be read as the sheet's; any other sheet has its own sentence.
   */
  inSheet?: Record<SheetKind, Said>
  /** Its time is up: it fades, then it's gone. */
  leaving?: boolean
}

interface ToastState {
  toasts: Toast[]
  show(toast: Omit<Toast, 'id'>): number
  dismiss(id: number): void
  /** Every toast gone at once. */
  clear(): void
  /** Marks one as on its way out. */
  leave(id: number): void
  /** Where a note is shown inside an open sheet, on a phone: the last is the sheet on top. */
  slots: HTMLElement[]
  slot(element: HTMLElement): () => void
}

let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show(toast) {
    const id = nextId++
    // Keep the stack short: the oldest make way.
    set((state) => ({ toasts: [...state.toasts.slice(-2), { ...toast, id }] }))
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
  leave: (id) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    })),
  slots: [],
  slot(element) {
    set((state) => ({ slots: [...state.slots, element] }))
    return () => set((state) => ({ slots: state.slots.filter((slot) => slot !== element) }))
  },
}))

export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().show(t)
