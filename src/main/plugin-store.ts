/**
 * What's newer in Lumovi-plugins, for the Plugins page: its latest release, checked before
 * anything of it is shown (plugins-release.ts), as the build checks the one it takes, anchored
 * where a build's lock can't be:
 *
 * - signed by Lumovi-plugins' release workflow on main;
 * - attested as built there from the commit its tag points at;
 * - never older (by its serial) than the newest this Lumovi has taken, nor than the release it
 *   was built with;
 * - not past the date its index says it stops being taken.
 *
 * Asked only when the page opens or Check now is pressed, never in the background, and at most
 * once in ten minutes unless Check now asks again. From one fixed address, whose redirect names
 * the latest tag (no API, which answers few an hour), then that tag's five files and its commit,
 * as git asks: from GitHub alone, following no redirect but to GitHub's own hosts. Through
 * Lumovi's network (its proxy and certificate authorities), with the build's caps: 16 MB and 60
 * seconds a file.
 *
 * Nothing is installed here: the page says what's newer.
 */
import type { StoreCheck, StoreFailure, StorePlugin, StoreRelease } from '@shared/plugin-store'
import {
  checkRelease,
  DownloadError,
  downloadRelease,
  DOWNLOAD_TIME_LIMIT,
  GITHUB,
  PLUGINS_REPOSITORY,
  PluginsReleaseError,
  taggedCommit,
  VERSION,
  type Asking,
  type Trust,
} from './plugins-release'

/** How long a check is kept, unless Check now asks again. */
export const CHECK_KEPT_MS = 10 * 60_000

/** GitHub's own hosts: its site, and where it keeps a release's files. */
const GITHUB_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

/** How many redirects one file may take: GitHub's take one. */
const MOST_REDIRECTS = 5

/** What the store is given. */
export interface StoreOptions {
  trust: Trust
  /** Where GitHub is: a stand-in's address, in the tests (never a packaged app's). */
  github?: string
  /** Settled once Lumovi's network is set up (its proxy, its certificate authorities). */
  ready?: Promise<unknown>
  /** Whether the organization's policy turns it off: asked at each check. */
  off: () => boolean
  /** The plugins the policy allows, by name, where it names them: asked at each check. */
  allowed?: () => readonly string[] | undefined
  /** The release this Lumovi was built with. */
  builtWith: { version: string; serial: number }
  /** The highest serial this Lumovi has taken, and keeping a higher one. */
  serial: () => number
  accept: (serial: number) => void
  download?: typeof fetch
  /** How long one answer may take, whole: the build's, unless a test says. */
  timeLimit?: number
  now?: () => number
  /** Told why a check failed, in full. */
  warn?: (message: string) => void
}

/**
 * `download`, asking only GitHub (or `github`, its stand-in) and following only redirects to
 * its own hosts.
 */
export function githubOnly(github: string, download: typeof fetch = fetch): typeof fetch {
  const own = new URL(github)
  const isGitHubs = (url: URL) =>
    url.origin === own.origin || (url.protocol === 'https:' && GITHUB_HOSTS.has(url.hostname))
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input))
    for (let hop = 0; ; hop++) {
      if (!isGitHubs(url)) throw new Error(`${url.host} isn’t GitHub’s`)
      const response = await download(url, { ...init, redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) return response
      await response.body?.cancel()
      if (hop === MOST_REDIRECTS) throw new Error('GitHub sent it elsewhere too many times')
      url = new URL(location, url)
    }
  }
}

/** Why it couldn't check, in the network's words where it's GitHub that didn't answer. */
function failureOf(error: unknown): StoreFailure {
  if (error instanceof Expired) return { check: 'expired', on: error.on }
  if (error instanceof Older) return { check: 'older' }
  if (error instanceof DownloadError) {
    const { why } = error
    return {
      check: 'network',
      words:
        'late' in why
          ? `GitHub didn’t answer in ${why.late} seconds`
          : 'status' in why
            ? `GitHub answered ${why.status}`
            : 'tooLarge' in why
              ? 'a file of the release is larger than any should be'
              : why.said,
    }
  }
  if (error instanceof PluginsReleaseError && error.check) return { check: error.check }
  return { check: 'network', words: (error as Error).message }
}

