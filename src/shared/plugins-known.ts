/**
 * The plugins Lumovi has, as the backend knows them: for each one in use its name, its version,
 * where it came from and its digest. What asks who a plugin is (the audit history, what a
 * session may be handed) asks this, in the main process and on a server alike: never the page.
 *
 * It's made the same way as what the page shows, from the same things: Lumovi's own plugins as
 * they're built in, a folder's files as they're read, the same checker and the same `settle`.
 * So the two can't differ in how they judge a file. They can differ in WHEN they read it: the
 * page settles at its last refresh and keeps that; this reads now. A file edited since the
 * page's refresh is still the old text to the page, and has its new digest here. Whatever writes
 * a digest beside something a page did has to say which reading it names.
 */
import { clashes, ownKinds, parsePlugin, type Plugin } from './plugins'
import { settle, type Origin, type PluginFile } from './plugin-loading'
import type { Grant } from './plugin-reads'
import type { ResourceKind } from './resources'

/** A file's name without its folders. */
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Lumovi's own plugins, read: each with the file it's from, and anything wrong with them. */
export interface Included {
  plugins: { plugin: Plugin; file: string; text: string }[]
  /** The kinds of Kubernetes' own that Lumovi's own views show: no plugin's to show. */
  ownKinds: ResourceKind[]
  /** There should be nothing. */
  problems: string[]
}

/**
 * Reads the plugins Lumovi comes with (`files`, by path, each a file's text) and its own views
 * of Kubernetes' kinds (`own`, written as a plugin's file is and no plugin of anyone's). The
 * same reading the page does of them, with nothing kept between calls: the own views first, for
 * the kinds no plugin may show; then each plugin; and a kind is one plugin's, among Lumovi's as
 * among anyone's.
 */
export function readIncluded(
  files: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string>> = {},
): Included {
  const problems: string[] = []
  const ownKinds: ResourceKind[] = []
  for (const [path, text] of Object.entries(own)) {
    const parsed = parsePlugin(text, fileName(path), { ownViews: true })
    for (const view of parsed.plugin?.views ?? []) ownKinds.push(...view.kinds)
    problems.push(...parsed.problems)
  }
  const read: Included['plugins'] = []
  for (const [path, text] of Object.entries(files)) {
    // (Lumovi's own may carry code, as the page reads them: `mayCarryCode('lumovi')`.)
    const parsed = parsePlugin(text, fileName(path), { lumovisOwn: ownKinds, carriesCode: true })
    if (parsed.plugin) read.push({ plugin: parsed.plugin, file: fileName(path), text })
    problems.push(...parsed.problems)
  }
  const lost = clashes(read.map(({ plugin }) => plugin))
  for (const { plugin } of read) {
    if (lost.has(plugin)) problems.push(`${plugin.source}: ${lost.get(plugin)}`)
  }
  return { plugins: read.filter(({ plugin }) => !lost.has(plugin)), ownKinds, problems }
}

/** A plugin Lumovi has in use, as the backend knows it. */
export interface KnownPlugin {
  name: string
  version: string
  /** Where it came from, which is what it's trusted by: where its file was, never what it says. */
  origin: Origin
  /** The file it's from: one built into Lumovi, or one of a folder's. */
  file: string
  /**
   * `sha256:` and the hex, of everything Lumovi took for this plugin: today its file's bytes, as
   * they were when the text that was checked was read from them (what `shasum -a 256` gives for
   * the file). It's the backend's own reading, made when it was asked: never anything a page
   * sent.
   */
  digest: string
  /**
   * What its code may read, from its file: its groups, and the kinds it claims, read whole. (Of
   * Kubernetes' own kinds, the fields its file names: none until `spec.reads` is read.)
   */
  grant: Grant
}

/** What a plugin's code may read, by its file. */
function grantOf(plugin: Plugin): Grant {
  return Object.freeze({
    groups: Object.freeze([...plugin.groups]),
    own: Object.freeze(ownKinds(plugin)),
    reads: Object.freeze({}),
  })
}

/**
 * The plugins in use: Lumovi's own that no file is in the place of, and a folder's files that
 * are in use (one in the place of one of Lumovi's is that plugin now, from a folder: listed
 * under its name with the folder's origin and its own digest). A file that's refused, or not in
 * use beside another, isn't a plugin Lumovi has. One a name, in the order of their names.
 */
export function knownPlugins(
  included: Included,
  /** A folder's files, each with the digest of the bytes its text was read from. */
  files: (PluginFile & { digest?: string })[],
  origin: Exclude<Origin, 'lumovi' | 'installed'>,
  /** The Lumovi that's reading them. */
  lumovi: string,
  /** The digest of one of Lumovi's own: of its file's bytes, which are its text as UTF-8. */
  digest: (text: string) => string,
): readonly Readonly<KnownPlugin>[] {
  const settled = settle(
    included.plugins.map(({ plugin }) => plugin),
    files,
    origin,
    { lumovi, lumovisOwn: included.ownKinds },
  )
  const own = new Map(included.plugins.map((entry) => [entry.plugin, entry]))
  const digests = new Map(files.map((file) => [file.name, file.digest]))
  // A file in use that came without its digest: never left out quietly (in the place of one of
  // Lumovi's, that name would then be in the list not at all).
  const digestOfFile = (file: string) => {
    const digest = digests.get(file)
    if (!digest) throw new Error(`${file} is in use and was handed over without its digest`)
    return digest
  }
  const known: KnownPlugin[] = [
    ...settled.lumovis.map((plugin) => {
      const { file, text } = own.get(plugin)!
      return {
        name: plugin.name,
        version: plugin.version,
        origin: 'lumovi' as const,
        file,
        digest: digest(text),
        grant: grantOf(plugin),
      }
    }),
    ...settled.files.flatMap(({ file, plugin, state }) =>
      state === 'not-in-use' || !plugin
        ? []
        : [
            {
              name: plugin.name,
              version: plugin.version,
              origin,
              file,
              digest: digestOfFile(file),
              grant: grantOf(plugin),
            },
          ],
    ),
  ]
  // (What's answered can't be changed by whoever asked: the same answer may be given again, to
  // whoever asks next.)
  known.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return Object.freeze(known.map((plugin) => Object.freeze(plugin)))
}
