/**
 * The plugins Lumovi comes with, as its build takes them: the bundle Lumovi-plugins' release
 * workflow built, signed and attested, pinned by plugins.lock.json. Checked at every build, the
 * cache's copy too, with nothing stored to trust but Sigstore's root as Lumovi ships it
 * (src/main/sigstore-root.json):
 *
 * - the bundle and its index are byte for byte what the lock pins (their SHA-256);
 * - each is signed by Lumovi-plugins' release workflow on main, as cosign signs (its certificate
 *   from Sigstore's authority, logged, naming that workflow exactly, signed in with GitHub's
 *   Actions), as kubectl's signature is checked (src/main/kubectl-signature.ts);
 * - the attestation is signed the same way, names exactly the bundle and the index with the
 *   SHA-256 this build computed, and says they were built by that workflow, on main, from the
 *   commit the lock pins;
 * - the index says what the bundle holds: its SHA-256, and each plugin's version and each file's
 *   SHA-256, of the text served, as UTF-8 (no byte order mark).
 *
 * (The check itself is src/main/plugins-release.ts's, which the Plugins page's look at the latest
 * release shares: src/main/plugin-store.ts.)
 *
 * Downloaded once, when the release's tag is checked too: that it points at the commit the lock
 * pins, asked of GitHub then and not on a build from the cache, which may be offline. Only a
 * release that passed every check is kept in the cache (.cache/plugins), one entry for each lock,
 * whole or not at all.
 *
 * Anything else stops the build, saying why. Then the build serves each plugin's file, and the
 * code beside it where it has any, by their file names, as `virtual:lumovi-plugins`
 * (vite-plugins.ts).
 *
 * As for kubectl, a certificate is dated by the log's signed timestamp, and no proof that the
 * signing is in Sigstore's transparency log (Rekor) is asked for: the certificate names the
 * workflow, a log saw it, and its key signed these bytes. What the build takes is held, first, by
 * the lock's SHA-256s, which a reviewed change sets; the signatures and the attestation say that
 * what a change pins is the workflow's. So the lock is never to be loosened (a version alone, say)
 * on the grounds that the signature would catch it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { TrustRoot } from '../src/main/kubectl-signature.ts'
import {
  checkRelease,
  downloadRelease as download,
  PLUGINS_REPOSITORY,
  PLUGINS_SIGNER,
  PluginsReleaseError,
  readJson,
  releaseFiles,
  taggedCommit,
  type Asking,
  type PluginFiles,
  type Release,
  type Trust,
} from '../src/main/plugins-release.ts'

export {
  DOWNLOAD_LIMIT,
  DOWNLOAD_TIME_LIMIT,
  PLUGINS_REPOSITORY,
  PLUGINS_SIGNER,
  PluginsReleaseError as PluginsBundleError,
  releaseFiles,
  type Asking,
  type PluginFiles,
  type Release,
  type Trust,
} from '../src/main/plugins-release.ts'

/** Which release of Lumovi-plugins Lumovi is built with: plugins.lock.json. */
export interface Lock {
  version: string
  /**
   * The commit the release's tag points at, which its attestation names as the one it was built
   * from. Every build checks the attestation's against it, the cache's copy too; the tag itself is
   * checked against it once, when the release is first downloaded into the cache (`takePlugins`).
   */
  commit: string
  /** The SHA-256 of the bundle, and of its index. */
  bundle: string
  index: string
}

/** The plugins' files apart from their code: what the page and the backend each take. */
export function pluginsAndCode(files: PluginFiles): { plugins: PluginFiles; code: PluginFiles } {
  const of = (end: string) =>
    Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith(end)))
  return { plugins: of('.yaml'), code: of('.js') }
}

/** The plugins with code beside them, by name: `karpenter` for karpenter.js beside karpenter.yaml. */
export const codedPlugins = (code: PluginFiles): string[] =>
  Object.keys(code).map((file) => file.replace(/\.js$/, ''))

export const LOCK_FILE = 'plugins.lock.json'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/

/** What's wrong with the lock, or nothing. */
export function lockProblems(lock: unknown): string[] {
  const value = lock as Partial<Lock>
  const problems: string[] = []
  if (typeof value?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    problems.push(`${LOCK_FILE}: version should be a release’s, three numbers`)
  }
  if (typeof value?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) {
    problems.push(`${LOCK_FILE}: commit should be the release’s commit, 40 hex digits`)
  }
  for (const key of ['bundle', 'index'] as const) {
    if (typeof value?.[key] !== 'string' || !HEX64.test(value[key])) {
      problems.push(`${LOCK_FILE}: ${key} should be its SHA-256, 64 hex digits`)
    }
  }
  const keys = Object.keys(value ?? {}).filter(
    (key) => !['version', 'commit', 'bundle', 'index'].includes(key),
  )
  if (keys.length) problems.push(`${LOCK_FILE}: ${keys.join(', ')} isn’t something it has`)
  return problems
}

/** What the lock pins, as the release's check takes it. */
const anchorOf = (lock: Lock) => ({
  version: lock.version,
  commit: lock.commit,
  by: LOCK_FILE,
  pinned: { bundle: lock.bundle, index: lock.index },
})

/** The plugins Lumovi is built with, and which release they're from. */
export interface Taken {
  files: PluginFiles
  release: { version: string; serial: number }
}

