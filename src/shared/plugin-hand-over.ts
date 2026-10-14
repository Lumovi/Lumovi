/**
 * The hand-over: whether a page may be handed a plugin's code, and what a person is told where
 * it isn't. One function answers it (`mayHandOver`, in the backend), and one call is the only way
 * a plugin's code reaches a page (`pluginCode`). Nothing else hands code over.
 */

/** Why a page isn't handed a plugin's code. */
export type NotHanded =
  /** No plugin Lumovi has in use by that name whose code it runs. */
  | 'not-in-use'
  /** One that has no code in this Lumovi. */
  | 'no-code'
  /** On a server: this session isn't held to coming from Lumovi's own page (the second wall). */
  | 'not-held'
  /** On a server: this browser hasn't been through Lumovi's check that it keeps a plugin's code apart. */
  | 'not-checked'
  /** On a server: it was, and it didn't pass (something got out, or a report couldn't be read). */
  | 'check-failed'
  /** On a server: the check didn't finish in time. */
  | 'check-unfinished'
  /**
   * On a server: the check couldn't look in the places a box might keep things (this browser
   * blocks them, or throws): it didn't finish, and won't in this browser as it is.
   */
  | 'check-unlooked'
  /**
   * On a server: the check's own request, from Lumovi's page, didn't reach the server (something
   * in front of it doesn't pass it on): nothing can be told of what a box lets out, so it didn't
   * finish, and won't from this page as things are.
   */
  | 'check-unreached'
  /** The person turned this plugin's code off, on the Plugins page. */
  | 'turned-off'
  /** On a server: its administrator turned plugins' code off (LUMOVI_PLUGIN_CODE=off). */
  | 'off-on-server'
  /** On a server: its administrator lets only some plugins' code run, and not this one's. */
  | 'off-on-server-for-it'
  /** The desktop app's: the organization's policy lets no plugin run code (`plugins: no-code`). */
  | 'off-by-policy'
  /** The desktop app's: one of the person's own, while Developer mode is off. */
  | 'developer-mode-off'
  /** The desktop app's: one of the person's own, where the organization's policy keeps it off. */
  | 'developer-mode-locked'
  /**
   * The desktop app's: one of the person's own, whose code waits for them to agree to what it may
   * do: never agreed to, its code changed since, or what it asks.
   */
  | 'waiting-first'
  | 'waiting-code'
  | 'waiting-asks'

/**
 * What turns a plugin's code off, wherever it's decided: kept by the backend, read each time it's
 * asked, never what a page says.
 */
export interface CodeSwitches {
  /** The organization's policy lets no plugin run code (the desktop app's). */
  policyOff?: true
  /**
   * A server's administrator: the plugins whose code may run (LUMOVI_PLUGIN_CODE's names; none,
   * where it's off). Unset: every plugin's may.
   */
  serverOnly?: readonly string[]
  /** The organization's policy lets no plugin's page propose a change (the desktop app's). */
  proposalsOff?: true
  /** The organization's policy lets no plugin's page show what's in a Secret (the desktop app's). */
  secretsOff?: true
  /** The organization's policy lets no plugin's page show or read logs (the desktop app's). */
  logsOff?: true
  /** The organization's policy lets no plugin talk to a server in the cluster (the desktop app's). */
  serversOff?: true
  /** This person's own choices, by plugin: on, or off. A plugin they haven't chosen for is as `CODE_ON` says. */
  chosen: Readonly<Record<string, boolean>>
}

/**
 * Whether a plugin's code that comes with Lumovi runs before its person has said: it does. What
 * it may read and do is on the Plugins page, and nobody is asked; the person turns it off there.
 */
export const CODE_ON = true

/** Nothing turned off, nobody's choice made. */
export const ALL_CODE_ON: CodeSwitches = { chosen: {} }

/** Whether this person's own switch has a plugin's code on: their choice, or the default. */
export const chosenOn = (plugin: string, chosen: Readonly<Record<string, boolean>>): boolean =>
  Object.hasOwn(chosen, plugin) ? chosen[plugin] === true : CODE_ON

/**
 * Whether a plugin's code is off by a switch, and whose: the organization's first, then the
 * server's, then the person's own (what's locked is said before what the person could turn on).
 */
export function codeOff(
  plugin: string,
  switches: CodeSwitches,
):
  | Extract<NotHanded, 'turned-off' | 'off-on-server' | 'off-on-server-for-it' | 'off-by-policy'>
  | undefined {
  if (switches.policyOff) return 'off-by-policy'
  const only = switches.serverOnly
  if (only && only.length === 0) return 'off-on-server'
  if (only && !only.includes(plugin)) return 'off-on-server-for-it'
  if (!chosenOn(plugin, switches.chosen)) return 'turned-off'
  return undefined
}

/** What `pluginCode` answers: the code and what it's known by, or why not. */
export type PluginCode =
  | {
      ok: true
      code: string
      /** The digests the page's reads name: its file's, and its code's. */
      digest: string
      codeDigest: string
    }
  | { ok: false; refused: NotHanded }

