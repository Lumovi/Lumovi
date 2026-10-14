import { Bug, MonitorDot, Play, Plug, RotateCw, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KubeObject, PluginVia } from '@shared/api'
import { whose } from '@shared/plugins'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/States'
import { useAccess } from '@renderer/hooks/access'
import { useClusterName, useReadOnly } from '@renderer/hooks/settings'
import { useMoment } from '@renderer/lib/confirm-moment'
import { formatRef } from '@renderer/lib/routes'
import { cn } from '@renderer/lib/cn'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { useSession } from '@renderer/state/session'
import { TheirText } from '@renderer/plugins/TheirText'
import { NotAllowed } from '../access/NotAllowed'
import { useAccessHere } from '../access/use-access'
import { TerminalSession } from '../terminal/session'
import { TerminalNotice, TerminalView, usePhase } from '../terminal/TerminalView'

interface ContainerStatus {
  name: string
  state?: { running?: unknown }
}

/** What the tab opens in a container: a shell, or attached to its main process. */
type How = 'shell' | 'attach'

/**
 * A shell in one of a pod's containers, including debug containers added to it; or attached to a
 * container's main process (`kubectl attach -it`), as Attach asks.
 */
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
  const asked = useActionsUi((state) => (state.shell?.ref === ref ? state.shell : null))
  // (A container a plugin's link names that the pod hasn't is no choice: the tab opens as it
  // would, on the first. A debug container just added is listed, and waited for.)
  const requested =
    asked?.container !== undefined && (!asked.via || containers.includes(asked.container))
      ? asked.container
      : null
  const [container, setContainer] = useState(requested ?? containers[0]!)
  const [honored, setHonored] = useState(asked?.n)
  const [how, setHow] = useState<How>(asked?.how ?? 'shell')
  // Brought here by a plugin's link: nothing starts until the person presses Start, each time a
  // link asks anew; and the bar says whose page it was, as long as the tab is open.
  const [from, setFrom] = useState(asked?.via?.label)
  if (asked && asked.n !== honored) {
    setHonored(asked.n)
    // (A link's ask, each time anew: its container, or the first where the pod hasn't it.)
    if (requested || asked.via) setContainer(requested ?? containers[0]!)
    if (asked.via) setFrom(asked.via.label)
    setHow(asked.how ?? 'shell')
  }
  const waiting = asked?.via
  // (Said under the facts: the container a link named, where the pod hasn't it.)
  const missing =
    asked?.via && asked.container !== undefined && !containers.includes(asked.container)
      ? asked.container
      : undefined
  const [startedVia, setStartedVia] = useState<PluginVia>()
  const shellStarted = useActionsUi((state) => state.shellStarted)
  // Until the pod shows it, a new container is listed, and waited for.
  const choices = containers.includes(container) ? containers : [...containers, container]
  const [attempt, setAttempt] = useState(0)
  const { readOnly, said } = useReadOnly()
  const attach = how === 'attach'
  const [allowed] = useAccess([
    { verb: 'create', kind: 'Pod', namespace, name, subresource: attach ? 'attach' : 'exec' },
  ])
  // (Attaching is as a shell is, to Lumovi's access: what's typed goes into the container.)
  const notAllowed = useAccessHere().whyNot(
    'shells',
    'on',
    namespace,
    attach ? 'attach to containers' : undefined,
  )
  const statuses: ContainerStatus[] = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.ephemeralContainerStatuses ?? []),
  ]
  const running = Boolean(statuses.find((s) => s.name === container)?.state?.running)

  // (Where Lumovi wouldn't open a shell anyway, its own place says why, never the Start.)
  const startHere = waiting && !notAllowed && !readOnly && allowed !== false && running
  let body
  const Icon = attach ? MonitorDot : SquareTerminal
  if (notAllowed) {
    body = (
      <NotAllowed
        title={attach ? 'You can’t attach to containers here' : 'You can’t open shells here'}
        reason={notAllowed}
      />
    )
  } else if (readOnly) {
    body = attach ? (
      <EmptyState icon={Icon} title="Attaching is off">
        {said}, and what you type when attached goes to a container’s process.
      </EmptyState>
    ) : (
      <EmptyState icon={Icon} title="Shells are off">
        {said}, and a shell can change a container.
      </EmptyState>
    )
  } else if (allowed === false) {
    body = attach ? (
      <EmptyState icon={Icon} title="No attach access">
        Your account can’t attach to containers in {namespace}.
      </EmptyState>
    ) : (
      <EmptyState icon={Icon} title="No shell access">
        Your account can’t open shells in {namespace}.
      </EmptyState>
    )
  } else if (!running) {
    body = (
      <EmptyState icon={Icon} title={`${container} isn’t running`}>
        {attach
          ? 'You can attach once the container runs.'
          : 'A shell can start once the container runs.'}
      </EmptyState>
    )
  } else if (startHere && !attach) {
    body = (
      <StartFromLink
        key={asked.n}
        pod={name}
        via={waiting}
        container={container}
        {...(missing ? { missing } : {})}
        choices={choices}
        onContainer={setContainer}
        onStart={() => {
          setStartedVia({ plugin: waiting.plugin, version: waiting.version, label: waiting.label })
          shellStarted(ref)
        }}
      />
    )
  } else {
    body = (
      <Session
        key={`${how}#${container}#${attempt}`}
        how={how}
        request={{
          context,
          namespace: namespace!,
          pod: name,
          container,
          ...(startedVia && !attach ? { via: startedVia } : {}),
        }}
        onReconnect={() => setAttempt(attempt + 1)}
        pod={pod}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b border-line px-5 py-2 text-xs text-ink-2">
        {!startHere && <ShellOrAttach how={how} onHow={setHow} />}
        {!startHere && (
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
        )}
        {from !== undefined && (
          <span data-shell-via className="flex min-w-0 items-center gap-1.5 text-ink-3">
            <Plug className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Opened from {whose(from)} page</span>
          </span>
        )}
        <span className="flex-1" />
        {!startHere && (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={!running || readOnly || allowed === false || Boolean(notAllowed)}
            onClick={() => setAttempt(attempt + 1)}
          >
            <RotateCw /> Reconnect
          </Button>
        )}
      </div>
      {body}
    </div>
  )
}

