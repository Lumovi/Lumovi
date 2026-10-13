/**
 * A release of Lumovi-plugins, checked: the one check for both the build, which takes the release
 * plugins.lock.json pins (scripts/plugins-bundle.ts), and the Plugins page, which looks at the
 * latest one (plugin-store.ts). Nothing stored to trust but Sigstore's root as Lumovi ships it:
 *
 * - each of the bundle and its index is signed by Lumovi-plugins' release workflow on main, as
 *   cosign signs (its certificate from Sigstore's authority, logged, naming that workflow exactly,
 *   signed in with GitHub's Actions), as kubectl's signature is checked (kubectl-signature.ts);
 * - the attestation is signed the same way, names exactly the bundle and the index with the
 *   SHA-256 computed here, and says they were built by that workflow, on main, from the commit
 *   the anchor names (the lock's, or the release's tag's);
 * - the index says what the bundle holds: its SHA-256, and each plugin's version and each file's
 *   SHA-256, of the text served, as UTF-8 (no byte order mark).
 *
 * And, for the build, the bundle and the index are byte for byte what the lock pins.
 *
 * Downloaded as git and a browser ask GitHub, never through its API, which answers few an hour to
 * whoever doesn't sign in.
 */
import { createHash } from 'node:crypto'
import { whyNotSignedBy, type Signer, type TrustRoot } from './kubectl-signature'

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

/** Where GitHub is: a stand-in's, in the tests. */
export const GITHUB = 'https://github.com'

/** What the release holds, by the file: each as downloaded, or nothing where it has none. */
export interface Release {
  bundle?: Buffer
  index?: Buffer
  bundleSignature?: Buffer
  indexSignature?: Buffer
  attestation?: Buffer
}

/** Who to trust: Sigstore's root and the signer. */
export interface Trust {
  root: TrustRoot
  signer: Signer
  repository: string
}

/**
 * What a release is checked against: its version, and the commit it was built from. The build's
 * pins its bundle and index too, by their SHA-256. `by` is what names them, as a problem says it
 * ("plugins.lock.json", "its tag v1.3.0").
 */
export interface Anchor {
  version: string
  commit: string
  by: string
  pinned?: { bundle: string; index: string }
}

/**
 * The plugins' files, by file name: each plugin's ("karpenter.yaml"), and the code beside it
 * where it has any ("karpenter.js").
 */
export type PluginFiles = Record<string, string>

/** Which check a release failed: its signatures, where it was built from, or its files. */
export type Failed = 'signed' | 'built' | 'files'

