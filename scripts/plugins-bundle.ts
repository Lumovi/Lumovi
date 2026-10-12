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
 * Downloaded once, when the release's tag is checked too: that it points at the commit the lock
 * pins, asked of GitHub then and not on a build from the cache, which may be offline. Only a
 * release that passed every check is kept in the cache (.cache/plugins), one entry for each lock,
 * whole or not at all.
 *
 * Anything else stops the build, saying why. Then the build serves each plugin's file, by its
 * file name, as `virtual:lumovi-plugins` (vite-plugins.ts).
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
import { whyNotSignedBy, type Signer, type TrustRoot } from '../src/main/kubectl-signature.ts'

/** Where Lumovi's plugins come from, and the workflow that signs their releases. */
export const PLUGINS_REPOSITORY = 'Lumovi/Lumovi-plugins'
const WORKFLOW = '.github/workflows/release.yml'
const REF = 'refs/heads/main'

/** Who signs the plugins' releases: that workflow, on main, as GitHub's Actions sign in. */
export const PLUGINS_SIGNER: Signer = {
  identity: `https://github.com/${PLUGINS_REPOSITORY}/${WORKFLOW}@${REF}`,
  issuer: 'https://token.actions.githubusercontent.com',
  name: 'Lumovi-plugins’ release workflow',
  changed: 'Lumovi-plugins has changed how it signs',
}

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

/** What the release holds, by the file: each as downloaded, or nothing where it has none. */
export interface Release {
  bundle?: Buffer
  index?: Buffer
  bundleSignature?: Buffer
  indexSignature?: Buffer
  attestation?: Buffer
}

/** Who to trust: Sigstore's root and the signer. The build's are fixed (`TRUST`). */
export interface Trust {
  root: TrustRoot
  signer: Signer
  repository: string
}

/** The plugins' files, by file name ("karpenter.yaml"): what `virtual:lumovi-plugins` serves. */
export type PluginFiles = Record<string, string>

/** Why the plugins can't be built in: each line a file, and what's wrong with it. */
export class PluginsBundleError extends Error {}

export const LOCK_FILE = 'plugins.lock.json'

/** The release's files, by what they are. */
export function releaseFiles(version: string) {
  const bundle = `plugins-${version}.json`
  const index = `plugins-${version}.index.json`
  return {
    bundle,
    index,
    bundleSignature: `${bundle}.sigstore.json`,
    indexSignature: `${index}.sigstore.json`,
    attestation: `plugins-${version}.attestation.json`,
  }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/
const PLUGIN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** U+FEFF: a byte order mark, which a file of text is served without. */
const BYTE_ORDER_MARK = 0xfeff

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

/** The value at `path` in JSON read loosely, or nothing: each is checked where it's used. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let here = value
  for (const key of path) {
    if (typeof here !== 'object' || here === null) return undefined
    here = (here as Record<string | number, unknown>)[key]
  }
  return here
}
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A Sigstore bundle's certificate (its DER), or nothing. */
function certificateOf(bundle: unknown): Buffer | undefined {
  const raw =
    text(at(bundle, 'verificationMaterial', 'certificate', 'rawBytes')) ??
    text(at(bundle, 'verificationMaterial', 'x509CertificateChain', 'certificates', 0, 'rawBytes'))
  return raw === undefined ? undefined : Buffer.from(raw, 'base64')
}

/** A file's JSON, if it's an object. */
function readJson(bytes: Buffer): object | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** DSSE's pre-authentication encoding: what an envelope's signature is over. */
function preAuthEncoding(type: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ])
}

/**
 * The plugins' files from `release`, as `lock` pins it and `trust` says who signs it: or a
 * PluginsBundleError saying everything that's wrong.
 */
