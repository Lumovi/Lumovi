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
}

/**
 * Why not, as the Plugins page says it in a plugin's entry: "Its pages don’t run here: this
 * server doesn’t offer plugins that run code to this browser."
 */
export const notHandedLine = (refused: Exclude<NotHanded, 'not-in-use'>): string =>
  `Its pages don’t run here${refused === 'check-unfinished' ? ' yet' : ''}: ${LINE[refused]}`
