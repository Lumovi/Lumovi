/**
 * The plugins Lumovi comes with, as its build takes them: the bundle Lumovi-plugins' release
 * workflow built, signed and attested, pinned by plugins.lock.json. Downloaded once into a cache
 * (.cache/plugins), and checked at every build, the cache's copy too, with nothing stored to
 * trust but Sigstore's root as Lumovi ships it (src/main/sigstore-root.json):
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
 * Anything else stops the build, saying why. Then the build serves each plugin's file, by its
 * file name, as `virtual:lumovi-plugins` (vite-plugins-bundle.ts).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  /** The commit its release was built from. */
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
  const entries = new Map(list(at(listed, 'plugins')).map((entry) => [at(entry, 'name'), entry]))
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

/**
 * The release's files: from the cache, or downloaded from Lumovi-plugins' release into it. A file
 * the release doesn't have is left out, for the check to say so. What's cached is checked as
 * anything downloaded is, so a cache that's wrong stops the build too.
 */
export async function fetchRelease(
  lock: Lock,
  cache = resolve('.cache/plugins'),
  download: typeof fetch = fetch,
): Promise<Release> {
  const release: Release = {}
  const names = releaseFiles(lock.version)
  for (const [key, name] of Object.entries(names) as [keyof Release, string][]) {
    const path = join(cache, lock.version, name)
    if (!existsSync(path)) {
      const url = `https://github.com/${PLUGINS_REPOSITORY}/releases/download/v${lock.version}/${name}`
      let response: Response
      try {
        response = await download(url)
      } catch (error) {
        throw new PluginsBundleError(
          `${name}: couldn’t be downloaded from ${url}: ${(error as Error).message}`,
        )
      }
      if (response.status === 404) continue
      if (!response.ok) {
        throw new PluginsBundleError(
          `${name}: couldn’t be downloaded: ${url} answered ${response.status}`,
        )
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()))
      renameSync(`${path}.part`, path)
    }
    release[key] = readFileSync(path)
  }
  return release
}

/** The plugins Lumovi is built with: the lock's release, fetched and checked. */
export async function verifiedPlugins(): Promise<PluginFiles> {
  const lock = readLock()
  return verifyRelease(await fetchRelease(lock), lock, trust())
}
