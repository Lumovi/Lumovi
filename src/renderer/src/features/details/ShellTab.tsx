import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Bug, RotateCw, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KubeObject, ShellExit } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/States'
import { useAccess } from '@renderer/hooks/access'
import { useReadOnly } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'

type Phase =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'ended'; exit: ShellExit }
  | { state: 'failed'; error: string }

interface ContainerStatus {
  name: string
  state?: { running?: unknown }
}

/** The terminal in the app's colours, read from its theme. */
function theme() {
  const css = getComputedStyle(document.documentElement)
  const color = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: color('--surface-2'),
    foreground: color('--text-1'),
    cursor: color('--accent'),
    cursorAccent: color('--surface-2'),
    selectionBackground: color('--accent-soft'),
  }
}

/** A shell in one of a pod's containers, including debug containers added to it. */
export function ShellTab({ pod }: { pod: KubeObject }) {
  const { context } = useCluster()
  const { name, namespace } = pod.metadata
  const containers: string[] = [
    ...pod.spec.containers.map((c: { name: string }) => c.name),
    ...(pod.spec.ephemeralContainers ?? []).map((c: { name: string }) => c.name),
  ]
  // A debug container that was just added is opened first, also when the tab is
  // already open (debugging is offered when a container has no shell).
  const ref = formatRef({ kind: 'Pod', name, namespace })
  const requested = useActionsUi((state) =>
    state.shell?.ref === ref ? state.shell.container : null,
  )
  const [container, setContainer] = useState(requested ?? containers[0]!)
  const [honored, setHonored] = useState(requested)
  if (requested && requested !== honored) {
    setHonored(requested)
    setContainer(requested)
  }
  // Until the pod shows it, a new container is listed, and waited for.
  const choices = containers.includes(container) ? containers : [...containers, container]
  const [attempt, setAttempt] = useState(0)
  const { readOnly } = useReadOnly()
  const [allowed] = useAccess([
    { verb: 'create', kind: 'Pod', namespace, name, subresource: 'exec' },
  ])
  const statuses: ContainerStatus[] = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.ephemeralContainerStatuses ?? []),
  ]
  const running = Boolean(statuses.find((s) => s.name === container)?.state?.running)

  let body
  if (readOnly) {
    body = (
      <EmptyState icon={SquareTerminal} title="Shells are off">
        {context} is read-only in KubeStacks, and a shell can change a container.
      </EmptyState>
    )
  } else if (allowed === false) {
    body = (
      <EmptyState icon={SquareTerminal} title="No shell access">
        Your account can’t open shells in {namespace}.
      </EmptyState>
    )
  } else if (!running) {
    body = (
      <EmptyState icon={SquareTerminal} title={`${container} isn’t running`}>
        A shell can start once the container runs.
      </EmptyState>
    )
  } else {
    body = (
      <Session
        key={`${container}#${attempt}`}
        request={{ context, namespace: namespace!, pod: name, container }}
        onReconnect={() => setAttempt(attempt + 1)}
        pod={pod}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-xs text-ink-2">
        <select
          aria-label="Container"
          value={container}
          onChange={(event) => setContainer(event.target.value)}
          className="h-7 max-w-48 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={!running || readOnly || allowed === false}
          onClick={() => setAttempt(attempt + 1)}
        >
          <RotateCw /> Reconnect
        </Button>
      </div>
      {body}
    </div>
  )
}

/**
 * Ready to type once connected: focus the terminal unless focus has moved out of
 * the panel, or the tabs are being browsed with the keyboard (arrows would get
 * stuck). Focus is on the body when what had it went away, like Reconnect.
 */
function takeFocus(host: HTMLElement, term: Terminal) {
  const active = document.activeElement!
  const browsing = active.getAttribute('role') === 'tab' && active.matches(':focus-visible')
  const here = active === document.body || host.closest('aside')!.contains(active)
  if (here && !browsing) term.focus()
}

function Session({
  request,
  pod,
  onReconnect,
}: {
  request: { context: string; namespace: string; pod: string; container: string }
  pod: KubeObject
  onReconnect: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>({ state: 'connecting' })
  const start = useActionsUi((state) => state.start)

  useEffect(() => {
    const id = crypto.randomUUID()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: theme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    let open = false
    const offData = api.terminal.onData((session, data) => {
      if (session === id) term.write(data)
    })
    const offExit = api.terminal.onExit((session, exit) => {
      if (session !== id) return
      open = false
      setPhase({ state: 'ended', exit })
    })
    const input = term.onData((data) => {
      if (open) api.terminal.write(id, data)
    })
    const resize = () => {
      fit.fit()
      if (open) api.terminal.resize(id, term.cols, term.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    void api.terminal.open(id, request).then((result) => {
      if (!result.ok) {
        setPhase({ state: 'failed', error: result.error.message })
        return
      }
      open = true
      setPhase({ state: 'open' })
      api.terminal.resize(id, term.cols, term.rows)
      takeFocus(host.current!, term)
    })
    return () => {
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      api.terminal.close(id)
      term.dispose()
    }
    // A new session starts when the container changes or on reconnect (the component's key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const noShell =
    phase.state === 'ended' && /executable file not found/.test(phase.exit.message ?? '')
  const ended =
    phase.state === 'failed'
      ? phase.error
      : phase.state === 'ended'
        ? noShell
          ? `${request.container} has no shell.`
          : phase.exit.code === undefined
            ? phase.exit.message!
            : `The shell exited with code ${phase.exit.code}.`
        : undefined

  return (
    // The terminal keeps the keys it handles (Escape for vi, less…) from reaching the panel.
    <div className="relative flex min-h-0 flex-1 flex-col bg-surface-2">
      {/* The terminal sits on its own layer, so its size can't feed back into the layout. */}
      <div
        role="region"
        aria-label={`Shell in ${request.container}`}
        aria-busy={phase.state === 'connecting'}
        className={cn('relative min-h-0 flex-1', ended && 'opacity-60')}
      >
        <div ref={host} className="absolute inset-0 px-3 py-2" />
      </div>
      {ended && (
        <div
          role="status"
          className="absolute inset-x-4 bottom-4 flex animate-rise items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-3 shadow-pop"
        >
          <p className="min-w-0 flex-1 text-[13px] text-ink-1">
            {ended}
            {noShell && (
              <span className="block text-xs text-ink-3">
                Images without a shell (like distroless ones) can be debugged with a debug
                container, which brings its own tools.
              </span>
            )}
          </p>
          {noShell && (
            <Button onClick={() => start('debug', pod)}>
              <Bug /> Debug
            </Button>
          )}
          <Button variant="primary" onClick={onReconnect}>
            <RotateCw /> Reconnect
          </Button>
        </div>
      )}
    </div>
  )
}
