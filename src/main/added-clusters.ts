/**
 * Clusters added in Lumovi (desktop): a kubeconfig pasted or imported, read and checked before it's
 * kept, then kept as a file of Lumovi's own (0600, in a folder of its data only it reads), read
 * after the rest. The person's own files are never written.
 *
 * A credential that runs a program on this computer (an exec plugin, or an auth provider's
 * cmd-path) is shown exactly as it would run, and runs only once the person agrees: neither to
 * check it nor to keep it before then. Kept, it runs as any kubeconfig's does.
 */
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import { parse, stringify } from 'yaml'
import type {
  ClusterCheck,
  CredentialCommand,
  KubeconfigFiles as Files,
  ManagedSettings,
  PastedKubeconfig,
  Result,
} from '@shared/api'
import { kubeRequest } from '@backend/kube/client'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { loadKubeConfig, type KubeConfigStore } from '@backend/kube/kubeconfig'
import { withProxy } from '@backend/network'
import { lockedBy, type KubeconfigFiles } from './kubeconfig-files'

/** The most a kubeconfig is read of: far more than any has. */
const MAX_TEXT = 1024 * 1024
/** How long the server has to answer, and the credentials to work (a browser sign-in included). */
const SERVER_WAIT_MS = 10_000
const CREDENTIALS_WAIT_MS = 60_000

/** Lumovi's own files, in the order they were added (none while the policy keeps to the default). */
export function ownKubeconfigs(folder: string, managed: ManagedSettings | undefined): string[] {
  if (lockedBy(managed)) return []
  try {
    return readdirSync(folder)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
      .map((name) => join(folder, name))
  } catch {
    return []
  }
}

/** A kubeconfig as written: its entries, each by name. */
interface Raw {
  clusters: { name: string; cluster: Record<string, unknown> }[]
  users: { name: string; user: Record<string, unknown> }[]
  contexts: { name: string; context: { cluster: string; user?: string; namespace?: string } }[]
}

export class AddedClusters {
  constructor(
    private readonly deps: {
      /** Where Lumovi's own are kept. */
      folder: string
      store: KubeConfigStore
      files: KubeconfigFiles
      managed: ManagedSettings | undefined
      /** Asks for one file (the system's file picker); null if the person cancels. */
      pick: () => Promise<string | null>
      env?: NodeJS.ProcessEnv
    },
  ) {}

