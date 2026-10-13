/**
 * A stand-in for dl.k8s.io, for the e2e tests: each minor version's newest patch is .9, and its
 * kubectl a script that says which it is (on Windows, never run), signed as Kubernetes signs it,
 * by a stand-in for Sigstore (sigstore.ts). Below /mirror, it's an organization's mirror of it.
 * What it's asked is kept, and it can be made to fail as the real one can.
 *
 * And for GitHub, as the Plugins page asks it for Lumovi-plugins' latest release
 * (plugin-store.ts): its redirect to the latest tag, git's list of refs, and the release's files,
 * each sent on to where GitHub keeps them, as GitHub does.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  builtWith,
  makeRelease,
  refsAnswer,
  type MadeRelease,
  type StandInRelease,
} from './plugin-store.ts'
import { startMockSigstore, type CertificateFault } from './sigstore.ts'

export interface MockDownloads {
  url: string
  /** The trust root of its stand-in for Sigstore, as a file (LUMOVI_SIGSTORE_ROOT). */
  sigstoreRoot: string
  /** The paths asked for, oldest first. */
  requests: string[]
  /** How it fails: its newest-patch files, a kubectl that isn't what it published, or kubectl. */
  fail?: 'lookup' | 'checksum' | 'download'
  /** How long kubectl takes to come. */
  delayMs?: number
  /**
   * How its signature is wrong: its certificate's (sigstore.ts), a kubectl that isn't what was
   * signed (its SHA-256 changed with it), or the signature or the certificate (or both) not there.
   */
  signing?: CertificateFault | 'tampered' | 'unsigned' | 'no-certificate' | 'no-signature'
  /** What `signing` goes back to after each test. */
  defaultSigning?: MockDownloads['signing']
  /**
   * Lumovi-plugins' latest release, as GitHub's stand-in has it: by default, the one Lumovi was
   * built with (nothing newer). `none`: it has no release; a number: what GitHub answers.
   */
  pluginStore?: StandInRelease | 'none' | number
  /** How long GitHub's stand-in takes to say which release is the latest. */
  pluginStoreDelayMs?: number
  reset(): void
  close(): Promise<void>
}

/** The stand-in kubectl of a version. */
export const standIn = (version: string) =>
  `#!/bin/sh\necho "kubectl ${version}, the tests' stand-in"\n`

export async function startMockDownloads(): Promise<MockDownloads> {
  const sigstore = await startMockSigstore()
  const sigstoreRoot = join(mkdtempSync(join(tmpdir(), 'lumovi-sigstore-')), 'root.json')
  writeFileSync(sigstoreRoot, JSON.stringify(sigstore.root))
  const downloads: MockDownloads = {
    url: '',
    sigstoreRoot,
    requests: [],
    reset() {
      this.requests.length = 0
      this.fail = undefined
      this.delayMs = undefined
      this.signing = this.defaultSigning
      this.pluginStore = undefined
      this.pluginStoreDelayMs = undefined
    },
    // Without waiting for the connections apps kept open (a killed app's, on Windows, never end).
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
        server.closeAllConnections()
      }),
  }
  // Each release as it was made, made once: signing takes a moment.
  const made = new WeakMap<StandInRelease, Promise<MadeRelease>>()
  let ownRelease: StandInRelease | undefined
  const releaseFor = (wanted: StandInRelease) => {
    if (!made.has(wanted)) made.set(wanted, makeRelease(sigstore, wanted))
    return made.get(wanted)!
  }
  const plugins = '/Lumovi/Lumovi-plugins'
  /** GitHub, as the Plugins page asks it for Lumovi-plugins' latest release. */
  const store = async (path: string, res: ServerResponse) => {
    const { pluginStore } = downloads
    if (typeof pluginStore === 'number' || pluginStore === 'none') {
      res.statusCode = pluginStore === 'none' ? 404 : pluginStore
      return res.end()
    }
    const release = await releaseFor(pluginStore ?? (ownRelease ??= builtWith()))
    const download = new RegExp(`^${plugins}/releases/download/v${release.version}/([^/]+)$`).exec(
      path,
    )
    const asset = /^\/release-assets\/([^/]+)$/.exec(path)
    if (path === `${plugins}/releases/latest`) {
      await new Promise((done) => setTimeout(done, downloads.pluginStoreDelayMs ?? 0))
      res.writeHead(302, { location: `${plugins}/releases/tag/v${release.version}` })
    } else if (path === `${plugins}.git/info/refs`) {
      res.write(refsAnswer(release.version, release.commit))
    } else if (download && release.files[download[1]!]) {
      // (Sent on to where the files are kept, as GitHub does.)
      res.writeHead(302, { location: `/release-assets/${download[1]}` })
    } else if (asset && release.files[asset[1]!]) {
      res.write(release.files[asset[1]!])
    } else {
      res.statusCode = 404
    }
    res.end()
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    downloads.requests.push(path)
    if (path.startsWith(plugins) || path.startsWith('/release-assets/')) {
      store(path, res).catch((error: unknown) => {
        res.statusCode = 500
        res.end(String(error))
      })
      return
    }
    const stable = /^(?:\/mirror)?\/release\/stable-(\d+\.\d+)\.txt$/.exec(path)
    const binary =
      /^(?:\/mirror)?\/release\/(v\d+\.\d+\.\d+)\/bin\/(\w+)\/(\w+)\/kubectl(\.exe)?(\.sha256|\.sig|\.cert)?$/.exec(
        path,
      )
    const { signing } = downloads
    if (stable && downloads.fail !== 'lookup') {
      res.end(`v${stable[1]}.9\n`)
    } else if (binary && !(downloads.fail === 'download' && !binary[5])) {
      const signed = standIn(binary[1]!)
      // Tampered: what's served, and its SHA-256, aren't what Kubernetes signed.
      const kubectl = signing === 'tampered' ? `${signed}echo changed\n` : signed
      const file = binary[5]
      if (!file) {
        setTimeout(() => res.end(kubectl), downloads.delayMs ?? 0)
      } else if (file === '.sha256') {
        const published = downloads.fail === 'checksum' ? `${kubectl} changed` : kubectl
        res.end(createHash('sha256').update(published).digest('hex'))
      } else if (
        signing === 'unsigned' ||
        (file === '.sig' && signing === 'no-signature') ||
        (file === '.cert' && signing === 'no-certificate')
      ) {
        res.statusCode = 404
        res.end()
      } else if (file === '.sig') {
        res.end(sigstore.sign(Buffer.from(signed)))
      } else {
        const fault = ['tampered', 'no-signature', 'no-certificate'].includes(signing!)
          ? undefined
          : (signing as CertificateFault | undefined)
        void sigstore.certificate(fault).then((certificate) => res.end(certificate))
      }
    } else {
      res.statusCode = downloads.fail === 'lookup' ? 503 : 404
      res.end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  downloads.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return downloads
}
