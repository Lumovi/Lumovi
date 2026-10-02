import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { SessionContext } from '@renderer/state/session'
import { useConnection } from '@renderer/web/connection'
import { loadSession, sessionEnded, type SessionState } from '@renderer/web/session'
import { SignInPage, Unavailable } from './SignInPage'

/**
 * A served page shows the app once someone is signed in, and the sign-in page
 * until then, or again once the session ends. The session is read once, when
 * the page loads: refreshing the app's data (⌘R) leaves it be.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState | Error>()
  const load = useCallback(() => {
    loadSession().then(setState, setState)
  }, [])
  const connection = useConnection()

  useEffect(load, [load])
  useEffect(() => {
    if (connection.state === 'ended') sessionEnded(connection.ended!)
  }, [connection])

  // A moment, with the page's background, rather than a spinner that flashes.
  if (!state) return null
  if (state instanceof Error) {
    return (
      <Unavailable
        error={state}
        onRetry={() => {
          setState(undefined)
          load()
        }}
      />
    )
  }
  if ('signIn' in state) return <SignInPage signIn={state.signIn} />
  return <SessionContext.Provider value={state.session}>{children}</SessionContext.Provider>
}
