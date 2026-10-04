import { createContext, useContext } from 'react'
import type { Session } from '@shared/server'

/** Who is signed in, when a Lumovi server serves the page; the desktop app has nobody. */
export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session | null {
  return useContext(SessionContext)
}

/** Whether there are clusters to switch between: the desktop app's, or a server's fleet. */
export function useSwitching(): boolean {
  const session = useSession()
  return session ? session.fleet === true : true
}
