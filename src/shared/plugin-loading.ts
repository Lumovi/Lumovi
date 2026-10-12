/**
 * Which plugins are in use, of all there are, and why the others aren't: decided here, once,
 * for everything that asks.
 *
 * The order, which is the whole rule:
 *
 * 1. The plugins that came inside Lumovi are in use.
 * 2. A file from a folder (a person's own, or a server's) is a plugin like any other. With the
 *    name of one of Lumovi's it's in that plugin's place, all of it; under any other name, what
 *    one of Lumovi's shows stays Lumovi's.
 * 3. Of two files with one name, the first by file name is the name's; the second isn't used,
 *    whatever becomes of the first. (A folder with two files of one name is its owner's to tidy.)
 * 4. A kind is one plugin's. The files with the name of one of Lumovi's are settled first, among
 *    themselves and against Lumovi's others: one that shows a kind another has isn't used (the
 *    later by file name, of two files), and Lumovi's own stays in its place. Then the others,
 *    each by file name and each once, against what's in use by then. Either way a reason names
 *    a plugin that's in use, and a kind it has.
 *
 * A file is used whole or not at all, and every file handed in comes back exactly once, with
 * its state and every reason: nothing is dropped unsaid. The answer doesn't depend on the order
 * the files are handed in.
 */
import { clashes, parsePlugin, plain, type ParseOptions, type Plugin } from './plugins'

/**
 * Where a plugin came from, which is what it's trusted by: worked out here from where its file
 * was, never from anything a file says.
 *
 * - `lumovi`: inside the build.
 * - `yours`: the person's own folder, on their computer.
 * - `server`: the folder a server's administrator fills.
 * - `installed`: from the store. A place that's known and not yet filled: nothing is accepted
 *   from it.
 */
export type Origin = 'lumovi' | 'yours' | 'server' | 'installed'

/**
 * Whether a plugin from there may carry code of its own. Only what came inside Lumovi may: a
 * folder's files, a person's or a server's, are data, whatever they say. (The store answers for
 * itself when there is one.)
 */
export function mayCarryCode(origin: Origin): boolean {
  return origin === 'lumovi'
}

/** A file of a folder, as it was read: its text, or why it couldn't be. */
export interface PluginFile {
  name: string
  text: string
  error?: string
}

/**
 * What became of a file. Whoever asks what a plugin may do asks with this, and so with its
 * origin: a plugin by itself doesn't say where it came from.
 */
export interface Loaded {
  file: string
  origin: Exclude<Origin, 'lumovi'>
  /** The plugin it holds, where it could be read whole. */
  plugin?: Plugin
  /**
   * `in-use`; `in-place-of` one of Lumovi's (`lumovis`), by its name; or `not-in-use`, with
   * every reason in `problems`.
   */
  state: 'in-use' | 'in-place-of' | 'not-in-use'
  /** Why it isn't in use: each a line, the file's name first, safe to show. */
  problems: string[]
  /**
   * The one of Lumovi's it's in the place of; or, for a file that isn't in use and has that
   * plugin's name, the one that's shown instead of it.
   */
  lumovis?: Plugin
  /** It's fine by itself, and not in use beside another. */
  beside?: true
}

export interface Settled {
  /** One for each file, in the order of their names. */
  files: Loaded[]
  /** Lumovi's that are in use: all of them but the ones a file is in the place of. */
  lumovis: Plugin[]
}

