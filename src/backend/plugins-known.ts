/**
 * The plugins this Lumovi has, for the backend's own questions (who a plugin is, in the audit
 * history; what a session may be handed): Lumovi's own, built into it here as they're built
 * into the page, and the folder's files, read as they're read for the page. See
 * `@shared/plugins-known`.
 */
import type { Host } from '@shared/api'
import { allowedBy } from '@shared/plugin-store'
import { knownPlugins, readIncluded, type KnownPlugin } from '@shared/plugins-known'
// The plugins Lumovi comes with, from the release its lock pins, as the build checked them: the
// same files the page's bundle has, built into this one, and the code beside them, named as each
// plugin's file is.
import SHIPPED from 'virtual:lumovi-plugins'
import SHIPPED_CODE from 'virtual:lumovi-plugins/code'
import { digestOf, filesMark, readFiles, type OwnReading } from './plugins'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

/**
 * Which plugins may be there at all, as the organization's policy says (the desktop app's): none;
 * Lumovi's own only (a person's folder isn't read); these by name only. Nothing said: all.
 */
export interface PluginsAllowed {
  off?: boolean
  bundledOnly?: boolean
  names?: readonly string[]
}

/** What the policy's managed settings say of which plugins may be there. */
export const pluginsAllowedBy = (
  managed: { pluginsOff?: true; pluginsBundledOnly?: true; pluginsAllowed?: string[] } | undefined,
): PluginsAllowed => ({
  ...(managed?.pluginsOff ? { off: true } : {}),
  ...(managed?.pluginsBundledOnly ? { bundledOnly: true } : {}),
  ...(managed?.pluginsAllowed ? { names: managed.pluginsAllowed } : {}),
})

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
 * Plugins installed from Lumovi-plugins (the desktop app's), each checked against what was
 * agreed as it's read: their files by name ("argo-cd.yaml"), and their code ("argo-cd.js").
 */
export interface InstalledFiles {
  files: Readonly<Record<string, string>>
  codes: Readonly<Record<string, string>>
}

/**
 * The plugins in use here, by the backend's own reading, now. The folders' files are looked at
 * each time (`filesMark`: names, sizes and times, nothing read), and read again, digested and
 * checked only when that changed: a file that changed has its new digest and never an old one,
 * and a page that reads ten times a second costs a look at each file. (Marked before it's read:
 * a file that changes while it's read is marked as it was, and read again next time.) `host`: a
 * person's folder on the desktop, a server's on a server. `lumovi`: this Lumovi's version.
 * `allowed`: which may be there at all, as the organization's policy says.
 */
export async function plugins(
  directory: { path: string; shown: string },
  host: Host,
  lumovi: string,
  env: NodeJS.ProcessEnv = process.env,
  allowed: PluginsAllowed = {},
  /** Those installed from the store, in place of Lumovi's own of their names. */
  installed?: () => Promise<InstalledFiles>,
  /**
   * The desktop app's: whether Developer mode is on, now. A person's own plugins in folders of
   * their own are read (the desktop's alone), and their code only while it's on.
   */
  developer?: () => boolean,
): Promise<readonly Readonly<KnownPlugin>[]> {
  // (None at all: not one of Lumovi's own, nor of a folder's.)
  if (allowed.off) return Object.freeze([])
  const origin = host === 'desktop' ? 'yours' : 'server'
  // (Lumovi's own only: none installed is used either.)
  const fromStore = installed && !allowed.bundledOnly ? await installed() : undefined
  const reading: OwnReading =
    host === 'desktop' ? { folders: true, code: developer?.() === true } : {}
  const mark = JSON.stringify([
    origin,
    lumovi,
    allowed,
    fromStore,
    reading,
    await filesMark(directory, env, reading),
  ])
  if (last?.mark === mark) return last.known
  const read = await readFiles(directory, env, reading)
  // (Lumovi's own only: a person's folder isn't read as plugins.)
  if (allowed.bundledOnly) {
    read.files = []
    delete read.code
  }
  const from = JSON.stringify([
    origin,
    lumovi,
    allowed,
    fromStore,
    reading,
    ...[read.files, read.code ?? [], read.included ?? [], read.includedCode ?? []].map((files) =>
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
  // (An installed one is in place of Lumovi's own of its name, its code too: or of none.)
  const installedNames = new Set(
    Object.keys(fromStore?.files ?? {}).map((file) => file.replace(/\.yaml$/, '')),
  )
  const included = readIncluded({ ...SHIPPED, ...standIns, ...fromStore?.files }, OWN)
  // Their code, by its file's name; the tests' stand-ins' beside theirs.
  const codes = Object.fromEntries([
    ...Object.entries(SHIPPED_CODE).filter(
      ([file]) => !installedNames.has(file.replace(/\.js$/, '')),
    ),
    ...(LUMOVI_TEST_BUILD && read.includedCode
      ? read.includedCode.filter((file) => !file.error).map((file) => [file.name, file.text])
      : []),
    ...Object.entries(fromStore?.codes ?? {}),
    // A person's own, in their plugins' folders (`toys/plugin.js`): read in Developer mode alone.
    ...(read.code ?? []).filter((file) => !file.error).map((file) => [file.name, file.text]),
  ])
  // One of Lumovi's own: the bytes of its file are its text as UTF-8, which the release's index
  // pins and the build checked (a test holds it of every one of them, and of their code).
  const all = knownPlugins(
    included,
    read.files,
    origin,
    lumovi,
    (text) => digestOf(utf8.encode(text)),
    codes,
    installedNames,
  )
  // (Only those the policy names: any other isn't there.)
  const known = allowed.names
    ? Object.freeze(all.filter((plugin) => allowedBy(allowed.names, plugin.name, plugin.version)))
    : all
  last = { mark, from, known }
  return known
}
