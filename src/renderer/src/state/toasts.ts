import { create } from 'zustand'

export interface Toast {
  id: number
  tone: 'success' | 'error'
  title: string
  description?: string
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  show(toast: Omit<Toast, 'id'>): number
  dismiss(id: number): void
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
}))

export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().show(t)
