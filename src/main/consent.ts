/**
 * What a kubeconfig's credentials do on this computer, and the person's consent to it: a program
 * they run, a file whose text they send, a server not verified they'd go to. Each is agreed to as
 * exactly what it does (secrets and all), given to the page as a keyed digest it gives back and
 * learns nothing from. For clusters added in Lumovi and the kubeconfigs in a folder alike.
 *
 * The key is kept in Lumovi's data folder, so a consent is known again after a restart, and one
 * made with another key (settings copied from another computer, or written by someone who can
 * write those but not this folder) isn't. It doesn't stand against a program already running as
 * the person, which can read the key: nothing kept on their own disk could.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { CredentialCommand, PastedKubeconfig } from '@shared/api'
import { KubeRequestError } from '@backend/kube/errors'

/** The most a kubeconfig is read of: far more than any has. */
export const MAX_TEXT = 1024 * 1024

/** A kubeconfig as written: its entries, each by name. */
export interface Raw {
  clusters: { name: string; cluster: Record<string, unknown> }[]
  users: { name: string; user: Record<string, unknown> }[]
  contexts: { name: string; context: { cluster: string; user?: string; namespace?: string } }[]
}

/**
 * A kubeconfig's entries, if it's one: without its comments, preferences and current context.
 * One without contexts is refused, unless it may only give clusters or users (`partOnly`).
 */
export function readKubeconfig(text: string, { partOnly = false } = {}): Raw {
  if (text.length > MAX_TEXT) throw tooLarge()
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (error) {
    // Only the reason and where: the parser quotes the lines around it, credentials and all.
    throw new KubeRequestError(
      'invalid',
      `It isn’t YAML: ${(error as Error).message.split('\n')[0]}`,
    )
  }
  const config = (parsed ?? {}) as Record<string, unknown>
  const list = (key: string, entry: string) => {
    const value = config[key] ?? []
    if (
      !Array.isArray(value) ||
      !value.every(
        (item: unknown) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { name?: unknown }).name === 'string' &&
          typeof ((item as Record<string, unknown>)[entry] ?? {}) === 'object',
      )
    ) {
      throw new KubeRequestError('invalid', `Its ${key} aren’t a kubeconfig’s: each needs a name.`)
    }
    return value as { name: string; [entry: string]: unknown }[]
  }
  const raw = {
    clusters: list('clusters', 'cluster').map(({ name, cluster }) => ({
      name,
      cluster: (cluster ?? {}) as Record<string, unknown>,
    })),
    users: list('users', 'user').map(({ name, user }) => ({
      name,
      user: (user ?? {}) as Record<string, unknown>,
    })),
    contexts: list('contexts', 'context').map(({ name, context }) => ({
      name,
      context: (context ?? {}) as Raw['contexts'][number]['context'],
    })),
  }
  if (raw.contexts.length === 0 && !partOnly) {
    throw new KubeRequestError('invalid', 'It has no contexts: a kubeconfig names at least one.')
  }
  return raw
}

export function authOf(
  user: Record<string, unknown> | undefined,
): PastedKubeconfig['contexts'][number]['auth'] {
  if (!user) return 'none'
  if (commandsOf([{ name: '', user }]).length > 0) return 'command'
  if (user['client-certificate'] || user['client-certificate-data']) return 'certificate'
  if (user.token || user['token-file'] || user.tokenFile || user['auth-provider']) return 'token'
  if (user.username) return 'basic'
  return 'none'
}

/** The programs these users' credentials run, as they'd run. */
export function commandsOf(users: Raw['users']): CredentialCommand[] {
  return users.flatMap(({ name, user }) => {
    const provider = user['auth-provider'] as
      { name?: unknown; config?: Record<string, unknown> } | undefined
    // client-node runs an auth provider's exec too, and the user's own over it.
    const exec = (user.exec ?? provider?.config?.exec) as
      { command?: unknown; args?: unknown; env?: unknown } | undefined
    const commands: CredentialCommand[] = []
    if (exec) {
      const args = Array.isArray(exec.args) ? exec.args.map(String) : []
      const env = Array.isArray(exec.env)
        ? (exec.env as { name?: unknown; value?: unknown }[]).map((variable) => ({
            name: String(variable.name),
            value: String(variable.value ?? ''),
          }))
        : []
      const line = [String(exec.command ?? ''), ...args].map(quoted).join(' ')
      commands.push({ user: name, line, env, consent: consent('run', line, env) })
    }
    // GCP's and Azure's run their cmd-path through a shell, with cmd-args as written.
    const cmdPath = provider?.config?.['cmd-path']
    if ((provider?.name === 'gcp' || provider?.name === 'azure') && cmdPath) {
      const args = provider.config?.['cmd-args']
      const line = `"${String(cmdPath)}"${args ? ` ${String(args)}` : ''}`
      commands.push({ user: name, line, shell: true, env: [], consent: consent('shell', line) })
    }
    return commands
  })
}

