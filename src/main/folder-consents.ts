/**
 * A folder's kubeconfigs are used as clusters added in Lumovi are: what a context's credentials
 * do on this computer (run a program, send a file, go to a server not verified) only once the
 * person has agreed to that very thing, and again after any change to it (a program's line or
 * environment, a file, where they go). Token and certificate contexts are used at once. What's
 * agreed to is kept in settings by file, as digests (consent.ts).
 *
 * A folder's kubeconfig is used whole (the store refuses a context that takes parts across one),
 * so a context, its cluster and its user here are all its file's, and what's agreed to is kept by
 * that file.
 */
import type { PastedKubeconfig } from '@shared/api'
import type { Source } from '@backend/kube/kubeconfig'
import {
  agreedTo,
  authOf,
  commandsOf,
  connectionOf,
  consent,
  readKubeconfig,
  tokenFilesOf,
  unverifiedOf,
  type Raw,
} from './consent'

/** A context's parts, each from where it's taken. */
export interface Parts {
  context: Source
  cluster?: Source
  user?: Source
}

/** Each text read once (several contexts of one file are asked of in turn). */
const parsed = new Map<string, Raw>()

function entriesOf(text: string): Raw {
  let raw = parsed.get(text)
  if (!raw) {
    if (parsed.size >= 50) parsed.clear()
    raw = readKubeconfig(text, { partOnly: true })
    parsed.set(text, raw)
  }
  return raw
}

/** A context with its cluster and user, from wherever each is taken, as one kubeconfig. */
export function rawOf({ context, cluster, user }: Parts): Raw {
  const entry = <K extends keyof Raw>(kind: K, source: Source | undefined): Raw[K] => {
    if (!source) return []
    const found = (entriesOf(source.text)[kind] as { name: string }[]).find(
      ({ name }) => name === source.name,
    )
    return (found ? [found] : []) as Raw[K]
  }
  return {
    contexts: entry('contexts', context),
    clusters: entry('clusters', cluster),
    users: entry('users', user),
  }
}

/**
 * What a context's credentials do that's asked first, each with what agreeing gives back: a
 * program is agreed to for where its credentials go (its line, its environment, and the
 * connection), so it's asked again when any of those changes.
 */
export function asksOf(raw: Raw): PastedKubeconfig {
  const [found] = raw.contexts
  const cluster = raw.clusters[0]?.cluster
  const server = typeof cluster?.server === 'string' ? cluster.server : undefined
  const connection = found ? connectionOf(raw, found.context.cluster, found.context.user) : ''
  return {
    contexts: found
      ? [
          {
            name: found.name,
            ...(server ? { server } : {}),
            ...(found.context.namespace ? { namespace: found.context.namespace } : {}),
            ...(found.context.user ? { user: found.context.user } : {}),
            auth: authOf(raw.users[0]?.user),
            ...(cluster?.['insecure-skip-tls-verify'] === true ? { insecure: true as const } : {}),
          },
        ]
      : [],
    commands: commandsOf(raw.users).map((command) => ({
      ...command,
      consent: consent('run for', command.consent, connection),
    })),
    tokenFiles: tokenFilesOf(raw),
    unverified: unverifiedOf(raw),
    keptCredentials: [],
    files: [],
    conflicts: [],
  }
}

/** Every consent a context's credentials need. */
export const consentsOf = (asks: PastedKubeconfig) => [
  ...asks.unverified.map(({ consent }) => consent),
  ...asks.commands.map(({ consent }) => consent),
  ...asks.tokenFiles.map(({ consent }) => consent),
]

/**
 * Why a context can't be used yet, if it can't: what its credentials would do that isn't agreed
 * to, by kind (never the program's line or a file's name: this is said where errors go).
 */
export function refusalOf(parts: Parts, agreed: readonly string[]): string | undefined {
  const asks = asksOf(rawOf(parts))
  const open = <T extends { consent: string }>(list: T[]) =>
    list.some(({ consent }) => !agreedTo(agreed, consent))
  const doing = [
    open(asks.commands) && 'run a program on this computer',
    open(asks.tokenFiles) && 'send a file to its server',
    open(asks.unverified) && 'go to a server Lumovi can’t verify',
  ].filter((what): what is string => !!what)
  if (doing.length === 0) return undefined
  const what = `${doing.slice(0, -1).join(', ')}${doing.length > 1 ? ' and ' : ''}${doing.at(-1)}`
  return `It’s from a folder of kubeconfigs, and its credentials would ${what}. Allow that first on the clusters page.`
}
