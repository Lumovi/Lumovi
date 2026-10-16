/**
 * The chart repositories and OCI registries Lumovi reads charts from (LMV-354): Lumovi's own list,
 * never Helm's, each with its sign-in where it has one. On the desktop they're kept for every
 * cluster, a sign-in in the system's keychain; on a server for everyone, sealed in its state, and
 * only its admins add them (see the keepers in main/ and server/).
 *
 * Helm never sees a sign-in. Lumovi fetches a chart itself, in memory, checks it against the
 * digest its repository lists, and hands Helm the file, in a folder of its own that's removed
 * after. A sign-in goes only where it was given: the repository's own scheme, host and port, under
 * its path, over https alone; a redirect anywhere else is followed without it.
 * What's read is bounded: its size, its time, a chart's size unpacked, and an index's YAML read
 * without aliases.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parse } from 'yaml'
import type {
  HelmRepositories,
  HelmRepository,
  HelmRepositoryInput,
  HelmRepositoryTest,
  RepositoryChart,
  Result,
} from '@shared/api'
import {
  addressOf,
  CHART_NAME,
  compareChartVersions,
  REPOSITORY_ID,
  REPOSITORY_NAME,
  sameOrigin,
  signInGoes,
} from '@shared/helm-repositories'
import type { Recorded } from '../audit/recorder'
import { KubeRequestError, toKubeError } from '../kube/errors'
import { assertQuery, assertString, invalid } from '../kube/validate'
import { fetchFailure, privateHost } from '../network'

/** The most an index, a manifest or a chart may be, as fetched. */
export const MOST_FETCHED = 20 * 1024 * 1024
/** The most a chart may be unpacked (Helm's own limit, too). */
export const MOST_UNPACKED = 100 * 1024 * 1024
/** The most an icon may be. */
export const MOST_ICON = 256 * 1024
/** How long one fetch may take, redirects and all. */
const FETCH_TIMEOUT_MS = 30_000
/** How many redirects a fetch follows. */
const MOST_REDIRECTS = 5
/** How many repositories, and how many charts a registry is asked for. */
const MOST_REPOSITORIES = 50
const MOST_REGISTRY_CHARTS = 50
const MOST_SECRET = 8192
/** How long a read is as good as a new one, however many ask for one. */
const FRESH_MS = 30_000

const HELM_CHART_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip'
const HELM_CONFIG = 'application/vnd.cncf.helm.config.v1+json'
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const ICON_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml)$/

/** A repository as it's kept: its sign-in's secret apart (see RepositoryKeeper.secret). */
export interface KeptRepository {
  id: string
  name: string
  kind: 'http' | 'oci'
  url: string
  charts: string[]
  username?: string
}

/** A repository as a deploy's record names it. */
export interface DeployedFrom {
  id: string
  name: string
  /** A registry's host. */
  registry?: string
}

/** Where repositories are kept: the desktop's file and keychain, or a server's sealed state. */
export interface RepositoryKeeper {
  kept: 'computer' | 'server'
  /** Why a sign-in can't be kept here (no keychain), where one can't. */
  noSignIns(): string | undefined
  list(): Promise<KeptRepository[]>
  /** Kept as it is: with `secret` its sign-in's new one, without it the one kept, null none. */
  put(repository: KeptRepository, secret: string | null | undefined): Promise<void>
  /** Forgotten, its sign-in with it. */
  remove(id: string): Promise<void>
  /** Its sign-in's password or token. */
  secret(id: string): Promise<string | undefined>
}

/** A change to the list, as it's recorded. */
export interface RepositoryChange {
  action: 'added' | 'changed' | 'removed'
  repository: KeptRepository
  /** What was done with its sign-in: never its secret. */
  signIn?: 'set' | 'replaced' | 'removed'
}

/** Who's asking: whether they may change the list, and what's recorded of it. */
export interface RepositoryPerson {
  mayChange(): boolean
  /** A server's admins, said to someone who may not. */
  admins?(): string[]
  /** Records a change (see recordOf). */
  record?(change: RepositoryChange): void
}

/** A change to the list, for the audit log: what was done with a sign-in, never the secret. */
export function recordOf({ action, repository, signIn }: RepositoryChange): Recorded {
  const done = { added: 'Added', changed: 'Changed', removed: 'Removed' }[action]
  const said = {
    set: 'with a sign-in',
    replaced: 'its sign-in replaced',
    removed: 'its sign-in removed',
  }
  return {
    action: `helm-repository.${action}`,
    outcome: 'success',
    target: { kind: 'HelmRepository', name: repository.name },
    summary: `${done} chart repository ${repository.name} (${repository.url})${signIn && action !== 'removed' ? `, ${said[signIn]}` : ''}`,
    details: {
      kind: repository.kind,
      url: repository.url,
      ...(repository.kind === 'oci' ? { charts: repository.charts } : {}),
      ...(repository.username ? { username: repository.username } : {}),
      ...(signIn ? { signIn } : {}),
    },
  }
}

