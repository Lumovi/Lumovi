/**
 * A kubectl for each cluster's terminals, as Kubernetes supports it: kubectl works with
 * clusters a minor version either side of its own, so it's the newest patch of the cluster's
 * own minor version (kubectl v1.34.3 for a v1.34.1 cluster). Downloaded from dl.k8s.io (or a
 * mirror of it), checked against the SHA-256 published beside it and against Kubernetes' own
 * signature (kubectl-signature.ts: dl.k8s.io has one for every kubectl Lumovi gets; a mirror
 * that has none is said to, in each terminal that uses its kubectl), and kept in the app's folder
 * (kubectl/v1.34.3/) for the terminals of every cluster on that version. As Lumovi starts, newer
 * patches the folder has replace older ones: a terminal can be using one while it runs.
 *
 * A terminal is often opened because something's wrong, so it waits for none of this for long:
 * a cluster that doesn't say its version at once, or a kubectl still downloading, and it starts
 * with the one on the PATH. What comes later is there for the terminals opened after.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { whyNotKubernetes, type TrustRoot } from './kubectl-signature'

/** Where Kubernetes publishes kubectl. */
export const KUBECTL_MIRROR = 'https://dl.k8s.io'
/** How long a minor version's newest patch is taken as known, and its not being known. */
const KNOWN_MS = 6 * 60 * 60_000
const UNKNOWN_MS = 10 * 60_000
const LOOKUP_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** How long a terminal waits to learn its cluster's version, and then for its kubectl. */
const VERSION_WAIT_MS = 3_000
const KUBECTL_WAIT_MS = 10_000

const GOOS: Partial<Record<string, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const GOARCH: Partial<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' }
const EXE = process.platform === 'win32' ? 'kubectl.exe' : 'kubectl'
/** A version as the folder keeps it: v1.34.3. */
const VERSION = /^v(\d+\.\d+)\.(\d+)$/
/**
 * The oldest minor version it gets kubectl for: Lumovi's own oldest (see the README). Older
 * kubectl lacks years of fixes, some to how it handles what a cluster sends it, and a cluster
 * mustn't choose that for the person whose terminal runs it.
 */
const OLDEST = '1.25'

/**
 * Whether kubectl can come from `url`: over HTTPS, or from this computer. Over plain HTTP, its
 * checksum (which comes from the same place) could be changed along with it.
 */
export function trustedMirror(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return (
      protocol === 'https:' ||
      (protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))
    )
  } catch {
    return false
  }
}

/**
 * A terminal's kubectl: the folder it's in and its version (and `unsigned`, the mirror's host,
 * where it came with no signature to check), or why it's the one on the PATH.
 */
export type MatchingKubectl =
  { dir: string; version: string; unsigned?: string } | { problem: string }

/**
 * In a version's folder, how it was checked: against Kubernetes' signature, or against its
 * SHA-256 only (from a mirror that keeps no signatures). Each names the host it came from and
 * the kubectl's own SHA-256, and is written once the kubectl is in place: one that doesn't name
 * the kubectl beside it (a crash between the two, say) says nothing, and that kubectl isn't used.
 * One without either was kept before Lumovi checked signatures (1.13.0): it's got again.
 */
const SIGNED = 'signed'
const UNSIGNED = 'unsigned'

/** How a version's kubectl was checked: signed, or its SHA-256 only, from `host`. */
interface Checked {
  signed: boolean
  host: string
}

export class Kubectls {
  /** Each minor version's newest patch (1.34 → v1.34.3), or why it isn't known, for a while. */
  readonly #newest = new Map<string, { until: number; version?: string; problem?: string }>()
  /** Downloads under way, by version: terminals opened meanwhile wait for the same one. */
  readonly #getting = new Map<string, Promise<Checked>>()
  /** Each cluster's minor version, as it last said it. */
  /** Done once the folder's been tidied, as Lumovi starts: terminals wait for it. */
  readonly #pruned: Promise<void>
  /** Each cluster's minor version, as it last said it (kept, for when it can't be reached). */
  readonly #minors: Map<string, string>

  constructor(
    private readonly deps: {
      /** Where they're kept: <dir>/v1.34.3/kubectl. */
      dir: string
      /** Where they come from: dl.k8s.io, or a mirror of it. */
      mirror: () => string
      /** dl.k8s.io: what's from it must be signed (a mirror's may not be). */
      official: string
      /** Whether a mirror's must be signed too (the organization's policy says). */
      signaturesRequired: () => boolean
      /** What a signature is checked against: Sigstore's trust root, as Lumovi ships it. */
      trust: TrustRoot
      /** A cluster's version, as it says it (v1.34.1-eks-…). */
      clusterVersion: (context: string) => Promise<string>
    },
  ) {
    this.#minors = this.#knownMinors()
    this.#pruned = this.#prune()
  }