/**
 * The files on this computer whose text its credentials send, and the server each goes to: one
 * for each (a user's file goes to the server of each context it signs in to).
 */
export function tokenFilesOf(raw: Raw): PastedKubeconfig['tokenFiles'] {
  const seen = new Set<string>()
  return raw.contexts.flatMap(({ context }) => {
    const found = raw.users.find((entry) => entry.name === context.user)
    const server = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster.server
    if (!found || typeof server !== 'string') return []
    const { name, user } = found
    const provider = user['auth-provider'] as { config?: Record<string, unknown> } | undefined
    return [user['token-file'], user.tokenFile, provider?.config?.tokenFile]
      .filter((path): path is string => typeof path === 'string' && !!path)
      .map((path) => ({ user: name, path, server, consent: consent('send', path, server) }))
      .filter(({ consent }) => !seen.has(consent) && seen.add(consent))
  })
}

/**
 * What a cluster's connection is: where its credentials go, and how they're kept from anyone
 * else on the way.
 */
const CONNECTION = [
  'server',
  'proxy-url',
  'insecure-skip-tls-verify',
  'certificate-authority',
  'certificate-authority-data',
  'tls-server-name',
]
/**
 * Where an OIDC user's own secrets go besides: its identity provider (its refresh token and
 * client secret, once its ID token has expired), and how it's verified.
 */
const ISSUER = ['idp-issuer-url', 'idp-certificate-authority', 'idp-certificate-authority-data']

/** Where a context's credentials go: its cluster's connection, and its user's issuer. */
export function connectionOf(raw: Raw, cluster: string, user?: string): string {
  const found = raw.clusters.find((entry) => entry.name === cluster)?.cluster ?? {}
  const config =
    (dig(raw.users.find((entry) => entry.name === user)?.user, ['auth-provider', 'config']) as
      Record<string, unknown> | undefined) ?? {}
  return JSON.stringify([
    ...CONNECTION.map((key) => found[key] ?? null),
    ...ISSUER.map((key) => config[key] ?? null),
  ])
}

/** `at` in `value`, if it's there. */
export function dig(value: unknown, at: string[]): unknown {
  return at.reduce<unknown>(
    (inside, key) =>
      typeof inside === 'object' && inside !== null
        ? (inside as Record<string, unknown>)[key]
        : undefined,
    value,
  )
}

/** The key file's name in Lumovi's data folder, and its length. */
const KEY_FILE = 'consent.key'
const KEY_BYTES = 32

/** Consents' key: kept (useConsentKey), so the page can't test a guess at what one stands for. */
let consentKey: Buffer | undefined

/**
 * Consents' key from Lumovi's data folder, made there once if it isn't: the person's alone (0600,
 * and in a folder only they can write; on Windows, where those mean nothing, the profile's own
 * app data, which only they and the system can read). One that's a link, the wrong size, or
 * anyone else's to read is replaced, and every consent kept with it is asked again; one that
 * can't be kept is this run's own. Never a consent without the person's.
 */
export function useConsentKey(folder: string): void {
  const path = join(folder, KEY_FILE)
  consentKey = (ownFolder(folder) && (keptKey(path) ?? madeKey(path))) || randomBytes(KEY_BYTES)
}

/** Whether only the person can write in the folder (on Windows, its own app data's ACL says). */
function ownFolder(folder: string): boolean {
  if (process.platform === 'win32') return true
  try {
    const { uid, mode } = statSync(folder)
    return uid === process.getuid?.() && (mode & 0o022) === 0
  } catch {
    return false
  }
}