/** A chart's versions as its repository lists them, with where each is and its digest. */
interface Listed {
  chart: RepositoryChart
  icon?: string
  files: Map<string, { url?: string; digest?: string }>
}

/** What a repository's last read found. */
interface Read {
  at: string
  charts?: Listed[]
  error?: string
}

/** The indexes read, shared by everyone a server serves (they're the same repositories). */
export class RepositoryReads {
  readonly reads = new Map<string, Read>()
  /** A read under way, by repository: asked again meanwhile, it's waited for. */
  readonly reading = new Map<string, Promise<Read>>()
}

/** A sign-in, and the one place it may go: an origin, and the path it's under. */
interface SignIn {
  username: string
  secret: string
  origin: string
  path: string
}

export interface RepositoryOptions {
  keeper: RepositoryKeeper
  person: RepositoryPerson
  reads?: RepositoryReads
  /** Refuses URLs a server mustn't fetch from (private addresses), redirects' too. */
  checkUrl?: (url: string) => Promise<void>
  now?: () => Date
  /** What fetches: the global fetch (through Lumovi's network, its proxy and authorities). */
  fetch?: typeof globalThis.fetch
}

/** The repositories Lumovi keeps, and what's in them: for one person. */
export class ChartRepositories {
  readonly #keeper: RepositoryKeeper
  readonly #person: RepositoryPerson
  readonly #reads: RepositoryReads
  readonly #checkUrl: (url: string) => Promise<void>
  readonly #now: () => Date
  readonly #fetchUrl: typeof globalThis.fetch

  constructor(options: RepositoryOptions) {
    this.#keeper = options.keeper
    this.#person = options.person
    this.#reads = options.reads ?? new RepositoryReads()
    this.#checkUrl = options.checkUrl ?? (async () => undefined)
    this.#now = options.now ?? (() => new Date())
    this.#fetchUrl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  list(): Promise<Result<HelmRepositories>> {
    return result(async () => this.#state(await this.#keeper.list()))
  }

  /** Every repository read again now (each read once, however many ask meanwhile). */
  refresh(): Promise<Result<HelmRepositories>> {
    return result(async () => {
      const kept = await this.#keeper.list()
      // (Read a moment ago, by this person or another, it's as it was.)
      const now = this.#now().getTime()
      await Promise.all(
        kept
          .filter((r) => !(now - Date.parse(this.#reads.reads.get(r.id)?.at ?? '') < FRESH_MS))
          .map((repository) => this.#readAgain(repository)),
      )
      return this.#state(kept)
    })
  }

  /** Whether a repository can be read as given: its sign-in, or (left out) the saved one's. */
  test(input: unknown): Promise<Result<HelmRepositoryTest>> {
    return result(async () => {
      this.#mayChange()
      const kept = await this.#keeper.list()
      const { repository, secret } = this.#checked(input, kept)
      const signIn = await this.#signIn(repository, secret)
      const charts = await this.#index(repository, signIn)
      return repository.kind === 'oci'
        ? {
            found: charts.map((listed) => ({
              chart: listed.chart.name,
              versions: listed.chart.versions.length,
            })),
          }
        : { charts: charts.length }
    })
  }

  save(input: unknown): Promise<Result<HelmRepositories>> {
    return result(async () => {
      this.#mayChange()
      const kept = await this.#keeper.list()
      const { repository, secret, before } = this.#checked(input, kept)
      if (!before && kept.length >= MOST_REPOSITORIES) {
        throw invalid(`Lumovi keeps at most ${MOST_REPOSITORIES} repositories.`)
      }
      if (repository.username !== undefined && secret === undefined && !before?.username) {
        throw invalid('Give its password or token.')
      }
      const signIn: 'set' | 'replaced' | 'removed' | undefined =
        secret === null
          ? before?.username
            ? 'removed'
            : undefined
          : secret !== undefined
            ? before?.username
              ? 'replaced'
              : 'set'
            : undefined
      await this.#keeper.put(repository, secret)
      this.#reads.reads.delete(repository.id)
      this.#person.record?.({
        action: before ? 'changed' : 'added',
        repository,
        ...(signIn ? { signIn } : {}),
      })
      const now = await this.#keeper.list()
      await this.#readAgain(repository)
      return this.#state(now)
    })
  }

  remove(id: unknown): Promise<Result<HelmRepositories>> {
    return result(async () => {
      this.#mayChange()
      assertString(id, 'id')
      const kept = await this.#keeper.list()
      const repository = kept.find((r) => r.id === id)
      if (!repository) throw new KubeRequestError('not-found', 'That repository isn’t kept now.')
      await this.#keeper.remove(id)
      this.#reads.reads.delete(id)
      this.#person.record?.({
        action: 'removed',
        repository,
        ...(repository.username ? { signIn: 'removed' as const } : {}),
      })
      return this.#state(await this.#keeper.list())
    })
  }

  /**
   * A chart's icon as a data: URL, fetched here (never by the page): over https, at most
   * MOST_ICON, an image, and only from the repository's own host or a public address. Null where
   * it names none Lumovi fetches.
   */
  icon(id: unknown, chart: unknown): Promise<Result<string | null>> {
    return result(async () => {
      assertString(id, 'repository')
      assertString(chart, 'chart')
      const repository = (await this.#keeper.list()).find((r) => r.id === id)
      const listed = this.#reads.reads.get(id)?.charts?.find((c) => c.chart.name === chart)
      if (!repository || !listed?.icon) return null
      let url: URL
      try {
        url = new URL(listed.icon)
      } catch {
        return null
      }
      if (url.protocol !== 'https:' || url.username || url.password) return null
      const own = addressOf(repository.kind, repository.url)
      const ownHost = 'url' in own ? own.url.host : undefined
      // Each hop, the first and every redirect's: over https, and the repository's own host or a
      // public address (never a private, link-local or cluster-local one), on the desktop too.
      const check = async (hop: URL) => {
        if (hop.protocol !== 'https:') throw new Error('An icon is fetched over https alone.')
        if (hop.host === ownHost) return
        if (/\.(local|internal|svc)$/i.test(hop.hostname) || (await privateHost(hop.href))) {
          throw new Error(`Lumovi doesn’t fetch an icon from ${hop.hostname}: it’s private.`)
        }
      }
      const fetched = await this.#fetch(url.href, {
        signIn: await this.#signIn(repository),
        most: MOST_ICON,
        accept: 'image/*',
        check,
      }).catch(() => undefined)
      const type = fetched?.type.split(';')[0]!.trim().toLowerCase()
      if (!fetched || !type || !ICON_TYPES.test(type)) return null
      return `data:${type};base64,${fetched.body.toString('base64')}`
    })
  }