/** Why not, as a person reads it in the place of the plugin's page (after "…couldn’t start."). */
const WHY: Readonly<Record<Exclude<NotHanded, 'not-in-use'>, string>> = {
  'not-held': 'This server doesn’t offer plugins that run code to this browser.',
  'not-checked':
    'Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  'no-code': 'Its code isn’t part of this Lumovi.',
  'check-failed':
    'Lumovi checked this browser and it didn’t pass, so it doesn’t run plugins’ code in this browser. Another browser may pass the check.',
  'check-unfinished':
    'Lumovi’s check of this browser didn’t finish in time, so it doesn’t run plugins’ code here yet. Open the page again to check again.',
  'check-unlooked':
    'Before handing a plugin its code, Lumovi checks that this browser keeps each plugin in a box of its own. Here it can’t look in the places a box might keep things, so no plugin’s code runs in this browser.',
  'check-unreached':
    'Lumovi couldn’t check this browser: its own test request didn’t reach this server, so it can’t tell what a plugin’s box lets out here. Something in front of Lumovi may not pass it on. Whoever runs Lumovi can see which in its log.',
  'turned-off': 'You turned off its code.',
  'off-on-server': 'This server doesn’t run plugins’ code. Whoever runs Lumovi can turn it on.',
  'off-on-server-for-it':
    'This server doesn’t run this plugin’s code. Whoever runs Lumovi can turn it on.',
  'off-by-policy': 'Your organization’s policy doesn’t let plugins run code.',
  'developer-mode-off': 'Developer mode is off.',
  'developer-mode-locked': 'Your organization’s policy keeps Developer mode off.',
  'waiting-first': 'Its code waits for you to agree to what it may do.',
  'waiting-code': 'Its code changed since you agreed. It waits for you.',
  'waiting-asks': 'It asks for more than when you agreed. It waits for you.',
}

/** Why not, as one sentence of Lumovi's: what a page's place says after its title. */
export const notHandedWhy = (refused: Exclude<NotHanded, 'not-in-use'>): string => WHY[refused]

/** The same, as it follows "Its pages don’t run here:" (Lumovi keeps its capital). */
const LINE: Readonly<Record<Exclude<NotHanded, 'not-in-use'>, string>> = {
  'not-held': 'this server doesn’t offer plugins that run code to this browser.',
  'not-checked':
    'Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  'no-code': 'its code isn’t part of this Lumovi.',
  'check-failed': 'Lumovi’s check of this browser didn’t pass.',
  'check-unfinished': 'Lumovi’s check of this browser didn’t finish in time.',
  'check-unlooked': 'Lumovi couldn’t check this browser.',
  'check-unreached': 'Lumovi’s check of this browser couldn’t reach this server.',
  'turned-off': 'you turned off its code.',
  'off-on-server': 'this server doesn’t run plugins’ code.',
  'off-on-server-for-it': 'this server doesn’t run this plugin’s code.',
  'off-by-policy': 'your organization’s policy doesn’t let plugins run code.',
  'developer-mode-off': 'Developer mode is off.',
  'developer-mode-locked': 'your organization’s policy keeps Developer mode off.',
  'waiting-first': 'its code waits for you to agree to what it may do.',
  'waiting-code': 'its code changed since you agreed, and waits for you.',
  'waiting-asks': 'it asks for more than when you agreed, and waits for you.',
}

/** The desktop app's: one of the person's own whose code waits for them to agree. */
export const WAITING: ReadonlySet<NotHanded> = new Set([
  'waiting-first',
  'waiting-code',
  'waiting-asks',
])

/** Where its code is off by a switch: the place in place of its page says so, not that it failed. */
export const SWITCHED_OFF: ReadonlySet<NotHanded> = new Set([
  'turned-off',
  'off-on-server',
  'off-on-server-for-it',
  'off-by-policy',
  'developer-mode-off',
  'developer-mode-locked',
])

/**
 * Why not, as the Plugins page says it in a plugin's entry: "Its pages don’t run here: this
 * server doesn’t offer plugins that run code to this browser." ("…don’t run: you turned off its
 * code", where it's off wherever the person is.) For one Lumovi has a page of its own for (its
 * label, `standsIn`), that it shows that page instead.
 */
export const notHandedLine = (
  refused: Exclude<NotHanded, 'not-in-use'>,
  standsIn?: string,
): string =>
  // (Off by the person or by their organization: off anywhere, not only here.)
  `Its pages don’t run${refused === 'turned-off' || refused === 'off-by-policy' || refused === 'developer-mode-off' || refused === 'developer-mode-locked' ? '' : ' here'}${refused === 'check-unfinished' ? ' yet' : ''}: ${LINE[refused]}` +
  (standsIn === undefined ? '' : ` Lumovi shows its own overview of ${standsIn} instead.`)
