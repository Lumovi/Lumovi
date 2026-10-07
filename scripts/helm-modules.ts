/**
 * The Go modules the helm Lumovi ships is built from (scripts/helm-modules.json), for the
 * desktop app's bill of materials (scripts/sbom.ts): read from the build information Go writes
 * into every binary, as `go version -m` reads it, from the linux-amd64 helm of HELM_VERSION
 * (every platform's is built from the same modules), checked against its pinned checksum.
 *
 *   node scripts/helm-modules.ts           writes it again (after HELM_VERSION changes)
 *   node scripts/helm-modules.ts --check   fails if it isn't what helm says, or if the built
 *                                          bill of materials (out/sbom.cdx.json) leaves any
 *                                          of them out (CI)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchHelm, HELM_VERSION } from './helm.ts'

export interface GoModule {
  path: string
  version: string
  /** The go.sum hash of what was built. */
  sum?: string
}

export interface HelmModules {
  helm: string
  /** The Go it was built with. */
  go: string
  modules: GoModule[]
}

export const MODULES_FILE = join(import.meta.dirname, 'helm-modules.json')
const SBOM = join(import.meta.dirname, '..', 'out', 'sbom.cdx.json')

/** Go's package URL, as scanners match it (syft's): pkg:golang/github.com/a/b@v1.2.3. */
export const goPurl = (path: string, version: string) =>
  `pkg:golang/${path}@${encodeURIComponent(version)}`

/** The package URLs a bill of materials lists for them: helm, its modules, and its Go. */
export const purlsOf = ({ helm, go, modules }: HelmModules) => [
  goPurl('helm.sh/helm/v4', `v${helm}`),
  ...modules.map(({ path, version }) => goPurl(path, version)),
  goPurl('stdlib', go.replace(/^go/, '')),
]

const MAGIC = Buffer.from('\xff Go buildinf:', 'latin1')
/** What Go puts before and after the module information, so that it can be found. */
const SENTINEL = 16

/** A varint-prefixed string, and where the next one starts. */
function varString(data: Buffer, at: number): [string, number] {
  let length = 0
  let shift = 0
  for (;;) {
    const byte = data[at++]!
    length |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) break
    shift += 7
  }
  return [data.subarray(at, at + length).toString('utf8'), at + length]
}

/**
 * A Go binary's build information (Go 1.18 and later, which writes it inline): the Go it was
 * built with, its main module, and the modules it depends on, as built (a module replaced by
 * another is the other).
 */
export function goBuildInfo(binary: Buffer): { go: string; main: GoModule; deps: GoModule[] } {
  for (let at = binary.indexOf(MAGIC); at !== -1; at = binary.indexOf(MAGIC, at + 1)) {
    // Its header is 32 bytes: the magic, the pointer size, and flags, whose second bit says the
    // strings follow inline.
    if (at % 16 !== 0 || !(binary[at + 15]! & 0x2)) continue
    const [go, next] = varString(binary, at + 32)
    const [raw] = varString(binary, next)
    if (raw.length < 2 * SENTINEL + 1) continue
    const info = raw.slice(SENTINEL, -SENTINEL)
    let main: GoModule | undefined
    const deps: GoModule[] = []
    for (const line of info.split('\n')) {
      const [kind, path, version, sum] = line.split('\t')
      const module = { path: path!, version: version!, ...(sum ? { sum } : {}) }
      if (kind === 'mod') main = module
      else if (kind === 'dep') deps.push(module)
      // A replacement: what was built is it, not the module it replaces.
      else if (kind === '=>') deps[deps.length - 1] = module
    }
    if (main && go.startsWith('go')) return { go, main, deps }
  }
  throw new Error('It has no Go build information Lumovi can read.')
}

async function modules(): Promise<HelmModules> {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-helm-modules-'))
  try {
    const { go, main, deps } = goBuildInfo(readFileSync(await fetchHelm('linux', 'x64', dir)))
    if (main.path !== 'helm.sh/helm/v4' || main.version !== `v${HELM_VERSION}`) {
      throw new Error(`helm says it's ${main.path}@${main.version}, not helm ${HELM_VERSION}.`)
    }
    return { helm: HELM_VERSION, go, modules: deps }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const text = JSON.stringify(await modules(), null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (readFileSync(MODULES_FILE, 'utf8') !== text) {
      console.error(
        `scripts/helm-modules.json isn't helm ${HELM_VERSION}'s: run node scripts/helm-modules.ts`,
      )
      process.exit(1)
    }
    if (existsSync(SBOM)) {
      const listed = new Set(
        (
          JSON.parse(readFileSync(SBOM, 'utf8')) as { components: { purl?: string }[] }
        ).components.map((c) => c.purl),
      )
      const missing = purlsOf(JSON.parse(text) as HelmModules).filter((p) => !listed.has(p))
      if (missing.length) {
        console.error(
          `out/sbom.cdx.json leaves out ${missing.length} of helm's: ${missing.join(', ')}`,
        )
        process.exit(1)
      }
      console.log(`out/sbom.cdx.json lists helm ${HELM_VERSION}, its modules and its Go.`)
    }
  } else {
    writeFileSync(MODULES_FILE, text)
    console.log(
      `scripts/helm-modules.json: helm ${HELM_VERSION}, ${text.split('"path"').length - 1} modules`,
    )
  }
}