  /**
   * What the audit log says of a repository a deploy is from: its id and name, and a registry's
   * host. Never its address's path or query, nor its sign-in.
   */
  async named(id: string): Promise<DeployedFrom | undefined> {
    const repository = (await this.#keeper.list()).find((r) => r.id === id)
    if (!repository) return undefined
    const address = addressOf(repository.kind, repository.url)
    return {
      id: repository.id,
      name: repository.name,
      ...(repository.kind === 'oci' && 'url' in address ? { registry: address.url.host } : {}),
    }
  }

  /**
   * A chart from a repository, fetched with its sign-in and checked against the digest it lists,
   * as a file in a folder of its own: for Helm, which `done` removes (on every path).
   */
  async fetchChart(
    id: string,
    chart: string,
    version: string,
  ): Promise<{ file: string; done: () => Promise<void> }> {
    if (!REPOSITORY_ID.test(id)) throw invalid('That isn’t a repository Lumovi keeps.')
    if (!CHART_NAME.test(chart)) throw invalid('That isn’t a chart’s name.')
    if (!/^[\w.+-]+$/.test(version) || version.startsWith('-')) {
      throw invalid('That isn’t a chart’s version.')
    }
    const repository = (await this.#keeper.list()).find((r) => r.id === id)
    if (!repository) throw new KubeRequestError('not-found', 'That repository isn’t kept now.')
    const signIn = await this.#signIn(repository)
    const body =
      repository.kind === 'oci'
        ? await this.#registryChart(repository, signIn, chart, version)
        : await this.#repositoryChart(repository, signIn, chart, version)
    // A chart that unpacks to more than Helm would take, or isn't a gzip at all, goes no further.
    try {
      gunzipSync(body, { maxOutputLength: MOST_UNPACKED })
    } catch {
      throw invalid(
        `The chart Lumovi fetched isn’t one Helm can read: it isn’t a packaged chart, or it unpacks to more than ${MOST_UNPACKED / 1024 / 1024} MB.`,
      )
    }
    const directory = await mkdtemp(join(tmpdir(), 'lumovi-chart-'))
    const done = () => rm(directory, { recursive: true, force: true })
    try {
      const file = join(directory, `${chart}-${version}.tgz`)
      await writeFile(file, body, { mode: 0o600 })
      return { file, done }
    } catch (error) {
      await done()
      throw error
    }
  }

  /** The person may change the list, or they're told who may. */
  #mayChange(): void {
    if (this.#person.mayChange()) return
    const admins = this.#person.admins?.() ?? []
    throw new KubeRequestError(
      'forbidden',
      admins.length
        ? `Only Lumovi’s admins add and change repositories here. The server names them: ${admins.join(', ')}.`
        : 'Lumovi’s admins add repositories here, and this server names none. Whoever runs it sets them with LUMOVI_ADMINS (the chart’s access.admins).',
    )
  }

  /** What's given, checked: as it'd be kept, and what's done with its sign-in. */
  #checked(
    input: unknown,
    kept: KeptRepository[],
  ): { repository: KeptRepository; secret: string | null | undefined; before?: KeptRepository } {
    const r = assertQuery<HelmRepositoryInput>(input)
    const before = r.id === undefined ? undefined : kept.find((k) => k.id === r.id)
    if (r.id !== undefined && !before) {
      throw new KubeRequestError('not-found', 'That repository isn’t kept now.')
    }
    assertString(r.name, 'name')
    const name = r.name.trim()
    if (!REPOSITORY_NAME.test(name) || name.length > 63) {
      throw invalid(
        'A repository’s name is letters, digits, dashes, dots and underscores, at most 63.',
      )
    }
    if (kept.some((k) => k.name === name && k.id !== before?.id)) {
      throw invalid(`There’s a repository named ${name} already.`)
    }
    if (r.kind !== 'http' && r.kind !== 'oci') throw invalid('kind must be http or oci')
    assertString(r.url, 'url')
    const address = addressOf(r.kind, r.url)
    if ('problem' in address) throw invalid(address.problem)
    const url = r.url.trim().replace(/\/+$/, '')
    let charts: string[] = []
    if (r.kind === 'oci') {
      if (!Array.isArray(r.charts) || r.charts.length === 0) {
        throw invalid('Name the charts Lumovi should look for: a registry has no index.')
      }
      charts = [...new Set(r.charts.map((c) => (typeof c === 'string' ? c.trim() : '')))]
      if (charts.length > MOST_REGISTRY_CHARTS) {
        throw invalid(`Lumovi looks for at most ${MOST_REGISTRY_CHARTS} charts in a registry.`)
      }
      const bad = charts.find((c) => !CHART_NAME.test(c))
      if (bad !== undefined) throw invalid(`${bad || 'An empty name'} isn’t a chart’s name.`)
    }
    let username: string | undefined
    let secret: string | null | undefined = null
    if (r.signIn !== null && r.signIn !== undefined) {
      assertString(r.signIn.username, 'username')
      username = r.signIn.username.trim()
      if (!username || username.length > 256 || /[\s:]/.test(username)) {
        throw invalid('A user name has no spaces or colons.')
      }
      if (!signInGoes(address.url)) {
        throw invalid(
          'A sign-in is only sent over https. Use the repository’s https address to add one.',
        )
      }
      const noKeeping = this.#keeper.noSignIns()
      if (noKeeping) throw invalid(noKeeping)
      if (r.signIn.secret !== undefined) {
        assertString(r.signIn.secret, 'secret')
        if (!r.signIn.secret || r.signIn.secret.length > MOST_SECRET) {
          throw invalid('Give its password or token.')
        }
        secret = r.signIn.secret
      } else if (
        before?.username &&
        before.username === username &&
        sameOrigin(before.url, url, before.kind) &&
        before.kind === r.kind
      ) {
        // Left out: the saved one stays, only where it still goes to the same place, as the same user.
        secret = undefined
      } else {
        throw invalid(
          before?.username && !sameOrigin(before.url, url, before.kind)
            ? 'Changing the host removes its sign-in. Enter it again for the new address.'
            : 'Give its password or token.',
        )
      }
    }
    return {
      repository: {
        id: before?.id ?? randomBytes(8).toString('hex'),
        name,
        kind: r.kind,
        url,
        charts,
        ...(username !== undefined ? { username } : {}),
      },
      secret,
      ...(before ? { before } : {}),
    }
  }

  /** A repository's sign-in, and where it may go: the saved one's, or one being tried. */
  async #signIn(repository: KeptRepository, given?: string | null): Promise<SignIn | undefined> {
    if (!repository.username || given === null) return undefined
    const secret = given ?? (await this.#keeper.secret(repository.id))
    if (!secret) return undefined
    const address = addressOf(repository.kind, repository.url)
    if ('problem' in address || !signInGoes(address.url)) return undefined
    return {
      username: repository.username,
      secret,
      origin: address.url.origin,
      path: address.url.pathname.replace(/\/+$/, ''),
    }
  }

  async #readAgain(repository: KeptRepository): Promise<Read> {
    const under = this.#reads.reading.get(repository.id)
    if (under) return under
    const reading = (async (): Promise<Read> => {
      const at = this.#now().toISOString()
      try {
        return { at, charts: await this.#index(repository, await this.#signIn(repository)) }
      } catch (error) {
        return { at, error: (error as Error).message }
      }
    })()
    this.#reads.reading.set(repository.id, reading)
    try {
      const read = await reading
      this.#reads.reads.set(repository.id, read)
      return read
    } finally {
      this.#reads.reading.delete(repository.id)
    }
  }

  #state(kept: KeptRepository[]): HelmRepositories {
    const noSignIns = this.#keeper.noSignIns()
    const mayChange = this.#person.mayChange()
    const admins = mayChange ? undefined : this.#person.admins?.()
    return {
      repositories: kept.map((k): HelmRepository => {
        const read = this.#reads.reads.get(k.id)
        return {
          id: k.id,
          name: k.name,
          kind: k.kind,
          url: k.url,
          charts: k.charts,
          ...(k.username ? { username: k.username } : {}),
          ...(read
            ? {
                read: read.error
                  ? { at: read.at, error: read.error }
                  : { at: read.at, charts: read.charts!.length },
              }
            : {}),
        }
      }),
      charts: kept
        .flatMap((k) => this.#reads.reads.get(k.id)?.charts ?? [])
        .map((listed) => listed.chart)
        .sort((a, b) => a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository)),
      kept: this.#keeper.kept,
      mayChange,
      ...(admins ? { admins } : {}),
      ...(noSignIns ? { noSignIns } : {}),
    }
  }

