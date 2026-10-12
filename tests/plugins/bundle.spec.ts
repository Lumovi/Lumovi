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
  DOWNLOAD_LIMIT,
  fetchRelease,
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

test('downloaded once into the cache, where the release has them; what it hasn’t, left for the check', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  const asked: string[] = []
  const download = (async (url: string) => {
    asked.push(url)
    const name = url.slice(url.lastIndexOf('/') + 1)
    const file = Object.entries(NAMES).find(([, each]) => each === name)?.[0] as keyof Release
    return name === NAMES.attestation
      ? new Response('Not Found', { status: 404 })
      : new Response(new Uint8Array(made[file]))
  }) as typeof fetch
  const fetched = await fetchRelease(lock, { cache, download })
  expect(fetched.cached).toBe(false)
  expect(asked).toEqual(
    Object.values(NAMES).map(
      (name) => `https://github.com/Lumovi/Lumovi-plugins/releases/download/v1.0.0/${name}`,
    ),
  )
  expect(fetched.release.attestation).toBeUndefined()
  expect(fetched.release.bundle?.equals(made.bundle)).toBe(true)
  // Kept whole, under its own name, and nothing half-written left beside it.
  expect(readFileSync(join(cache, VERSION, NAMES.bundle)).equals(made.bundle)).toBe(true)
  expect(readdirSync(join(cache, VERSION)).filter((name) => name.endsWith('.part'))).toEqual([])
  expect(existsSync(join(cache, VERSION, NAMES.attestation))).toBe(false)
  // Again: from the cache, and the one it hasn't asked for again.
  asked.length = 0
  expect((await fetchRelease(lock, { cache, download })).cached).toBe(true)
  expect(asked).toEqual([
    `https://github.com/Lumovi/Lumovi-plugins/releases/download/v1.0.0/${NAMES.attestation}`,
  ])
  // A release that can't be reached stops the build, saying where.
  const broken = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
  await expect(
    fetchRelease(lock, { cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')), download: broken }),
  ).rejects.toThrow(
    `${NAMES.bundle}: couldn’t be downloaded: https://github.com/Lumovi/Lumovi-plugins/releases/download/v1.0.0/${NAMES.bundle} answered 500`,
  )
})

test('a cached copy that’s wrong is downloaded again, once, before anything is refused', async () => {
  const { release: made, lock } = await release()
  const cache = mkdtempSync(join(tmpdir(), 'plugins-cache-'))
  let downloads = 0
  const download = (async (url: string) => {
    downloads++
    const name = url.slice(url.lastIndexOf('/') + 1)
    const file = Object.entries(NAMES).find(([, each]) => each === name)?.[0] as keyof Release
    return new Response(new Uint8Array(made[file]))
  }) as typeof fetch
  await fetchRelease(lock, { cache, download })
  // A download cut short, left in the cache.
  writeFileSync(join(cache, VERSION, NAMES.bundle), made.bundle.subarray(0, 10))
  downloads = 0
  expect(await takePlugins(lock, trust, { cache, download })).toEqual({
    'alpha.yaml': PLUGINS.alpha,
    'beta.yaml': PLUGINS.beta,
  })
  expect(downloads).toBe(Object.keys(NAMES).length)
  expect(readFileSync(join(cache, VERSION, NAMES.bundle)).equals(made.bundle)).toBe(true)
  // And a release that's wrong as downloaded is refused after that one more try, not before.
  const wrong = (async (url: string) => {
    const name = url.slice(url.lastIndexOf('/') + 1)
    const file = Object.entries(NAMES).find(([, each]) => each === name)?.[0] as keyof Release
    return new Response(new Uint8Array(name === NAMES.bundle ? Buffer.from('{}') : made[file]))
  }) as typeof fetch
  await expect(
    takePlugins(lock, trust, {
      cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')),
      download: wrong,
    }),
  ).rejects.toThrow(`${NAMES.bundle}: its SHA-256 is ${sha256(Buffer.from('{}'))}`)
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
  await expect(
    fetchRelease(lock, { cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')), download: huge }),
  ).rejects.toThrow(
    `${NAMES.bundle}: is larger than 16 MB, and no file of a plugins release is that large`,
  )
  // Or said so before it's read, where the answer says how large it is.
  const said = (async () =>
    new Response('x', {
      headers: { 'content-length': String(DOWNLOAD_LIMIT + 1) },
    })) as unknown as typeof fetch
  await expect(
    fetchRelease(lock, { cache: mkdtempSync(join(tmpdir(), 'plugins-cache-')), download: said }),
  ).rejects.toThrow(
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