  /** The kubectl for a cluster's terminals; `getting` is told when one is to be downloaded. */
  async for(context: string, getting: (version: string) => void): Promise<MatchingKubectl> {
    // (Or the tidying could take away what this terminal's download is writing.)
    await this.#pruned
    const goos = GOOS[process.platform]
    const goarch = GOARCH[process.arch]
    if (!goos || !goarch) return { problem: `Kubernetes has no kubectl for ${process.arch}` }
    if (!trustedMirror(this.#mirror)) {
      return {
        problem: `Lumovi gets kubectl only over HTTPS, and ${shown(this.#mirror)} isn’t (LUMOVI_KUBECTL_MIRROR)`,
      }
    }
    let minor: string
    try {
      minor = await this.#minorOf(context)
    } catch (error) {
      return { problem: message(error) }
    }
    if (older(minor, OLDEST)) {
      return {
        problem: `the cluster says it’s Kubernetes ${minor}, and Lumovi gets kubectl for ${OLDEST} or later`,
      }
    }
    let downloading: string | undefined
    const matching = async () => {
      const version = await this.#newestOf(minor)
      let checked = await this.#usable(join(this.deps.dir, version))
      if (!checked) {
        downloading = version
        getting(version)
        checked = await this.#download(version, `${goos}/${goarch}`)
      }
      return this.#found(version, checked)
    }
    try {
      return await within(matching(), KUBECTL_WAIT_MS, () =>
        downloading
          ? `kubectl ${downloading} is still downloading, for the terminals opened once it’s done`
          : `${host(this.#mirror)} didn’t answer within ${KUBECTL_WAIT_MS / 1000} seconds`,
      )
    } catch (error) {
      // Not tried again for a while: terminals opened meanwhile don't wait for it to fail. (What
      // only took long carries on.)
      if (!(error instanceof Late)) {
        this.#newest.set(minor, { until: Date.now() + UNKNOWN_MS, problem: message(error) })
      }
      // Offline, say: the newest one kept of that minor version will do.
      const kept = await this.#kept(minor)
      if (kept) return this.#found(kept.version, kept.checked)
      return {
        problem:
          error instanceof Late
            ? error.message
            : `Lumovi couldn’t get kubectl ${minor} to match the cluster (${message(error)})`,
      }
    }
  }

  /** A version the folder has, and whether it came unsigned (from which mirror). */
  #found(version: string, { signed, host }: Checked): MatchingKubectl {
    return { dir: join(this.deps.dir, version), version, ...(signed ? {} : { unsigned: host }) }
  }

