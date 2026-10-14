/**
 * The first release of Lumovi to carry each thing a plugin can use of its door: what its file
 * can say that an older Lumovi doesn't read, what a read can ask, the parts a page's code can
 * name, and the kinds a part's description can hold that only a newer door hands over. A plugin
 * that uses one needs that Lumovi at least (its `needs.lumovi`): the plugins' own checks read
 * this from the Lumovi they pin, and refuse a plugin whose file says an older one.
 *
 * `next` is the release being made: `npm version` writes its number in (scripts/plugin-since.ts),
 * so main says `next` of what no release has carried yet. Something new a plugin can use is a
 * line here, as `next`.
 */
import type { DECLARED } from './kit/parts'

/** A release, as three numbers; or the one being made. */
export type Since = `${number}.${number}.${number}` | 'next'

export const PLUGIN_SINCE = {
  /** What a plugin's file can say. */
  file: {
    pages: 'next',
    tabs: 'next',
    commands: 'next',
    reads: 'next',
    showsSecrets: 'next',
    /** A view's `manages`: how an object of its kind says it manages another. */
    manages: 'next',
    changes: 'next',
    opens: 'next',
    /** Where its pages link to Lumovi's own places; a destination's `{ object, at }` with it. */
    links: 'next',
    /**
     * Whether its pages show containers' logs (`shown`: Lumovi reads and draws them), or its code
     * reads them too (`read`).
     */
    logs: 'next',
    /** Its tool's own server its code may ask, through Lumovi. */
    server: 'next',
  },
  /** What a view's action can say beyond what it first took. */
  action: {
    /** Busy where it was, instead of hidden, while what it started goes on. */
    busy: 'next',
    /** What must still be as the person saw it, when it's sent. */
    same: 'next',
    /** Its dialog's own question and button, where it asks first. */
    confirmTitle: 'next',
    confirmButton: 'next',
  },
  /** What a read can ask beyond a kind's list or one object of it. */
  read: {
    usage: 'next',
    fields: 'next',
    labels: 'next',
    /** A pod's logs, read once: for a plugin whose file says `logs: read`. */
    logs: 'next',
    /** A path of its tool's own server, asked once: for a plugin whose file says `server`. */
    server: 'next',
    /** An object's warning events: for a plugin whose file says `events: true` of its kind. */
    events: 'next',
  },
  /** The parts a page's code can name. */
  parts: {
    Table: 'next',
    Graph: 'next',
    Tiles: 'next',
    Header: 'next',
    Split: 'next',
    Card: 'next',
    Pair: 'next',
    Counts: 'next',
    Steps: 'next',
    Stack: 'next',
    Logs: 'next',
    Secret: 'next',
  } satisfies Record<keyof typeof DECLARED, Since>,
  /** The kinds a part's description can hold that a door hands over as something else. */
  kinds: {
    destination: 'next',
    cut: 'next',
  },
  /**
   * What a part's description can say past what it first took, drawn only by a Lumovi that
   * carries it. Keyed by the part, then the path: `[]` for each item of a list, `kind=time` for a
   * choice's variant, a bare name for a property that's there.
   */
  props: {
    'Tiles.tiles[].value.kind=time': 'next',
    'Header.status.detail': 'next',
    'Header.buttons[].note': 'next',
    'Card.about': 'next',
    'Header.buttons[].off': 'next',
    'Header.buttons[].goes': 'next',
    'Header.buttons[].busy': 'next',
    'Header.secondStatus': 'next',
    'Table.leadHeading': 'next',
    'Table.rows[].cells[].mono': 'next',
    'Table.rows[].cells[].full': 'next',
    'Table.rows[].rows[].cells[].mono': 'next',
    'Table.rows[].rows[].cells[].full': 'next',
    /** A row's button, and its press. */
    'Table.rows[].cells[].kind=button': 'next',
    'Table.onPress': 'next',
    /** A graph's card marked, or shown for context, and what a mark is. */
    'Graph.nodes[].marked': 'next',
    'Graph.nodes[].context': 'next',
    'Graph.nodes[].goes': 'next',
    'Graph.legend.marked': 'next',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Since>>>>
