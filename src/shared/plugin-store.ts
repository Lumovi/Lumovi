/**
 * What's newer in Lumovi-plugins, as the Plugins page says it (the desktop app's alone): the
 * latest release, checked in the main process (src/main/plugin-store.ts) before anything of it is
 * shown, and only when the page opens or Check now is pressed. And what was installed from it
 * (src/main/plugins-installed.ts).
 */
import type { ManagedSettings } from './api'
import { asks } from './plugin-asks'
import type { Plugin } from './plugins'

/**
 * Each field of a plugin, by whether it's part of what a person agrees to: `asked`, or
 * `not-asked` (who it is, and what it needs: nothing it may do). Every field of `Plugin` is said
 * here, and TypeScript holds it: a field added to a plugin's file fails the build until it's said,
 * so it's never agreed to unseen. (A key this Lumovi doesn't know is refused as a file's read.)
 */
export const PLUGIN_FIELDS = {
  name: 'not-asked',
  version: 'not-asked',
  needs: 'not-asked',
  source: 'not-asked',
  groups: 'asked',
  shows: 'asked',
  place: 'asked',
  views: 'asked',
  reads: 'asked',
  showsSecrets: 'asked',
  changes: 'asked',
  added: 'asked',
  opens: 'asked',
  links: 'asked',
  logs: 'asked',
  server: 'asked',
} as const satisfies Record<keyof Plugin, 'asked' | 'not-asked'>

/**
 * Of what's asked, what `asks()` reads and says in its own terms (a place's kinds, but not its
 * label or icon; a view's kinds, actions, links and lists, but not its columns).
 */
const READ_BY_ASKS = [
  'groups',
  'shows',
  'place',
  'views',
  'reads',
  'showsSecrets',
  'changes',
] as const satisfies readonly (keyof Plugin)[]

/** The rest of what's asked: agreed to as it is, and each compared in the store's dialog. */
export type AskedField = Exclude<
  {
    [K in keyof typeof PLUGIN_FIELDS]: (typeof PLUGIN_FIELDS)[K] extends 'asked' ? K : never
  }[keyof typeof PLUGIN_FIELDS],
  (typeof READ_BY_ASKS)[number]
>
const ASKED = (Object.keys(PLUGIN_FIELDS) as (keyof typeof PLUGIN_FIELDS)[]).filter(
  (field): field is AskedField =>
    PLUGIN_FIELDS[field] === 'asked' && !(READ_BY_ASKS as readonly string[]).includes(field),
)

/**
 * What a plugin asks, as one text to agree to and compare: what its file asks (`asks`), what it
 * adds to Lumovi's pages, which of Lumovi's lists and places its pages open, and whether code
 * comes with it. Two that ask the same are the same text, whatever Lumovi's words for them are.
 */
export const asksOf = (plugin: Plugin, code: boolean): string =>
  JSON.stringify({
    asks: asks(plugin),
    ...Object.fromEntries(ASKED.map((field) => [field, plugin[field]])),
    code,
  })

/**
 * A plugin's fields this Lumovi can't say what they ask (none of `PLUGIN_FIELDS`): where it has
 * any, nothing installs it or goes back to it, rather than letting what they ask pass unasked.
 */
export const unsaid = (plugin: Plugin): string[] =>
  Object.keys(plugin).filter((field) => !Object.hasOwn(PLUGIN_FIELDS, field))

/** A plugin of the release: what its index says, and its file, to say what it asks. */
export interface StorePlugin {
  name: string
  version: string
  /** The oldest Lumovi it works with. */
  lumovi?: string
  /** Its file (plugin.yaml), checked against the release's signed index. */
  file: string
  /** Whether code comes with it. */
  code: boolean
}

/** A release that passed every check. */
export interface StoreRelease {
  /** Its version, as its tag names it: "1.3.0". */
  version: string
  serial: number
  /** When it was checked here (milliseconds since 1970). */
  checked: number
  plugins: StorePlugin[]
}

/** Why the latest release couldn't be checked, by the check it failed. */
export type StoreFailure =
  /** GitHub couldn't be asked, or didn't answer as it does: in the network's words. */
  | { check: 'network'; words: string }
  /** Not signed by Lumovi-plugins' release workflow. */
  | { check: 'signed' }
  /** Not shown to have been built from its tag's commit. */
  | { check: 'built' }
  /** A file isn't the one the release names. */
  | { check: 'files' }
  /** Past the date its index says it stops being taken (ISO 8601). */
  | { check: 'expired'; on: string }
  /** Older than one this Lumovi has already taken, or was built with. */
  | { check: 'older' }

export type StoreCheck =
  /** Turned off by the organization's policy: nothing is asked of GitHub. */
  | { state: 'off' }
  | { state: 'checked'; release: StoreRelease }
  /** It failed: `last` is what the last good check found, which the page goes on with. */
  | { state: 'failed'; failure: StoreFailure; at: number; last?: StoreRelease }

