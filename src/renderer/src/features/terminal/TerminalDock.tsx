import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCw,
  SquareTerminal,
  X,
} from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { Button, IconButton } from '@renderer/components/Button'
import { Kbd } from '@renderer/components/Kbd'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { menuContent, menuItem } from '../shell/menu-styles'
import { tabName, useDock, type TerminalTab } from './dock'
import { keysText, TERMINAL_KEYS } from './keys'
import { TerminalNotice, TerminalView, usePhase } from './TerminalView'

/** How tall the dock is unless resized, and the least it can be. */
const HEIGHT = 288
const MIN_HEIGHT = 140
/** How far an arrow key resizes it. */
const STEP = 24

/** Whether focus moved into, or out of, one of the dock's terminals (not its tabs or buttons). */
const inTerminal = (event: FocusEvent) =>
  (event.target as HTMLElement).classList.contains('xterm-helper-textarea')

/**
 * Terminals on this computer, under a cluster's pages: a thin bar that's always
 * there (with the terminals that run, if any), which opens into a dock of
 * them, each tab a shell with kubectl pointed at its cluster. ⌃` opens and
 * closes it.
 */
export function TerminalDock() {
  const { tabs, active, open, maximized, focus } = useDock()
  const dock = useDock.getState()
  const { context, namespace } = useCluster()
  const stored = usePrefs((prefs) => prefs.terminalHeight)
  const setStored = usePrefs((prefs) => prefs.setTerminalHeight)
  const section = useRef<HTMLElement>(null)
  // For the cluster (and namespace) that's open: from here, and from ⌃`, the menu and the palette.
  const add = () => dock.add(context, namespace ?? undefined)
  const toggle = () => dock.toggle(context, namespace ?? undefined)
  useEffect(() => {
    useDock.setState({ here: { context, namespace: namespace ?? undefined } })
    return () => useDock.setState({ here: undefined })
  }, [context, namespace])

  // What's asked to be focused (a new tab, a pasted command…), once it's shown: after a dialog
  // or the palette that asked has given focus back to what opened it.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      // Not from a tab's name being edited (double-clicked, its first click shows the tab).
      if (document.activeElement instanceof HTMLInputElement) return
      useDock
        .getState()
        .tabs.find((tab) => tab.session.id === active)
        ?.session.focus()
    })
    return () => clearTimeout(timer)
  }, [open, active, focus])
  // Closed (or gone with the page), no terminal has focus: ⌘W is the window's again. And
  // if one had it (closed with ⌃`, its last tab closed), the page has it back.
  const panels = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) return () => api.desktop!.setTerminalFocus(false)
    const focused = document.activeElement
    if (focused === document.body || panels.current!.contains(focused)) {
      document.getElementById('content')!.focus()
    }
  }, [open])

  /** As tall as it may be: most of the space it shares with the page above it. */
  const tallest = () => section.current!.parentElement!.clientHeight * 0.85
  const height = maximized ? '85%' : `${Math.max(MIN_HEIGHT, stored ?? HEIGHT)}px`
  const resize = (to: number) => {
    setStored(Math.round(Math.min(tallest(), Math.max(MIN_HEIGHT, to))))
    dock.setMaximized(false)
  }
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    const bottom = section.current!.getBoundingClientRect().bottom
    handle.setPointerCapture(event.pointerId)
    const move = (moved: globalThis.PointerEvent) => resize(bottom - moved.clientY)
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = ({ ArrowUp: STEP, ArrowDown: -STEP } as Record<string, number>)[event.key]
    if (by === undefined) return
    event.preventDefault()
    // From the height as kept (the page may not show the last step yet), or as shown.
    resize((usePrefs.getState().terminalHeight ?? section.current!.offsetHeight) + by)
  }
  // The dock's own keys, which its terminals leave to it (see TERMINAL_KEYS; macOS's ⌘T and
  // ⌘W come from the main process, before the menu has them).
  const shortcuts = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) return
    const { code, shiftKey } = event
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
    const cmd = event.metaKey && !event.ctrlKey && !event.altKey && shiftKey
    const step =
      (ctrl && code === 'PageDown') || (cmd && code === 'BracketRight')
        ? 1
        : (ctrl && code === 'PageUp') || (cmd && code === 'BracketLeft')
          ? -1
          : 0
    if (step !== 0) {
      event.preventDefault()
      dock.step(step)
    } else if (ctrl && shiftKey && code === 'KeyW') {
      event.preventDefault()
      dock.close(active!)
    } else if (ctrl && shiftKey && code === 'KeyT') {
      event.preventDefault()
      add()
    }
  }

  return (
    <section
      ref={section}
      aria-label="Terminal"
      style={open ? { height } : undefined}
      onKeyDown={shortcuts}
      onFocus={(event) => {
        if (inTerminal(event)) api.desktop!.setTerminalFocus(true)
      }}
      onBlur={(event) => {
        if (inTerminal(event)) api.desktop!.setTerminalFocus(false)
      }}
      className="relative flex shrink-0 flex-col border-t border-line bg-surface-2"
    >
      {open && (
        // Taller or shorter: dragged, or with the arrow keys.
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the terminal"
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={keys}
          className="group absolute inset-x-0 -top-1.5 z-10 h-3 cursor-row-resize outline-none"
        >
          <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-transparent transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent" />
        </div>
      )}
      {/* As tall as the sidebar's footer, its top border in line with the footer's. */}
      <header
        className={cn(
          'flex h-[39px] shrink-0 items-center gap-1 pr-2 pl-2',
          open && 'border-b border-line',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls="terminal-panels"
          onClick={toggle}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-2 outline-none hover:bg-surface-3 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <SquareTerminal className="size-3.5" />
          Terminal
        </button>
        {tabs.length > 0 && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />}
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => (
            <Tab key={tab.session.id} tab={tab} selected={open && tab.session.id === active} />
          ))}
        </div>
        <IconButton
          label={`New terminal (${keysText(TERMINAL_KEYS.add)})`}
          className="size-7 shrink-0"
          onClick={add}
        >
          <Plus />
        </IconButton>
        <span className="flex-1" />
        {open ? (
          <IconButton
            label={maximized ? 'Restore the terminal' : 'Maximize the terminal'}
            className="size-7"
            onClick={() => dock.setMaximized(!maximized)}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        ) : (
          <span aria-hidden className="mr-1 flex">
            <Kbd>{keysText(TERMINAL_KEYS.toggle)}</Kbd>
          </span>
        )}
        <IconButton
          label={`${open ? 'Hide' : 'Show'} the terminal (${keysText(TERMINAL_KEYS.toggle)})`}
          className="size-7"
          onClick={toggle}
        >
          {open ? <ChevronDown /> : <ChevronUp />}
        </IconButton>
      </header>
      <div
        ref={panels}
        id="terminal-panels"
        hidden={!open}
        className="relative flex min-h-0 flex-1"
      >
        {tabs.map((tab) => (
          <Panel key={tab.session.id} tab={tab} shown={tab.session.id === active} />
        ))}
      </div>
    </section>
  )
}

