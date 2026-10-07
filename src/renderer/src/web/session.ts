/**
 * Signing in and out of a Lumovi server, over plain HTTP: the WebSocket
 * that carries everything else needs a session to connect.
 */
import { PATHS, type Session, type SessionEnd, type SignIn } from '@shared/server'

/** Where the server is: everything is below its base path, which the page's `<base>` names. */
export const serverUrl = (path: string) => new URL(path, document.baseURI)

/** The router's base path: '' at the root, or e.g. /lumovi. */
export const basename = () => serverUrl('.').pathname.slice(0, -1)

/** Set before a page reloads because its session ended, so the sign-in page can say so. */
const ENDED = 'lumovi:session-ended'
/** And what the server couldn't keep of a sign-out, to say too. */
const UNKEPT = 'lumovi:sign-out-unkept'

export type SessionState =
  { session: Session } | { signIn: SignIn & { ended?: SessionEnd; unkept?: string } }

/** Who is signed in, or how to sign in. */
export async function loadSession(): Promise<SessionState> {
  const response = await fetch(serverUrl(PATHS.session))
  if (response.status !== 401) return { session: (await (await check(response)).json()) as Session }
  const ended = (sessionStorage.getItem(ENDED) ?? undefined) as SessionEnd | undefined
  const unkept = sessionStorage.getItem(UNKEPT) ?? undefined
  sessionStorage.removeItem(ENDED)
  sessionStorage.removeItem(UNKEPT)
  return { signIn: { ...((await response.json()) as SignIn), ended, unkept } }
}

/** Whether there's still a session; true while the server can't say (it's restarting, say). */
export function stillSignedIn(): Promise<boolean> {
  return fetch(serverUrl(PATHS.session)).then(
    (response) => response.status !== 401,
    () => true,
  )
}

/** Signs in with a token; rejects saying why the server wouldn't. */
export async function signInWithToken(token: string): Promise<void> {
  await check(
    await fetch(serverUrl(PATHS.session), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  )
}

/**
 * Signs out; what the server couldn't keep of it, if anything (503: it's over there, but a
 * restart before it can keep it would bring it back).
 */
export async function signOut(): Promise<string | undefined> {
  const response = await fetch(serverUrl(PATHS.session), { method: 'DELETE' })
  if (response.status === 503) {
    const { error } = (await response.json().catch(() => ({}))) as { error?: string }
    return error ?? 'Lumovi couldn’t keep that you signed out.'
  }
  await check(response)
  return undefined
}

/** Single sign-on, coming back to the page that's open now. */
export function signInUrl(): string {
  const url = serverUrl(PATHS.signIn)
  const at = window.location.pathname.slice(basename().length) + window.location.search
  url.searchParams.set('then', at)
  return url.href
}

/** Reloads the page once its session has ended, for the sign-in page to say how. */
export function sessionEnded(how: SessionEnd, unkept?: string): void {
  sessionStorage.setItem(ENDED, how)
  if (unkept) sessionStorage.setItem(UNKEPT, unkept)
  window.location.reload()
}

async function check(response: Response): Promise<Response> {
  if (response.ok) return response
  const { error } = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(error ?? `The server answered ${response.status}`)
}
