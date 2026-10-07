/**
 * A stand-in for dl.k8s.io, for the e2e tests: each minor version's newest patch is .9, and its
 * kubectl a script that says which it is (on Windows, never run). What it's asked is kept, and
 * it can be made to fail as the real one can.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockDownloads {
  url: string
  /** The paths asked for, oldest first. */
  requests: string[]
  /** How it fails: its newest-patch files, a kubectl that isn't what it published, or kubectl. */
  fail?: 'lookup' | 'checksum' | 'download'
  /** How long kubectl takes to come. */
  delayMs?: number
  reset(): void
  close(): Promise<void>
}

/** The stand-in kubectl of a version. */
export const standIn = (version: string) =>
  `#!/bin/sh\necho "kubectl ${version}, the tests' stand-in"\n`

export async function startMockDownloads(): Promise<MockDownloads> {
  const downloads: MockDownloads = {
    url: '',
    requests: [],
    reset() {
      this.requests.length = 0
      this.fail = undefined
      this.delayMs = undefined
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    downloads.requests.push(path)
    const stable = /^\/release\/stable-(\d+\.\d+)\.txt$/.exec(path)
    const binary =
      /^\/release\/(v\d+\.\d+\.\d+)\/bin\/(\w+)\/(\w+)\/kubectl(\.exe)?(\.sha256)?$/.exec(path)
    if (stable && downloads.fail !== 'lookup') {
      res.end(`v${stable[1]}.9\n`)
    } else if (binary && !(downloads.fail === 'download' && !binary[5])) {
      const kubectl = standIn(binary[1]!)
      if (!binary[5]) {
        setTimeout(() => res.end(kubectl), downloads.delayMs ?? 0)
      } else {
        const published = downloads.fail === 'checksum' ? `${kubectl} changed` : kubectl
        res.end(createHash('sha256').update(published).digest('hex'))
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
