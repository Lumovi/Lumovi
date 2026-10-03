import { createContext, useContext } from 'react'
import type { Session } from '@shared/server'

/** Who is signed in, when a Lumovi server serves the page; the desktop app has nobody. */
export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session | null {
  return useContext(SessionContext)
}
