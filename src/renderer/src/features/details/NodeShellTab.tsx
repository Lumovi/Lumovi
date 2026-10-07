import {
  CircleAlert,
  Play,
  RotateCw,
  Settings2,
  ShieldAlert,
  Square,
  SquareTerminal,
} from 'lucide-react'
import { useState } from 'react'
import { Tail } from '@renderer/components/Tail'
import { IMAGE_REFERENCE, isNodeShellSetting, NAMESPACE_NAME } from '@shared/node-shell'
import type { KubeObject, NodeShellRequest, NodeShellSetting } from '@shared/api'
import { nodeStatus } from '@shared/health'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/States'
import { useAccess } from '@renderer/hooks/access'
import {
  ADMINS_ONLY,
  useNodeShellSetting,
  useReadOnly,
  useSharedSettings,
} from '@renderer/hooks/settings'
import { kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { NotAllowed } from '../access/NotAllowed'
import { useAccessHere } from '../access/use-access'
import { ActionDialog } from '../actions/ActionDialog'
import { TerminalSession } from '../terminal/session'
import { TerminalNotice, TerminalView, usePhase } from '../terminal/TerminalView'

type Mode = NodeShellRequest['mode']

const MODES: { value: Mode; label: string }[] = [
  { value: 'node', label: 'On the node' },
  { value: 'pod', label: 'In the pod, with the node’s files' },
]

/** The command that does what a node shell does, by hand. */
function debugCommand(context: string, node: string, setting: NodeShellSetting, mode: Mode) {
  const shell =
    mode === 'node'
      ? [
          'nsenter',
          '--target',
          '1',
          '--mount',
          '--uts',
          '--ipc',
          '--net',
          '--pid',
          '--',
          'sh',
          '-l',
        ]
      : ['sh', '-l']
  // Its own flags before `--`: what comes after it is the command the pod runs.
  return `${kubectl(
    context,
    setting.namespace,
    'debug',
    `node/${node}`,
    '-it',
    '--image',
    setting.image,
    '--profile',
    'sysadmin',
  )} -- ${shell.join(' ')}`
}

/**
 * A shell on a node, through a privileged pod Lumovi starts there and deletes
 * once the shell ends: on the node itself (root, in its own namespaces), or in
 * the pod, with the node's files under /host. Nothing starts until asked.
 */
export function NodeShellTab({ node }: { node: KubeObject }) {
  const { context } = useCluster()
  const name = node.metadata.name
  const { readOnly, said } = useReadOnly()
  const { setting, off } = useNodeShellSetting()
  const [mode, setMode] = useState<Mode>('node')
  // A started shell (each start a new one), or none yet.
  /** The shell started, and the image it was started from. */
  const [attempt, setAttempt] = useState<{ n: number; mode: Mode; image: string } | null>(null)
  // Its settings, from the toolbar, or from a shell that failed (which, saved, starts over).
  const [editing, setEditing] = useState<'toolbar' | 'failure' | null>(null)
  // Its pod created, watched until it runs, a shell opened in it, and deleted.
  const [create, read, exec, remove] = useAccess([
    { verb: 'create', kind: 'Pod', namespace: setting.namespace },
    { verb: 'get', kind: 'Pod', namespace: setting.namespace },
    { verb: 'create', kind: 'Pod', namespace: setting.namespace, subresource: 'exec' },
    { verb: 'delete', kind: 'Pod', namespace: setting.namespace },
  ])
  const windows = node.status!.nodeInfo.operatingSystem === 'windows'
  const notAllowed = useAccessHere().whyNot('nodeShells', 'on')
  const start = (as: Mode) => {
    setMode(as)
    setAttempt({ n: (attempt?.n ?? 0) + 1, mode: as, image: setting.image })
  }

  let body
  if (notAllowed) {
    body = <NotAllowed title="You can’t open shells on nodes here" reason={notAllowed} />
  } else if (off) {
    body = (
      <EmptyState icon={SquareTerminal} title="Node shells are off">
        This Lumovi server turned them off.
      </EmptyState>
    )
  } else if (readOnly) {
    body = (
      <EmptyState icon={SquareTerminal} title="Shells are off">
        {said}, and a node shell can change the node.
      </EmptyState>
    )
  } else if (windows) {
    body = (
      <EmptyState icon={SquareTerminal} title="Node shells need a Linux node">
        {name} runs Windows, whose containers can’t share a node’s namespaces the way a node shell
        needs.
      </EmptyState>
    )
  } else if (create === false || read === false || exec === false) {
    body = (
      <EmptyState icon={SquareTerminal} title="No node shell access">
        Your account can’t create pods in {setting.namespace}, read them, or open shells in them. A
        node shell needs all three: ask for them, or choose another namespace in its settings.
      </EmptyState>
    )
  } else if (!attempt) {
    body = (
      <Explainer
        node={node}
        setting={setting}
        mode={mode}
        canDelete={remove !== false}
        onStart={() => start(mode)}
      />
    )
  } else {
    body = (
      <Session
        key={attempt.n}
        request={{ target: 'node', context, node: name, mode: attempt.mode }}
        image={attempt.image}
        onStart={start}
        onSettings={() => setEditing('failure')}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-xs text-ink-2">
        <select
          aria-label="Where"
          value={mode}
          disabled={attempt !== null}
          onChange={(event) => setMode(event.target.value as Mode)}
          className="h-7 max-w-64 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1 disabled:opacity-60"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        {attempt && (
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAttempt(null)}>
            <Square /> End
          </Button>
        )}
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing('toolbar')}>
          <Settings2 /> Settings
        </Button>
      </div>
      {body}
      {editing && (
        <NodeShellDialog
          node={name}
          mode={mode}
          onClose={(saved) => {
            setEditing(null)
            if (saved && editing === 'failure') setAttempt(null)
          }}
        />
      )}
    </div>
  )
}

