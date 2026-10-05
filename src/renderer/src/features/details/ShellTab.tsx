import { Bug, RotateCw, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/States'
import { useAccess } from '@renderer/hooks/access'
import { useReadOnly } from '@renderer/hooks/settings'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { TerminalSession } from '../terminal/session'
import { TerminalNotice, TerminalView, usePhase } from '../terminal/TerminalView'

interface ContainerStatus {
  name: string
  state?: { running?: unknown }
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
        {context} is read-only in Lumovi, and a shell can change a container.
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

function Session({
  request,
  pod,
  onReconnect,
}: {
  request: { context: string; namespace: string; pod: string; container: string }
  pod: KubeObject
  onReconnect: () => void
}) {
  // A new session (a new shell) when the container changes, or on reconnect: the component's key.
  const [session] = useState(() => new TerminalSession({ target: 'container', ...request }))
  const phase = usePhase(session)
  const start = useActionsUi((state) => state.start)

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
    <TerminalView
      session={session}
      label={`Shell in ${request.container}`}
      focusWhenOpen
      dimmed={Boolean(ended)}
    >
      {ended && (
        <TerminalNotice
          detail={
            noShell &&
            'Images without a shell (like distroless ones) can be debugged with a debug container, which brings its own tools.'
          }
          actions={
            <>
              {noShell && (
                <Button onClick={() => start('debug', pod)}>
                  <Bug /> Debug
                </Button>
              )}
              <Button variant="primary" onClick={onReconnect}>
                <RotateCw /> Reconnect
              </Button>
            </>
          }
        >
          {ended}
        </TerminalNotice>
      )}
    </TerminalView>
  )
}