/** The release, as `lock` pins it and `trust` says who signs it: or a PluginsBundleError. */
function checkedAgainst(release: Release, lock: Lock, trust: Trust): Taken {
  const lockWrong = lockProblems(lock)
  if (lockWrong.length) throw new PluginsReleaseError(lockWrong.join('\n'))
  const { files, index } = checkRelease(release, anchorOf(lock), trust)
  return { files, release: { version: index.version, serial: index.serial } }
}

/**
 * The plugins' files from `release`, as `lock` pins it and `trust` says who signs it: or a
 * PluginsBundleError saying everything that's wrong (src/main/plugins-release.ts).
 */
export function verifyRelease(release: Release, lock: Lock, trust: Trust): PluginFiles {
  return checkedAgainst(release, lock, trust).files
}

/** Sigstore's root, as Lumovi ships it: the only thing the build trusts. */
export function sigstoreRoot(): TrustRoot {
  return JSON.parse(readFileSync(resolve('src/main/sigstore-root.json'), 'utf8')) as TrustRoot
}

/** The build's trust: fixed, here, and nowhere else. */
export const trust = (): Trust => ({
  root: sigstoreRoot(),
  signer: PLUGINS_SIGNER,
  repository: PLUGINS_REPOSITORY,
})

/** Reads plugins.lock.json, or says why it can't. */
export function readLock(path = resolve(LOCK_FILE)): Lock {
  if (!existsSync(path)) {
    throw new PluginsReleaseError(
      `${LOCK_FILE}: is missing: it names the release of ${PLUGINS_REPOSITORY} Lumovi is built with`,
    )
  }
  const lock = readJson(readFileSync(path))
  const problems = lockProblems(lock)
  if (problems.length) throw new PluginsReleaseError(problems.join('\n'))
  return lock as Lock
}

/** The release's files, by what each is in a `Release`. */
const filesOf = (lock: Lock) =>
  Object.entries(releaseFiles(lock.version)) as [keyof Release, string][]

/**
 * The release's files, downloaded from GitHub. A file the release doesn't have is left out, for
 * the check to say so.
 */
export const downloadRelease = (lock: Lock, asking: Asking = {}): Promise<Release> =>
  download(lock.version, asking)

/** Where checked releases are kept between builds. */
export const CACHE = resolve('.cache/plugins')

/** The cache's entry for `lock`: named by its version, and the SHA-256 of all it pins. */
export function cacheEntry(lock: Lock, cache = CACHE): string {
  const pinned = JSON.stringify([lock.version, lock.commit, lock.bundle, lock.index])
  return join(cache, `${lock.version}-${sha256(Buffer.from(pinned))}`)
}

/** The release as the cache keeps it, or nothing where it has no entry for the lock. */
function cached(entry: string, lock: Lock): Release | undefined {
  if (!existsSync(entry)) return undefined
  const release: Release = {}
  for (const [key, name] of filesOf(lock)) {
    const path = join(entry, name)
    if (existsSync(path)) release[key] = readFileSync(path)
  }
  return release
}

/**
 * Keeps a release that passed every check: written under a name of its own, and named as the
 * lock's entry last, so an entry is whole or not there. (Where another build kept it first, that
 * one stays.)
 */
function keep(entry: string, lock: Lock, release: Release) {
  const part = `${entry}.${process.pid}.${randomUUID()}.part`
  mkdirSync(part, { recursive: true })
  for (const [key, name] of filesOf(lock)) {
    writeFileSync(join(part, name), release[key]!)
  }
  try {
    renameSync(part, entry)
  } catch (error) {
    rmSync(part, { recursive: true, force: true })
    if (!existsSync(entry)) throw error
  }
}

/**
 * The plugins of the lock's release, as `trust` says who signs it: from the cache, checked again,
 * or downloaded, checked, and kept, once its tag is found to point at the lock's commit too. A
 * cached copy that's wrong (changed since it was kept, say) is put aside, and the release
 * downloaded again, once. Only then refused.
 */
export async function takePlugins(
  lock: Lock,
  trust: Trust,
  options: Asking & { cache?: string } = {},
): Promise<PluginFiles> {
  return (await takeRelease(lock, trust, options)).files
}

/** The same, with which release they're from: what the build serves. */
export async function takeRelease(
  lock: Lock,
  trust: Trust,
  { cache = CACHE, ...asking }: Asking & { cache?: string } = {},
): Promise<Taken> {
  const lockWrong = lockProblems(lock)
  if (lockWrong.length) throw new PluginsReleaseError(lockWrong.join('\n'))
  const entry = cacheEntry(lock, cache)
  const kept = cached(entry, lock)
  if (kept) {
    try {
      return checkedAgainst(kept, lock, trust)
    } catch (error) {
      if (!(error instanceof PluginsReleaseError)) throw error
      rmSync(entry, { recursive: true, force: true })
    }
  }
  const tagged = await taggedCommit(lock.version, asking)
  if (tagged !== lock.commit) {
    throw new PluginsReleaseError(
      tagged === undefined
        ? `v${lock.version}: isn’t a tag of ${PLUGINS_REPOSITORY}`
        : `v${lock.version}: ${PLUGINS_REPOSITORY}’s tag points at ${tagged}, and ${LOCK_FILE} pins ${lock.commit}`,
    )
  }
  const release = await downloadRelease(lock, asking)
  const taken = checkedAgainst(release, lock, trust)
  keep(entry, lock, release)
  return taken
}

/** The plugins Lumovi is built with: the lock's release, fetched and checked. */
export async function verifiedPlugins(): Promise<Taken> {
  return takeRelease(readLock(), trust())
}