/** What starting a shell does, before anything starts. */
function Explainer({
  node,
  setting,
  mode,
  canDelete,
  onStart,
}: {
  node: KubeObject
  setting: NodeShellSetting
  mode: Mode
  canDelete: boolean
  onStart: () => void
}) {
  const name = node.metadata.name
  const ready = nodeStatus(node).health !== 'critical'
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-12 text-center">
      <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-strong">
        <SquareTerminal className="size-5" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink-1">A shell on {name}</h3>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
        {mode === 'node'
          ? `Lumovi starts a privileged pod on ${name} and opens a shell in the node’s own namespaces: you’re root on the node.`
          : `Lumovi starts a privileged pod on ${name} and opens a shell in it, with the node’s files under /host.`}{' '}
        The pod is deleted when the shell ends.
      </p>
      <dl className="mt-5 grid w-full max-w-sm grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left text-xs">
        <dt className="text-ink-3">Pod</dt>
        <dd className="truncate font-mono text-ink-1">{setting.namespace}/lumovi-node-shell-…</dd>
        <dt className="text-ink-3">Image</dt>
        <dd className="min-w-0 font-mono text-ink-1">
          <Tail text={setting.image} />
        </dd>
        <dt className="text-ink-3">Access</dt>
        <dd className="text-ink-1">Privileged, with the node’s processes, network and files</dd>
      </dl>
      {(!ready || !canDelete) && (
        <ul className="mt-3 w-full max-w-sm space-y-1.5 text-left text-xs text-warn-text">
          {!ready && (
            <li className="flex gap-2">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {name} isn’t ready: its kubelet may not start the pod.
            </li>
          )}
          {!canDelete && (
            <li className="flex gap-2">
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              Your account can’t delete pods in {setting.namespace}: the pod stays until its 12-hour
              deadline.
            </li>
          )}
        </ul>
      )}
      <Button variant="primary" className="mt-6" onClick={onStart}>
        <Play /> Start shell
      </Button>
      <p className="mt-3 max-w-sm text-xs leading-relaxed text-ink-3">
        As <span className="font-mono">kubectl debug node</span> does: your RBAC and{' '}
        {setting.namespace}’s Pod Security decide whether it may.
      </p>
    </div>
  )
}

