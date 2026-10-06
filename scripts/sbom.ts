/**
 * The software bills of materials (CycloneDX) of what Lumovi ships, from the packages its
 * builds bundled and ship (out/<build>/packages.json, which scripts/vite-licenses.ts writes):
 *
 *   out/sbom.cdx.json    the desktop app: its main process, preload and page, the packages
 *                        it ships as they are, and Electron
 *   out/image.cdx.json   the image's JavaScript: the page, the server and a fleet's agent (the
 *                        image's own bill, made as it's built, has its system's packages)
 *
 * Run by `npm run build`, after the builds.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Package {
  name: string
  version: string
  license?: string
}

const ROOT = process.cwd()
const OUT = join(ROOT, 'out')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Package

const packagesOf = (...lists: string[]): Package[] =>
  lists.flatMap((name) => {
    const file = join(OUT, name)
    if (!existsSync(file)) throw new Error(`${file} isn’t there: build first (npm run build).`)
    return JSON.parse(readFileSync(file, 'utf8')) as Package[]
  })

/** npm's package URL: pkg:npm/%40scope/name@version. */
const purl = ({ name, version }: Package) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`

/** A license as CycloneDX has it: an SPDX expression where it's one, its name otherwise. */
function licenses(license: string | undefined) {
  if (!license) return {}
  const spdx = /^\(?[\w.+-]+( (AND|OR|WITH) \(?[\w.+-]+\)?)*\)?$/.test(license)
  return { licenses: [spdx ? { expression: license } : { license: { name: license } }] }
}

function component(pkg: Package, type = 'library') {
  const [group, name] = pkg.name.startsWith('@') ? pkg.name.split('/') : [undefined, pkg.name]
  return {
    type,
    'bom-ref': purl(pkg),
    ...(group ? { group } : {}),
    name: name!,
    version: pkg.version,
    purl: purl(pkg),
    ...licenses(pkg.license),
  }
}

function write(file: string, name: string, packages: Package[], extra: object[] = []): void {
  const unique = new Map(packages.map((pkg) => [purl(pkg), pkg]))
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', 'bom-ref': `lumovi@${version}`, name, version },
    },
    components: [...extra, ...[...unique.keys()].sort().map((key) => component(unique.get(key)!))],
  }
  writeFileSync(join(OUT, file), JSON.stringify(bom, null, 2) + '\n')
  console.log(`${join('out', file)}: ${bom.components.length} components`)
}

const electron = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
) as Package
write(
  'sbom.cdx.json',
  'lumovi',
  packagesOf(
    'main/packages.json',
    'preload/packages.json',
    'renderer/packages.json',
    'main/dependencies.json',
  ),
  [component({ ...electron, license: electron.license ?? 'MIT' }, 'framework')],
)
write(
  'image.cdx.json',
  'lumovi-server',
  packagesOf('renderer/packages.json', 'server/packages.json', 'agent/packages.json'),
)