function Tab({ tab, selected }: { tab: TerminalTab; selected: boolean }) {
  const phase = usePhase(tab.session)
  const dock = useDock.getState()
  const [renaming, setRenaming] = useState(false)
  const ended = phase.state === 'ended' || phase.state === 'failed'
  const id = tab.session.id
  // Renamed, it's shown (its name is edited where it's selected).
  const rename = () => {
    if (!selected) dock.select(id)
    setRenaming(true)
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={cn(
            'group flex h-7 shrink-0 items-center rounded-md text-xs transition-colors',
            selected
              ? 'bg-surface-3 text-ink-1'
              : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
          )}
        >
          {renaming ? (
            <Rename tab={tab} onDone={() => setRenaming(false)} />
          ) : (
            <button
              type="button"
              role="tab"
              aria-label={`${tabName(tab)}${ended ? ', exited' : ''}`}
              id={`terminal-tab-${id}`}
              aria-selected={selected}
              aria-controls={`terminal-${id}`}
              onClick={() => dock.select(id)}
              onDoubleClick={rename}
              onKeyDown={(event) => {
                if (event.key === 'F2') rename()
              }}
              className="flex h-full items-center gap-1.5 rounded-md pr-1 pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <SquareTerminal className={cn('size-3.5', ended ? 'text-ink-3' : 'text-accent')} />
              <span className="max-w-48 truncate font-medium">{tab.title ?? tab.context}</span>
              {!tab.title && tab.namespace && <span className="text-ink-3">{tab.namespace}</span>}
              {ended && <span className="text-ink-3 italic">exited</span>}
            </button>
          )}
          <button
            type="button"
            aria-label={`Close the terminal ${tabName(tab)}`}
            onClick={() => dock.close(id)}
            className={cn(
              'mr-1 grid size-5 place-items-center rounded text-ink-3 outline-none hover:bg-line hover:text-ink-1 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        {/* Focus goes where what's picked puts it: the name being changed, or the terminal. */}
        <ContextMenu.Content
          className={menuContent}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className={menuItem} onSelect={rename}>
            <Pencil className="size-4 text-ink-3" />
            <span className="flex-1">Rename…</span>
            <Keys keys={['F2']} />
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => dock.add(tab.context, tab.namespace)}
          >
            <Plus className="size-4 text-ink-3" />
            <span className="flex-1">New terminal like it</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item className={menuItem} onSelect={() => dock.close(id)}>
            <X className="size-4 text-ink-3" />
            <span className="flex-1">Close</span>
            <Keys keys={TERMINAL_KEYS.close} />
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => dock.closeOthers(id)}>
            <span className="size-4" />
            <span className="flex-1">Close the others</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** A tab's name, being changed: Enter keeps it, Escape doesn't, an empty one goes back. */
function Rename({ tab, onDone }: { tab: TerminalTab; onDone: () => void }) {
  const [name, setName] = useState(tab.title ?? tab.context)
  const input = useRef<HTMLInputElement>(null)
  // Focused once a menu that asked for it has closed (and done with focus).
  useEffect(() => {
    const timer = setTimeout(() => {
      input.current!.focus()
      input.current!.select()
    })
    return () => clearTimeout(timer)
  }, [])
  const keep = () => {
    useDock.getState().rename(tab.session.id, name)
    onDone()
  }
  return (
    <input
      aria-label="Terminal name"
      value={name}
      ref={input}
      onChange={(event) => setName(event.target.value)}
      onBlur={keep}
      onKeyDown={(event) => {
        if (event.key === 'Enter') keep()
        if (event.key === 'Escape') {
          event.preventDefault()
          onDone()
          useDock.getState().refocus()
        }
      }}
      spellCheck={false}
      className="mx-1 h-6 w-36 rounded border border-accent bg-surface px-1.5 text-xs text-ink-1 ring-3 ring-accent-soft outline-none"
    />
  )
}

/** Keys, as a menu shows its shortcuts. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex gap-0.5">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}

function Panel({ tab, shown }: { tab: TerminalTab; shown: boolean }) {
  const phase = usePhase(tab.session)
  const dock = useDock.getState()
  const ended =
    phase.state === 'failed'
      ? phase.error
      : phase.state === 'ended'
        ? `The shell exited with code ${phase.exit.code}.`
        : undefined
  return (
    <div
      role="tabpanel"
      id={`terminal-${tab.session.id}`}
      aria-labelledby={`terminal-tab-${tab.session.id}`}
      hidden={!shown}
      className="absolute inset-0 flex flex-col"
    >
      <TerminalView
        session={tab.session}
        label={`Terminal ${tabName(tab)}`}
        owned={false}
        dimmed={Boolean(ended)}
      >
        {ended && (
          <TerminalNotice
            actions={
              <Button variant="primary" onClick={() => dock.restart(tab.session.id)}>
                <RotateCw /> Restart
              </Button>
            }
          >
            {ended}
          </TerminalNotice>
        )}
      </TerminalView>
    </div>
  )
}
