/**
 * Clusters added in Lumovi (desktop): a kubeconfig pasted or imported, read and checked before it's
 * kept, then kept as a file of Lumovi's own (0600, in a folder of its data only it reads), read
 * after the rest. The person's own files are never written.
 *
 * A credential that runs a program on this computer (an exec plugin, or an auth provider's
 * cmd-path), or sends a file of it to the server (a token file), is shown exactly as it would
 * run or what it would send, and is used only once the person agrees to that very thing: neither
 * to check it nor to keep it before then (the credentials aren't even read until then: a token
 * file is read as they are). Kept, it's used as any kubeconfig's is.
 *
 * The page gets an added cluster's text back with its secrets as placeholders: they stay here.
 */
import { createHmac, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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

/** Lumovi's own files, by name (none while the policy keeps to the default). */
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
      // A file, whole: a device's or a pipe's would be read for ever.
      const stat = statSync(path)
      if (!stat.isFile()) throw new KubeRequestError('invalid', `${path} isn’t a file.`)
      if (stat.size > MAX_TEXT) throw tooLarge()
      return { ok: true, data: readFileSync(path, 'utf8') }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * What it holds and does. Of one of Lumovi's own being edited (`editing`), with its secrets for
   * its placeholders: what's agreed to is what it does with them.
   */
  inspect(text: string, editing?: string): Result<PastedKubeconfig> {
    try {
      const given = read(text)
      const stored = this.#stored(editing)
      const raw = stored ? restored(given, stored) : given
      // Taken by what else is read: the one being edited is itself.
      const taken = new Set(
        this.#others(editing === undefined ? undefined : this.#own(editing)).contexts.map(
          (context) => context.name,
        ),
      )
      const used = (raw: Raw) =>
        unique(
          raw.contexts.flatMap(({ context }) =>
            raw.users.filter((user) => user.name === context.user),
          ),
        )
      // Agreed to as they'd run, with their secrets; shown as given, placeholders and all.
      const agreeable = commandsOf(used(raw))
      return {
        ok: true,
        data: {
          contexts: raw.contexts.map(({ name, context }) => {
            const user = raw.users.find((entry) => entry.name === context.user)?.user
            const server = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster
              .server
            const cluster = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster
            // Its password is a secret: shown as kept.
            const proxy = withoutPassword(cluster?.['proxy-url'])
            return {
              name,
              ...(typeof server === 'string' ? { server } : {}),
              ...(context.namespace ? { namespace: context.namespace } : {}),
              auth: authOf(user),
              // Its credentials would go to a server not verified, or everything through a proxy.
              ...(cluster?.['insecure-skip-tls-verify'] === true
                ? { insecure: true as const }
                : {}),
              ...(typeof proxy === 'string' ? { proxy } : {}),
            }
          }),
          commands: commandsOf(used(given)).map((command, index) => ({
            ...command,
            consent: agreeable[index]!.consent,
          })),
          tokenFiles: tokenFilesOf(raw),
          unverified: unverifiedOf(raw),
          keptCredentials: stored
            ? keptSendsOf(given, raw, stored).map(({ context, server, consent }) => ({
                context,
                server,
                consent,
              }))
            : [],
          files: filesOf(raw),
          conflicts: raw.contexts.map(({ name }) => name).filter((name) => taken.has(name)),
        },
      }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * Whether `context` can be used: its server answers, and its credentials work, if what they do
   * here (`agreed`, as inspect gave it) is agreed to.
   */
  async check(
    text: string,
    context: string,
    agreed: string[],
    editing?: string,
  ): Promise<Result<ClusterCheck>> {
    try {
      this.#mayChange()
      // One of Lumovi's own being edited: its placeholders as its secrets (where they were kept for,
      // or agreed to send elsewhere), and what it did before agreed to (where it did it).
      const stored = this.#stored(editing)
      const given = read(text)
      const full = stored ? restored(given, stored) : given
      const agreedByPerson = agreed
      if (stored) agreed = [...agreed, ...carriedConsents(stored, full)]
      const sends = stored
        ? [
            ...keptSendsOf(given, full, stored).filter((send) => send.context === context),
            ...movedCommandsOf(full, stored, context),
          ]
        : []
      const raw = pick(full, [context], {}, { contexts: [], clusters: [], users: [] })
      refuseRelative(raw)
      refuseIrregular(raw)
      // The server without credentials: none read yet.
      const cluster = this.#kubeConfig({ ...raw, users: [] }).getCurrentCluster()!

      // Anyone may ask a server its version, mostly: no credentials, so nothing run yet.
      const anonymous = new KubeConfig()
      anonymous.loadFromOptions({
        clusters: [cluster],
        users: [{ name: 'anonymous' }],
        contexts: [{ name: 'check', cluster: cluster.name, user: 'anonymous' }],
        currentContext: 'check',
      })
      let server: ClusterCheck['server']
      const asked = performance.now()
      const latency = () => ({ latencyMs: Math.round(performance.now() - asked) })
      try {
        const answer = JSON.parse(
          await kubeRequest(anonymous, '/version', { timeoutMs: SERVER_WAIT_MS }),
        ) as { gitVersion?: unknown }
        server = {
          ok: true,
          ...(typeof answer.gitVersion === 'string' ? { version: answer.gitVersion } : {}),
          ...latency(),
        }
      } catch (error) {
        // Refused (401, 403…) is answered.
        server =
          error instanceof KubeRequestError && error.status !== undefined
            ? { ok: true, ...latency() }
            : { ok: false, message: toKubeError(error).message }
      }
      if (!server.ok)
        return { ok: true, data: { server, credentials: { ok: false, notTried: 'server' } } }
      if (
        unagreed(raw, agreed).length > 0 ||
        // What goes somewhere it didn't, agreed to by the person now (not carried over).
        sends.some((send) => !agreedByPerson.includes(send.consent))
      ) {
        return { ok: true, data: { server, credentials: { ok: false, notTried: 'agreement' } } }
      }
      const kc = this.#kubeConfig(raw)

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
      if (credentials.ok && !server.version) server = { ...server, ...(await versionOf(kc)) }
      return { ok: true, data: { server, credentials } }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Kept as a file of Lumovi's own: its contexts (or those named), each named as `names` says. */
  add(
    text: string,
    options: { contexts?: string[]; names?: Record<string, string>; agreed: string[] },
  ): Result<{ path: string; files: Files }> {
    try {
      this.#mayChange()
      const raw = read(text)
      const contexts = options.contexts?.length
        ? options.contexts
        : raw.contexts.map(({ name }) => name)
      const kept = this.#checked(
        pick(raw, contexts, options.names ?? {}, this.#others()),
        options.agreed,
      )
      mkdirSync(this.deps.folder, { recursive: true, mode: 0o700 })
      // Named after its first context, as it's known.
      const taken = new Set(readdirSync(this.deps.folder))
      const name = `${free(slug(kept.contexts[0]!.name), new Set([...taken].map((file) => file.replace(/\.yaml$/, ''))))}.yaml`
      const path = join(this.deps.folder, name)
      writeFileSync(path, written(kept), { mode: 0o600, flag: 'wx' })
      return { ok: true, data: { path, files: this.#reread() } }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Its text, to edit: its secrets as placeholders, which stay here. */
  read(path: string): Result<string> {
    try {
      return { ok: true, data: written(hidden(read(readFileSync(this.#own(path), 'utf8')))) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * One of Lumovi's own, written again: checked as when added. A placeholder left as it was keeps
   * its secret; what it runs or sends, agreed to before, needn't be again.
   */
  edit(path: string, text: string, agreed: string[]): Result<Files> {
    try {
      this.#mayChange()
      const own = this.#own(path)
      const stored = read(readFileSync(own, 'utf8'))
      const given = read(text)
      const raw = restored(given, stored)
      const agreedNow = [...agreed, ...carriedConsents(stored, raw)]
      const kept = this.#checked(
        pick(
          raw,
          raw.contexts.map(({ name }) => name),
          {},
          this.#others(own),
        ),
        agreedNow,
        // What goes somewhere it didn't, agreed to by the person now (not carried over).
        [
          ...keptSendsOf(given, raw, stored)
            .filter((send) => !agreed.includes(send.consent))
            .map((send) => `send its kept credentials to ${send.server}`),
          ...movedCommandsOf(raw, stored)
            .filter((command) => !agreed.includes(command.consent))
            .map((command) => `run ${command.line} on this computer, for ${command.server}`),
        ],
      )
      // Whole or not at all: written beside it, then put in its place.
      const next = `${own}.${randomBytes(3).toString('hex')}.tmp`
      try {
        writeFileSync(next, written(kept), { mode: 0o600, flag: 'wx' })
        renameSync(next, own)
      } finally {
        rmSync(next, { force: true })
      }
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

  /**
   * What's to be kept, if it can be: what it runs or sends agreed to, every file it names whole
   * and a file, and read as anything that reads it will.
   */
  #checked(raw: Raw, agreed: string[], alsoNeeded: string[] = []): Raw {
    refuseRelative(raw)
    refuseIrregular(raw)
    const needed = [...unagreed(raw, agreed), ...alsoNeeded]
    if (needed.length > 0) {
      throw new KubeRequestError(
        'not-allowed',
        `Its credentials would ${needed.join(', and ')}. Agree to that to keep it.`,
        403,
      )
    }
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

  /** One of Lumovi's own, as kept, if one's named. */
  #stored(editing: string | undefined): Raw | undefined {
    return editing === undefined ? undefined : read(readFileSync(this.#own(editing), 'utf8'))
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
 * Those contexts, each named as `names` says, with their clusters and users named as nothing
 * else is (not to be taken for those of the same name read before or after, as kubectl would:
 * the person sees only the context's). Refused if a context's name is taken.
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
    if (kept.contexts.some((context) => context.name === as)) {
      throw new KubeRequestError(
        'invalid',
        `Two of its contexts would be named “${as}”: name them apart.`,
      )
    }
    if (taken.contexts.has(as)) conflicts.push(as)
    taken.contexts.add(as)

    const cluster = raw.clusters.find((entry) => entry.name === found.context.cluster)
    if (!cluster) {
      throw new KubeRequestError(
        'invalid',
        `“${name}” is on cluster “${found.context.cluster}”, which it doesn’t have.`,
      )
    }
    const clusterName = unnamed(taken.clusters)
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
      userName = unnamed(taken.users)
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

/** A name for a cluster or user no kubeconfig of the person's will have; then taken. */
function unnamed(taken: Set<string>): string {
  let name: string
  do name = `lumovi-${randomBytes(6).toString('hex')}`
  while (taken.has(name))
  taken.add(name)
  return name
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
function tokenFilesOf(raw: Raw): PastedKubeconfig['tokenFiles'] {
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

/** Consents' key: this run's own, so the page can't test a guess at what one stands for. */
const CONSENT_KEY = randomBytes(32)

/**
 * What's agreed to, when it is: one thing a credential does here, exactly as it would do it
 * (secrets and all), as a keyed digest: the page gives it back, and learns nothing from it.
 */
function consent(...what: unknown[]): string {
  return createHmac('sha256', CONSENT_KEY).update(JSON.stringify(what)).digest('hex')
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
function connectionOf(raw: Raw, cluster: string): string {
  const found = raw.clusters.find((entry) => entry.name === cluster)?.cluster ?? {}
  return JSON.stringify(CONNECTION.map((key) => found[key] ?? null))
}

/** The connections each user's contexts have. */
function connectionsOf(raw: Raw): Map<string, Set<string>> {
  const connections = new Map<string, Set<string>>()
  for (const { context } of raw.contexts) {
    if (!context.user) continue
    const set = connections.get(context.user) ?? new Set<string>()
    set.add(connectionOf(raw, context.cluster))
    connections.set(context.user, set)
  }
  return connections
}

/**
 * The users of a stored cluster whose contexts, as edited, go somewhere they weren't kept for: a
 * context's connection that none of theirs had (a server moved, a context added).
 */
function movedUsers(edited: Raw, stored: Raw): Set<string> {
  const kept = connectionsOf(stored)
  const moved = new Set<string>()
  for (const [user, connections] of connectionsOf(edited)) {
    const was = kept.get(user)
    if (was && [...connections].some((connection) => !was.has(connection))) moved.add(user)
  }
  return moved
}

/**
 * What a stored cluster's credentials did that was agreed to, still agreed to as edited: but not
 * for a user whose contexts go somewhere they didn't (it would send what the program gives there).
 * A token file's is for the server it goes to anyway.
 */
function carriedConsents(stored: Raw, edited: Raw): string[] {
  const moved = movedUsers(edited, stored)
  return [
    ...commandsOf(stored.users.filter(({ name }) => !moved.has(name))),
    ...tokenFilesOf(stored),
    ...unverifiedOf(stored),
  ].map(({ consent }) => consent)
}

/**
 * The servers not verified (`insecure-skip-tls-verify`) that its credentials would go to:
 * whatever answers there gets them, so each is agreed to first, for that very server.
 */
function unverifiedOf(raw: Raw): { context: string; server: string; consent: string }[] {
  const seen = new Set<string>()
  return raw.contexts.flatMap(({ name, context }) => {
    const cluster = raw.clusters.find((entry) => entry.name === context.cluster)?.cluster
    const user = raw.users.find((entry) => entry.name === context.user)?.user
    if (cluster?.['insecure-skip-tls-verify'] !== true || authOf(user) === 'none') return []
    const server = String(cluster.server ?? '')
    const agreement = consent('unverified', server)
    if (seen.has(agreement)) return []
    seen.add(agreement)
    return [{ context: name, server, consent: agreement }]
  })
}

/**
 * The programs of users whose contexts go somewhere they didn't (`context`'s, if one's named),
 * with where: agreed to anew by the person, since what one gives would go there. Another user's
 * identical program agreed to before (a sibling, as each context gets a user of its own) doesn't
 * count for them.
 */
function movedCommandsOf(
  edited: Raw,
  stored: Raw,
  context?: string,
): { line: string; server: string; consent: string }[] {
  const moved = movedUsers(edited, stored)
  return edited.contexts.flatMap(({ name, context: entry }) => {
    if (context !== undefined && name !== context) return []
    if (!entry.user || !moved.has(entry.user)) return []
    const server = String(
      edited.clusters.find((cluster) => cluster.name === entry.cluster)?.cluster.server ?? '',
    )
    return commandsOf(edited.users.filter((user) => user.name === entry.user)).map(
      ({ line, consent }) => ({ line, server, consent }),
    )
  })
}

/** Whether a user, as given (before its placeholders are its secrets), keeps any of them. */
function keepsSecrets(user: Record<string, unknown> | undefined): boolean {
  return (
    SECRETS.some((at) => dig(user, at) === KEPT) ||
    envOf(user).some((variable) => variable.value === KEPT)
  )
}

/**
 * Where a kept user's secrets would go that they weren't kept for: each context whose connection
 * none of its user's had, to be agreed to (for that very connection) before they're sent there.
 */
function keptSendsOf(
  given: Raw,
  edited: Raw,
  stored: Raw,
): { context: string; server: string; consent: string }[] {
  const kept = connectionsOf(stored)
  const seen = new Set<string>()
  return edited.contexts.flatMap(({ name, context }) => {
    const user = context.user
    if (!user || !keepsSecrets(given.users.find((entry) => entry.name === user)?.user)) return []
    const connection = connectionOf(edited, context.cluster)
    if (kept.get(user)?.has(connection)) return []
    const server = edited.clusters.find((entry) => entry.name === context.cluster)?.cluster.server
    const agreement = consent('kept', user, connection)
    if (seen.has(agreement)) return []
    seen.add(agreement)
    return [{ context: name, server: String(server ?? ''), consent: agreement }]
  })
}

/** What its credentials do here that isn't agreed to, as said to the person. */
function unagreed(raw: Raw, agreed: string[]): string[] {
  return [
    ...unverifiedOf(raw)
      .filter(({ consent }) => !agreed.includes(consent))
      .map(({ server }) => `go to ${server}, which isn’t verified`),
    ...commandsOf(raw.users)
      .filter(({ consent }) => !agreed.includes(consent))
      .map(({ line }) => `run ${line} on this computer`),
    ...tokenFilesOf(raw)
      .filter(({ consent }) => !agreed.includes(consent))
      .map(({ path, server }) => `send ${path} to ${server}`),
  ]
}

/** Where a user's secrets are, and what the page gets in their place. */
const SECRETS = [
  ['token'],
  ['password'],
  ['client-key-data'],
  ['auth-provider', 'config', 'id-token'],
  ['auth-provider', 'config', 'refresh-token'],
  ['auth-provider', 'config', 'access-token'],
  ['auth-provider', 'config', 'client-secret'],
]
const KEPT = '(kept by Lumovi)'

/** `at` in `value`, if it's there. */
function dig(value: unknown, at: string[]): unknown {
  return at.reduce<unknown>(
    (inside, key) =>
      typeof inside === 'object' && inside !== null
        ? (inside as Record<string, unknown>)[key]
        : undefined,
    value,
  )
}

/** `at` in `value` set to `to` (where what holds it is there). */
function put(value: Record<string, unknown>, at: string[], to: unknown): void {
  const holder = dig(value, at.slice(0, -1))
  if (typeof holder === 'object' && holder !== null) {
    ;(holder as Record<string, unknown>)[at.at(-1)!] = to
  }
}

/** A user's program's environment, where it has one (its values can be secrets, as keys). */
function envOf(user: Record<string, unknown> | undefined): { name?: unknown; value?: unknown }[] {
  const provider = user?.['auth-provider'] as { config?: Record<string, unknown> } | undefined
  const exec = (user?.exec ?? provider?.config?.exec) as { env?: unknown } | undefined
  return Array.isArray(exec?.env) ? (exec.env as { name?: unknown; value?: unknown }[]) : []
}

/** A proxy's address with its password as a placeholder (or as it is, without one). */
function withoutPassword(proxy: unknown): unknown {
  if (typeof proxy !== 'string') return proxy
  try {
    const url = new URL(proxy)
    if (!url.password) return proxy
    url.password = KEPT
    return url.toString()
  } catch {
    return proxy
  }
}

/** Whether a proxy's address has its password as a placeholder. */
const keepsPassword = (proxy: unknown) => {
  try {
    return typeof proxy === 'string' && decodeURIComponent(new URL(proxy).password) === KEPT
  } catch {
    return false
  }
}

/** Its users' secrets as placeholders: the program's environment's values, and proxies' passwords. */
function hidden(raw: Raw): Raw {
  const users = raw.users.map(({ name, user }) => {
    const copy = structuredClone(user)
    for (const at of SECRETS) if (dig(copy, at) !== undefined) put(copy, at, KEPT)
    for (const variable of envOf(copy)) variable.value = KEPT
    return { name, user: copy }
  })
  const clusters = raw.clusters.map(({ name, cluster }) =>
    cluster['proxy-url'] === undefined
      ? { name, cluster }
      : { name, cluster: { ...cluster, 'proxy-url': withoutPassword(cluster['proxy-url']) } },
  )
  return { ...raw, users, clusters }
}

/**
 * Each placeholder left in `edited` as the secret `stored` keeps for it (by user, and where; a
 * proxy's password for that very proxy). Where it may go is for keptSendsOf to say.
 */
function restored(edited: Raw, stored: Raw): Raw {
  const clusters = edited.clusters.map(({ name, cluster }) => {
    const proxy = cluster['proxy-url']
    if (!keepsPassword(proxy)) return { name, cluster }
    const was = stored.clusters.find((entry) => entry.name === name)?.cluster['proxy-url']
    // The password, only for the proxy it was kept for.
    if (typeof was !== 'string' || withoutPassword(was) !== withoutPassword(proxy)) {
      throw new KubeRequestError(
        'invalid',
        `“${name}”’s proxy password is ${KEPT} for another proxy: paste it again.`,
      )
    }
    return { name, cluster: { ...cluster, 'proxy-url': was } }
  })
  const users = edited.users.map(({ name, user }) => {
    const copy = structuredClone(user)
    for (const at of SECRETS) {
      if (dig(copy, at) !== KEPT) continue
      const secret = dig(stored.users.find((entry) => entry.name === name)?.user, at)
      if (typeof secret !== 'string') {
        throw new KubeRequestError(
          'invalid',
          `“${name}”’s ${at.at(-1)} is ${KEPT} under another user: paste it again.`,
        )
      }
      put(copy, at, secret)
    }
    const storedEnv = envOf(stored.users.find((entry) => entry.name === name)?.user)
    for (const variable of envOf(copy)) {
      if (variable.value !== KEPT) continue
      const secret = storedEnv.find((entry) => entry.name === variable.name)?.value
      if (typeof secret !== 'string') {
        throw new KubeRequestError(
          'invalid',
          `“${name}”’s ${String(variable.name)} is ${KEPT} under another user: paste it again.`,
        )
      }
      variable.value = secret
    }
    return { name, user: copy }
  })
  return { ...edited, users, clusters }
}

/**
 * Refused if a file it names isn't one, or is larger than any of its kind (a device's would be
 * read for ever).
 */
function refuseIrregular(raw: Raw): void {
  for (const file of filesOf(raw)) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      throw new KubeRequestError('invalid', `It names ${file}, which isn’t there.`)
    }
    if (!stat.isFile())
      throw new KubeRequestError('invalid', `It names ${file}, which isn’t a file.`)
    if (stat.size > MAX_TEXT) {
      throw new KubeRequestError(
        'invalid',
        `It names ${file}, which is larger than any such file (over 1 MB).`,
      )
    }
  }
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

/**
 * For a terminal here: POSIX shells', or PowerShell's on Windows; each path in the home folder
 * from `$HOME`, so it reads as it would be typed. Nothing in a path is read as more than its
 * text: in single quotes for POSIX shells (where a double-quoted `!` is history, in bash and
 * zsh), and in double quotes with what ends or reads into them escaped for PowerShell (its
 * curly quotes too).
 */
export function kubeconfigLine(
  paths: string[],
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const windows = platform === 'win32'
  const parts = paths.flatMap((path, index) => {
    const separator = index > 0 ? [windows ? ';' : ':'] : []
    return path.startsWith(home + (windows ? '\\' : '/'))
      ? [...separator, HOME, path.slice(home.length)]
      : [...separator, path]
  })
  if (windows) {
    const text = parts
      .map((part) => (part === HOME ? '$HOME' : part.replace(/[`"$“”„]/g, '`$&')))
      .join('')
    return `$env:KUBECONFIG = "${text}"`
  }
  // Read as it's typed, in double quotes, where nothing in it means more there (as Lumovi's own
  // folder's paths); else runs of text, each in single quotes, and $HOME in double.
  if (parts.every((part) => part === HOME || !/[$`"\\!]/.test(part))) {
    return `export KUBECONFIG="${parts.map((part) => (part === HOME ? '$HOME' : part)).join('')}"`
  }
  const runs: string[] = []
  for (const part of parts) {
    if (part === HOME || runs.length === 0 || runs.at(-1) === HOME) runs.push(part)
    else runs[runs.length - 1] += part
  }
  const text = runs
    .map((run) => (run === HOME ? '"$HOME"' : `'${run.replaceAll("'", `'\\''`)}'`))
    .join('')
  return `export KUBECONFIG=${text}`
}

/** Where `$HOME` goes in a line's parts. */
const HOME = Symbol('home') as unknown as string

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
