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
  /** On a server: this browser hasn't passed Lumovi's check that it keeps a plugin's code apart. */
  | 'not-checked'

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
}

/** Why not, as one sentence of Lumovi's: what a page's place says after its title. */
export const notHandedWhy = (refused: Exclude<NotHanded, 'not-in-use'>): string => WHY[refused]

/** The same, as it follows "Its pages don’t run here:" (Lumovi keeps its capital). */
const LINE: Readonly<Record<Exclude<NotHanded, 'not-in-use'>, string>> = {
  'not-held': 'this server doesn’t offer plugins that run code to this browser.',
  'not-checked':
    'Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  'no-code': 'its code isn’t part of this Lumovi.',
}

/**
 * Why not, as the Plugins page says it in a plugin's entry: "Its pages don’t run here: this
 * server doesn’t offer plugins that run code to this browser."
 */
export const notHandedLine = (refused: Exclude<NotHanded, 'not-in-use'>): string =>
  `Its pages don’t run here: ${LINE[refused]}`
