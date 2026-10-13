/**
 * Lumovi's parts a plugin's page may name: each by its declaration (`DECLARED`), which the door
 * checks every word against, and the component of Lumovi's that draws it. A part not here, no
 * plugin can name.
 */
import { useContext, useEffect } from 'react'
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
import { DOOR_LIMITS } from '@shared/plugin-door'
import { whose } from '@shared/plugins'
import type { ObjectRef, TableProps } from '@shared/kit/table'
import { Pair, Split, Stack, Tiles } from '@renderer/kit/Arrangements'
import { Card } from '@renderer/kit/Card'
import { Counts } from '@renderer/kit/Counts'
import { Graph } from '@renderer/kit/Graph'
import { PageHeader } from '@renderer/kit/PageHeader'
import { LogsShown } from '@renderer/kit/Shown'
import { useSettings } from '@renderer/hooks/settings'
import { useLogSlot, toldOnce } from './log-slots'
import { PageKey } from './Surface'
import { Table } from '@renderer/kit/Table'
import type { KitPart, PageBy } from './page'

/**
 * A Logs part on a plugin's page: Lumovi's own log view of the pod, where the organization's
 * policy lets plugins show logs, and a place for its stream is free on the page and of the
 * plugin (else it waits, and its author is told once a page).
 */
function PluginLogs({ props, by }: { props: Readonly<Record<string, unknown>>; by?: PageBy }) {
  const { title, pod, container } = props as {
    title: { their: string }
    pod?: ObjectRef
    container?: { their: string }
  }
  // (Until Lumovi knows its policy, nothing starts: the policy may say no logs.)
  const settings = useSettings().data
  const off = settings?.managed?.pluginLogsOff === true
  const page = useContext(PageKey)
  const shownPod = pod?.kind === 'Pod' ? pod : undefined
  const slot = useLogSlot(
    by?.plugin ?? '',
    page,
    settings !== undefined && !off && shownPod !== undefined,
  )
  useEffect(() => {
    if (slot === 'page' && by && toldOnce(page)) {
      console.warn(
        `${whose(by.name)} page drew more Logs parts than it may show at once (${DOOR_LIMITS.logStreamsPage}): the rest wait.`,
      )
    }
  }, [slot, by, page])
  if (settings === undefined) return null
  return (
    <LogsShown
      shown={{ title: title.their, ...(shownPod ? { pod: shownPod } : {}) }}
      by={by ? { name: by.name, version: by.version } : { name: '', version: '' }}
      {...(container ? { container: container.their } : {})}
      {...(by ? { via: { plugin: by.plugin, version: by.version, label: by.name } } : {})}
      {...(off ? { off: true } : slot !== 'open' ? { waiting: slot } : {})}
    />
  )
}

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
  Header: ({ props, go }) => {
    const header = props as HeaderProps
    return (
      <PageHeader
        header={header}
        {...(header.onPress ? { onPress: header.onPress } : {})}
        {...(go ? { go } : {})}
      />
    )
  },
  // A pod's logs, read and drawn by Lumovi: the plugin's code never holds a line.
  Logs: ({ props, by }) => <PluginLogs props={props} {...(by ? { by } : {})} />,
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