  /**
   * A cluster's minor version: as it last said it, or as it says it now if it does at once.
   * It's asked each time, for the next terminal (it may have been upgraded).
   */
  async #minorOf(context: string): Promise<string> {
    const asking = this.deps.clusterVersion(context).then(
      (said) => {
        const minor = /^v?(\d+\.\d+)\./.exec(said)?.[1]
        if (!minor) throw new Error(`Lumovi can’t tell which kubectl matches ${said.slice(0, 40)}`)
        if (this.#minors.get(context) !== minor) {
          this.#minors.set(context, minor)
          void this.#keepMinors()
        }
        return minor
      },
      (error: unknown) => {
        throw new Error(`Lumovi couldn’t ask the cluster its version (${message(error)})`)
      },
    )
    // What comes too late is for the next terminal.
    asking.catch(() => undefined)
    const known = this.#minors.get(context)
    if (known) return known
    return within(
      asking,
      VERSION_WAIT_MS,
      () =>
        `Lumovi couldn’t ask the cluster its version (it didn’t answer within ${VERSION_WAIT_MS / 1000} seconds)`,
    )
  }

  /** clusters.json: each cluster's minor version, by its context's name. */
  get #minorsFile(): string {
    return join(this.deps.dir, 'clusters.json')
  }

  #knownMinors(): Map<string, string> {
    try {
      const kept = JSON.parse(readFileSync(this.#minorsFile, 'utf8')) as Record<string, unknown>
      return new Map(
        Object.entries(kept).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && /^\d+\.\d+$/.test(entry[1]),
        ),
      )
    } catch {
      return new Map()
    }
  }

  /** Kept as yours alone (context names can name customers), and whole or not at all. */
  async #keepMinors(): Promise<void> {
    const partial = `${this.#minorsFile}.${process.pid}`
    try {
      await mkdir(this.deps.dir, { recursive: true })
      await writeFile(partial, JSON.stringify(Object.fromEntries(this.#minors)), { mode: 0o600 })
      await rename(partial, this.#minorsFile)
    } catch {
      await rm(partial, { force: true }).catch(() => {})
    }
  }

  get #mirror(): string {
    return this.deps.mirror().replace(/\/+$/, '')
  }

  async #newestOf(minor: string): Promise<string> {
    const known = this.#newest.get(minor)
    if (known && known.until > Date.now()) {
      if (known.version) return known.version
      throw new Error(known.problem)
    }
    try {
      const said = (await get(`${this.#mirror}/release/stable-${minor}.txt`)).toString().trim()
      if (VERSION.exec(said)?.[1] !== minor) {
        throw new Error(`${host(this.#mirror)} says ${minor}’s newest is ${said.slice(0, 40)}`)
      }
      this.#newest.set(minor, { until: Date.now() + KNOWN_MS, version: said })
      return said
    } catch (error) {
      this.#newest.set(minor, { until: Date.now() + UNKNOWN_MS, problem: message(error) })
      throw error
    }
  }

  #download(version: string, platform: string): Promise<Checked> {
    let getting = this.#getting.get(version)
    if (!getting) {
      getting = this.#fetch(version, platform).finally(() => this.#getting.delete(version))
      this.#getting.set(version, getting)
    }
    return getting
  }

  async #fetch(version: string, platform: string): Promise<Checked> {
    const mirror = this.#mirror
    const url = `${mirror}/release/${version}/bin/${platform}/${EXE}`
    const [kubectl, published, signature, certificate] = await Promise.all([
      get(url, DOWNLOAD_TIMEOUT_MS),
      get(`${url}.sha256`),
      getIfThere(`${url}.sig`),
      getIfThere(`${url}.cert`),
    ])
    const sha256 = createHash('sha256').update(kubectl).digest('hex')
    if (sha256 !== published.toString().trim().split(/\s+/)[0]) {
      throw new Error(`what was downloaded isn’t what ${host(mirror)} published`)
    }
    // Kubernetes signs every kubectl Lumovi gets: from dl.k8s.io, one without a signature, or
    // with half of one, isn't taken (whoever could change it could take its signature away).
    // A mirror may keep no signatures: then the SHA-256 it publishes is all there is.
    // As its host says it, however it's spelled (DL.K8S.IO, dl.k8s.io:443, …).
    const official = host(mirror) === host(this.deps.official)
    if (signature && certificate) {
      const refused = whyNotKubernetes(kubectl, signature, certificate, this.deps.trust)
      // What may have happened first (a terminal's line can be cut short), then why.
      if (refused) {
        const which = refused.changed
          ? `so it may have been changed, or ${refused.changed} and Lumovi needs an update`
          : 'and may have been changed'
        throw new Error(
          `${host(mirror)}’s kubectl ${version} couldn’t be verified as Kubernetes’ own, ${which}: ${refused.why}`,
        )
      }
    } else if (signature || certificate) {
      throw new Error(
        `${host(mirror)} published kubectl ${version}’s ${signature ? 'signature without its certificate' : 'certificate without its signature'}`,
      )
    } else if (official) {
      throw new Error(`${host(mirror)} published no signature for kubectl ${version}`)
    } else if (this.deps.signaturesRequired()) {
      throw new Error(
        `${host(mirror)} published no signature for kubectl ${version}, and your organization’s policy requires one`,
      )
    }
    const dir = join(this.deps.dir, version)
    await mkdir(dir, { recursive: true })
    // Whole, or not there: a terminal never finds half of one. How it was checked is said once
    // it's there, naming it: what was said of one before it no longer is, and a crash between
    // the two leaves it said of nothing.
    await rm(join(dir, SIGNED), { force: true })
    await rm(join(dir, UNSIGNED), { force: true })
    const partial = join(dir, `.${EXE}.${process.pid}`)
    await writeFile(partial, kubectl, { mode: 0o755 })
    await rename(partial, join(dir, EXE))
    const checked = { signed: Boolean(signature), host: host(mirror) }
    const marker = signature ? SIGNED : UNSIGNED
    await writeFile(join(dir, `.${marker}.${process.pid}`), `${checked.host}\n${sha256}\n`)
    await rename(join(dir, `.${marker}.${process.pid}`), join(dir, marker))
    return checked
  }

  /**
   * How a version's kubectl was checked, where its folder says so of the kubectl there, in a way
   * that does now: one taken unsigned from a mirror isn't used once the policy requires
   * signatures. (Read each time it's used: what's kept could have been changed since.)
   */
  async #usable(dir: string): Promise<Checked | undefined> {
    const checked = await checkedAs(dir)
    return checked && (checked.signed || !this.deps.signaturesRequired()) ? checked : undefined
  }

  /** The newest patch of a minor version the folder has that can be used. */
  async #kept(minor: string): Promise<{ version: string; checked: Checked } | undefined> {
    for (const version of await this.#versions()) {
      if (VERSION.exec(version)?.[1] !== minor) continue
      const checked = await this.#usable(join(this.deps.dir, version))
      if (checked) return { version, checked }
    }
    return undefined
  }

  /** The versions the folder has, newest first. */
  async #versions(): Promise<string[]> {
    const names = await readdir(this.deps.dir).catch(() => [])
    return names
      .filter((name) => VERSION.test(name))
      .sort((a, b) => {
        const [, minorA, patchA] = VERSION.exec(a)!
        const [, minorB, patchB] = VERSION.exec(b)!
        return minorA === minorB
          ? Number(patchB) - Number(patchA)
          : minorB!.localeCompare(minorA!, 'en', { numeric: true })
      })
  }

  /**
   * Keeps only each minor version's newest patch, and nothing half-written (a download a crash
   * cut short), nor unchecked (kept before 1.13.0): as Lumovi starts, before any terminal.
   */
  async #prune(): Promise<void> {
    // clusters.json as a crash left it half-written; and as yours alone, as 1.9.1 didn't keep it.
    for (const name of await readdir(this.deps.dir).catch(() => [])) {
      if (name.startsWith('clusters.json.')) {
        await rm(join(this.deps.dir, name), { force: true }).catch(() => {})
      }
    }
    await chmod(this.#minorsFile, 0o600).catch(() => {})
    // Of each minor version, the newest; and the newest signed one too, where that's older: what
    // a policy requiring signatures can use, offline.
    const newest = new Set<string>()
    const newestSigned = new Set<string>()
    for (const version of await this.#versions()) {
      const minor = VERSION.exec(version)![1]!
      const dir = join(this.deps.dir, version)
      const signed = existsSync(join(dir, SIGNED))
      if (existsSync(join(dir, EXE)) && !signed && !existsSync(join(dir, UNSIGNED))) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (newest.has(minor) && !(signed && !newestSigned.has(minor))) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        continue
      }
      for (const name of await readdir(dir).catch(() => [])) {
        if (name.startsWith('.')) await rm(join(dir, name), { force: true }).catch(() => {})
      }
      newest.add(minor)
      if (signed) newestSigned.add(minor)
    }
  }
}