  /** What a repository has: its index's charts, or each chart a registry is asked for. */
  async #index(repository: KeptRepository, signIn: SignIn | undefined): Promise<Listed[]> {
    if (repository.kind === 'oci') {
      return Promise.all(
        repository.charts.map((chart) => this.#registryListed(repository, signIn, chart)),
      )
    }
    const { body } = await this.#fetch(`${repository.url}/index.yaml`, {
      signIn,
      most: MOST_FETCHED,
      accept: 'application/x-yaml, text/yaml, */*',
    })
    let index: { entries?: Record<string, IndexVersion[]> }
    try {
      // No aliases: an index is data, and an alias can make a few bytes into a lot.
      index = parse(body.toString('utf8'), {
        maxAliasCount: 0,
        prettyErrors: false,
      }) as typeof index
    } catch (error) {
      throw new Error(`Couldn’t read its index: ${(error as Error).message.split('\n')[0]}`, {
        cause: error,
      })
    }
    if (
      !index ||
      typeof index !== 'object' ||
      !index.entries ||
      typeof index.entries !== 'object'
    ) {
      throw new Error('Couldn’t read its index: it lists no charts.')
    }
    return Object.entries(index.entries).flatMap(([name, versions]): Listed[] => {
      if (!CHART_NAME.test(name) || !Array.isArray(versions)) return []
      const ordered = versions
        .filter((v) => v && typeof v === 'object' && typeof v.version === 'string')
        .sort((a, b) => compareChartVersions(b.version, a.version))
      const latest = ordered[0]
      if (!latest) return []
      return [
        {
          chart: {
            repository: repository.id,
            name,
            ...text('description', latest.description),
            ...(Array.isArray(latest.keywords)
              ? { keywords: latest.keywords.filter((k) => typeof k === 'string').slice(0, 20) }
              : {}),
            ...link('home', latest.home),
            ...sources(latest.sources),
            icon: typeof latest.icon === 'string' && latest.icon.startsWith('https://'),
            versions: ordered.map((v) => ({
              version: v.version,
              ...text('appVersion', v.appVersion),
              ...text('created', v.created),
            })),
          },
          ...(typeof latest.icon === 'string' ? { icon: latest.icon } : {}),
          files: new Map(
            ordered.map((v) => [
              v.version,
              {
                ...(Array.isArray(v.urls) && typeof v.urls[0] === 'string'
                  ? { url: new URL(v.urls[0], `${repository.url}/`).href }
                  : {}),
                ...(typeof v.digest === 'string' ? { digest: v.digest.toLowerCase() } : {}),
              },
            ]),
          ),
        },
      ]
    })
  }

  /** A chart in a repository: fetched from where its index says, and checked against its digest. */
  async #repositoryChart(
    repository: KeptRepository,
    signIn: SignIn | undefined,
    chart: string,
    version: string,
  ): Promise<Buffer> {
    const read = this.#reads.reads.get(repository.id)
    let listed = read?.charts?.find((c) => c.chart.name === chart)
    if (!listed?.files.get(version)) {
      listed = (await this.#index(repository, signIn)).find((c) => c.chart.name === chart)
    }
    const file = listed?.files.get(version)
    if (!file) {
      throw new KubeRequestError('not-found', `${repository.name} has no ${chart} ${version}.`)
    }
    if (!file.url)
      throw invalid(`${repository.name}’s index says nowhere to fetch ${chart} ${version} from.`)
    if (!file.digest || !/^[0-9a-f]{64}$/.test(file.digest)) {
      throw invalid(
        `${repository.name}’s index lists no digest for ${chart} ${version}, so Lumovi can’t check the chart it fetches.`,
      )
    }
    const { body } = await this.#fetch(file.url, { signIn, most: MOST_FETCHED })
    if (sha256(body) !== file.digest) {
      throw invalid('The chart Lumovi fetched isn’t the one its repository lists.')
    }
    return body
  }

  /** A chart in a registry: its tags as versions, and what its newest's config says of it. */
  async #registryListed(
    repository: KeptRepository,
    signIn: SignIn | undefined,
    chart: string,
  ): Promise<Listed> {
    const registry = new Registry(repository, chart, signIn, (url, options) =>
      this.#fetch(url, options),
    )
    const { body } = await registry.get(`tags/list`, 'application/json')
    const tags = (JSON.parse(body.toString('utf8')) as { tags?: unknown }).tags
    // Helm writes a version's + as _ in a tag (a tag can't hold +).
    const versions = (Array.isArray(tags) ? tags : [])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/_/g, '+'))
      .filter((v) => compareChartVersions(v, '0.0.0') >= 0 || /^v?\d+\.\d+\.\d+-/.test(v))
      .sort((a, b) => compareChartVersions(b, a))
    if (versions.length === 0) throw new Error(`Couldn’t read ${chart}: it has no versions.`)
    let config: IndexVersion = { version: versions[0]! }
    try {
      const manifest = await registry.manifest(versions[0]!)
      if (manifest.config?.mediaType === HELM_CONFIG && manifest.config.digest) {
        const blob = await registry.blob(manifest.config.digest, 1024 * 1024)
        config = JSON.parse(blob.toString('utf8')) as IndexVersion
      }
    } catch {
      // Its versions are what counts; what it says of itself is extra.
    }
    return {
      chart: {
        repository: repository.id,
        name: chart,
        ...text('description', config.description),
        ...link('home', config.home),
        ...sources(config.sources),
        icon: typeof config.icon === 'string' && config.icon.startsWith('https://'),
        versions: versions.map((version, i) => ({
          version,
          ...(i === 0 ? text('appVersion', config.appVersion) : {}),
        })),
      },
      ...(typeof config.icon === 'string' ? { icon: config.icon } : {}),
      files: new Map(versions.map((v) => [v, {}])),
    }
  }

  /** A chart in a registry: its manifest checked against its digest, and its layer against its own. */
  async #registryChart(
    repository: KeptRepository,
    signIn: SignIn | undefined,
    chart: string,
    version: string,
  ): Promise<Buffer> {
    if (!repository.charts.includes(chart)) {
      throw new KubeRequestError(
        'not-found',
        `Lumovi doesn’t look for ${chart} in ${repository.name}.`,
      )
    }
    const registry = new Registry(repository, chart, signIn, (url, options) =>
      this.#fetch(url, options),
    )
    const manifest = await registry.manifest(version)
    const layer = manifest.layers?.find((l) => l.mediaType === HELM_CHART_LAYER)
    if (!layer?.digest)
      throw invalid(`${chart} ${version} in ${repository.name} isn’t a Helm chart.`)
    if (typeof layer.size === 'number' && layer.size > MOST_FETCHED) {
      throw invalid(
        `${chart} ${version} is larger than Lumovi fetches (${MOST_FETCHED / 1024 / 1024} MB).`,
      )
    }
    return registry.blob(layer.digest, MOST_FETCHED)
  }

  /**
   * Fetches a URL: within MOST_REDIRECTS redirects, each checked as the first is; the sign-in
   * only where it goes (its origin, under its path, over https); within a
   * time and a size.
   */
  async #fetch(url: string, options: FetchOptions): Promise<Fetched> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    let at = new URL(url)
    for (let hop = 0; hop <= MOST_REDIRECTS; hop++) {
      if (at.protocol !== 'https:' && at.protocol !== 'http:') {
        throw new Error(`Couldn’t read ${at.host}: Lumovi only fetches over https and http.`)
      }
      if (at.username || at.password)
        throw new Error('Lumovi doesn’t send a sign-in in an address.')
      await this.#checkUrl(at.href)
      await options.check?.(at)
      const headers: Record<string, string> = {
        'user-agent': 'Lumovi',
        ...(options.accept ? { accept: options.accept } : {}),
        ...options.headers,
      }
      const goes =
        options.signIn &&
        signInGoes(at) &&
        at.origin === options.signIn.origin &&
        (at.pathname === options.signIn.path ||
          at.pathname.startsWith(`${options.signIn.path}/`) ||
          options.signIn.path === '')
      if (options.authorization === undefined && goes) {
        headers.authorization = `Basic ${Buffer.from(`${options.signIn!.username}:${options.signIn!.secret}`).toString('base64')}`
      } else if (options.authorization && at.origin === options.authorizationOrigin) {
        headers.authorization = options.authorization
      }
      const response = await this.#fetchUrl(at, { headers, redirect: 'manual', signal }).catch(
        (error: Error) => {
          throw new Error(`Couldn’t reach ${at.host}: ${fetchFailure(error)}`)
        },
      )
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel()
        if (options.redirects === false) {
          throw new Error(`Couldn’t sign in: ${at.host} redirected its sign-in elsewhere.`)
        }
        at = new URL(response.headers.get('location')!, at)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new FetchError(
          response.status,
          response.statusText,
          response.headers.get('www-authenticate'),
        )
      }
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > options.most) {
        await response.body?.cancel()
        throw new Error(tooLarge(options.most))
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response.body ?? []) {
        size += (chunk as Uint8Array).length
        if (size > options.most) throw new Error(tooLarge(options.most))
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
      return {
        body: Buffer.concat(chunks),
        type: response.headers.get('content-type') ?? '',
        digest: response.headers.get('docker-content-digest') ?? undefined,
      }
    }
    throw new Error(
      `Couldn’t read ${new URL(url).host}: it redirected more than ${MOST_REDIRECTS} times.`,
    )
  }
}

