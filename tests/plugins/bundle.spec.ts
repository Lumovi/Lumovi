/**
 * The plugins Lumovi is built with: a release of Lumovi-plugins, pinned by plugins.lock.json,
 * signed and attested by its release workflow; and every way of it being wrong refused by the
 * build, saying why (scripts/plugins-bundle.ts). Signed by the tests' stand-in for Sigstore
 * (tests/mock-downloads/sigstore.ts): its certificate authority and its log are the tests' own,
 * and the identity its certificates name is the real one, checked as the build checks it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from '@sigstore/core'
import { expect, test } from '@playwright/test'
import {
  cacheEntry,
  DOWNLOAD_LIMIT,
  downloadRelease,
  PLUGINS_REPOSITORY,
  PLUGINS_SIGNER,
  PluginsBundleError,
  readLock,
  releaseFiles,
  takePlugins,
  verifyRelease,
  type Lock,
  type Release,
  type Trust,
} from '../../scripts/plugins-bundle.ts'
import { lumoviPlugins } from '../../scripts/vite-plugins.ts'
import { whyNotKubernetes, type TrustRoot } from '../../src/main/kubectl-signature.ts'
import { KUBERNETES_SIGNER } from '../../src/main/kubernetes-signer.ts'
import {
  startMockSigstore,
  type CertificateFault,
  type MockSigstore,
  type WorkflowSigner,
} from '../mock-downloads/sigstore.ts'

const VERSION = '1.0.0'
const COMMIT = 'a'.repeat(40)
const NAMES = releaseFiles(VERSION)
const REPOSITORY = `https://github.com/${PLUGINS_REPOSITORY}`
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** U+FEFF, made from its number: none is written in this file. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/** Two plugins, as Lumovi-plugins' bundle carries them. */
const PLUGINS = {
  alpha: 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: alpha }\n',
  beta: 'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: beta }\n',
}

let sigstore: MockSigstore
let trust: Trust
test.beforeAll(async () => {
  sigstore = await startMockSigstore()
  trust = {
    root: sigstore.root as TrustRoot,
    signer: PLUGINS_SIGNER,
    repository: PLUGINS_REPOSITORY,
  }
})

/** What an attestation says, as GitHub's attest action writes it. */
interface Statement {
  _type: string
  subject: { name: string; digest: { sha256: string } }[]
  predicateType: string
  predicate: {
    buildDefinition: {
      buildType: string
      externalParameters: { workflow: { ref: string; repository: string; path: string } }
      resolvedDependencies: { uri: string; digest: { gitCommit: string } }[]
    }
  }
}

/** The bundle's index, as Lumovi-plugins writes it. */
interface Index {
  format: number
  version: string
  serial: number
  bundle: { file: string; size: number; sha256: string }
  plugins: {
    name: string
    version: string
    files: { path: string; size: number; sha256: string }[]
  }[]
}

interface Made {
  /** The plugins' texts, by name. */
  texts?: Record<string, string>
  /** Who signs the bundle and the index, and the attestation, and how it's wrong. */
  signer?: WorkflowSigner
  fault?: CertificateFault
  attestedBy?: WorkflowSigner
  /** What the attestation says, changed. */
  statement?: (statement: Statement) => void
  /** The index, changed after it's made from the bundle. */
  index?: (index: Index) => void
}