/** Why a release can't be taken: each line a file, and what's wrong with it. */
export class PluginsReleaseError extends Error {
  /** The first check it failed, where it's one of the release's checks. */
  readonly check?: Failed
  constructor(message: string, check?: Failed) {
    super(message)
    if (check) this.check = check
  }
}

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
const PLUGIN_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** A release's version, and the Lumovi a plugin needs: three numbers. */
export const VERSION = /^\d+\.\d+\.\d+$/
/** U+FEFF: a byte order mark, which a file of text is served without. */
const BYTE_ORDER_MARK = 0xfeff

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
export function readJson(bytes: Buffer): object | undefined {
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

/** What the index says of each plugin it lists. */
export interface Indexed {
  name: string
  version: string
  /** The oldest Lumovi it works with, where the index says. */
  lumovi?: string
}

/** A release, checked: its plugins' files, and what its index says of it. */
export interface Checked {
  files: PluginFiles
  index: {
    version: string
    /** Which release it is, in order: a later one's is never lower. */
    serial: number
    /** When it was made, and when it stops being taken, as the index says (ISO 8601). */
    made?: string
    expires?: string
    plugins: Indexed[]
  }
}

/**
 * The plugins' files from `release`, as `anchor` names it and `trust` says who signs it, with
 * what its index says of it: or a PluginsReleaseError saying everything that's wrong.
 */
export function checkRelease(release: Release, anchor: Anchor, trust: Trust): Checked {
  const names = releaseFiles(anchor.version)
  const problems: { line: string; check: Failed }[] = []
  const fail = () => {
    if (problems.length) {
      throw new PluginsReleaseError(problems.map(({ line }) => line).join('\n'), problems[0]!.check)
    }
  }

  // Every file there, and, for the build, byte for byte what it pins.
  for (const key of ['bundle', 'index'] as const) {
    const bytes = release[key]
    if (!bytes) {
      problems.push({
        line: `${names[key]}: isn’t in ${PLUGINS_REPOSITORY}’s release ${anchor.version}`,
        check: 'files',
      })
    } else if (anchor.pinned && sha256(bytes) !== anchor.pinned[key]) {
      problems.push({
        line: `${names[key]}: its SHA-256 is ${sha256(bytes)}, and ${anchor.by} pins ${anchor.pinned[key]}`,
        check: 'files',
      })
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
      problems.push({
        line: `${names[key]}: isn’t signed: the release has no ${names[signatureKey]}`,
        check: 'signed',
      })
      continue
    }
    const read = readJson(signature)
    const certificate = certificateOf(read)
    const value = text(at(read, 'messageSignature', 'signature'))
    if (!certificate || value === undefined) {
      problems.push({
        line: `${names[signatureKey]}: isn’t a signature Lumovi can read`,
        check: 'signed',
      })
      continue
    }
    const why = whyNot(release[key]!, value, certificate)
    if (why) problems.push({ line: `${names[key]}: ${why}`, check: 'signed' })
  }

  // The attestation: signed likewise, of exactly these two, by that workflow, from that commit.
  const where = names.attestation
  const attestation = release.attestation && readJson(release.attestation)
  const certificate = certificateOf(attestation)
  const payloadText = text(at(attestation, 'dsseEnvelope', 'payload'))
  const payloadType = text(at(attestation, 'dsseEnvelope', 'payloadType'))
  const sig = text(at(attestation, 'dsseEnvelope', 'signatures', 0, 'sig'))
  if (!release.attestation) {
    problems.push({
      line: `${where}: isn’t in ${PLUGINS_REPOSITORY}’s release ${anchor.version}`,
      check: 'built',
    })
  } else if (!certificate || payloadText === undefined || !payloadType || sig === undefined) {
    problems.push({ line: `${where}: isn’t an attestation Lumovi can read`, check: 'built' })
  } else {
    const payload = Buffer.from(payloadText, 'base64')
    const why = whyNot(preAuthEncoding(payloadType, payload), sig, certificate)
    const statement = payloadType === 'application/vnd.in-toto+json' ? readJson(payload) : undefined
    if (why) {
      problems.push({ line: `${where}: ${why}`, check: 'signed' })
    } else if (
      at(statement, '_type') !== 'https://in-toto.io/Statement/v1' ||
      at(statement, 'predicateType') !== 'https://slsa.dev/provenance/v1'
    ) {
      problems.push({
        line: `${where}: isn’t a statement of where they were built`,
        check: 'built',
      })
    } else {
      // Exactly the two, each with the SHA-256 computed here.
      const said = list(at(statement, 'subject'))
        .map((subject) => `${text(at(subject, 'name'))} ${text(at(subject, 'digest', 'sha256'))}`)
        .sort()
      const meant = [`${names.bundle} ${sha256(bundle)}`, `${names.index} ${sha256(index)}`].sort()
      if (JSON.stringify(said) !== JSON.stringify(meant)) {
        problems.push({
          line: `${where}: attests ${said.join(', ') || 'nothing'}, not ${meant.join(', ')}, as downloaded`,
          check: 'files',
        })
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
        problems.push({
          line: `${where}: says they were built by ${built[0]}/${built[1]}@${built[2]}, not ${repository}/${WORKFLOW}@${REF}`,
          check: 'built',
        })
      }
      const uri = text(at(definition, 'resolvedDependencies', 0, 'uri'))
      const commit = text(at(definition, 'resolvedDependencies', 0, 'digest', 'gitCommit'))
      if (!uri?.startsWith(`git+${repository}@`) || commit !== anchor.commit) {
        problems.push({
          line: `${where}: says they were built from ${uri} at ${commit}, not ${trust.repository} at ${anchor.commit}, as ${anchor.by} pins`,
          check: 'built',
        })
      }
    }
  }
  fail()

  // What the index says the bundle holds, and what it holds.
  const contents = readJson(bundle)
  const listed = readJson(index)
  if (at(contents, 'format') !== 1 || !Array.isArray(at(contents, 'plugins'))) {
    throw new PluginsReleaseError(
      `${names.bundle}: isn’t a bundle of plugins Lumovi can read`,
      'files',
    )
  }
  if (at(listed, 'format') !== 1 || !Array.isArray(at(listed, 'plugins'))) {
    throw new PluginsReleaseError(`${names.index}: isn’t an index Lumovi can read`, 'files')
  }
  const files = (line: string) => problems.push({ line, check: 'files' })
  if (at(contents, 'version') !== anchor.version || at(listed, 'version') !== anchor.version) {
    files(`${names.index}: isn’t of version ${anchor.version}, as ${anchor.by} pins`)
  }
  const serial = at(listed, 'serial')
  if (!Number.isSafeInteger(serial) || (serial as number) < 0) {
    files(`${names.index}: has no serial, a whole number, to say which release it is`)
  }
  if (
    at(listed, 'bundle', 'file') !== names.bundle ||
    at(listed, 'bundle', 'sha256') !== sha256(bundle)
  ) {
    files(`${names.index}: names another bundle than ${names.bundle}`)
  }
  const entries = new Map<unknown, unknown>()
  const indexed: Indexed[] = []
  for (const entry of list(at(listed, 'plugins'))) {
    if (entries.has(at(entry, 'name'))) {
      files(`${names.index}: names ${String(at(entry, 'name'))} twice`)
    }
    entries.set(at(entry, 'name'), entry)
  }
  const served: PluginFiles = {}
  for (const plugin of list(at(contents, 'plugins'))) {
    const name = text(at(plugin, 'name'))
    const entry = entries.get(at(plugin, 'name'))
    entries.delete(at(plugin, 'name'))
    if (name === undefined || !PLUGIN_NAME.test(name)) {
      files(`${names.bundle}: holds a plugin named ${JSON.stringify(at(plugin, 'name'))}`)
      continue
    }
    const version = at(plugin, 'version')
    if (entry === undefined || at(entry, 'version') !== version) {
      files(`${names.bundle}: holds ${name} ${version}, which the index doesn’t name`)
      continue
    }
    const needs = at(entry, 'lumovi')
    if (needs !== undefined && !(typeof needs === 'string' && VERSION.test(needs))) {
      files(`${names.index}: says ${name} needs Lumovi ${JSON.stringify(needs)}, not a version`)
    }
    indexed.push({
      name,
      version: String(version),
      ...(typeof needs === 'string' ? { lumovi: needs } : {}),
    })
    const pinned = new Map(list(at(entry, 'files')).map((file) => [at(file, 'path'), file]))
    let carried = false
    for (const file of list(at(plugin, 'files'))) {
      const path = at(file, 'path')
      const content = text(at(file, 'text'))
      const pin = pinned.get(path)
      pinned.delete(path)
      if (content === undefined || pin === undefined) {
        files(`${names.bundle}: ${name}/${path} isn’t in the index`)
        continue
      }
      // As served: its UTF-8, with nothing in front of it.
      const bytes = Buffer.from(content, 'utf8')
      if (!content.isWellFormed() || content.charCodeAt(0) === BYTE_ORDER_MARK) {
        files(`${names.bundle}: ${name}/${path} isn’t UTF-8 text without a byte order mark`)
      } else if (sha256(bytes) !== at(pin, 'sha256') || bytes.length !== at(pin, 'size')) {
        files(`${names.bundle}: ${name}/${path} isn’t what the index says it is`)
      } else if (path === 'plugin.yaml') {
        served[`${name}.yaml`] = content
      } else if (path === 'plugin.js') {
        // Its code, named as its file is: what the backend hands a page of it.
        served[`${name}.js`] = content
      }
      if (path === 'plugin.yaml') carried = true
    }
    for (const path of pinned.keys()) {
      files(`${names.bundle}: ${name}/${path} is in the index and not in the bundle`)
    }
    if (!carried) files(`${names.bundle}: ${name} has no plugin.yaml`)
  }
  for (const name of entries.keys()) {
    files(`${names.index}: names ${name}, which the bundle doesn’t hold`)
  }
  fail()
  return {
    files: served,
    index: {
      version: anchor.version,
      serial: serial as number,
      ...(typeof at(listed, 'made') === 'string' ? { made: at(listed, 'made') as string } : {}),
      ...(typeof at(listed, 'expires') === 'string'
        ? { expires: at(listed, 'expires') as string }
        : {}),
      plugins: indexed,
    },
  }
}

/** How large a release's file may be, downloaded: far more than one is, and no more. */
export const DOWNLOAD_LIMIT = 16 * 1024 * 1024

/**
 * How long one file of a release may take to come, whole: far longer than one does, and then
 * it stops saying so, rather than waiting for a server that's stopped answering.
 */
export const DOWNLOAD_TIME_LIMIT = 60_000

/** Why something of a release couldn't be downloaded: `late` where nothing came in time. */
export class DownloadError extends PluginsReleaseError {
  constructor(
    message: string,
    /** `late`: after how many seconds it stopped waiting. */
    readonly why: { late: number } | { status: number } | { tooLarge: true } | { said: string },
  ) {
    super(message)
  }
}

/** A response's body, read up to `limit` bytes: past it, a DownloadError. */
async function bodyOf(response: Response, name: string, limit: number): Promise<Buffer> {
  const said = Number(response.headers.get('content-length'))
  const tooLarge = () =>
    new DownloadError(
      `${name}: is larger than ${limit / 1024 / 1024} MB, and no file of a plugins release is that large`,
      { tooLarge: true },
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

/** How GitHub is asked: a download, and how large its answer may be. */
export interface Asking {
  download?: typeof fetch
  limit?: number
  /** How long, in milliseconds, one answer may take, whole. */
  timeLimit?: number
  /** Where GitHub is: its stand-in's address, in the tests. */
  github?: string
}

/** `url`'s answer, read: or nothing where it's not found. */
async function ask(
  url: string,
  name: string,
  { download = fetch, limit = DOWNLOAD_LIMIT, timeLimit = DOWNLOAD_TIME_LIMIT }: Asking,
) {
  const signal = AbortSignal.timeout(timeLimit)
  const late = () =>
    new DownloadError(
      `${name}: couldn’t be downloaded from ${url}: no answer in time (${timeLimit / 1000} s)`,
      { late: timeLimit / 1000 },
    )
  const failed = (error: unknown) =>
    new DownloadError(`${name}: couldn’t be downloaded from ${url}: ${(error as Error).message}`, {
      said: (error as Error).message,
    })
  let response: Response
  try {
    response = await download(url, { signal })
  } catch (error) {
    if (signal.aborted) throw late()
    if (error instanceof DownloadError) throw error
    throw failed(error)
  }
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new DownloadError(`${name}: couldn’t be downloaded: ${url} answered ${response.status}`, {
      status: response.status,
    })
  }
  try {
    return await bodyOf(response, name, limit)
  } catch (error) {
    if (error instanceof DownloadError) throw error
    if (signal.aborted) throw late()
    throw failed(error)
  }
}

/**
 * The release's files, downloaded. A file the release doesn't have is left out, for the check to
 * say so.
 */
export async function downloadRelease(version: string, asking: Asking = {}): Promise<Release> {
  const release: Release = {}
  const github = asking.github ?? GITHUB
  for (const [key, name] of Object.entries(releaseFiles(version)) as [keyof Release, string][]) {
    const url = `${github}/${PLUGINS_REPOSITORY}/releases/download/v${version}/${name}`
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
 * where it has no such tag: asked as git asks, not of GitHub's API.
 */
export async function taggedCommit(
  version: string,
  asking: Asking = {},
): Promise<string | undefined> {
  const url = `${asking.github ?? GITHUB}/${PLUGINS_REPOSITORY}.git/info/refs?service=git-upload-pack`
  const answer = await ask(url, `v${version}`, asking)
  if (!answer) {
    throw new DownloadError(`v${version}: couldn’t be read: ${url} answered 404`, { status: 404 })
  }
  const refs = refsOf(answer)
  if (!refs) {
    throw new PluginsReleaseError(
      `v${version}: GitHub’s list of tags was cut short, or isn’t git’s: ${url}`,
      'built',
    )
  }
  return refs.get(`refs/tags/v${version}^{}`) ?? refs.get(`refs/tags/v${version}`)
}