  async import(): Promise<Result<string | null>> {
    try {
      this.#mayChange()
      const path = await this.deps.pick()
      if (!path) return { ok: true, data: null }
      if (statSync(path).size > MAX_TEXT) throw tooLarge()
      return { ok: true, data: readFileSync(path, 'utf8') }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  inspect(text: string): Result<PastedKubeconfig> {
    try {
      const raw = read(text)
      const taken = new Set(this.#others().contexts.map((context) => context.name))
      const users = raw.contexts.flatMap(({ context }) =>
        raw.users.filter((user) => user.name === context.user),
      )
      return {
        ok: true,
        data: {
          contexts: raw.contexts.map(({ name, context }) => {
            const user = raw.users.find((entry) => entry.name === context.user)?.user
            const server = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster
              .server
            return {
              name,
              ...(typeof server === 'string' ? { server } : {}),
              ...(context.namespace ? { namespace: context.namespace } : {}),
              auth: authOf(user),
            }
          }),
          commands: commandsOf(unique(users)),
          files: filesOf(raw),
          conflicts: raw.contexts.map(({ name }) => name).filter((name) => taken.has(name)),
        },
      }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Whether `context` can be used: its server answers, and (if agreed to) its credentials work. */
  async check(
    text: string,
    context: string,
    allowCommands: boolean,
  ): Promise<Result<ClusterCheck>> {
    try {
      this.#mayChange()
      const raw = pick(read(text), [context], {}, { contexts: [], clusters: [], users: [] })
      refuseRelative(raw)
      const kc = this.#kubeConfig(raw)
      const cluster = kc.getCurrentCluster()!

      // Anyone may ask a server its version, mostly: no credentials, so nothing run yet.
      const anonymous = new KubeConfig()
      anonymous.loadFromOptions({
        clusters: [cluster],
        users: [{ name: 'anonymous' }],
        contexts: [{ name: 'check', cluster: cluster.name, user: 'anonymous' }],
        currentContext: 'check',
      })
      let server: ClusterCheck['server']
      try {
        const answer = JSON.parse(
          await kubeRequest(anonymous, '/version', { timeoutMs: SERVER_WAIT_MS }),
        ) as { gitVersion?: unknown }
        server = {
          ok: true,
          ...(typeof answer.gitVersion === 'string' ? { version: answer.gitVersion } : {}),
        }
      } catch (error) {
        // Refused (401, 403…) is answered.
        server =
          error instanceof KubeRequestError && error.status !== undefined
            ? { ok: true }
            : { ok: false, message: toKubeError(error).message }
      }
      if (!server.ok)
        return { ok: true, data: { server, credentials: { ok: false, notTried: 'server' } } }
      if (commandsOf(raw.users).length > 0 && !allowCommands) {
        return { ok: true, data: { server, credentials: { ok: false, notTried: 'commands' } } }
      }

      let credentials: ClusterCheck['credentials']
      try {
        await within(
          CREDENTIALS_WAIT_MS,
          kubeRequest(kc, '/api/v1/namespaces?limit=1', { timeoutMs: SERVER_WAIT_MS }),
        )
        credentials = { ok: true, allowed: true }
      } catch (error) {
        // Signed in, but not let list namespaces: still a way in.
        credentials =
          error instanceof KubeRequestError && error.status === 403
            ? { ok: true, allowed: false }
            : { ok: false, message: toKubeError(error).message }
      }
      // A server that tells only those signed in its version.
      if (credentials.ok && !server.version) server = { ok: true, ...(await versionOf(kc)) }
      return { ok: true, data: { server, credentials } }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Kept as a file of Lumovi's own: its contexts (or those named), each named as `names` says. */
  add(
    text: string,
    options: { contexts?: string[]; names?: Record<string, string>; allowCommands: boolean },
  ): Result<Files> {
    try {
      this.#mayChange()
      const raw = read(text)
      const contexts = options.contexts?.length
        ? options.contexts
        : raw.contexts.map(({ name }) => name)
      const kept = this.#checked(pick(raw, contexts, options.names ?? {}, this.#others()), options)
      mkdirSync(this.deps.folder, { recursive: true, mode: 0o700 })
      const name = `${Date.now()}-${slug(kept.contexts[0]!.name)}-${randomBytes(3).toString('hex')}.yaml`
      writeFileSync(join(this.deps.folder, name), written(kept), { mode: 0o600, flag: 'wx' })
      return { ok: true, data: this.#reread() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  read(path: string): Result<string> {
    try {
      return { ok: true, data: readFileSync(this.#own(path), 'utf8') }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** One of Lumovi's own, written again: checked as when added. */
  edit(path: string, text: string, allowCommands: boolean): Result<Files> {
    try {
      this.#mayChange()
      const own = this.#own(path)
      const raw = read(text)
      const kept = this.#checked(
        pick(
          raw,
          raw.contexts.map(({ name }) => name),
          {},
          this.#others(own),
        ),
        { allowCommands },
      )
      // Whole or not at all: written beside it, then put in its place.
      const next = `${own}.${randomBytes(3).toString('hex')}.tmp`
      writeFileSync(next, written(kept), { mode: 0o600, flag: 'wx' })
      renameSync(next, own)
      return { ok: true, data: this.#reread() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** One of Lumovi's own, no longer read, and its file deleted. */
  remove(path: string): Result<Files> {
    try {
      this.#mayChange()
      rmSync(this.#own(path))
      return { ok: true, data: this.#reread() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** The line that has kubectl read the same: one of the files read, or all of them, in order. */
  forKubectl(path?: string): Result<string> {
    try {
      const read = this.deps.files.list().files.map((file) => file.path)
      if (path !== undefined && !read.includes(path)) {
        throw new KubeRequestError('invalid', `${path} isn’t one of the kubeconfig files read.`)
      }
      return { ok: true, data: kubeconfigLine(path === undefined ? read : [path]) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  #mayChange(): void {
    const locked = lockedBy(this.deps.managed)
    if (locked) throw new KubeRequestError('not-allowed', locked, 403)
  }

  /** What's read now, but `except` (one being edited): what's named in it is taken. */
  #others(except?: string): Raw {
    const kc = loadKubeConfig(
      this.deps.store.paths().paths.filter((file) => resolve(file) !== except),
      this.deps.env,
    )
    return {
      clusters: kc.clusters.map(({ name }) => ({ name, cluster: {} })),
      users: kc.users.map(({ name }) => ({ name, user: {} })),
      contexts: kc.contexts.map(({ name, cluster }) => ({ name, context: { cluster } })),
    }
  }

  /** What's to be kept, if it can be: what it runs agreed to, and every file it names whole. */
  #checked(raw: Raw, { allowCommands }: { allowCommands: boolean }): Raw {
    refuseRelative(raw)
    const commands = commandsOf(raw.users)
    if (commands.length > 0 && !allowCommands) {
      throw new KubeRequestError(
        'not-allowed',
        `Its credentials run ${commands.map(({ line }) => line).join(', ')} on this computer. Agree to that to keep it.`,
        403,
      )
    }
    // As anything that reads it will.
    this.#kubeConfig(raw)
    return raw
  }

  /** As Lumovi would read it: through the proxy the environment says, unless its own does. */
  #kubeConfig(raw: Raw): KubeConfig {
    const kc = new KubeConfig()
    try {
      kc.loadFromString(written(raw))
    } catch (error) {
      throw new KubeRequestError('invalid', (error as Error).message.split('\n')[0]!)
    }
    kc.loadFromOptions({
      clusters: kc.clusters.map((cluster) => withProxy(cluster, this.deps.env ?? process.env)),
      users: kc.users,
      contexts: kc.contexts,
      currentContext: kc.currentContext,
    })
    return kc
  }

  /** One of Lumovi's own, where it is: not any path the page names. */
  #own(path: string): string {
    const own = resolve(path)
    if (dirname(own) !== resolve(this.deps.folder) || !own.endsWith('.yaml')) {
      throw new KubeRequestError('invalid', `${path} isn’t a cluster added in Lumovi.`)
    }
    statSync(own)
    return own
  }

  #reread(): Files {
    this.deps.store.load()
    return this.deps.files.list()
  }
}

/** A kubeconfig's entries, if it's one: without its comments, preferences and current context. */
function read(text: string): Raw {
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
  if (raw.contexts.length === 0) {
    throw new KubeRequestError('invalid', 'It has no contexts: a kubeconfig names at least one.')
  }
  return raw
}

/**
 * Those contexts, each named as `names` says, with their clusters and users named after them
 * (not to be taken for those of the same name read before, as kubectl would). Refused if a
 * context's name is taken.
 */
function pick(raw: Raw, contexts: string[], names: Record<string, string>, others: Raw): Raw {
  const taken = {
    contexts: new Set(others.contexts.map(({ name }) => name)),
    clusters: new Set(others.clusters.map(({ name }) => name)),
    users: new Set(others.users.map(({ name }) => name)),
  }
  const kept: Raw = { clusters: [], users: [], contexts: [] }
  const conflicts: string[] = []
  for (const name of contexts) {
    const found = raw.contexts.find((context) => context.name === name)
    if (!found) throw new KubeRequestError('invalid', `It has no context named “${name}”.`)
    const as = (names[name] ?? name).trim()
    if (!as) throw new KubeRequestError('invalid', `“${name}” needs a name.`)
    if (taken.contexts.has(as)) conflicts.push(as)
    taken.contexts.add(as)

    const cluster = raw.clusters.find((entry) => entry.name === found.context.cluster)
    if (!cluster) {
      throw new KubeRequestError(
        'invalid',
        `“${name}” is on cluster “${found.context.cluster}”, which it doesn’t have.`,
      )
    }
    const clusterName = free(as, taken.clusters)
    kept.clusters.push({ name: clusterName, cluster: cluster.cluster })

    let userName: string | undefined
    if (found.context.user) {
      const user = raw.users.find((entry) => entry.name === found.context.user)
      if (!user) {
        throw new KubeRequestError(
          'invalid',
          `“${name}” signs in as “${found.context.user}”, which it doesn’t have.`,
        )
      }
      userName = free(as, taken.users)
      kept.users.push({ name: userName, user: user.user })
    }
    kept.contexts.push({
      name: as,
      context: { ...found.context, cluster: clusterName, ...(userName ? { user: userName } : {}) },
    })
  }
  if (conflicts.length > 0) {
    throw new KubeRequestError(
      'conflict',
      `Already read: ${conflicts.map((name) => `“${name}”`).join(', ')}. kubectl would take ${conflicts.length === 1 ? 'that one' : 'those'}, so name ${conflicts.length === 1 ? 'it' : 'them'} otherwise.`,
    )
  }
  return kept
}

/** `name`, or the first `name-N` not taken; then taken. */
function free(name: string, taken: Set<string>): string {
  let free = name
  for (let n = 2; taken.has(free); n++) free = `${name}-${n}`
  taken.add(free)
  return free
}

/** As kept: a kubeconfig of these, its first context current. */
function written(raw: Raw): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: raw.clusters,
    users: raw.users,
    contexts: raw.contexts,
    'current-context': raw.contexts[0]?.name ?? '',
  })
}

function authOf(
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
function commandsOf(users: Raw['users']): CredentialCommand[] {
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
      commands.push({
        user: name,
        line: [String(exec.command ?? ''), ...args].map(quoted).join(' '),
        env,
      })
    }
    // GCP's and Azure's run their cmd-path through a shell, with cmd-args as written.
    const cmdPath = provider?.config?.['cmd-path']
    if ((provider?.name === 'gcp' || provider?.name === 'azure') && cmdPath) {
      const args = provider.config?.['cmd-args']
      commands.push({
        user: name,
        line: `"${String(cmdPath)}"${args ? ` ${String(args)}` : ''}`,
        shell: true,
        env: [],
      })
    }
    return commands
  })
}

/** The files on this computer these connections read. */
function filesOf(raw: Raw): string[] {
  const files = [
    ...raw.clusters.map(({ cluster }) => cluster['certificate-authority']),
    ...raw.users.flatMap(({ user }) => [
      user['client-certificate'],
      user['client-key'],
      user['token-file'],
      user.tokenFile,
      (user['auth-provider'] as { config?: Record<string, unknown> } | undefined)?.config
        ?.tokenFile,
    ]),
  ]
  return [...new Set(files.filter((file): file is string => typeof file === 'string' && !!file))]
}

/**
 * Refused if it names a file, or a program, by where it is relative to the kubeconfig: kept in
 * Lumovi's folder, it'd be looked for there.
 */
function refuseRelative(raw: Raw): void {
  const relative = [
    ...filesOf(raw).filter((file) => !isAbsolute(file)),
    ...raw.users
      .map(({ user }) => (user.exec as { command?: unknown } | undefined)?.command)
      .filter(
        (command): command is string =>
          typeof command === 'string' && /[\\/]/.test(command) && !isAbsolute(command),
      ),
  ]
  if (relative.length > 0) {
    throw new KubeRequestError(
      'invalid',
      `It names ${relative.map((file) => `“${file}”`).join(', ')} relative to where it was: give ${relative.length === 1 ? 'its full path' : 'their full paths'}, or the certificate’s data.`,
    )
  }
}

/** A list of unique users (one used by several contexts once). */
function unique(users: Raw['users']): Raw['users'] {
  return users.filter((user, index) => users.findIndex(({ name }) => name === user.name) === index)
}

/** As a shell would need it to be one word. */
function quoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/** For a terminal here: POSIX shells', or PowerShell's on Windows. */
export function kubeconfigLine(paths: string[], platform = process.platform): string {
  const value = paths.join(platform === 'win32' ? ';' : delimiter)
  return platform === 'win32'
    ? `$env:KUBECONFIG = '${value.replaceAll("'", "''")}'`
    : `export KUBECONFIG='${value.replaceAll("'", `'\\''`)}'`
}

/** A file's name from a context's: letters, digits and dashes. */
function slug(name: string): string {
  return (
    basename(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'cluster'
  )
}

function tooLarge(): KubeRequestError {
  return new KubeRequestError('invalid', 'It’s larger than any kubeconfig (over 1 MB).')
}

/** The server's version, if it says. */
async function versionOf(kc: KubeConfig): Promise<{ version?: string }> {
  try {
    const { gitVersion } = JSON.parse(
      await kubeRequest(kc, '/version', { timeoutMs: SERVER_WAIT_MS }),
    ) as { gitVersion?: unknown }
    return typeof gitVersion === 'string' ? { version: gitVersion } : {}
  } catch {
    return {}
  }
}

/** `promise`, or a timeout after `ms`. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KubeRequestError('timeout', `The credentials didn’t work within ${ms / 1000}s.`),
          ),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
