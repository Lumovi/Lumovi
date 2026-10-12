/**
 * The plugins this Lumovi has, for the backend's own questions (who a plugin is, in the audit
 * history; what a session may be handed): Lumovi's own, built into it here as they're built
 * into the page, and the folder's files, read as they're read for the page. See
 * `@shared/plugins-known`.
 */
import type { Host } from '@shared/api'
import { knownPlugins, readIncluded, type KnownPlugin } from '@shared/plugins-known'
// The plugins Lumovi comes with, from the release its lock pins, as the build checked them: the
// same files the page's bundle has, built into this one, and the code beside them, named as each
// plugin's file is.
import SHIPPED from 'virtual:lumovi-plugins'
import SHIPPED_CODE from 'virtual:lumovi-plugins/code'
import { digestOf, filesMark, readFiles } from './plugins'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

// Its own views of Kubernetes' kinds.
const OWN = import.meta.glob<string>('../renderer/src/views/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const utf8 = new TextEncoder()

/**
 * The answer to the last ask, and what it was made from: the folders' files as they were marked
 * before they were read (`filesMark`), and what was read of them.
 */
let last: { mark: string; from: string; known: readonly Readonly<KnownPlugin>[] } | undefined

/**
 * The plugins in use here, by the backend's own reading, now. The folders' files are looked at
 * each time (`filesMark`: names, sizes and times, nothing read), and read again, digested and
 * checked only when that changed: a file that changed has its new digest and never an old one,
 * and a page that reads ten times a second costs a look at each file. (Marked before it's read:
 * a file that changes while it's read is marked as it was, and read again next time.) `host`: a
 * person's folder on the desktop, a server's on a server. `lumovi`: this Lumovi's version.
 */
export async function plugins(
  directory: { path: string; shown: string },
  host: Host,
  lumovi: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly Readonly<KnownPlugin>[]> {
  const origin = host === 'desktop' ? 'yours' : 'server'
  const mark = JSON.stringify([origin, lumovi, await filesMark(directory, env)])
  if (last?.mark === mark) return last.known
  const read = await readFiles(directory, env)
  const from = JSON.stringify([
    origin,
    lumovi,
    ...[read.files, read.included ?? [], read.includedCode ?? []].map((files) =>
      files.map(({ name, digest, error }) => [name, digest ?? error]),
    ),
  ])
  if (last?.from === from) {
    last = { ...last, mark }
    return last.known
  }
  // (A release build has none of this: Lumovi's own are the ones built into it. The tests'
  // stand-ins are taken exactly as the page takes them.)
  const standIns =
    LUMOVI_TEST_BUILD && read.included
      ? Object.fromEntries(read.included.map((file) => [file.name, file.text]))
      : {}
  const included = readIncluded({ ...SHIPPED, ...standIns }, OWN)
  // Their code, by its file's name; the tests' stand-ins' beside theirs.
  const codes = Object.fromEntries([
    ...Object.entries(SHIPPED_CODE),
    ...(LUMOVI_TEST_BUILD && read.includedCode
      ? read.includedCode.filter((file) => !file.error).map((file) => [file.name, file.text])
      : []),
  ])
  // One of Lumovi's own: the bytes of its file are its text as UTF-8, which the release's index
  // pins and the build checked (a test holds it of every one of them, and of their code).
  const known = knownPlugins(
    included,
    read.files,
    origin,
    lumovi,
    (text) => digestOf(utf8.encode(text)),
    codes,
  )
  last = { mark, from, known }
  return known
}
