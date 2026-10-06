/**
 * Writes `out/THIRD_PARTY_NOTICES.txt`: the license of every package the app
 * ships, which installers include next to the app (see electron-builder.yml).
 *
 * That's every package bundled into the main, preload or renderer code (fonts
 * included), plus the main process's `dependencies`, which ship as they are in
 * `node_modules`. The three builds run in one process, one after another, so
 * each adds its packages and rewrites the file.
 *
 * Each build also writes the packages it bundled to `out/<build>/packages.json`
 * (and the desktop's, those it ships as they are to `out/main/dependencies.json`),
 * which scripts/sbom.ts makes the software bills of materials of.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Plugin } from 'vite'

interface PackageJson {
  name: string
  version: string
  license?: string
  repository?: string | { url: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

// Builds run from the project folder (Vite bundles this file, so import.meta.dirname can't tell).
const ROOT = process.cwd()
const OUTPUT = join(ROOT, 'out', 'THIRD_PARTY_NOTICES.txt')
/** The server bundles everything it uses: it ships without node_modules. */
const SERVER_OUTPUT = join(ROOT, 'out', 'server', 'THIRD_PARTY_NOTICES.txt')
/** Used from CSS rather than imported, so they're not in the module graph. */
const FROM_CSS = ['tailwindcss']
/** What the page ships that isn't a package, by the notice kept beside it. */
const VENDORED = ['src/renderer/src/assets/fonts/terminal-symbols.NOTICE.txt']
const LEGAL_FILE = /^(licen[sc]e|copying|notice)/i

const bundled = new Set<string>()

const read = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson

/** The package folder a module belongs to, from its id. */
function packageDir(id: string): string | undefined {
  const path = id.replace(/^\0/, '').replace(/\?.*$/, '').replaceAll('\\', '/')
  return /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1]
}

/** `name` as Node.js resolves it from `from`: the nearest node_modules folder up. */
function resolvePackage(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

/** The main process's dependencies and theirs, as installed for this platform. */
function shippedPackages(): Set<string> {
  const found = new Set<string>()
  const visit = (from: string, name: string) => {
    const dir = resolvePackage(from, name)
    // Optional dependencies for other platforms aren't installed.
    if (!dir || found.has(dir)) return
    found.add(dir)
    const { dependencies, optionalDependencies } = read(dir)
    for (const dep of Object.keys({ ...dependencies, ...optionalDependencies })) visit(dir, dep)
  }
  for (const dep of Object.keys(read(ROOT).dependencies ?? {})) visit(ROOT, dep)
  return found
}

function notice(dir: string): string {
  const pkg = read(dir)
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const texts = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_FILE.test(entry.name))
    .map((entry) => readFileSync(join(dir, entry.name), 'utf8').trim())
  return [
    `${pkg.name} ${pkg.version}`,
    `License: ${pkg.license ?? 'see below'}`,
    ...(repository ? [`Source: ${repository.replace(/^git\+/, '').replace(/\.git$/, '')}`] : []),
    '',
    ...(texts.length > 0 ? texts : ['(The package includes no license file.)']),
  ].join('\n')
}

function write(output: string, dependencies: boolean): void {
  const dirs = new Set([...bundled, ...(dependencies ? shippedPackages() : [])])
  for (const name of FROM_CSS) dirs.add(join(ROOT, 'node_modules', name))
  const byName = new Map<string, string>()
  for (const dir of dirs) {
    const { name, version } = read(dir)
    byName.set(`${name}@${version}`, dir)
  }
  const sections = [
    ...[...byName.keys()].sort().map((key) => notice(byName.get(key)!)),
    ...VENDORED.map((file) => readFileSync(join(ROOT, file), 'utf8').trim()),
  ]
  const rule = '\n\n' + '='.repeat(80) + '\n\n'
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(
    output,
    'Lumovi includes the following third-party software, under the licenses below.' +
      rule +
      sections.join(rule) +
      '\n',
  )
}

/** A list of packages, as scripts/sbom.ts reads it. */
function list(output: string, dirs: Iterable<string>): void {
  const packages = new Map<string, { name: string; version: string; license?: string }>()
  for (const dir of dirs) {
    const { name, version, license } = read(dir)
    packages.set(`${name}@${version}`, { name, version, ...(license ? { license } : {}) })
  }
  const sorted = [...packages.keys()].sort().map((key) => packages.get(key)!)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(sorted, null, 2) + '\n')
}

/**
 * For the desktop app's builds, the server's (which ships with the page's files), or a fleet
 * agent's (whose packages the server's notices cover: only listed).
 */
export function licenses(target: 'desktop' | 'server' | 'agent' = 'desktop'): Plugin {
  return {
    name: 'lumovi:licenses',
    apply: 'build',
    generateBundle(options) {
      const mine = new Set<string>()
      for (const id of this.getModuleIds()) {
        const dir = packageDir(id)
        if (dir) mine.add(dir)
      }
      for (const dir of mine) bundled.add(dir)
      const build = basename(options.dir ?? dirname(options.file!))
      list(join(ROOT, 'out', build, 'packages.json'), mine)
      if (target === 'server') write(SERVER_OUTPUT, false)
      if (target === 'desktop') {
        write(OUTPUT, true)
        list(join(ROOT, 'out', 'main', 'dependencies.json'), shippedPackages())
      }
    },
  }
}
