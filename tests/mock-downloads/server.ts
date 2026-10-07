/**
 * A stand-in for dl.k8s.io, for the e2e tests: each minor version's newest patch is .9, and its
 * kubectl a script that says which it is (on Windows, never run), signed as Kubernetes signs it,
 * by a stand-in for Sigstore (sigstore.ts). Below /mirror, it's an organization's mirror of it.
 * What it's asked is kept, and it can be made to fail as the real one can.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      this.signing = undefined
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    downloads.requests.push(path)
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