interface FetchOptions {
  signIn?: SignIn
  /** False: a redirect is an error (a token's realm), not followed. */
  redirects?: false
  /** Refuses a hop (each, the first too) besides what refuses any of a server's. */
  check?: (url: URL) => Promise<void>
  most: number
  accept?: string
  headers?: Record<string, string>
  /** A registry's token, and the one origin it goes to (its sign-in's never goes with it). */
  authorization?: string
  authorizationOrigin?: string
}

interface Fetched {
  body: Buffer
  type: string
  digest?: string
}

/** What a repository's index lists of a chart's version (Chart.yaml's fields, and where it is). */
interface IndexVersion {
  version: string
  appVersion?: unknown
  description?: unknown
  keywords?: unknown[]
  home?: unknown
  sources?: unknown[]
  icon?: unknown
  created?: unknown
  urls?: unknown[]
  digest?: unknown
}

/** A fetch a server answered with an error: said in Lumovi's words, by its status. */
export class FetchError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly challenge: string | null,
  ) {
    const said = `${status}${statusText ? ` ${statusText}` : ''}`
    super(
      status === 401
        ? `Couldn’t sign in: ${said}.`
        : status === 403
          ? `Not allowed: ${said}.`
          : `Couldn’t read: ${said}.`,
    )
  }
}

