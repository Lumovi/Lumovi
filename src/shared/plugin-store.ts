/**
 * What's newer in Lumovi-plugins, as the Plugins page says it (the desktop app's alone): the
 * latest release, checked in the main process (src/main/plugin-store.ts) before anything of it is
 * shown, and only when the page opens or Check now is pressed.
 */

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