/** The network's own words for why a request failed: its cause's, where it has one. */
const wordsOf = (error: unknown) =>
  ((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message).replace(
    /\.$/,
    '',
  )

export class PluginStore {
  readonly #options: StoreOptions
  readonly #github: string
  readonly #asking: Asking
  #last?: { at: number; result: StoreCheck }
  #good?: StoreRelease
  #running?: Promise<StoreCheck>

  constructor(options: StoreOptions) {
    this.#options = options
    this.#github = options.github ?? GITHUB
    const download = githubOnly(this.#github, options.download)
    // (The network's words, where it's the network that failed: not fetch's "fetch failed".)
    this.#asking = {
      github: this.#github,
      timeLimit: options.timeLimit ?? DOWNLOAD_TIME_LIMIT,
      download: (input, init) =>
        download(input, init).catch((error: unknown) => {
          if ((init?.signal as AbortSignal | undefined)?.aborted) throw error
          throw new Error(wordsOf(error), { cause: error })
        }),
    }
  }

  /**
   * What's newer, as the latest release says: checked now if `now` (Check now), or if the last
   * check is older than ten minutes; otherwise that one's answer. One check at a time.
   */
  check(now = false): Promise<StoreCheck> {
    if (this.#options.off()) return Promise.resolve({ state: 'off' })
    const at = (this.#options.now ?? Date.now)()
    if (this.#running) return this.#running
    if (!now && this.#last && at - this.#last.at < CHECK_KEPT_MS) {
      return Promise.resolve(this.#last.result)
    }
    this.#running = this.#check(at).finally(() => (this.#running = undefined))
    return this.#running
  }

  async #check(at: number): Promise<StoreCheck> {
    let result: StoreCheck
    try {
      await this.#options.ready
      result = { state: 'checked', release: await this.#latest(at) }
      this.#good = result.release
    } catch (error) {
      this.#options.warn?.(`Lumovi couldn’t check for newer plugins: ${(error as Error).message}`)
      result = {
        state: 'failed',
        failure: failureOf(error),
        at,
        ...(this.#good ? { last: this.#good } : {}),
      }
    }
    this.#last = { at, result }
    return result
  }

  /** The latest release, checked, or why not. */
  async #latest(at: number): Promise<StoreRelease> {
    const version = await this.#latestVersion()
    const commit = await taggedCommit(version, this.#asking)
    if (commit === undefined) {
      throw new PluginsReleaseError(`v${version}: isn’t a tag of ${PLUGINS_REPOSITORY}`, 'built')
    }
    const release = await downloadRelease(version, this.#asking)
    const { files, index } = checkRelease(
      release,
      { version, commit, by: `its tag v${version}` },
      this.#options.trust,
    )
    const expires = index.expires === undefined ? Number.NaN : Date.parse(index.expires)
    if (Number.isNaN(expires)) {
      throw new PluginsReleaseError(`v${version}: its index says no date it expires`, 'files')
    }
    if (expires <= at) throw new Expired(index.expires!)
    const newest = Math.max(this.#options.serial(), this.#options.builtWith.serial)
    if (index.serial < newest) {
      throw new Older(`v${version}: its serial is ${index.serial}, and Lumovi has taken ${newest}`)
    }
    this.#options.accept(index.serial)
    const allowed = this.#options.allowed?.()
    const plugins: StorePlugin[] = index.plugins
      .filter(({ name }) => !allowed || allowed.includes(name))
      .map(({ name, version, lumovi }) => ({
        name,
        version,
        ...(lumovi === undefined ? {} : { lumovi }),
        file: files[`${name}.yaml`]!,
        code: Object.hasOwn(files, `${name}.js`),
      }))
    return { version, serial: index.serial, checked: at, plugins }
  }

  /** The latest release's version, as GitHub's redirect to its tag names it. */
  async #latestVersion(): Promise<string> {
    const url = `${this.#github}/${PLUGINS_REPOSITORY}/releases/latest`
    const timeLimit = this.#asking.timeLimit!
    const signal = AbortSignal.timeout(timeLimit)
    let response: Response
    try {
      // (Its redirect is the answer: read, not followed.)
      response = await (this.#options.download ?? fetch)(url, { signal, redirect: 'manual' })
    } catch (error) {
      if (signal.aborted) {
        throw new DownloadError(`${url}: no answer in time`, { late: timeLimit / 1000 })
      }
      throw new DownloadError(`${url}: ${wordsOf(error)}`, { said: wordsOf(error) })
    }
    await response.body?.cancel()
    const location = response.headers.get('location')
    const tag = location
      ? new RegExp(`^/${PLUGINS_REPOSITORY}/releases/tag/v(\\d+\\.\\d+\\.\\d+)$`).exec(
          new URL(location, url).pathname,
        )
      : null
    if (response.status < 300 || response.status >= 400 || !tag || !VERSION.test(tag[1]!)) {
      throw new DownloadError(
        `${url} answered ${response.status}${location ? `, to ${location}` : ''}`,
        response.status >= 300 && response.status < 400
          ? { said: 'GitHub didn’t say which release is the latest' }
          : { status: response.status },
      )
    }
    return tag[1]!
  }
}

/** A release past the date its index says it stops being taken. */
class Expired extends PluginsReleaseError {
  constructor(readonly on: string) {
    super(`its index expired on ${on}`)
  }
}

/** A release older than one this Lumovi has taken. */
class Older extends PluginsReleaseError {}
