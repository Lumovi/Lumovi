// The helm the desktop app ships with: the server image's (the Dockerfile's HELM_VERSION, which
// CI keeps the same), each platform's checked against the checksum pinned here, as Helm's
// release published it.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const HELM_VERSION = '4.3.0'

/** Helm's archives' SHA-256, by Go's platform names (get.helm.sh and Helm's release notes). */
const SHA256: Record<string, string> = {
  'darwin-amd64': '347a784877e0e20eac865e8d1c36a80f6bb0861d6f29abd34defb6570ef95d92',
  'darwin-arm64': 'd3870437e1e95b67f8edbde964156c84a26503f560821d40c542441658934fba',
  'linux-amd64': '86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb',
  'linux-arm64': '31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08',
  'windows-amd64': '304ea163cce4d9ad14e189c01846c6a34de9cfdfe48536ae54b2e8ba7884e67c',
  'windows-arm64': '4a9eefa30d26eb73900a9a0f16e97eae678582172204db60cbd454c68acea246',
}
const GOOS: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const GOARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }

/**
 * Puts helm, and its license, in `dir`, for a platform (Node's names) and an architecture
 * (x64, arm64): downloaded, checked, and only then written down and opened.
 */
export async function fetchHelm(platform: string, arch: string, dir: string): Promise<string> {
  const target = `${GOOS[platform]}-${GOARCH[arch]}`
  const sha256 = SHA256[target]
  if (!sha256) throw new Error(`Lumovi doesn’t ship helm for ${platform} ${arch}.`)
  const file = `helm-v${HELM_VERSION}-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
  const response = await fetch(`https://get.helm.sh/${file}`)
  if (!response.ok) throw new Error(`get.helm.sh answered ${response.status} for ${file}.`)
  const archive = Buffer.from(await response.arrayBuffer())
  const got = createHash('sha256').update(archive).digest('hex')
  if (got !== sha256) throw new Error(`${file} isn’t Helm’s: its SHA-256 is ${got}.`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const exe = platform === 'win32' ? 'helm.exe' : 'helm'
  // Windows' own tar (bsdtar) reads zips (Git's, first on CI's PATH, doesn't), but not from a
  // pipe: the archive, checked, is given to it in a folder of its own.
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'tar.exe') : 'tar'
  const temp = mkdtempSync(join(tmpdir(), 'lumovi-helm-'))
  try {
    const path = join(temp, file)
    writeFileSync(path, archive, { flag: 'wx', mode: 0o600 })
    const run = spawnSync(
      tar,
      ['-xf', path, '-C', dir, '--strip-components=1', `${target}/${exe}`, `${target}/LICENSE`],
      { encoding: 'utf8' },
    )
    if (run.status !== 0) throw new Error(`tar couldn’t open ${file}: ${run.stderr || run.error}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  return join(dir, exe)
}