export function verifyRelease(release: Release, lock: Lock, trust: Trust): PluginFiles {
  const lockWrong = lockProblems(lock)
  if (lockWrong.length) throw new PluginsBundleError(lockWrong.join('\n'))
  const names = releaseFiles(lock.version)
  const problems: string[] = []
  const fail = () => {
    if (problems.length) throw new PluginsBundleError(problems.join('\n'))
  }

  // Byte for byte what the lock pins.
  for (const key of ['bundle', 'index'] as const) {
    const bytes = release[key]
    if (!bytes) {
      problems.push(`${names[key]}: isn’t in ${PLUGINS_REPOSITORY}’s release ${lock.version}`)
    } else if (sha256(bytes) !== lock[key]) {
      problems.push(
        `${names[key]}: its SHA-256 is ${sha256(bytes)}, and ${LOCK_FILE} pins ${lock[key]}`,
      )
    }
  }
  fail()
  const bundle = release.bundle!
  const index = release.index!

  /** Why `data` isn't signed by the signer under `bundle`'s certificate, or nothing. */
  const whyNot = (data: Buffer, signature: string, certificate: Buffer) =>
    whyNotSignedBy(data, Buffer.from(signature, 'base64'), certificate, trust.root, trust.signer)
      ?.why

  // Each signed by the release workflow.
  for (const [key, signatureKey] of [
    ['bundle', 'bundleSignature'],
    ['index', 'indexSignature'],
  ] as const) {
    const signature = release[signatureKey]
    if (!signature) {
      problems.push(`${names[key]}: isn’t signed: the release has no ${names[signatureKey]}`)
      continue
    }
    const read = readJson(signature)
    const certificate = certificateOf(read)
    const value = text(at(read, 'messageSignature', 'signature'))
    if (!certificate || value === undefined) {
      problems.push(`${names[signatureKey]}: isn’t a signature Lumovi can read`)
      continue
    }
    const why = whyNot(release[key]!, value, certificate)
    if (why) problems.push(`${names[key]}: ${why}`)
  }

  // The attestation: signed likewise, of exactly these two, by that workflow, from that commit.
  const where = names.attestation
  const attestation = release.attestation && readJson(release.attestation)
  const certificate = certificateOf(attestation)
  const payloadText = text(at(attestation, 'dsseEnvelope', 'payload'))
  const payloadType = text(at(attestation, 'dsseEnvelope', 'payloadType'))
  const sig = text(at(attestation, 'dsseEnvelope', 'signatures', 0, 'sig'))
  if (!release.attestation) {
    problems.push(`${where}: isn’t in ${PLUGINS_REPOSITORY}’s release ${lock.version}`)
  } else if (!certificate || payloadText === undefined || !payloadType || sig === undefined) {
    problems.push(`${where}: isn’t an attestation Lumovi can read`)
  } else {
    const payload = Buffer.from(payloadText, 'base64')
    const why = whyNot(preAuthEncoding(payloadType, payload), sig, certificate)
    const statement = payloadType === 'application/vnd.in-toto+json' ? readJson(payload) : undefined
    if (why) {
      problems.push(`${where}: ${why}`)
    } else if (
      at(statement, '_type') !== 'https://in-toto.io/Statement/v1' ||
      at(statement, 'predicateType') !== 'https://slsa.dev/provenance/v1'
    ) {
      problems.push(`${where}: isn’t a statement of where they were built`)
    } else {
      // Exactly the two, each with the SHA-256 computed here.
      const said = list(at(statement, 'subject'))
        .map((subject) => `${text(at(subject, 'name'))} ${text(at(subject, 'digest', 'sha256'))}`)
        .sort()
      const meant = [`${names.bundle} ${sha256(bundle)}`, `${names.index} ${sha256(index)}`].sort()
      if (JSON.stringify(said) !== JSON.stringify(meant)) {
        problems.push(
          `${where}: attests ${said.join(', ') || 'nothing'}, not ${meant.join(', ')}, as downloaded`,
        )
      }
      const definition = at(statement, 'predicate', 'buildDefinition')
      const workflow = at(definition, 'externalParameters', 'workflow')
      const built = [
        text(at(workflow, 'repository')),
        text(at(workflow, 'path')),
        text(at(workflow, 'ref')),
      ]
      const repository = `https://github.com/${trust.repository}`
      if (built[0] !== repository || built[1] !== WORKFLOW || built[2] !== REF) {
        problems.push(
          `${where}: says they were built by ${built[0]}/${built[1]}@${built[2]}, not ${repository}/${WORKFLOW}@${REF}`,
        )
      }
      const uri = text(at(definition, 'resolvedDependencies', 0, 'uri'))
      const commit = text(at(definition, 'resolvedDependencies', 0, 'digest', 'gitCommit'))
      if (!uri?.startsWith(`git+${repository}@`) || commit !== lock.commit) {
        problems.push(
          `${where}: says they were built from ${uri} at ${commit}, not ${trust.repository} at ${lock.commit}, as ${LOCK_FILE} pins`,
        )
      }
    }
  }
  fail()

  // What the index says the bundle holds, and what it holds.
  const contents = readJson(bundle)
  const listed = readJson(index)
  if (at(contents, 'format') !== 1 || !Array.isArray(at(contents, 'plugins'))) {
    throw new PluginsBundleError(`${names.bundle}: isn’t a bundle of plugins Lumovi can read`)
  }
  if (at(listed, 'format') !== 1 || !Array.isArray(at(listed, 'plugins'))) {
    throw new PluginsBundleError(`${names.index}: isn’t an index Lumovi can read`)
  }
  if (at(contents, 'version') !== lock.version || at(listed, 'version') !== lock.version) {
    problems.push(`${names.index}: isn’t of version ${lock.version}, as ${LOCK_FILE} pins`)
  }
  if (
    at(listed, 'bundle', 'file') !== names.bundle ||
    at(listed, 'bundle', 'sha256') !== sha256(bundle)
  ) {
    problems.push(`${names.index}: names another bundle than ${names.bundle}`)
  }
  const entries = new Map<unknown, unknown>()
  for (const entry of list(at(listed, 'plugins'))) {
    if (entries.has(at(entry, 'name'))) {
      problems.push(`${names.index}: names ${String(at(entry, 'name'))} twice`)
    }
    entries.set(at(entry, 'name'), entry)
  }
  const files: PluginFiles = {}
  for (const plugin of list(at(contents, 'plugins'))) {
    const name = text(at(plugin, 'name'))
    const entry = entries.get(at(plugin, 'name'))
    entries.delete(at(plugin, 'name'))
    if (name === undefined || !PLUGIN_NAME.test(name)) {
      problems.push(`${names.bundle}: holds a plugin named ${JSON.stringify(at(plugin, 'name'))}`)
      continue
    }
    const version = at(plugin, 'version')
    if (entry === undefined || at(entry, 'version') !== version) {
      problems.push(`${names.bundle}: holds ${name} ${version}, which the index doesn’t name`)
      continue
    }
    const indexed = new Map(list(at(entry, 'files')).map((file) => [at(file, 'path'), file]))
    let carried = false
    for (const file of list(at(plugin, 'files'))) {
      const path = at(file, 'path')
      const served = text(at(file, 'text'))
      const pinned = indexed.get(path)
      indexed.delete(path)
      if (served === undefined || pinned === undefined) {
        problems.push(`${names.bundle}: ${name}/${path} isn’t in the index`)
        continue
      }
      // As served: its UTF-8, with nothing in front of it.
      const bytes = Buffer.from(served, 'utf8')
      if (!served.isWellFormed() || served.charCodeAt(0) === BYTE_ORDER_MARK) {
        problems.push(`${names.bundle}: ${name}/${path} isn’t UTF-8 text without a byte order mark`)
      } else if (sha256(bytes) !== at(pinned, 'sha256') || bytes.length !== at(pinned, 'size')) {
        problems.push(`${names.bundle}: ${name}/${path} isn’t what the index says it is`)
      } else if (path === 'plugin.yaml') {
        files[`${name}.yaml`] = served
      }
      if (path === 'plugin.yaml') carried = true
    }
    for (const path of indexed.keys()) {
      problems.push(`${names.bundle}: ${name}/${path} is in the index and not in the bundle`)
    }
    if (!carried) problems.push(`${names.bundle}: ${name} has no plugin.yaml`)
  }
  for (const name of entries.keys()) {
    problems.push(`${names.index}: names ${name}, which the bundle doesn’t hold`)
  }
  fail()
  return files
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
    throw new PluginsBundleError(
      `${LOCK_FILE}: is missing: it names the release of ${PLUGINS_REPOSITORY} Lumovi is built with`,
    )
  }
  const lock = readJson(readFileSync(path))
  const problems = lockProblems(lock)
  if (problems.length) throw new PluginsBundleError(problems.join('\n'))
  return lock as Lock
}