/** A release as Lumovi-plugins' workflow makes one, and the lock that pins it. */
async function release(made: Made = {}): Promise<{ release: Required<Release>; lock: Lock }> {
  const texts = made.texts ?? PLUGINS
  const bundle = json({
    format: 1,
    version: VERSION,
    plugins: Object.entries(texts).map(([name, text]) => ({
      name,
      version: '1.0.0',
      files: [{ path: 'plugin.yaml', text }],
    })),
  })
  const listed: Index = {
    format: 1,
    version: VERSION,
    serial: 1,
    bundle: { file: NAMES.bundle, size: bundle.length, sha256: sha256(bundle) },
    plugins: Object.entries(texts).map(([name, text]) => ({
      name,
      version: '1.0.0',
      files: [
        {
          path: 'plugin.yaml',
          size: Buffer.byteLength(text),
          sha256: sha256(Buffer.from(text)),
        },
      ],
    })),
  }
  made.index?.(listed)
  const index = json(listed)
  const signer = made.signer ?? PLUGINS_SIGNER
  const statement: Statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      { name: NAMES.bundle, digest: { sha256: sha256(bundle) } },
      { name: NAMES.index, digest: { sha256: sha256(index) } },
    ],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/heads/main',
            repository: REPOSITORY,
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [
          { uri: `git+${REPOSITORY}@refs/heads/main`, digest: { gitCommit: COMMIT } },
        ],
      },
    },
  }
  made.statement?.(statement)
  return {
    release: {
      bundle,
      index,
      bundleSignature: await sigstore.blob(bundle, signer, made.fault),
      indexSignature: await sigstore.blob(index, signer, made.fault),
      attestation: await sigstore.attestation(statement, made.attestedBy ?? signer, made.fault),
    },
    lock: { version: VERSION, commit: COMMIT, bundle: sha256(bundle), index: sha256(index) },
  }
}

/** What the build says of `release` pinned by `lock`: the files it serves, or why it stops. */
function verdict(release: Release, lock: Lock): Record<string, string> | string {
  try {
    return verifyRelease(release, lock, trust)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginsBundleError)
    return (error as Error).message
  }
}

test('a release as its workflow makes one: each plugin’s file served, by its file name', async () => {
  const { release: made, lock } = await release()
  expect(verdict(made, lock)).toEqual({ 'alpha.yaml': PLUGINS.alpha, 'beta.yaml': PLUGINS.beta })
})

test('a byte off, in the bundle or its index: refused, with what it is and what’s pinned', async () => {
  const { release: made, lock } = await release()
  const off = Buffer.from(made.bundle)
  off.writeUInt8(off.readUInt8(off.length - 2) ^ 1, off.length - 2)
  expect(verdict({ ...made, bundle: off }, lock)).toBe(
    `${NAMES.bundle}: its SHA-256 is ${sha256(off)}, and plugins.lock.json pins ${lock.bundle}`,
  )
  const indexOff = Buffer.concat([made.index, Buffer.from(' ')])
  expect(verdict({ ...made, index: indexOff }, lock)).toBe(
    `${NAMES.index}: its SHA-256 is ${sha256(indexOff)}, and plugins.lock.json pins ${lock.index}`,
  )
})

test('unsigned, or signed over other bytes: refused', async () => {
  const { release: made, lock } = await release()
  expect(verdict({ ...made, bundleSignature: undefined }, lock)).toBe(
    `${NAMES.bundle}: isn’t signed: the release has no ${NAMES.bundleSignature}`,
  )
  expect(verdict({ ...made, indexSignature: Buffer.from('{}') }, lock)).toBe(
    `${NAMES.indexSignature}: isn’t a signature Lumovi can read`,
  )
  // A real signature, by the release workflow, of something else.
  expect(verdict({ ...made, bundleSignature: made.indexSignature }, lock)).toBe(
    `${NAMES.bundle}: its signature isn’t for what was downloaded`,
  )
})

test('signed by anyone but that workflow on main, exactly: refused, saying who signed it', async () => {
  const github = PLUGINS_SIGNER.issuer
  const others = [
    // Another repository, another workflow file, another ref, a name that only starts as it does.
    `https://github.com/someone/Lumovi-plugins/.github/workflows/release.yml@refs/heads/main`,
    `${REPOSITORY}/.github/workflows/checks.yml@refs/heads/main`,
    `${REPOSITORY}/.github/workflows/release.yml@refs/heads/next`,
    `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main-next`,
  ]
  for (const identity of others) {
    const { release: made, lock } = await release({ signer: { identity, issuer: github } })
    expect(verdict(made, lock), identity).toBe(
      [NAMES.bundle, NAMES.index, NAMES.attestation]
        .map(
          (file) =>
            `${file}: it’s signed by ${identity}, not Lumovi-plugins’ release workflow as this Lumovi knows it`,
        )
        .join('\n'),
    )
  }
  // An email where the workflow's URI is pinned.
  const email = await release({ fault: 'identity' })
  expect(verdict(email.release, email.lock)).toContain(
    `${NAMES.bundle}: it’s signed by someone@example.com, not Lumovi-plugins’ release workflow as this Lumovi knows it`,
  )
  // The workflow's name, signed in elsewhere.
  const elsewhere = await release({
    signer: { identity: PLUGINS_SIGNER.identity, issuer: 'https://accounts.google.com' },
  })
  expect(verdict(elsewhere.release, elsewhere.lock)).toContain(
    `${NAMES.bundle}: its signer signed in with https://accounts.google.com, not as this Lumovi knows Lumovi-plugins’ release workflow does`,
  )
})