/** How a version's kubectl was checked, if its folder says so of the kubectl there. */
async function checkedAs(dir: string): Promise<Checked | undefined> {
  for (const [marker, signed] of [
    [SIGNED, true],
    [UNSIGNED, false],
  ] as const) {
    const said = await readFile(join(dir, marker), 'utf8').catch(() => undefined)
    if (said === undefined) continue
    const [host = '', sha256] = said.trim().split('\n')
    const kubectl = await readFile(join(dir, EXE)).catch(() => undefined)
    if (!kubectl || createHash('sha256').update(kubectl).digest('hex') !== sha256) return undefined
    return { signed, host }
  }
  return undefined
}

/** A wait that ran out: what it waited for carries on. */
class Late extends Error {}

/** What `promise` gives, unless `ms` go by first: then it's Late, and says `late()`. */
async function within<T>(promise: Promise<T>, ms: number, late: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Late(late())), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** What's at a URL, or why not. */
async function get(url: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${host(url)} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** What's at a URL, nothing where it isn't (404), or why not. */
async function getIfThere(url: string): Promise<Buffer | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${host(url)} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const host = (url: string) => new URL(url).host

/** A URL as a terminal's line may say it: without a user and password in it, and not too long. */
function shown(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().slice(0, 60)
  } catch {
    return 'what it says'
  }
}

/** Whether minor version `a` (1.24) is older than `b` (1.25). */
function older(a: string, b: string): boolean {
  const [majorA, minorA] = a.split('.').map(Number)
  const [majorB, minorB] = b.split('.').map(Number)
  return majorA! < majorB! || (majorA === majorB && minorA! < minorB!)
}

/**
 * An error's own words (a failed fetch's are its cause's), as much as a terminal's line needs:
 * Lumovi's own whole (the longest, a refused signature's, with a mirror's name), and another's,
 * or a certificate's names, no longer than that.
 */
function message(error: unknown): string {
  const { message, cause } = error as Error & { cause?: Error }
  return (cause?.message ?? message).slice(0, 320)
}
