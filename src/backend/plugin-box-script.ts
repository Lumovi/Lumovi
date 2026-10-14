/**
 * How a sealed document's policy names its own script: by its SHA-256, as a policy's source,
 * made from the text itself wherever it's served (never written by hand). The box's is Lumovi's
 * (`BOX_SCRIPT`), the same in every box, and it's in the box's document; what a browser runs
 * there is this text or nothing.
 */
import { createHash } from 'node:crypto'
import { BOX_SCRIPT } from '@shared/plugin-box'

/** A script's text as a policy names it. */
export const scriptSource = (text: string): string =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`

export const BOX_SCRIPT_SOURCE = scriptSource(BOX_SCRIPT)
