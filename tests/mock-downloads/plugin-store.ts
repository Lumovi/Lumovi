/**
 * A stand-in for Lumovi-plugins' releases on GitHub, for the e2e tests: a release made as its
 * workflow makes one, signed and attested by the tests' stand-in for Sigstore (sigstore.ts) with
 * the workflow's real identity, as the Plugins page checks it (src/main/plugin-store.ts). By
 * default it's the release Lumovi was built with, made again: nothing newer.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGINS_SIGNER, releaseFiles, type Release } from '../../src/main/plugins-release.ts'
import { cacheEntry, readLock } from '../../scripts/plugins-bundle.ts'
import type { MockSigstore, WorkflowSigner } from './sigstore.ts'

const REPOSITORY = 'https://github.com/Lumovi/Lumovi-plugins'
const DAY = 24 * 60 * 60 * 1000
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/** A plugin of a stand-in release: its file, and its code where it has some. */
export interface StandInPlugin {
  name: string
  version: string
  /** The oldest Lumovi it needs. */
  lumovi?: string
  text: string
  code?: string
}

/** A release, as a test wants it, and how it's wrong. */
export interface StandInRelease {
  version: string
  serial: number
  plugins: StandInPlugin[]
  /** When it stops being taken: by default, in 180 days. */
  expires?: string
  /** The commit its tag points at. */
  commit?: string
  /**
   * How it's wrong: signed by another workflow; attested as built from another commit than its
   * tag's; a file that isn't what the index says.
   */
  fault?: 'signer' | 'commit' | 'tampered'
}

/** The release's files, by name, and its tag's commit. */
export interface MadeRelease {
  version: string
  commit: string
  files: Record<string, Buffer>
}

/** A release as Lumovi-plugins' workflow makes one, signed by the stand-in for Sigstore. */
export async function makeRelease(
  sigstore: MockSigstore,
  wanted: StandInRelease,
): Promise<MadeRelease> {
  const { version } = wanted
  const names = releaseFiles(version)
  const commit = wanted.commit ?? 'c'.repeat(40)
  const carried = ({ text, code }: StandInPlugin) => [
    { path: 'plugin.yaml', text },
    ...(code === undefined ? [] : [{ path: 'plugin.js', text: code }]),
  ]
  const bundle = json({
    format: 1,
    version,
    plugins: wanted.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      files: carried(plugin),
    })),
  })
  const made = Date.now()
  const index = json({
    format: 1,
    version,
    serial: wanted.serial,
    made: new Date(made).toISOString(),
    expires: wanted.expires ?? new Date(made + 180 * DAY).toISOString(),
    bundle: { file: names.bundle, size: bundle.length, sha256: sha256(bundle) },
    plugins: wanted.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      ...(plugin.lumovi === undefined ? {} : { lumovi: plugin.lumovi }),
      files: carried(plugin).map(({ path, text }) => ({
        path,
        size: Buffer.byteLength(text),
        // (Tampered: the index names other bytes than the bundle carries.)
        sha256: sha256(Buffer.from(wanted.fault === 'tampered' ? `${text}#` : text)),
      })),
    })),
  })
  const signer: WorkflowSigner =
    wanted.fault === 'signer'
      ? {
          identity: `https://github.com/someone/Lumovi-plugins/.github/workflows/release.yml@refs/heads/main`,
          issuer: PLUGINS_SIGNER.issuer,
        }
      : PLUGINS_SIGNER
  const attestation = await sigstore.attestation(
    {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        { name: names.bundle, digest: { sha256: sha256(bundle) } },
        { name: names.index, digest: { sha256: sha256(index) } },
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
            {
              uri: `git+${REPOSITORY}@refs/heads/main`,
              digest: { gitCommit: wanted.fault === 'commit' ? 'd'.repeat(40) : commit },
            },
          ],
        },
      },
    },
    PLUGINS_SIGNER,
  )
  const release: Required<Release> = {
    bundle,
    index,
    bundleSignature: await sigstore.blob(bundle, signer),
    indexSignature: await sigstore.blob(index, signer),
    attestation,
  }
  return {
    version,
    commit,
    files: Object.fromEntries(
      (Object.entries(names) as [keyof Release, string][]).map(([key, name]) => [
        name,
        release[key],
      ]),
    ),
  }
}

/**
 * The release Lumovi was built with, as the build kept it (.cache/plugins): its plugins at their
 * versions, under its version and serial.
 */
export function builtWith(): StandInRelease {
  const lock = readLock()
  const entry = cacheEntry(lock)
  const names = releaseFiles(lock.version)
  if (!existsSync(join(entry, names.bundle))) {
    throw new Error(`${entry}: isn’t there: build Lumovi first, which keeps its plugins’ release`)
  }
  const bundle = JSON.parse(readFileSync(join(entry, names.bundle), 'utf8')) as {
    plugins: { name: string; version: string; files: { path: string; text: string }[] }[]
  }
  const index = JSON.parse(readFileSync(join(entry, names.index), 'utf8')) as {
    serial: number
    plugins: { name: string; lumovi?: string }[]
  }
  const needs = new Map(index.plugins.map(({ name, lumovi }) => [name, lumovi]))
  return {
    version: lock.version,
    serial: index.serial,
    plugins: bundle.plugins.map(({ name, version, files }) => {
      const code = files.find(({ path }) => path === 'plugin.js')?.text
      const lumovi = needs.get(name)
      return {
        name,
        version,
        text: files.find(({ path }) => path === 'plugin.yaml')!.text,
        ...(code === undefined ? {} : { code }),
        ...(lumovi === undefined ? {} : { lumovi }),
      }
    }),
  }
}

/** git's list of Lumovi-plugins' refs, as GitHub answers it: pkt-lines, the tag's among them. */
export function refsAnswer(version: string, commit: string): string {
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`
  const main = 'f'.repeat(40)
  return [
    line('# service=git-upload-pack\n'),
    '0000',
    line(`${main} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main\n`),
    line(`${main} refs/heads/main\n`),
    line(`${commit} refs/tags/v${version}\n`),
    '0000',
  ].join('')
}
