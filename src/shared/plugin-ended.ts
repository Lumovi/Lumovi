/**
 * What Lumovi says in the place of a plugin's page that has ended: who ended it, why in Lumovi's
 * own words, and whether opening it again can help. Never a crash's words: nothing of the
 * person's went wrong, and nothing else in Lumovi changed.
 *
 * What a plugin itself said as it failed is the plugin's, and is shown as that: plain text, with
 * every character that can't be seen spelled out, so it can't pass for a sentence of Lumovi's.
 */
import { shortInPieces, type Piece } from './kit/characters'
import { notHandedWhy, type NotHanded } from './plugin-hand-over'
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
  /** Its code wasn't handed to this page, and why (`mayHandOver`): it never started. */
  | { why: 'not-handed'; refused: NotHanded }
  /** Its file or its code changed since the page was handed them. */
  | { why: 'changed' }
  /** On a server: this browser's check failed after all, once the page was handed its code. */
  | { why: 'check-failed' }

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

const WHY: Record<
  Exclude<
    PageEnd['why'],
    'failed' | 'no-box' | 'drawing' | 'not-handed' | 'changed' | 'check-failed'
  >,
  string
> = {
  memory: 'It was using more memory than a plugin may.',
  processor: 'Over the last half minute it used more than half of a processor core.',
  shared: 'It wasn’t running apart from the rest, as a plugin must.',
  silent: 'It had stopped answering.',
  'too-much': 'It sent more at once than a plugin may.',
  'not-allowed': 'It sent something a plugin can’t.',
}

/** What stands in the place of the page of the plugin shown as `name`, ended by `end`. */
export function endedWords(name: string, end: PageEnd): EndedWords {
  if (end.why === 'not-handed') {
    // (As the place says of a plugin taken away while its page was open.)
    if (end.refused === 'not-in-use') {
      return {
        title: `${name} isn’t in use any more.`,
        still: 'The rest of Lumovi is as it was.',
        again: false,
      }
    }
    // A check that couldn't look: said as Lumovi's, with what the person can change; opening the
    // page again would look again where it can't.
    if (end.refused === 'check-unlooked') {
      return {
        title: 'Lumovi couldn’t check this browser.',
        why: notHandedWhy('check-unlooked'),
        still: 'The rest of Lumovi is as it was.',
        advice:
          'If this browser blocks storage for this site, allowing it and reloading lets Lumovi check.',
        again: false,
      }
    }
    return {
      title: `${whose(name)} page couldn’t start.`,
      why: notHandedWhy(end.refused),
      still: 'The rest of Lumovi is as it was.',
      // (A check that didn't finish can be run again; nothing else here changes by opening again.)
      again: end.refused === 'check-unfinished',
    }
  }
  if (end.why === 'changed') {
    return {
      title: `${name} changed since its page was opened.`,
      still: 'The rest of Lumovi is as it was.',
      again: true,
    }
  }
  if (end.why === 'check-failed') {
    return {
      title: `Lumovi stopped ${whose(name)} page.`,
      why: notHandedWhy('check-failed'),
      still: 'The rest of Lumovi is as it was.',
      again: false,
    }
  }
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
    const said = shortInPieces(end.said, SAID_AT_MOST, SAID_LINES)
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
/** And the lines they're shown in. */
export const SAID_LINES = 5