/** How large a release's file may be, downloaded: far more than one is, and no more. */
export const DOWNLOAD_LIMIT = 16 * 1024 * 1024

/** A response's body, read up to `limit` bytes: past it, a PluginsBundleError. */
async function bodyOf(response: Response, name: string, limit: number): Promise<Buffer> {
  const said = Number(response.headers.get('content-length'))
  const tooLarge = () =>
    new PluginsBundleError(
      `${name}: is larger than ${limit / 1024 / 1024} MB, and no file of a plugins release is that large`,
    )
  if (said > limit) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw tooLarge()
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** How the build asks GitHub: a download, and how large its answer may be. */
export interface Asking {
  download?: typeof fetch
  limit?: number
  /** How long, in milliseconds, one answer may take, whole. */
  timeLimit?: number
}

/**
 * How long one file of a release may take to come, whole: far longer than one does, and then
 * the build stops saying so, rather than waiting for a server that's stopped answering.
 */
export const DOWNLOAD_TIME_LIMIT = 60_000

/** `url`'s answer, read: or nothing where it's not found. */
async function ask(
  url: string,
  name: string,
  { download = fetch, limit = DOWNLOAD_LIMIT, timeLimit = DOWNLOAD_TIME_LIMIT }: Asking,
) {
  const signal = AbortSignal.timeout(timeLimit)
  const late = () =>
    new PluginsBundleError(
      `${name}: couldn’t be downloaded from ${url}: no answer in time (${timeLimit / 1000} s)`,
    )
  let response: Response
  try {
    response = await download(url, { signal })
  } catch (error) {
    if (signal.aborted) throw late()
    throw new PluginsBundleError(
      `${name}: couldn’t be downloaded from ${url}: ${(error as Error).message}`,
    )
  }
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new PluginsBundleError(
      `${name}: couldn’t be downloaded: ${url} answered ${response.status}`,
    )
  }
  try {
    return await bodyOf(response, name, limit)
  } catch (error) {
    if (error instanceof PluginsBundleError) throw error
    if (signal.aborted) throw late()
    throw new PluginsBundleError(
      `${name}: couldn’t be downloaded from ${url}: ${(error as Error).message}`,
    )
  }
}

