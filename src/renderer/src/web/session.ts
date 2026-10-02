/**
 * Signing in and out of a KubeStacks server, over plain HTTP: the WebSocket
 * that carries everything else needs a session to connect.
 */
import { PATHS, type Session, type SessionEnd, type SignIn } from '@shared/server'

/** Where the server is: everything is below its base path, which the page's `<base>` names. */
export const serverUrl = (path: string) => new URL(path, document.baseURI)

/** The router's base path: '' at the root, or e.g. /kubestacks. */
export const basename = () => serverUrl('.').pathname.slice(0, -1)

/** Set before a page reloads because its session ended, so the sign-in page can say so. */
const ENDED = 'kubestacks:session-ended'

export type SessionState = { session: Session } | { signIn: SignIn & { ended?: SessionEnd } }

/** Who is signed in, or how to sign in. */
export async function loadSession(): Promise<SessionState> {
  const response = await fetch(serverUrl(PATHS.session))
  if (response.status !== 401) return { session: (await (await check(response)).json()) as Session }
  const ended = (sessionStorage.getItem(ENDED) ?? undefined) as SessionEnd | undefined
  sessionStorage.removeItem(ENDED)
  return { signIn: { ...((await response.json()) as SignIn), ended } }
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

export async function signOut(): Promise<void> {
  await check(await fetch(serverUrl(PATHS.session), { method: 'DELETE' }))
}

/** Single sign-on, coming back to the page that's open now. */
export function signInUrl(): string {
  const url = serverUrl(PATHS.signIn)
  const at = window.location.pathname.slice(basename().length) + window.location.search
  url.searchParams.set('then', at)
  return url.href
}

/** Reloads the page once its session has ended, for the sign-in page to say how. */
export function sessionEnded(how: SessionEnd): void {
  sessionStorage.setItem(ENDED, how)
  window.location.reload()
}

async function check(response: Response): Promise<Response> {
  if (response.ok) return response
  const { error } = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(error ?? `The server answered ${response.status}`)
}
