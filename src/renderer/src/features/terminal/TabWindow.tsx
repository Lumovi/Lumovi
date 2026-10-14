/**
 * A window of one tab below: the tab alone, filling it, under a band that names it (its tab,
 * namespace and cluster, quietly) with "Put back below". A terminal's shell goes on running here
 * from the window it came from; closing the window closes the tab, and so ends it.
 */
import { PanelBottom, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { movedTabOf } from '@shared/moved-tab'
import { apiKindOf } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { KindIcon } from '@renderer/components/KindIcon'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { useClusterName } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { ClusterContext } from '@renderer/state/cluster'
import { useDock, type KeptTab } from './dock'
import { KeptPanel, NotReadYet } from './Kept'
import { Panel } from './TerminalDock'

/** A detail's tab, as the band names it (none for its overview). */
const TAB_NAMES: Record<string, string> = {
  pods: 'Pods',
  logs: 'Logs',
  metrics: 'Metrics',
  map: 'Map',
  events: 'Events',
  audit: 'Audit',
  yaml: 'YAML',
}

export function TabWindow() {
  const { tabs, kept, active, order } = useDock()
  const navigate = useNavigate()
  const clusterName = useClusterName()
  const [arrived, setArrived] = useState(false)
  const leaving = useRef(false)

  // Its tab, as the main process holds it: one opened again as Lumovi did, on a cluster that
  // signs in through a program, waits to be asked for before it's read.
  useEffect(() => {
    let gone = false
    void (async () => {
      const [{ tab, restored }, contexts] = await Promise.all([
        api.desktop!.movedTab(),
        api.kube.contexts().catch(() => undefined),
      ])
      if (gone) return
      const moved = movedTabOf(tab)
      if (!moved) return window.close()
      const signsIn = contexts?.contexts.some((c) => c.name === moved.context && c.signsInWith)
      useDock
        .getState()
        .receive(moved.kind === 'kept' && restored && signsIn ? { ...moved, waiting: true } : moved)
      setArrived(true)
    })()
    return () => {
      gone = true
    }
  }, [])

  // Its last tab closed (or gone back below), the window goes with it.
  useEffect(() => {
    if (arrived && order.length === 0 && !leaving.current) window.close()
  }, [arrived, order.length])

  const terminal = tabs.find((tab) => tab.session.id === active)
  const object = kept.find((each) => each.id === active)
  const context = terminal?.context ?? object?.context

  const name = terminal ? (terminal.title ?? 'Terminal') : object ? object.object.name : ''
  const quiet = [
    object ? TAB_NAMES[object.tab] : undefined,
    terminal?.namespace ?? object?.object.namespace,
    context && clusterName(context),
  ].filter(Boolean)
  useEffect(() => {
    if (!context) return
    const what = object
      ? `${name}${TAB_NAMES[object.tab] ? `, ${TAB_NAMES[object.tab]}` : ''}`
      : name
    document.title = `${what} · ${clusterName(context)} — Lumovi`
  }, [name, object, context, clusterName])

  const putBack = async () => {
    const id = active
    const tab = id ? useDock.getState().take(id) : undefined
    if (!tab) return
    // (Until it's answered, the window stays: its tab's gone from here only once it's there.)
    leaving.current = true
    const { here } = await api.desktop!.putBack(tab).catch(() => ({ here: true as const }))
    if (!here) return
    // No other window of Lumovi's to put it in: this one becomes one, its tab below, on its
    // cluster's page (the start screen while that's still to be read).
    leaving.current = false
    useDock.getState().receive(tab)
    const waiting = tab.kind === 'kept' && tab.waiting
    void navigate(waiting ? '/' : `/cluster/${encodeURIComponent(tab.context)}`, { replace: true })
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="titlebar-leading titlebar-trailing flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 drag">
        {terminal ? (
          <SquareTerminal className="size-4 shrink-0 text-ink-2" />
        ) : object ? (
          <KindIcon kind={object.object.kind} className="size-4 shrink-0 text-ink-2" />
        ) : null}
        <h1 className="flex min-w-0 items-baseline gap-2 text-[13px]">
          {object && <span className="sr-only">{apiKindOf(object.object.kind)}</span>}
          <MiddleTruncate text={name} className="font-medium text-ink-1" />
          {quiet.length > 0 && <span className="truncate text-ink-3">{quiet.join(' · ')}</span>}
        </h1>
        <span className="flex-1" />
        {(terminal || object) && (
          <Button variant="secondary" className="shrink-0 no-drag" onClick={() => void putBack()}>
            <PanelBottom /> Put back below
          </Button>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        {terminal && <Panel tab={terminal} shown />}
        {object && <Alone kept={object} />}
      </div>
    </div>
  )
}

/** A kept object alone in its window: read once it's asked for, where it waits to be (its card's button focused, so Enter reads it). */
function Alone({ kept }: { kept: KeptTab }) {
  if (!kept.waiting) {
    // (The window's own cluster is the tab's: there's no other here.)
    const { context, object } = kept
    const namespace = object.namespace ?? null
    return (
      <ClusterContext.Provider
        value={{
          context,
          namespaces: namespace ? [namespace] : null,
          namespace,
          setNamespaces: () => {},
          setNamespace: () => {},
        }}
      >
        <KeptPanel kept={kept} shown alone />
      </ClusterContext.Provider>
    )
  }
  // (Not in its cluster's scope, which would count as that cluster opened here, and read it.)
  return <NotReadYet kept={kept} focused />
}
