/**
 * A person's own settings (LMV-357): how Lumovi looks, how it says times, its terminals, which
 * namespace a cluster opens in. Each applies at once, in every window, and survives a restart:
 * on the desktop in its settings file, on a server for the person, whatever device they sign in
 * from. What an organization's policy sets (the desktop's policy file, a server's
 * LUMOVI_SETTINGS) is what they are, and locked.
 */

/** The accents: each a fill, its label, and a strong shade, per theme (see styles/index.css). */
export const ACCENTS = ['blue', 'cyan', 'violet', 'graphite'] as const
export type Accent = (typeof ACCENTS)[number]

/** Text sizes, as the View menu's Zoom In and Zoom Out step through them, in percent. */
export const TEXT_SIZES = [90, 100, 110, 125] as const

/** The terminal's font sizes, in px. */
export const TERMINAL_FONT_SIZES = { min: 10, max: 24 }

/** How many searches can be saved, and how long one can be. */
export const SAVED_SEARCHES_AT_MOST = 50
export const SAVED_SEARCH_LENGTH = 200

/** Which namespace a cluster opens in. */
export type OpenNamespaces =
  { mode: 'last' } | { mode: 'all' } | { mode: 'named'; namespace: string }

export interface Preferences {
  accent: Accent
  /** Comfortable lists (rows 46 px), or compact ones (36 px). */
  density: 'comfortable' | 'compact'
  /** In percent: the window's zoom on the desktop, the page's on a server. */
  textSize: number
  /** Where times are said: this device's zone, UTC, or an IANA zone ("Europe/Budapest"). */
  timeZone: string
  clock: 'system' | '12' | '24'
  /** The terminal's font family: one of TERMINAL_FONTS, or what the system has by that name. */
  terminalFont: string
  terminalFontSize: number
  /** What's selected in a terminal is copied at once. */
  copyOnSelect: boolean
  /** The desktop's: the program its terminals start; empty, the login shell. */
  shell: string
  namespaces: OpenNamespaces
  /** Saved searches (LMV-171): what was typed into Search, as typed, in the order saved. */
  searches: string[]
}

export const PREFERENCE_DEFAULTS: Preferences = {
  accent: 'blue',
  density: 'comfortable',
  textSize: 100,
  timeZone: 'local',
  clock: 'system',
  terminalFont: 'JetBrains Mono',
  terminalFontSize: 12,
  copyOnSelect: false,
  shell: '',
  namespaces: { mode: 'last' },
  searches: [],
}

/** Fonts offered for the terminal (any other the system has can be typed). */
export const TERMINAL_FONTS = [
  'JetBrains Mono',
  'Menlo',
  'SF Mono',
  'Consolas',
  'Cascadia Mono',
  'Ubuntu Mono',
  'monospace',
]

/** What can be set: these, the theme, and (on the desktop) whether updates are checked for. */
export type PreferenceKey = keyof Preferences | 'theme' | 'autoUpdate'

/** Each section's settings, as its Restore puts them back. */
export const SECTIONS: Record<
  'appearance' | 'time' | 'terminal' | 'namespaces' | 'updates',
  PreferenceKey[]
> = {
  appearance: ['theme', 'accent', 'density', 'textSize'],
  time: ['timeZone', 'clock'],
  terminal: ['terminalFont', 'terminalFontSize', 'copyOnSelect', 'shell'],
  namespaces: ['namespaces'],
  updates: ['autoUpdate'],
}

/** A namespace's name, as Kubernetes has them. */
const NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** Whether a time zone is one this runtime knows ("local" and "UTC" always are). */
export function isTimeZone(zone: string): boolean {
  if (zone === 'local' || zone === 'UTC') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Settings as given (a change, a file, a policy), checked one by one: what isn't a setting, or
 * isn't one of its values, is left out, with why. `null` puts one back to its default.
 */
export function checkedPreferences(value: unknown): {
  preferences: Partial<Record<keyof Preferences, unknown>>
  problems: string[]
} {
  const preferences: Partial<Record<keyof Preferences, unknown>> = {}
  const problems: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { preferences, problems: ['Settings are an object of names and values.'] }
  }
  for (const [key, given] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(PREFERENCE_DEFAULTS, key)) {
      if (key !== 'theme' && key !== 'autoUpdate') problems.push(`${key} isn’t a setting.`)
      continue
    }
    const name = key as keyof Preferences
    if (given === null) {
      preferences[name] = null
      continue
    }
    const ok = {
      accent: () => (ACCENTS as readonly unknown[]).includes(given),
      density: () => given === 'comfortable' || given === 'compact',
      textSize: () => (TEXT_SIZES as readonly unknown[]).includes(given),
      timeZone: () => typeof given === 'string' && given.length <= 64 && isTimeZone(given),
      clock: () => given === 'system' || given === '12' || given === '24',
      terminalFont: () => typeof given === 'string' && /^[\w .-]{1,64}$/.test(given),
      terminalFontSize: () =>
        Number.isInteger(given) &&
        (given as number) >= TERMINAL_FONT_SIZES.min &&
        (given as number) <= TERMINAL_FONT_SIZES.max,
      copyOnSelect: () => typeof given === 'boolean',
      // A full path (whether it's there is checked where it runs: the desktop's main process),
      // or empty for the login shell. A relative one would be the main process's folder's.
      shell: () =>
        typeof given === 'string' &&
        given.length <= 1024 &&
        !/[\0\n]/.test(given) &&
        (given === '' || isFullPath(given)),
      namespaces: () => {
        const n = given as Partial<{ mode: unknown; namespace: unknown }>
        return (
          typeof n === 'object' &&
          (n.mode === 'last' ||
            n.mode === 'all' ||
            (n.mode === 'named' &&
              typeof n.namespace === 'string' &&
              n.namespace.length <= 63 &&
              NAMESPACE.test(n.namespace)))
        )
      },
      searches: () =>
        Array.isArray(given) &&
        given.length <= SAVED_SEARCHES_AT_MOST &&
        new Set(given).size === given.length &&
        given.every(
          (search) =>
            typeof search === 'string' &&
            search.length <= SAVED_SEARCH_LENGTH &&
            /^\S[^\n]*$/.test(search),
        ),
    }[name]()
    if (ok) preferences[name] = given
    else if (name === 'shell')
      problems.push(`shell can’t be ${JSON.stringify(given)}: it’s a full path, as /bin/zsh is.`)
    else problems.push(`${key} can’t be ${JSON.stringify(given)}.`)
  }
  return { preferences, problems }
}

/** A full path: from the root (/…), or on Windows from a drive (C:\…) or a share (\\…). */
export const isFullPath = (path: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

/** Whether a setting's value is its default. */
export const isDefault = (key: string, value: unknown): boolean =>
  Object.hasOwn(PREFERENCE_DEFAULTS, key) &&
  JSON.stringify(PREFERENCE_DEFAULTS[key as keyof Preferences]) === JSON.stringify(value)

/** Settings as they are: the defaults, what the person set, and over both what policy sets. */
export function effectivePreferences(
  own: Partial<Preferences>,
  locked: Partial<Preferences> = {},
): Preferences {
  return { ...PREFERENCE_DEFAULTS, ...own, ...locked }
}
