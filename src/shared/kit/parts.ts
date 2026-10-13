/**
 * Lumovi's parts a plugin's page may name, by their declarations: data, with nothing of how
 * they're drawn, so the same list is what the door checks a page against in Lumovi and wherever
 * else a plugin's code is held to it (the plugins' own checks build the door with it). What draws
 * each is `KIT_PARTS`, made from this, and a part declared here with nothing to draw it fails to
 * compile.
 */
import type { Part } from './declare'
import { graph } from './graph'
import { card, counts, header, logs, pair, secretShown, split, stack, tiles } from './page'
import { table } from './table'

export const DECLARED = {
  Table: table,
  Graph: graph,
  Tiles: tiles,
  Header: header,
  Split: split,
  Card: card,
  Pair: pair,
  Counts: counts,
  Stack: stack,
  Logs: logs,
  Secret: secretShown,
} as const satisfies Readonly<Record<string, Part>>