/** Settles what's in use: `included` are Lumovi's own, already read; `files` are a folder's. */
export function settle(
  included: Plugin[],
  files: PluginFile[],
  origin: Exclude<Origin, 'lumovi' | 'installed'>,
  options: ParseOptions = {},
): Settled {
  const byName = new Map(included.map((plugin) => [plugin.name, plugin]))
  // (By the files' names, whatever order they came in: "the first" is the same one every time.)
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const loaded = sorted.map((file): Loaded => {
    const refused = (problems: string[], name?: string): Loaded => ({
      file: file.name,
      origin,
      state: 'not-in-use',
      problems: problems.map(plain),
      // One that would have been in the place of one of Lumovi's leaves it in use.
      ...(name !== undefined && byName.has(name) ? { lumovis: byName.get(name) } : {}),
    })
    if (file.error) return refused([`${file.name}: ${file.error}`])
    try {
      // (Whether it may carry code is its origin's to say, whatever a caller passed.)
      const read = parsePlugin(file.text, file.name, {
        ...options,
        carriesCode: mayCarryCode(origin),
      })
      return read.plugin
        ? { file: file.name, origin, plugin: read.plugin, state: 'in-use', problems: [] }
        : refused(read.problems, read.name)
    } catch (error) {
      // Whatever a file holds, it's that file's problem and never the others'.
      return refused([`${file.name}: It couldn’t be read: ${(error as Error).message}`])
    }
  })
  // A name is one plugin's: of two files with one name, the first is the name's and the second
  // is out, whatever becomes of the first.
  const named = new Map<string, Loaded>()
  for (const entry of loaded) {
    if (!entry.plugin) continue
    const first = named.get(entry.plugin.name)
    if (first === undefined) named.set(entry.plugin.name, entry)
    else {
      entry.state = 'not-in-use'
      entry.beside = true
      entry.problems.push(plain(`${entry.file}: ${entry.plugin.name} is ${first.file}’s name too`))
    }
  }
  // And a kind is one plugin's. First the files with the name of one of Lumovi's, among
  // themselves: their places exist whether or not they're used, so which of Lumovi's are held
  // depends on which of these stand. They start in their places, all of them; whatever clashes
  // is taken out, one at a time (and Lumovi's of its name is held again), until nothing does.
  const candidates = [...named.values()]
  const places = candidates.filter((entry) => byName.has(entry.plugin!.name))
  const heldBeside = (entries: Loaded[]) =>
    included.filter(({ name }) => !entries.some((entry) => entry.plugin!.name === name))
  const losers = (entries: Loaded[]) => {
    const lost = clashes(
      entries.map((entry) => entry.plugin!),
      heldBeside(entries),
    )
    return entries.filter((entry) => lost.has(entry.plugin!))
  }
  let taken = places
  for (let out = losers(taken); out.length > 0; out = losers(taken)) {
    const last = out[out.length - 1]
    taken = taken.filter((entry) => entry !== last)
  }
  // Taking one out can free what another lost to: each that's out is tried again against what
  // stands, until none comes back. What stays out is then out against what's in use at the
  // end, which is what its reason is read from: it names a plugin that's in use, and a kind
  // that plugin has.
  const reason = (entry: Loaded, beside: Loaded[]) =>
    clashes(
      [...beside.map((other) => other.plugin!), entry.plugin!],
      heldBeside([...beside, entry]),
    ).get(entry.plugin!)
  for (let back = true; back;) {
    back = false
    for (const entry of places) {
      if (!taken.includes(entry) && reason(entry, taken) === undefined) {
        taken = [...taken, entry]
        back = true
      }
    }
  }
  const held = heldBeside(taken)
  for (const entry of places) {
    entry.lumovis = byName.get(entry.plugin!.name)
    if (taken.includes(entry)) entry.state = 'in-place-of'
    else {
      entry.state = 'not-in-use'
      entry.beside = true
      entry.problems.push(plain(`${entry.file}: ${reason(entry, taken)}`))
    }
  }
  // Then the others, each once and by file name, against what's in use by then: what's taken
  // stays, and nothing of Lumovi's comes or goes for them.
  for (const entry of candidates.filter((other) => !byName.has(other.plugin!.name))) {
    const lost = clashes([...taken.map((other) => other.plugin!), entry.plugin!], held).get(
      entry.plugin!,
    )
    if (lost === undefined) taken = [...taken, entry]
    else {
      entry.state = 'not-in-use'
      entry.beside = true
      entry.problems.push(plain(`${entry.file}: ${lost}`))
    }
  }
  // (A file that isn't in use and has the name of one of Lumovi's: that one is shown instead
  // of it only if no other file is in its place.)
  for (const entry of loaded) {
    if (entry.state === 'not-in-use' && entry.lumovis && !held.includes(entry.lumovis)) {
      delete entry.lumovis
    }
  }
  return { files: loaded, lumovis: held }
}