/**
 * Whether the organization's policy lets a plugin be there (`pluginsAllowed`): every one where it
 * names none; else one it names, by its name (`argo-cd`, any version) or by its name and version
 * (`argo-cd@1.2.0`, only that one). Without a version, whether it names that plugin at all.
 */
export function allowedBy(
  list: readonly string[] | undefined,
  name: string,
  version?: string,
): boolean {
  if (!list) return true
  return list.some((entry) => {
    const at = entry.indexOf('@')
    if (at < 0) return entry === name
    return entry.slice(0, at) === name && (version === undefined || entry.slice(at + 1) === version)
  })
}

/** A copy of a plugin installed from the store, as it was agreed to. */
export interface InstalledCopy {
  version: string
  /** The release of Lumovi-plugins it came from. */
  release: string
  /** Each of its files' SHA-256 (hex), by its path in the plugin: plugin.yaml, plugin.js. */
  files: Record<string, string>
  /** The SHA-256 (hex) of what it asks, as the person was shown it and agreed (`asksOf`). */
  asks: string
  /** When it was installed (ISO 8601). */
  at: string
}

/** A plugin installed from the store: the copy in use, and the one before, kept. */
export interface InstalledRecord {
  current: InstalledCopy
  kept?: InstalledCopy
}

/** An installed plugin as the page is told of it. */
export interface InstalledPlugin {
  name: string
  version: string
  release: string
  /** The copy kept, to go back to, where it's still the one agreed to: its file and release. */
  kept?: { version: string; release: string; file: string; code: boolean }
  /** Its file's text, checked against what was agreed. */
  file: string
  code: boolean
}

/** Why an installed copy isn't used, and Lumovi's own (or none) is in its place. */
export interface InstalledNotUsed {
  name: string
  version: string
  /**
   * `files`: its files aren't the ones agreed to; `lumovi`: it needs a newer Lumovi (`needs`);
   * `policy`: the organization's policy doesn't allow it.
   */
  why: 'files' | 'lumovi' | 'policy'
  needs?: string
}

/** The installed plugins, as the page and the backend take them. */
export interface Installed {
  plugins: InstalledPlugin[]
  notUsed: InstalledNotUsed[]
}

/** "Oct 1", or "Oct 1, 2027" in another year. */
const dateOf = (iso: string) => {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** Why it couldn't check, as the toolbar says it: which check failed. */
export function failedLine(failure: StoreFailure): string {
  const why =
    failure.check === 'network'
      ? failure.words
      : failure.check === 'signed'
        ? 'the release isn’t signed by Lumovi-plugins’ release workflow, so Lumovi took nothing from it'
        : failure.check === 'built'
          ? 'the release doesn’t show it was built from its tag’s commit, so Lumovi took nothing from it'
          : failure.check === 'files'
            ? 'a file isn’t the one the release names, so Lumovi took nothing from it'
            : failure.check === 'expired'
              ? `this release expired on ${dateOf(failure.on)}, and Lumovi takes none past that`
              : 'this release is older than one Lumovi has already taken, so Lumovi took nothing from it'
  return `Couldn’t check for newer plugins: ${why}.`
}

/**
 * Why the organization's policy doesn't let `plugin` (at its version, with code or not) be
 * installed: the first thing it doesn't allow, in its words, with the key that says so. Nothing
 * where it allows it.
 */
export function policyRefusal(
  managed: ManagedSettings | undefined,
  plugin: Plugin,
  code: boolean,
): { line: string; key: string } | undefined {
  if (!managed) return undefined
  const asked = asks(plugin)
  if (managed.pluginsOff || managed.pluginsBundledOnly) {
    return {
      line: 'Your organization’s policy allows only the plugins that come with Lumovi.',
      key: managed.pluginsOff ? 'plugins: off' : 'plugins: bundled',
    }
  }
  if (!allowedBy(managed.pluginsAllowed, plugin.name, plugin.version)) {
    return { line: 'Your organization’s policy doesn’t allow this version.', key: 'pluginsAllowed' }
  }
  if (managed.pluginProposalsOff && asked.changes.length > 0) {
    return {
      line: 'Your organization’s policy doesn’t let plugins propose changes, and this one would.',
      key: 'pluginProposals: off',
    }
  }
  if (managed.pluginSecretsOff && asked.secrets.length > 0) {
    return {
      line: 'Your organization’s policy doesn’t let plugins show what’s in Secrets, and this one would.',
      key: 'pluginSecrets: off',
    }
  }
  if (managed.pluginLogsOff && plugin.logs !== undefined) {
    return {
      line: 'Your organization’s policy doesn’t let plugins show or read containers’ logs, and this one would.',
      key: 'pluginLogs: off',
    }
  }
  if (managed.pluginServersOff && plugin.server !== undefined) {
    return {
      line: 'Your organization’s policy doesn’t let plugins talk to servers in the cluster, and this one would.',
      key: 'pluginServers: off',
    }
  }
  if (managed.pluginCodeOff && code) {
    return {
      line: 'Your organization’s policy doesn’t let plugins run code, and this one has code.',
      key: 'plugins: no-code',
    }
  }
  return undefined
}