/**
 * A chart in an OCI registry, read through its API (the distribution spec): a token where it
 * asks for one, from the realm it names, only over https and on its own host's domain.
 */
class Registry {
  readonly #base: string
  readonly #name: string
  #token?: string

  constructor(
    repository: KeptRepository,
    chart: string,
    private readonly signIn: SignIn | undefined,
    private readonly fetchUrl: (url: string, options: FetchOptions) => Promise<Fetched>,
  ) {
    const address = addressOf('oci', repository.url) as { url: URL }
    this.#base = `${address.url.origin}/v2`
    this.#name = `${address.url.pathname.replace(/^\/+|\/+$/g, '')}/${chart}`
  }

  async get(path: string, accept: string, most = MOST_FETCHED): Promise<Fetched> {
    const url = `${this.#base}/${this.#name}/${path}`
    const options = (): FetchOptions => ({
      most,
      accept,
      ...(this.#token
        ? {
            authorization: `Bearer ${this.#token}`,
            authorizationOrigin: new URL(this.#base).origin,
          }
        : this.signIn
          ? { signIn: { ...this.signIn, path: `/v2/${this.#name}` } }
          : {}),
    })
    try {
      return await this.fetchUrl(url, options())
    } catch (error) {
      if (
        !(error instanceof FetchError) ||
        error.status !== 401 ||
        this.#token ||
        !error.challenge
      ) {
        throw error
      }
      this.#token = await this.#tokenFor(error.challenge)
      return this.fetchUrl(url, options())
    }
  }

  async manifest(version: string): Promise<{
    config?: { mediaType?: string; digest?: string }
    layers?: { mediaType?: string; digest?: string; size?: number }[]
  }> {
    const fetched = await this.get(
      `manifests/${version.replace(/\+/g, '_')}`,
      OCI_MANIFEST,
      1024 * 1024,
    )
    if (fetched.digest && /^sha256:[0-9a-f]{64}$/.test(fetched.digest)) {
      if (`sha256:${sha256(fetched.body)}` !== fetched.digest) {
        throw invalid('The chart Lumovi fetched isn’t the one its repository lists.')
      }
    }
    return JSON.parse(fetched.body.toString('utf8')) as Awaited<ReturnType<Registry['manifest']>>
  }

  /** A blob, checked against its digest: what it's named by. */
  async blob(digest: string, most: number): Promise<Buffer> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
      throw invalid('The registry names a blob by a digest Lumovi doesn’t check.')
    const { body } = await this.get(`blobs/${digest}`, '*/*', most)
    if (`sha256:${sha256(body)}` !== digest) {
      throw invalid('The chart Lumovi fetched isn’t the one its repository lists.')
    }
    return body
  }

