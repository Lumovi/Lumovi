/**
 * Fetches the CRDs of the operators KubeStacks ships views for, at the
 * versions in tests/views/crds/sources.json, and keeps what the views check
 * (tests/views) needs of them: their kinds, versions and the shape of their
 * schemas, without descriptions or validations.
 *
 *   npm run crds                 all of them
 *   npm run crds -- flux keda    only these
 *
 * To check views against a newer release, change its version in
 * sources.json, run this, and run `npm run views:check`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const DIR = resolve('tests/views/crds')

/**
 * A manifest with CRDs: its URL, or with a release of its own; `helm` when
 * it's a chart's template, whose templating is left out. Or one version of
 * one kind's schema, for tools whose operators create their CRDs themselves
 * (the URL of its JSON Schema, from a catalog of them).
 */
type File =
  | string
  | { url: string; version?: string; helm?: true }
  | { schema: string; group: string; kind: string; apiVersion: string }
type Sources = Record<string, { version: string; files: File[] }>

/** What a schema says about the shape of a value, and nothing else. */
export interface Shape {
  properties?: Record<string, Shape>
  items?: Shape
  additionalProperties?: Shape
  /** Anything goes below here (x-kubernetes-preserve-unknown-fields, int-or-string). */
  any?: true
}

export interface Crd {
  group: string
  kind: string
  plural: string
  namespaced: boolean
  versions: { name: string; served: boolean; schema: Shape }[]
}

type Schema = Record<string, unknown>

/**
 * How deep shapes go: views read a handful of levels in, and below this
 * anything goes (it's where embedded pod specs make schemas huge).
 */
const DEPTH = 6

function shape(schema: Schema | undefined, depth = 0): Shape {
  if (!schema || depth === DEPTH) return { any: true }
  const result: Shape = {}
  if (
    schema['x-kubernetes-preserve-unknown-fields'] ||
    schema['x-kubernetes-int-or-string'] ||
    (!schema.type && !schema.properties && !schema.items)
  ) {
    result.any = true
  }
  // Variants (anyOf, oneOf, allOf) only add to what the properties allow.
  const variants = ['anyOf', 'oneOf', 'allOf'].flatMap((key) => (schema[key] ?? []) as Schema[])
  const properties = Object.assign(
    {},
    ...variants.map((variant) => variant.properties ?? {}),
    schema.properties ?? {},
  ) as Record<string, Schema>
  if (Object.keys(properties).length > 0) {
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, shape(value, depth + 1)]),
    )
  }
  if (schema.items) result.items = shape(schema.items as Schema, depth + 1)
  const additional = schema.additionalProperties
  if (additional) {
    result.additionalProperties =
      additional === true ? { any: true } : shape(additional as Schema, depth + 1)
  }
  return result
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

/** A chart's template as plain YAML: its templating left out, and what it fills in made up. */
function untemplated(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\{\{.*\}\}\s*$/.test(line))
    .join('\n')
    .replace(/\{\{.*?\}\}/g, 'x')
}

type Fetched = { url: string; helm?: true } | Extract<File, { schema: string }>

async function crdsOf(files: Fetched[]): Promise<Crd[]> {
  const crds: Crd[] = []
  for (const file of files) {
    if ('schema' in file) {
      const schema = JSON.parse(await fetchText(file.schema)) as Schema
      let crd = crds.find((c) => c.group === file.group && c.kind === file.kind)
      if (!crd) {
        // A schema says nothing about the plural or the scope, which the check doesn't need.
        crd = { group: file.group, kind: file.kind, plural: '', namespaced: true, versions: [] }
        crds.push(crd)
      }
      crd.versions.push({ name: file.apiVersion, served: true, schema: shape(schema) })
      continue
    }
    const text = await fetchText(file.url)
    for (const document of parseAllDocuments(file.helm ? untemplated(text) : text)) {
      const doc = document.toJS() as Schema | null
      if (doc?.kind !== 'CustomResourceDefinition') continue
      const spec = doc.spec as {
        group: string
        names: { kind: string; plural: string }
        scope: string
        versions: { name: string; served: boolean; schema?: { openAPIV3Schema?: Schema } }[]
      }
      crds.push({
        group: spec.group,
        kind: spec.names.kind,
        plural: spec.names.plural,
        namespaced: spec.scope === 'Namespaced',
        versions: spec.versions.map((version) => ({
          name: version.name,
          served: version.served,
          schema: shape(version.schema?.openAPIV3Schema),
        })),
      })
    }
  }
  return crds.sort((a, b) => `${a.group}/${a.kind}`.localeCompare(`${b.group}/${b.kind}`))
}

if (import.meta.main) {
  const sources = JSON.parse(readFileSync(join(DIR, 'sources.json'), 'utf8')) as Sources
  const names = process.argv.slice(2)
  const unknown = names.filter((name) => !(name in sources))
  if (unknown.length) throw new Error(`No CRD sources for ${unknown.join(', ')}`)
  for (const [name, { version, files }] of Object.entries(sources)) {
    if (names.length && !names.includes(name)) continue
    const at = (url: string, release = version) =>
      url.replaceAll('{version}', release).replaceAll('{number}', release.replace(/^v/, ''))
    const fetched = files.map((file): Fetched => {
      if (typeof file === 'string') return { url: at(file) }
      if ('schema' in file) return { ...file, schema: at(file.schema) }
      return { url: at(file.url, file.version), ...(file.helm ? { helm: true as const } : {}) }
    })
    const crds = await crdsOf(fetched)
    if (crds.length === 0) throw new Error(`${name}: no CRDs found`)
    // One CRD a line, so a new release's diff shows which kinds changed.
    const lines = crds.map((crd) => JSON.stringify(crd))
    writeFileSync(
      join(DIR, `${name}.json`),
      `{"version":${JSON.stringify(version)},"crds":[\n${lines.join(',\n')}\n]}\n`,
    )
    console.log(`${name} ${version}: ${crds.map((crd) => crd.kind).join(', ')}`)
  }
}