function Session({
  request,
  image,
  onStart,
  onSettings,
}: {
  request: NodeShellRequest
  image: string
  onStart: (mode: Mode) => void
  onSettings: () => void
}) {
  const [session] = useState(() => new TerminalSession(request))
  const phase = usePhase(session)
  // Before anything's typed (after, it's the last command's), how a shell on the node ends says
  // what it lacks. Nodes without a shell of their own (Talos, Bottlerocket): there's the pod's.
  const lacks = (code: number) =>
    phase.state === 'ended' && request.mode === 'node' && phase.exit.code === code && !session.typed
  const noShell = lacks(127)
  // An image without nsenter, which a shell on the node itself needs: another image has.
  const noNsenter = lacks(125)
  // An image without one (distroless, say): another image has.
  const noImageShell =
    phase.state === 'ended' && /executable file not found/.test(phase.exit.message ?? '')
  // What went wrong, for which settings may be the answer.
  const fixable = phase.state === 'failed' || noImageShell || noNsenter
  // Under it, once ended: why, and what became of its pod.
  const exit = phase.state === 'ended' ? phase.exit : undefined
  const detail =
    exit &&
    [
      noShell
        ? 'Talos and Bottlerocket nodes, say, have none. The pod’s shell has the node’s files under /host.'
        : noImageShell
          ? 'A node shell’s image needs sh, and nsenter for shells on the node itself: alpine has both.'
          : noNsenter
            ? 'A shell on the node itself runs the image’s nsenter: alpine has it. (A shell in the pod doesn’t need it.)'
            : undefined,
      exit.left ?? (noShell ? undefined : 'Its pod was deleted.'),
    ]
      .filter(Boolean)
      .join(' ')
  const ended =
    phase.state === 'failed'
      ? phase.error
      : phase.state === 'ended'
        ? noShell
          ? `${request.node} has no shell of its own.`
          : noImageShell
            ? `${image} has no shell.`
            : noNsenter
              ? `${image} has no nsenter.`
              : phase.exit.code === undefined
                ? phase.exit.message!
                : `The shell exited with code ${phase.exit.code}.`
        : undefined

  return (
    <TerminalView
      session={session}
      label={`Shell on ${request.node}`}
      focusWhenOpen
      dimmed={Boolean(ended)}
    >
      {ended && (
        <TerminalNotice
          detail={detail}
          actions={
            fixable ? (
              <>
                <Button onClick={onSettings}>
                  <Settings2 /> Settings
                </Button>
                <Button variant="primary" onClick={() => onStart(request.mode)}>
                  <RotateCw /> Try again
                </Button>
              </>
            ) : noShell ? (
              <Button variant="primary" onClick={() => onStart('pod')}>
                <SquareTerminal /> Shell in the pod
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onStart(request.mode)}>
                <RotateCw /> Start again
              </Button>
            )
          }
        >
          {ended}
        </TerminalNotice>
      )}
    </TerminalView>
  )
}

/** Where a cluster's node shells run: the namespace of their pods, and its image. */
function NodeShellDialog({
  node,
  mode,
  onClose,
}: {
  node: string
  mode: Mode
  /** Whether it saved. */
  onClose: (saved: boolean) => void
}) {
  const { context } = useCluster()
  const { setting, defaults, custom, set } = useNodeShellSetting()
  const { shared, mayChange } = useSharedSettings()
  const [namespace, setNamespace] = useState(setting.namespace)
  const [image, setImage] = useState(setting.image)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const next = { namespace: namespace.trim(), image: image.trim() }
  const valid = isNodeShellSetting(next)
  const save = async (value: NodeShellSetting | null) => {
    setPending(true)
    try {
      await set(value)
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
      return
    }
    toast({ tone: 'success', title: 'Node shell settings saved' })
    onClose(true)
  }
  const field =
    'h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft aria-invalid:border-critical'

  return (
    <ActionDialog
      icon={Settings2}
      title="Node shells"
      subject="Settings"
      command={debugCommand(context, node, valid ? next : setting, mode)}
      confirmLabel="Save"
      ready={valid && mayChange}
      pending={pending}
      error={mayChange ? error : ADMINS_ONLY}
      onClose={() => onClose(false)}
      onSubmit={() => void save(next)}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        A node shell runs in a privileged pod Lumovi starts on the node. Here’s where it’s created,
        and what it runs{shared ? ', the same for everyone on this server' : ''}.
      </p>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-ink-2">Namespace</span>
        <input
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
          aria-invalid={!NAMESPACE_NAME.test(next.namespace)}
          spellCheck={false}
          autoComplete="off"
          className={field}
        />
        <span className="block text-xs leading-relaxed text-ink-3">
          Its Pod Security must allow privileged pods, as kube-system’s usually does.
        </span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-ink-2">Image</span>
        <input
          value={image}
          onChange={(event) => setImage(event.target.value)}
          aria-invalid={!IMAGE_REFERENCE.test(next.image)}
          spellCheck={false}
          autoComplete="off"
          className={field}
        />
        <span className="block text-xs leading-relaxed text-ink-3">
          With a shell, and nsenter for shells on the node itself (alpine has both). Where nodes
          can’t pull from Docker Hub, a copy in your own registry.
        </span>
      </label>
      {custom && mayChange && (
        <button
          type="button"
          onClick={() => void save(null)}
          className="text-xs text-accent hover:underline"
        >
          Use the defaults: {defaults.namespace}, {defaults.image}
        </button>
      )}
    </ActionDialog>
  )
}