test('a certificate Sigstore didn’t issue, or never logged: refused as kubectl’s would be', async () => {
  const forged = await release({ fault: 'authority' })
  expect(verdict(forged.release, forged.lock)).toContain(
    `${NAMES.bundle}: its certificate isn’t from Sigstore’s certificate authority as this Lumovi knows it`,
  )
  const unlogged = await release({ fault: 'unlogged' })
  expect(verdict(unlogged.release, unlogged.lock)).toContain(
    `${NAMES.bundle}: its certificate wasn’t logged`,
  )
})

test('the attestation: there, signed by that workflow, of exactly these two, from the pinned commit', async () => {
  const { release: made, lock } = await release()
  expect(verdict({ ...made, attestation: undefined }, lock)).toBe(
    `${NAMES.attestation}: isn’t in ${PLUGINS_REPOSITORY}’s release ${VERSION}`,
  )
  expect(verdict({ ...made, attestation: Buffer.from('not json') }, lock)).toBe(
    `${NAMES.attestation}: isn’t an attestation Lumovi can read`,
  )
  const someone = `https://github.com/someone/Lumovi-plugins/.github/workflows/release.yml@refs/heads/main`
  const other = await release({ attestedBy: { identity: someone, issuer: PLUGINS_SIGNER.issuer } })
  expect(verdict(other.release, other.lock)).toBe(
    `${NAMES.attestation}: it’s signed by ${someone}, not Lumovi-plugins’ release workflow as this Lumovi knows it`,
  )
  // Of another file: what it attests isn't what was downloaded.
  const elsewhere = await release({
    statement: (statement) => {
      statement.subject[0]!.digest.sha256 = 'b'.repeat(64)
    },
  })
  expect(verdict(elsewhere.release, elsewhere.lock)).toBe(
    `${NAMES.attestation}: attests ${[`${NAMES.bundle} ${'b'.repeat(64)}`, `${NAMES.index} ${elsewhere.lock.index}`].sort().join(', ')}, not ${[`${NAMES.bundle} ${elsewhere.lock.bundle}`, `${NAMES.index} ${elsewhere.lock.index}`].sort().join(', ')}, as downloaded`,
  )
  // And a third file beside them is no longer exactly these two.
  const more = await release({
    statement: (statement) => {
      statement.subject.push({ name: 'more.json', digest: { sha256: 'c'.repeat(64) } })
    },
  })
  expect(verdict(more.release, more.lock)).toMatch(/: attests .*more\.json.*, as downloaded$/)
  // Built from another commit than the lock's, or by another workflow.
  const commit = await release({
    statement: (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = 'd'.repeat(40)
    },
  })
  expect(verdict(commit.release, commit.lock)).toBe(
    `${NAMES.attestation}: says they were built from git+${REPOSITORY}@refs/heads/main at ${'d'.repeat(40)}, not ${PLUGINS_REPOSITORY} at ${COMMIT}, as plugins.lock.json pins`,
  )
  const workflow = await release({
    statement: (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path =
        '.github/workflows/checks.yml'
    },
  })
  expect(verdict(workflow.release, workflow.lock)).toBe(
    `${NAMES.attestation}: says they were built by ${REPOSITORY}/.github/workflows/checks.yml@refs/heads/main, not ${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
  )
  // A statement of something else.
  const other2 = await release({
    statement: (statement) => {
      statement.predicateType = 'https://example.com/other'
    },
  })
  expect(verdict(other2.release, other2.lock)).toBe(
    `${NAMES.attestation}: isn’t a statement of where they were built`,
  )
})

test('what’s served is what the signed index says, as UTF-8 with nothing in front of it', async () => {
  // A file the index names otherwise, though both are signed and pinned.
  const wrong = await release({
    index: (index) => {
      index.plugins[0]!.files[0]!.sha256 = 'e'.repeat(64)
    },
  })
  expect(verdict(wrong.release, wrong.lock)).toBe(
    `${NAMES.bundle}: alpha/plugin.yaml isn’t what the index says it is`,
  )
  // A byte order mark in front: refused, even with the index's digest of its bytes.
  const marked = await release({
    texts: { ...PLUGINS, alpha: `${BYTE_ORDER_MARK}${PLUGINS.alpha}` },
  })
  expect(verdict(marked.release, marked.lock)).toBe(
    `${NAMES.bundle}: alpha/plugin.yaml isn’t UTF-8 text without a byte order mark`,
  )
  // A plugin the index doesn't name, and one it names that isn't there.
  const missing = await release({
    index: (index) => {
      index.plugins[1]!.name = 'gamma'
    },
  })
  expect(verdict(missing.release, missing.lock)).toBe(
    [
      `${NAMES.bundle}: holds beta 1.0.0, which the index doesn’t name`,
      `${NAMES.index}: names gamma, which the bundle doesn’t hold`,
    ].join('\n'),
  )
  // A plugin the index names twice, as if it were one.
  const twice = await release({
    index: (index) => {
      index.plugins.push({ ...index.plugins[0]! })
    },
  })
  expect(verdict(twice.release, twice.lock)).toBe(`${NAMES.index}: names alpha twice`)
  // A name that isn't a plugin's, which would be a file's name.
  const named = await release({ texts: { '../alpha': PLUGINS.alpha } })
  expect(verdict(named.release, named.lock)).toBe(
    `${NAMES.bundle}: holds a plugin named "../alpha"`,
  )
})

test('a lock that pins nothing, or not a release: refused before anything is read', async () => {
  const { release: made } = await release()
  expect(verdict(made, { version: 'latest', commit: 'main', bundle: 'x', index: '' } as Lock)).toBe(
    [
      'plugins.lock.json: version should be a release’s, three numbers',
      'plugins.lock.json: commit should be the release’s commit, 40 hex digits',
      'plugins.lock.json: bundle should be its SHA-256, 64 hex digits',
      'plugins.lock.json: index should be its SHA-256, 64 hex digits',
    ].join('\n'),
  )
  const folder = mkdtempSync(join(tmpdir(), 'lock-'))
  expect(() => readLock(join(folder, 'plugins.lock.json'))).toThrow(
    'plugins.lock.json: is missing: it names the release of Lumovi/Lumovi-plugins Lumovi is built with',
  )
})

const RELEASE_URL = `https://github.com/Lumovi/Lumovi-plugins/releases/download/v${VERSION}`
const REFS_URL = 'https://github.com/Lumovi/Lumovi-plugins.git/info/refs?service=git-upload-pack'
const MAIN = 'f'.repeat(40)

/** git's list of Lumovi-plugins' refs, as GitHub answers it: pkt-lines, the first saying what it can do. */
function refsAnswer(refs: Record<string, string>): Response {
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`
  const lines = Object.entries(refs).map(([ref, commit], n) =>
    line(
      `${commit} ${ref}${n === 0 ? '\0multi_ack side-band-64k symref=HEAD:refs/heads/main' : ''}\n`,
    ),
  )
  return new Response(`${line('# service=git-upload-pack\n')}0000${lines.join('')}0000`)
}

/**
 * GitHub, as the build asks it: the release's files (what `made` hasn't, not found), and its refs,
 * with the release's tag at `tags` (or, as `refs`, the answer itself). Each URL asked is written
 * to `asked`.
 */
function github(
  made: Release,
  {
    tags = { [`refs/tags/v${VERSION}`]: COMMIT },
    asked = [],
    refs,
  }: { tags?: Record<string, string>; asked?: string[]; refs?: string } = {},
): typeof fetch {
  return (async (url: string) => {
    asked.push(url)
    if (url === REFS_URL) {
      if (refs !== undefined) return new Response(refs)
      return refsAnswer({ HEAD: MAIN, 'refs/heads/main': MAIN, 'refs/tags/v0.9.0': MAIN, ...tags })
    }
    const name = url.slice(url.lastIndexOf('/') + 1)
    const file = Object.entries(NAMES).find(([, each]) => each === name)?.[0] as keyof Release
    const bytes = url.startsWith(`${RELEASE_URL}/`) ? made[file] : undefined
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('Not Found', { status: 404 })
  }) as typeof fetch
}

/** What's in a cache: each entry's files, by entry. */
function contents(cache: string): Record<string, string[]> {
  if (!existsSync(cache)) return {}
  return Object.fromEntries(
    readdirSync(cache).map((entry) => [entry, readdirSync(join(cache, entry)).sort()]),
  )
}

const taken = { 'alpha.yaml': PLUGINS.alpha, 'beta.yaml': PLUGINS.beta }
const offline = (async (url: string) => {
  throw new Error(`offline: ${url}`)
}) as unknown as typeof fetch

test('downloaded once, its tag asked then: kept whole once every check passed, and then nothing’s asked', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  const asked: string[] = []
  expect(await takePlugins(lock, trust, { cache, download: github(made, { asked }) })).toEqual(
    taken,
  )
  expect(asked).toEqual([REFS_URL, ...Object.values(NAMES).map((name) => `${RELEASE_URL}/${name}`)])
  // One entry, for this lock, with every file, and nothing half-written beside it.
  const entry = cacheEntry(lock, cache)
  expect(contents(cache)).toEqual({
    [entry.slice(cache.length + 1)]: Object.values(NAMES).sort(),
  })
  expect(entry.slice(cache.length + 1)).toMatch(/^1\.0\.0-[0-9a-f]{64}$/)
  expect(readFileSync(join(entry, NAMES.bundle)).equals(made.bundle)).toBe(true)
  // Then from the cache, checked again, with nothing asked: offline, and the tag not asked again.
  expect(await takePlugins(lock, trust, { cache, download: offline })).toEqual(taken)
  // Another lock (a byte of what it pins) is another entry.
  expect(cacheEntry({ ...lock, commit: 'b'.repeat(40) }, cache)).not.toBe(entry)
})

test('a tag that points at another commit than the lock’s, or isn’t there, stops the first download', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  const asked: string[] = []
  const elsewhere = { [`refs/tags/v${VERSION}`]: 'b'.repeat(40) }
  await expect(
    takePlugins(lock, trust, { cache, download: github(made, { tags: elsewhere, asked }) }),
  ).rejects.toThrow(
    `v1.0.0: Lumovi/Lumovi-plugins’s tag points at ${'b'.repeat(40)}, and plugins.lock.json pins ${COMMIT}`,
  )
  // Nothing downloaded after it, and nothing kept.
  expect(asked).toEqual([REFS_URL])
  expect(contents(cache)).toEqual({})
  await expect(
    takePlugins(lock, trust, { cache, download: github(made, { tags: {} }) }),
  ).rejects.toThrow('v1.0.0: isn’t a tag of Lumovi/Lumovi-plugins')
  // An annotated tag: the commit it's of, not the tag's own object.
  const annotated = {
    [`refs/tags/v${VERSION}`]: 'c'.repeat(40),
    [`refs/tags/v${VERSION}^{}`]: COMMIT,
  }
  expect(
    await takePlugins(lock, trust, { cache, download: github(made, { tags: annotated }) }),
  ).toEqual(taken)
  const pointing = { ...annotated, [`refs/tags/v${VERSION}^{}`]: 'b'.repeat(40) }
  await expect(
    takePlugins(lock, trust, {
      cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')),
      download: github(made, { tags: pointing }),
    }),
  ).rejects.toThrow(`tag points at ${'b'.repeat(40)}`)
  // Refs that can't be read stop it, saying where.
  const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
  await expect(
    takePlugins(lock, trust, {
      cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')),
      download: down,
    }),
  ).rejects.toThrow(`v1.0.0: couldn’t be downloaded: ${REFS_URL} answered 503`)
})

test('a list of tags cut short, or not git’s, stops the first download', async () => {
  const { release: made, lock } = await release()
  const whole = await refsAnswer({
    HEAD: MAIN,
    'refs/heads/main': MAIN,
    [`refs/tags/v${VERSION}.1`]: COMMIT,
  }).text()
  const cutShort = `v1.0.0: GitHub’s list of tags was cut short, or isn’t git’s: ${REFS_URL}`
  for (const refs of [
    // v1.0.0.1's line, cut where what's left would name v1.0.0.
    whole.slice(0, whole.indexOf(`v${VERSION}.1`) + `v${VERSION}`.length),
    // A length past the end, with a short line after it.
    `${whole.slice(0, -4)}ffff${COMMIT} refs/tags/v${VERSION}\n`,
    // Whole lines, and no flush at the end.
    whole.slice(0, -4),
    // Not pkt-lines at all; or nothing.
    '<!DOCTYPE html><html><body>Sign in</body></html>',
    '',
  ]) {
    const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
    const asked: string[] = []
    await expect(
      takePlugins(lock, trust, { cache, download: github(made, { refs, asked }) }),
    ).rejects.toThrow(cutShort)
    expect(asked).toEqual([REFS_URL])
    expect(contents(cache)).toEqual({})
  }
  // As whole, it's read: no tag v1.0.0 there.
  await expect(
    takePlugins(lock, trust, {
      cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')),
      download: github(made, { refs: whole }),
    }),
  ).rejects.toThrow('v1.0.0: isn’t a tag of Lumovi/Lumovi-plugins')
})

test('a download that fails, is cut short or doesn’t pass a check leaves nothing in the cache', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  const answered = github(made)
  // The connection lost in the middle of the attestation.
  const interrupted = (async (url: string) => {
    if (!url.endsWith(NAMES.attestation)) return answered(url)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(made.attestation.subarray(0, 100)))
          controller.error(new Error('the connection was reset'))
        },
      }),
    )
  }) as typeof fetch
  await expect(takePlugins(lock, trust, { cache, download: interrupted })).rejects.toThrow(
    `${NAMES.attestation}: couldn’t be downloaded from ${RELEASE_URL}/${NAMES.attestation}: the connection was reset`,
  )
  expect(contents(cache)).toEqual({})
  // A file the release answers with an error.
  const broken = (async (url: string) =>
    url.endsWith(NAMES.bundle) ? new Response('', { status: 500 }) : answered(url)) as typeof fetch
  await expect(takePlugins(lock, trust, { cache, download: broken })).rejects.toThrow(
    `${NAMES.bundle}: couldn’t be downloaded: ${RELEASE_URL}/${NAMES.bundle} answered 500`,
  )
  expect(contents(cache)).toEqual({})
  // A release without its attestation: downloaded whole, and refused by the check.
  const unattested = { ...made, attestation: undefined }
  await expect(takePlugins(lock, trust, { cache, download: github(unattested) })).rejects.toThrow(
    `${NAMES.attestation}: isn’t in Lumovi/Lumovi-plugins’s release 1.0.0`,
  )
  expect(contents(cache)).toEqual({})
})

test('a cached copy that’s wrong is downloaded again, once, before anything is refused', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  await takePlugins(lock, trust, { cache, download: github(made) })
  // Changed since it was kept.
  const entry = cacheEntry(lock, cache)
  writeFileSync(join(entry, NAMES.bundle), made.bundle.subarray(0, 10))
  const asked: string[] = []
  expect(await takePlugins(lock, trust, { cache, download: github(made, { asked }) })).toEqual(
    taken,
  )
  expect(asked).toEqual([REFS_URL, ...Object.values(NAMES).map((name) => `${RELEASE_URL}/${name}`)])
  expect(readFileSync(join(entry, NAMES.bundle)).equals(made.bundle)).toBe(true)
  // And where the download is wrong too: refused, after that one more try, with nothing kept.
  writeFileSync(join(entry, NAMES.bundle), made.bundle.subarray(0, 10))
  const wrong = github({ ...made, bundle: Buffer.from('{}') })
  await expect(takePlugins(lock, trust, { cache, download: wrong })).rejects.toThrow(
    `${NAMES.bundle}: its SHA-256 is ${sha256(Buffer.from('{}'))}`,
  )
  expect(contents(cache)).toEqual({})
})

test('a download that doesn’t answer in time is given up, saying so, never waited on', async () => {
  const { lock } = await release()
  // A server that's stopped answering: nothing comes until the download is given up.
  const silent = ((_: string, init?: RequestInit) =>
    new Promise<Response>((_, refuse) =>
      init?.signal?.addEventListener('abort', () => refuse(init.signal!.reason)),
    )) as typeof fetch
  await expect(downloadRelease(lock, { download: silent, timeLimit: 100 })).rejects.toThrow(
    `${NAMES.bundle}: couldn’t be downloaded from ${RELEASE_URL}/${NAMES.bundle}: no answer in time (0.1 s)`,
  )
})

test('a download larger than any release’s file is cut off, saying so', async () => {
  const { lock } = await release()
  const huge = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024))
        },
      }),
    )) as unknown as typeof fetch
  await expect(downloadRelease(lock, { download: huge })).rejects.toThrow(
    `${NAMES.bundle}: is larger than 16 MB, and no file of a plugins release is that large`,
  )
  // Or said so before it's read, where the answer says how large it is.
  const said = (async () =>
    new Response('x', {
      headers: { 'content-length': String(DOWNLOAD_LIMIT + 1) },
    })) as unknown as typeof fetch
  await expect(downloadRelease(lock, { download: said })).rejects.toThrow(
    `${NAMES.bundle}: is larger than 16 MB, and no file of a plugins release is that large`,
  )
})

test('the build serves the files as one module, or stops saying why', async () => {
  const served = lumoviPlugins(async () => ({ 'alpha.yaml': PLUGINS.alpha }))
  const context = {
    error: (message: string) => {
      throw new Error(message)
    },
  }
  await (served.buildStart as (this: unknown) => Promise<void>).call(context)
  const id = (served.resolveId as (id: string) => string | undefined)('virtual:lumovi-plugins')
  expect(id).toBe('\0virtual:lumovi-plugins')
  expect((served.load as (id: string) => string | undefined)(id!)).toBe(
    `export default Object.freeze(${JSON.stringify({ 'alpha.yaml': PLUGINS.alpha })})`,
  )
  expect((served.resolveId as (id: string) => string | undefined)('other')).toBeUndefined()
  const refused = lumoviPlugins(async () => {
    throw new PluginsBundleError(`${NAMES.bundle}: isn’t signed`)
  })
  await expect(
    (refused.buildStart as (this: unknown) => Promise<void>).call(context),
  ).rejects.toThrow(`Lumovi’s plugins can’t be built in:\n${NAMES.bundle}: isn’t signed`)
})

test('kubectl’s certificates and their check are as they were: an email, Kubernetes’ issuer', async () => {
  const binary = Buffer.from('kubectl')
  const certificate = await sigstore.certificate()
  const leaf = X509Certificate.parse(Buffer.from(certificate.toString(), 'base64').toString())
  expect(leaf.subjectAltName).toBe(KUBERNETES_SIGNER.identity)
  expect(leaf.extSubjectAltName?.rfc822Name).toBe(KUBERNETES_SIGNER.identity)
  const root = sigstore.root as TrustRoot
  expect(whyNotKubernetes(binary, sigstore.sign(binary), certificate, root)).toBeUndefined()
  expect(
    whyNotKubernetes(binary, sigstore.sign(binary), await sigstore.certificate('identity'), root),
  ).toEqual({
    why: 'it’s signed by someone@example.com, not Kubernetes’ release as this Lumovi knows it',
    changed: 'Kubernetes has changed how it signs',
  })
  expect(
    whyNotKubernetes(binary, sigstore.sign(binary), await sigstore.certificate('issuer'), root),
  ).toEqual({
    why: 'its signer signed in with https://token.actions.githubusercontent.com, not as this Lumovi knows Kubernetes’ release does',
    changed: 'Kubernetes has changed how it signs',
  })
})