  /** A Bearer token, from the realm the registry names; asked with the sign-in where there is one. */
  async #tokenFor(challenge: string): Promise<string> {
    const fields = Object.fromEntries(
      [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]),
    )
    if (!/^bearer\b/i.test(challenge) || !fields.realm) {
      throw new FetchError(401, 'Unauthorized', null)
    }
    let realm: URL
    try {
      realm = new URL(fields.realm)
    } catch {
      throw new FetchError(401, 'Unauthorized', null)
    }
    const registry = new URL(this.#base)
    if (realm.protocol !== 'https:') {
      throw new Error(
        `Couldn’t sign in: the registry sends its sign-in to ${realm.host}, over http.`,
      )
    }
    if (fields.service) realm.searchParams.set('service', fields.service)
    realm.searchParams.set('scope', fields.scope ?? `repository:${this.#name}:pull`)
    // The sign-in goes to the realm only where it's the registry's own (realmTakesSignIn), and
    // never on along the realm's redirects.
    const { body } = await this.fetchUrl(realm.href, {
      most: 64 * 1024,
      accept: 'application/json',
      redirects: false,
      ...(this.signIn && realmTakesSignIn(registry.hostname, realm.hostname)
        ? { signIn: { ...this.signIn, origin: realm.origin, path: realm.pathname } }
        : {}),
    })
    const answer = JSON.parse(body.toString('utf8')) as { token?: unknown; access_token?: unknown }
    const token = typeof answer.token === 'string' ? answer.token : answer.access_token
    if (typeof token !== 'string' || !token) throw new FetchError(401, 'Unauthorized', null)
    return token
  }
}

