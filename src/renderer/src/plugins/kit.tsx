/**
 * Lumovi's parts a plugin's page may name: each by its declaration (`DECLARED`), which the door
 * checks every word against, and the component of Lumovi's that draws it. A part not here, no
 * plugin can name.
 */
import type { GraphProps } from '@shared/kit/graph'
import type {
  CardProps,
  CountsProps,
  HeaderProps,
  PairProps,
  SplitProps,
  TilesProps,
} from '@shared/kit/page'
import { DECLARED } from '@shared/kit/parts'
import type { TableProps } from '@shared/kit/table'
import { Pair, Split, Stack, Tiles } from '@renderer/kit/Arrangements'
import { Card } from '@renderer/kit/Card'
import { Counts } from '@renderer/kit/Counts'
import { Graph } from '@renderer/kit/Graph'
import { PageHeader } from '@renderer/kit/PageHeader'
import { Table } from '@renderer/kit/Table'
import type { KitPart } from './page'

/** What draws each declared part: one for every part, or this doesn't compile. */
const DRAWN: { readonly [Name in keyof typeof DECLARED]: KitPart['draw'] } = {
  // (Opening what a row, a card or a tile names is Lumovi's own: `go`, never a property the
  // plugin wrote.)
  Table: ({ props, go }) => <Table {...(props as TableProps)} {...(go ? { go } : {})} />,
  Graph: ({ props, go }) => <Graph {...(props as GraphProps)} {...(go ? { go } : {})} />,
  Tiles: ({ props, go }) => {
    const { tiles, onOpen } = props as TilesProps
    return <Tiles tiles={tiles} {...(go ? { go } : {})} {...(onOpen ? { onOpen } : {})} />
  },
  Header: ({ props }) => {
    const header = props as HeaderProps
    return <PageHeader header={header} {...(header.onPress ? { onPress: header.onPress } : {})} />
  },
  Split: ({ props, children }) => {
    const { list, onPick } = props as SplitProps
    return (
      <Split list={list} {...(onPick ? { onPick } : {})}>
        {children}
      </Split>
    )
  },
  Card: ({ props, children }) => <Card {...(props as CardProps)}>{children}</Card>,
  Pair: ({ props, children }) => <Pair {...(props as PairProps)}>{children}</Pair>,
  Counts: ({ props }) => <Counts {...(props as CountsProps)} />,
  Stack: ({ children }) => <Stack>{children}</Stack>,
}

export const KIT_PARTS: Readonly<Record<string, KitPart>> = Object.fromEntries(
  Object.entries(DECLARED).map(([name, declared]) => [
    name,
    { declared, draw: DRAWN[name as keyof typeof DECLARED] },
  ]),
)
