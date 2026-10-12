/**
 * The plugins this Lumovi has, for the backend's own questions (who a plugin is, in the audit
 * history; what a session may be handed): Lumovi's own, built into it here as they're built
 * into the page, and the folder's files, read as they're read for the page. See
 * `@shared/plugins-known`.
 */
import type { Host } from '@shared/api'
import { knownPlugins, readIncluded, type KnownPlugin } from '@shared/plugins-known'
import { digestOf, readFiles } from './plugins'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

// The plugins Lumovi comes with, and its own views of Kubernetes' kinds: the same files the
// page's bundle has, built into this one.
const SHIPPED = import.meta.glob<string>('../../plugins/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const OWN = import.meta.glob<string>('../renderer/src/views/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const utf8 = new TextEncoder()

/** The answer to the last ask, and what it was made from: checked again only when that changes. */
let last: { from: string; known: readonly Readonly<KnownPlugin>[] } | undefined

/**
 * The plugins in use here, by the backend's own reading, now: the folder is read again each
 * time, so a file that changed has its new digest and never an old one. (Read and digested each
 * time; checked again only when a digest has changed: the answer is the same and the work is
 * one hash a file.) `host`: a person's folder on the desktop, a server's on a server. `lumovi`:
 * this Lumovi's version.
 */
export async function plugins(
  directory: { path: string; shown: string },
  host: Host,
  lumovi: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly Readonly<KnownPlugin>[]> {
  const read = await readFiles(directory, env)
  const origin = host === 'desktop' ? 'yours' : 'server'
  const from = JSON.stringify([
    origin,
    lumovi,
    ...[read.files, read.included ?? []].map((files) =>
      files.map(({ name, digest, error }) => [name, digest ?? error]),
    ),
  ])
  if (last?.from === from) return last.known
  // (A release build has none of this: Lumovi's own are the ones built into it. The tests'
  // stand-ins are taken exactly as the page takes them.)
  const standIns =
    LUMOVI_TEST_BUILD && read.included
      ? Object.fromEntries(read.included.map((file) => [file.name, file.text]))
      : {}
  const included = readIncluded({ ...SHIPPED, ...standIns }, OWN)
  // One of Lumovi's own: the bytes of its file are its text as UTF-8 (a test holds that of every
  // one of them, so what a build carries is what `shasum` gives for the file in the repository).
  const known = knownPlugins(included, read.files, origin, lumovi, (text) =>
    digestOf(utf8.encode(text)),
  )
  last = { from, known }
  return known
}