/**
 * Registries whose token realm is on another host of their own: decided here, by name, as no
 * rule on the names alone can be (two hosts under a public suffix, co.uk or azurecr.io, can be
 * anyone's). Docker Hub's alone, so far.
 */
const REALMS: Record<string, string[]> = {
  'registry-1.docker.io': ['auth.docker.io'],
  'docker.io': ['auth.docker.io'],
  'index.docker.io': ['auth.docker.io'],
}

/**
 * Whether a registry's sign-in may go to the token realm it names: the registry's own host, or
 * one REALMS says is its; anything else (another host, another tenant under a shared suffix, an
 * address) is asked without it.
 */
export function realmTakesSignIn(registryHost: string, realmHost: string): boolean {
  const [registry, realm] = [registryHost.toLowerCase(), realmHost.toLowerCase()]
  return realm === registry || (REALMS[registry]?.includes(realm) ?? false)
}

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex')

const tooLarge = (most: number) =>
  `It’s larger than Lumovi reads (${most >= 1024 * 1024 ? `${most / 1024 / 1024} MB` : `${most / 1024} KB`}).`

const text = <K extends string>(key: K, value: unknown) =>
  (typeof value === 'string' && value ? { [key]: value.slice(0, 1000) } : {}) as Partial<
    Record<K, string>
  >

/** A chart's sources: its http(s) links alone. */
const sources = (value: unknown) =>
  Array.isArray(value)
    ? {
        sources: value
          .filter((s): s is string => typeof s === 'string' && /^https?:\/\//.test(s))
          .slice(0, 10),
      }
    : {}

const link = <K extends string>(key: K, value: unknown) =>
  (typeof value === 'string' && /^https?:\/\//.test(value) ? { [key]: value } : {}) as Partial<
    Record<K, string>
  >

async function result<T>(task: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await task() }
  } catch (error) {
    return { ok: false, error: toKubeError(error) }
  }
}