/** The key kept there, if it's one to trust: a file of its own (not a link), the person's alone. */
function keptKey(path: string): Buffer | undefined {
  let fd: number | undefined
  try {
    // Opened first, never through a link, and then judged: what's read is what was judged.
    // (Without waiting: a pipe put there opens at once, and isn't a file.)
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    const opened = fstatSync(fd)
    if (!fine(opened)) return undefined
    // (Where opening can follow a link, as on Windows: the name is that very file, no link.)
    const named = lstatSync(path)
    if (!named.isFile() || named.ino !== opened.ino || named.dev !== opened.dev) return undefined
    const key = Buffer.alloc(KEY_BYTES)
    return readSync(fd, key, 0, KEY_BYTES, 0) === KEY_BYTES ? key : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** A file, of a key's length, and (where modes mean something) the person's to read alone. */
function fine(stat: { isFile(): boolean; size: number; mode: number; uid: number }): boolean {
  if (!stat.isFile() || stat.size !== KEY_BYTES) return false
  return (
    process.platform === 'win32' || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
  )
}

/**
 * A new key, kept: whatever was there (a link is removed, not what it leads to) made way for a
 * file created anew, never through a link or over another's. Another Lumovi making one at that
 * moment: theirs.
 */
function madeKey(path: string): Buffer | undefined {
  const key = randomBytes(KEY_BYTES)
  try {
    rmSync(path, { force: true })
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch {
    return keptKey(path)
  }
}

/**
 * What's agreed to, when it is: one thing a credential does here, exactly as it would do it
 * (secrets and all), as a keyed digest: the page gives it back, and learns nothing from it. Its
 * parts are joined as JSON, so no two different sets of them are the same text.
 */
export function consent(...what: unknown[]): string {
  if (!consentKey) throw new Error('Consents’ key isn’t read yet.')
  return createHmac('sha256', consentKey).update(JSON.stringify(what)).digest('hex')
}

/** Whether `digest` is one of those agreed to: each compared in the same time, alike or not. */
export function agreedTo(agreed: readonly string[], digest: string): boolean {
  const wanted = Buffer.from(digest, 'hex')
  let found = false
  for (const given of agreed) {
    if (typeof given !== 'string' || given.length !== digest.length) continue
    const buffer = Buffer.from(given, 'hex')
    if (buffer.length === wanted.length && timingSafeEqual(buffer, wanted)) found = true
  }
  return found
}

/** A server over plain HTTP: what's sent it isn't encrypted. */
export const plain = (server: string) => /^http:/i.test(server)

/**
 * The servers not verified that its credentials would go to: whatever answers there gets them, so
 * each is agreed to first, for that very server. That's one with `insecure-skip-tls-verify`, or
 * one over plain HTTP, unencrypted, flag or not: Lumovi doesn't connect to it without the flag
 * (serverUrl), but kubectl would, in its terminals or from its line.
 */
export function unverifiedOf(raw: Raw): { context: string; server: string; consent: string }[] {
  const seen = new Set<string>()
  return raw.contexts.flatMap(({ name, context }) => {
    const cluster = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster
    const user = raw.users.find((entry) => entry.name === context.user)?.user
    if (!cluster || authOf(user) === 'none') return []
    const server = String(cluster.server ?? '')
    if (cluster['insecure-skip-tls-verify'] !== true && !plain(server)) return []
    const agreement = consent('unverified', server)
    if (seen.has(agreement)) return []
    seen.add(agreement)
    return [{ context: name, server, consent: agreement }]
  })
}

/**
 * What its credentials do here that isn't agreed to, as said to the person. The programs they
 * run are `commands`, where those are asked of otherwise (a folder's: for where they go).
 */
export function unagreed(
  raw: Raw,
  agreed: readonly string[],
  commands: CredentialCommand[] = commandsOf(raw.users),
): string[] {
  return [
    ...unverifiedOf(raw)
      .filter(({ consent }) => !agreedTo(agreed, consent))
      .map(({ server }) =>
        plain(server) ? `go to ${server} unencrypted` : `go to ${server}, which isn’t verified`,
      ),
    ...commands
      .filter(({ consent }) => !agreedTo(agreed, consent))
      .map(({ line }) => `run ${line} on this computer`),
    ...tokenFilesOf(raw)
      .filter(({ consent }) => !agreedTo(agreed, consent))
      .map(({ path, server }) => `send ${path} to ${server}`),
  ]
}

/** As a shell would need it to be one word. */
export function quoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

export function tooLarge(): KubeRequestError {
  return new KubeRequestError('invalid', 'It’s larger than any kubeconfig (over 1 MB).')
}
