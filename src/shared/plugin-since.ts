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
    pages: '1.22.0',
    tabs: '1.22.0',
    commands: '1.22.0',
    reads: '1.22.0',
    showsSecrets: '1.22.0',
    /** A view's `manages`: how an object of its kind says it manages another. */
    manages: '1.22.0',
    changes: '1.22.0',
    opens: '1.22.0',
    /** Where its pages link to Lumovi's own places; a destination's `{ object, at }` with it. */
    links: '1.22.0',
    /**
     * Whether its pages show containers' logs (`shown`: Lumovi reads and draws them), or its code
     * reads them too (`read`).
     */
    logs: '1.22.0',
    /** Its tool's own server its code may ask, through Lumovi. */
    server: '1.22.0',
    /** A page's `takes`: the kind whose tab it stands in. */
    takes: '1.22.0',
    /** A view's action done to ticked rows (`bulk`), and how its work ends (`ends`). */
    bulk: '1.22.0',
    ends: '1.22.0',
    /** An action's input that's a switch, or a choice of labelled values. */
    switch: '1.22.0',
    choices: '1.22.0',
    /** What of a kind's change does harm (`spec.changes[].harm`), drawn by Lumovi in red. */
    harm: '1.22.0',
  },
  /** What a view's action can say beyond what it first took. */
  action: {
    /** Busy where it was, instead of hidden, while what it started goes on. */
    busy: '1.22.0',
    /** What must still be as the person saw it, when it's sent. */
    same: '1.22.0',
    /** Its dialog's own question and button, where it asks first. */
    confirmTitle: '1.22.0',
    confirmButton: '1.22.0',
  },
  /** What a read can ask beyond a kind's list or one object of it. */
  read: {
    usage: '1.22.0',
    fields: '1.22.0',
    labels: '1.22.0',
    /** A pod's logs, read once: for a plugin whose file says `logs: read`. */
    logs: '1.22.0',
    /** A path of its tool's own server, asked once: for a plugin whose file says `server`. */
    server: '1.22.0',
    /** An object's warning events: for a plugin whose file says `events: true` of its kind. */
    events: '1.22.0',
  },
  /** The parts a page's code can name. */
  parts: {
    Table: '1.22.0',
    Graph: '1.22.0',
    Tiles: '1.22.0',
    Header: '1.22.0',
    Split: '1.22.0',
    Card: '1.22.0',
    Pair: '1.22.0',
    Counts: '1.22.0',
    Steps: '1.22.0',
    Stack: '1.22.0',
    Logs: '1.22.0',
    Secret: '1.22.0',
  } satisfies Record<keyof typeof DECLARED, Since>,
  /** The kinds a part's description can hold that a door hands over as something else. */
  kinds: {
    destination: '1.22.0',
    cut: '1.22.0',
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
    /** A count that opens; a status's running time; a table's bar and its rows' values. */
    'Counts.groups[].rows[].opens': 'next',
    'Table.rows[].cells[].kind=status.since': 'next',
    'Table.filters': 'next',
    'Table.search': 'next',
    'Table.rows[].facets': 'next',
    'Table.ticks': 'next',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Since>>>>