/**
 * A shell a plugin's link asked for, before anything starts: what it would be, and Start, which
 * only the person presses. Start is never where the focus starts (the container is, or the
 * heading), Enter doesn't press it, and a press in its first moment is dropped: a press meant for
 * the plugin's link, under the pointer, can't land on it.
 */
function StartFromLink({
  pod,
  via,
  container,
  missing,
  choices,
  onContainer,
  onStart,
}: {
  pod: string
  via: PluginVia
  container: string
  /** The container the link named, where the pod hasn't it (another is picked). */
  missing?: string
  choices: string[]
  onContainer: (container: string) => void
  onStart: () => void
}) {
  const { context } = useCluster()
  const named = useClusterName()(context)
  const session = useSession()
  const live = useMoment(`${pod}\u0000${via.plugin}`)
  const first = useRef<HTMLSelectElement & HTMLHeadingElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <div
      data-shell-start
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-12 text-center"
    >
      <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-strong">
        <SquareTerminal className="size-5" />
      </div>
      <h3
        ref={choices.length > 1 ? undefined : first}
        tabIndex={-1}
        className="text-[15px] font-semibold text-ink-1 outline-none"
      >
        A shell in {pod}
      </h3>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
        {whose(via.label)} page opened this tab. A shell starts only when you press Start: as you,
        within your access.
      </p>
      <dl className="mt-5 grid w-full max-w-sm grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left text-xs">
        <dt className="text-ink-3">Container</dt>
        <dd className="min-w-0">
          <select
            ref={choices.length > 1 ? first : undefined}
            aria-label="Container"
            value={container}
            onChange={(event) => onContainer(event.target.value)}
            className="h-7 max-w-full rounded-md border border-line bg-surface px-1.5 text-xs text-ink-1"
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </dd>
        <dt className="text-ink-3">As</dt>
        {/* (Whole, however long: a context is often an ARN, a name an email.) */}
        <dd
          className="min-w-0 [overflow-wrap:anywhere] text-ink-1"
          // (The cluster as Lumovi names it; its kubeconfig's context, where that's another name.)
          {...(!session && named !== context ? { title: context } : {})}
        >
          {session
            ? `${session.user.name}, with your RBAC`
            : `Your kubeconfig’s user for ${named}, with its RBAC`}
        </dd>
        <dt className="text-ink-3">Runs</dt>
        <dd className="text-ink-1">bash, or sh where there’s no bash</dd>
      </dl>
      {missing !== undefined && (
        <p
          data-shell-missing
          className="mt-2 max-w-sm text-xs leading-relaxed [overflow-wrap:anywhere] text-ink-3"
        >
          {whose(via.label)} page asked for a container named{' '}
          <TheirText text={{ their: missing }} inline />, which this pod doesn’t have.
        </p>
      )}
      <Button
        variant="primary"
        className="mt-6"
        aria-disabled={!live}
        onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
        onClick={() => live && onStart()}
      >
        <Play /> Start shell
      </Button>
      <p className="mt-3 max-w-sm text-xs leading-relaxed text-ink-3">
        A plugin’s page can bring you here, never start a shell. Opening the Shell tab yourself
        starts one at once, as always.
      </p>
    </div>
  )
}

/** Shell | Attach: what the tab opens in the container, as the charts' segmented control. */
function ShellOrAttach({ how, onHow }: { how: How; onHow: (how: How) => void }) {
  const choices = [
    { id: 'shell', label: 'Shell', Icon: SquareTerminal },
    { id: 'attach', label: 'Attach', Icon: MonitorDot },
  ] as const
  return (
    <div
      role="group"
      aria-label="Shell or attach"
      className="flex shrink-0 rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {choices.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={how === id}
          title={id === 'attach' ? 'To its main process, as kubectl attach -it' : undefined}
          onClick={() => onHow(id)}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-2 transition-colors hover:text-ink-1 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-[0_0_0_1px_var(--line-strong)]',
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}

function Session({
  how,
  request,
  pod,
  onReconnect,
}: {
  how: How
  request: { context: string; namespace: string; pod: string; container: string }
  pod: KubeObject
  onReconnect: () => void
}) {
  // A new session (a new shell, or attached anew) when the container changes, or on reconnect:
  // the component's key.
  const [session] = useState(
    () =>
      new TerminalSession(
        how === 'attach'
          ? {
              target: 'attach',
              context: request.context,
              namespace: request.namespace,
              pod: request.pod,
              container: request.container,
            }
          : { target: 'container', ...request },
      ),
  )
  const phase = usePhase(session)
  const start = useActionsUi((state) => state.start)

  const noShell =
    how === 'shell' &&
    phase.state === 'ended' &&
    /executable file not found/.test(phase.exit.message ?? '')
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
      label={
        how === 'attach' ? `Attached to ${request.container}` : `Shell in ${request.container}`
      }
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
