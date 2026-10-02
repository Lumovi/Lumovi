/**
 * How pages talk to a KubeStacks server: who is signed in, over HTTP, and the
 * calls and events of the KubestacksApi over one WebSocket per page.
 */
import type { MetricsSourceSetting } from './api'

/**
 * How people sign in: with a token the cluster accepts, with single sign-on
 * (OpenID Connect), or through an authenticating proxy in front of the server.
 */
export type AuthMode = 'token' | 'oidc' | 'proxy'

export interface SessionUser {
  name: string
  groups: string[]
}

/** `GET api/session` when signed in. */
export interface Session {
  user: SessionUser
  auth: AuthMode
  /** The one cluster the server shows, by the name its pages use for it. */
  cluster: string
  /** Where signing out of the authenticating proxy is, when it's set. */
  signOutUrl?: string
}

/**
 * Why signing in didn't work: the provider said no, the sign-in took too long
 * (or came from another browser), it failed (the server's log says how), or
 * the server won't act as that user.
 */
export type SignInProblem = 'denied' | 'expired' | 'failed' | 'refused'

/** `GET api/session` without a session (401): how to sign in. */
export interface SignIn {
  auth: AuthMode
  /** The single sign-on provider's name, for its button. */
  provider?: string
  /** Behind a proxy: why who it says can't be let in. */
  problem?: SignInProblem
}

/** The preferences each browser keeps, and gives the server for its pages. */
export interface PageSettings {
  readOnly: string[]
  metricsSource: Record<string, MetricsSourceSetting>
}

export type ClientMessage =
  /** The browser's preferences: first on every connection, then whenever another tab changes them. */
  | { type: 'settings'; settings: PageSettings }
  | { type: 'invoke'; id: number; channel: string; args: unknown[] }
  | { type: 'send'; channel: string; args: unknown[] }

export type ServerMessage =
  /** The answer to an invoke: its value, or why it failed. */
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'event'; channel: string; args: unknown[] }

/** Paths below the server's base path. */
export const PATHS = {
  session: 'api/session',
  socket: 'api/socket',
  signIn: 'auth/sign-in',
  callback: 'auth/callback',
  health: 'healthz',
} as const

/** The WebSocket close code that means the session ended; its reason says how. */
export const SESSION_ENDED = 4401

/** How a session ended: it expired, or its person signed out (maybe in another tab). */
export type SessionEnd = 'expired' | 'signed-out'

/** The cookie that keeps the theme a browser chose, so pages start in it. */
export const THEME_COOKIE = 'kubestacks-theme'
