/**
 * What Lumovi says in the place of a plugin's page that has ended: who ended it, why in Lumovi's
 * own words, and whether opening it again can help. Never a crash's words: nothing of the
 * person's went wrong, and nothing else in Lumovi changed.
 *
 * What a plugin itself said as it failed is the plugin's, and is shown as that: plain text, with
 * every character that can't be seen spelled out, so it can't pass for a sentence of Lumovi's.
 */
import { inPieces, type Piece } from './kit/characters'
import { whose } from './plugins'

/** Every way a plugin's page ends. */
export type PageEnd =
  /** Lumovi ended its process: over its memory, over its processor time, or not apart from the rest. */
  | { why: 'memory' | 'processor' | 'shared' }
  /** It left Lumovi's pings unanswered. */
  | { why: 'silent' }
  /** Over what a plugin may send: counted by its box, or by the door. */
  | { why: 'too-much' }
  /** It sent what no plugin's page can: something that isn't text, or a step that isn't allowed. */
  | { why: 'not-allowed' }
  /** Its own code failed; `said` is its error's message. */
  | { why: 'failed'; said: string }
  /** The place a plugin's code runs in never opened. */
  | { why: 'no-box' }
  /**
   * A part of Lumovi's own failed as it drew the page: Lumovi's fault. Only the boundary round a
   * plugin's surface says this; nothing a plugin sends can, or it could have Lumovi blame itself.
   */
  | { why: 'drawing' }

export interface EndedWords {
  title: string
  /** Why, in Lumovi's words. (A page that failed by itself has its own words instead.) */
  why?: string
  /** The plugin's own words, in pieces: shown under "<name> said", as its and as text. */
  said?: Piece[]
  /** That nothing else changed. */
  still: string
  /** A last line: for a page over its memory or processor time, or a fault of Lumovi's. */
  advice?: string
  /** Whether "Open it again" is offered: where opening again can help. */
  again: boolean
}

const STILL =
  'The rest of Lumovi is as it was, and stopping the page changed nothing in your cluster.'
const ADVICE =
  'On a very large cluster a page can need more than a plugin is allowed. If it happens again, tell the plugin’s author.'

const WHY: Record<Exclude<PageEnd['why'], 'failed' | 'no-box' | 'drawing'>, string> = {
  memory: 'It was using more memory than a plugin may.',
  processor: 'Over the last half minute it used more than half of a processor core.',
  shared: 'It wasn’t running apart from the rest, as a plugin must.',
  silent: 'It had stopped answering.',
  'too-much': 'It sent more at once than a plugin may.',
  'not-allowed': 'It sent something a plugin can’t.',
}

/** What stands in the place of the page of the plugin shown as `name`, ended by `end`. */
export function endedWords(name: string, end: PageEnd): EndedWords {
  if (end.why === 'no-box') {
    return {
      title: `${whose(name)} page couldn’t start.`,
      why: 'Lumovi couldn’t open the place a plugin’s code runs in.',
      still: 'The rest of Lumovi is as it was.',
      again: false,
    }
  }
  if (end.why === 'drawing') {
    return {
      title: `Lumovi couldn’t draw ${whose(name)} page.`,
      why: 'That’s a fault in Lumovi, not in the plugin.',
      still: 'The rest of Lumovi is as it was.',
      advice: 'If it happens again, tell us.',
      again: true,
    }
  }
  if (end.why === 'failed') {
    const said = inPieces(end.said, SAID_AT_MOST)
    return {
      title: `${whose(name)} page stopped by itself.`,
      ...(said.length > 0 && { said }),
      still: STILL,
      again: true,
    }
  }
  return {
    title: `Lumovi stopped ${whose(name)} page.`,
    why: WHY[end.why],
    still: STILL,
    ...((end.why === 'memory' || end.why === 'processor') && { advice: ADVICE }),
    again: true,
  }
}

/** The most of a plugin's own words that's shown: what its box takes of a failure's message. */
export const SAID_AT_MOST = 200
