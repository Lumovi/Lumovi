import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Prefs {
  /** The namespace picked per context; `null` is "All namespaces". */
  namespaces: Record<string, string | null>
  setNamespace: (context: string, namespace: string | null) => void
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      namespaces: {},
      setNamespace: (context, namespace) =>
        set((prefs) => ({ namespaces: { ...prefs.namespaces, [context]: namespace } })),
    }),
    { name: 'kubestacks:prefs' },
  ),
)