/** The release's files, by what each is in a `Release`. */
const filesOf = (lock: Lock) =>
  Object.entries(releaseFiles(lock.version)) as [keyof Release, string][]

/**
 * The release's files, downloaded. A file the release doesn't have is left out, for the check to
 * say so.
 */
export async function downloadRelease(lock: Lock, asking: Asking = {}): Promise<Release> {
  const release: Release = {}
  for (const [key, name] of filesOf(lock)) {
    const url = `https://github.com/${PLUGINS_REPOSITORY}/releases/download/v${lock.version}/${name}`
    const bytes = await ask(url, name, asking)
    if (bytes) release[key] = bytes
  }
  return release
}

/**
 * git's answer listing a repository's refs (its pkt-lines), read: each ref, and what it names. Or
 * nothing, where it isn't whole: a line cut short (what's left of its name could be another ref's),
 * anything but pkt-lines, or an end that isn't a flush (0000), as git's always is.
 */
function refsOf(answer: Buffer): Map<string, string> | undefined {
  const refs = new Map<string, string>()
  let at = 0
  let flushed = false
  while (at < answer.length) {
    const size = answer.toString('latin1', at, at + 4)
    if (!/^[0-9a-f]{4}$/.test(size)) return undefined
    const length = Number.parseInt(size, 16)
    flushed = length === 0
    // (0000 ends a part of the answer, and says nothing.)
    if (length < 4) {
      at += 4
      continue
    }
    if (at + length > answer.length) return undefined
    const [line = ''] = answer
      .toString('utf8', at + 4, at + length)
      .replace(/\n$/, '')
      .split('\0')
    const [, commit, ref] = /^([0-9a-f]{40}) (\S+)$/.exec(line) ?? []
    if (commit && ref) refs.set(ref, commit)
    at += length
  }
  return flushed ? refs : undefined
}

/**
 * The commit Lumovi-plugins' tag of `version` points at (an annotated tag's, peeled), or nothing
 * where it has no such tag: asked as git asks, not of GitHub's API, which answers few an hour to
 * a build that doesn't sign in.
 */
export async function taggedCommit(
  version: string,
  asking: Asking = {},
): Promise<string | undefined> {
  const url = `https://github.com/${PLUGINS_REPOSITORY}.git/info/refs?service=git-upload-pack`
  const answer = await ask(url, `v${version}`, asking)
  if (!answer) throw new PluginsBundleError(`v${version}: couldn’t be read: ${url} answered 404`)
  const refs = refsOf(answer)
  if (!refs) {
    throw new PluginsBundleError(
      `v${version}: GitHub’s list of tags was cut short, or isn’t git’s: ${url}`,
    )
  }
  return refs.get(`refs/tags/v${version}^{}`) ?? refs.get(`refs/tags/v${version}`)
}

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
  { cache = CACHE, ...asking }: Asking & { cache?: string } = {},
): Promise<PluginFiles> {
  const lockWrong = lockProblems(lock)
  if (lockWrong.length) throw new PluginsBundleError(lockWrong.join('\n'))
  const entry = cacheEntry(lock, cache)
  const kept = cached(entry, lock)
  if (kept) {
    try {
      return verifyRelease(kept, lock, trust)
    } catch (error) {
      if (!(error instanceof PluginsBundleError)) throw error
      rmSync(entry, { recursive: true, force: true })
    }
  }
  const tagged = await taggedCommit(lock.version, asking)
  if (tagged !== lock.commit) {
    throw new PluginsBundleError(
      tagged === undefined
        ? `v${lock.version}: isn’t a tag of ${PLUGINS_REPOSITORY}`
        : `v${lock.version}: ${PLUGINS_REPOSITORY}’s tag points at ${tagged}, and ${LOCK_FILE} pins ${lock.commit}`,
    )
  }
  const release = await downloadRelease(lock, asking)
  const files = verifyRelease(release, lock, trust)
  keep(entry, lock, release)
  return files
}

/** The plugins Lumovi is built with: the lock's release, fetched and checked. */
export async function verifiedPlugins(): Promise<PluginFiles> {
  return takePlugins(readLock(), trust())
}
