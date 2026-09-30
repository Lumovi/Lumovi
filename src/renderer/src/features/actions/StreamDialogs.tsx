import { Bug, Cable } from 'lucide-react'
import { useState } from 'react'
import type { ForwardKind } from '@shared/api'
import { Stepper } from '@renderer/components/Stepper'
import { useChange } from '@renderer/hooks/change'
import { useOpenObject } from '@renderer/hooks/open-object'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { ActionDialog, useSubmit } from './ActionDialog'
import { subjectOf, target, type ActionProps } from './common'

const IMAGES = [
  { image: 'busybox:1.37', note: 'Small: sh, ps, top, wget, nslookup' },
  { image: 'nicolaka/netshoot:v0.14', note: 'Networking: curl, dig, tcpdump, iperf and more' },
  { image: 'alpine:3.22', note: 'apk, to install what you need' },
]

/** `kubectl debug -it --target`: a container with tools, next to the pod's own. */
export function DebugDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const openObject = useOpenObject()
  const showTab = useActionsUi((state) => state.showTab)
  const { name, namespace } = object.metadata
  const containers: string[] = object.spec.containers.map((c: { name: string }) => c.name)
  const [image, setImage] = useState(IMAGES[0]!.image)
  const [custom, setCustom] = useState('')
  const [share, setShare] = useState(containers[0]!)
  const [container] = useState(() => `debugger-${Math.random().toString(36).slice(2, 7)}`)
  const chosen = image === 'custom' ? custom.trim() : image
  const { pending, error, submit } = useSubmit(() => {
    // The shell opens in the new container once it runs.
    openObject('Pod', name, namespace)
    showTab(formatRef({ kind: 'Pod', name, namespace }), 'shell', container)
    onClose()
  })
  const command = kubectl(
    context,
    namespace,
    'debug',
    '-it',
    name,
    `--image=${chosen}`,
    `--container=${container}`,
    ...(share ? [`--target=${share}`] : []),
  )
  return (
    <ActionDialog
      icon={Bug}
      title={`Debug ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Start debugging"
      wide
      ready={chosen !== ''}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: { action: 'debug', container, image: chosen, target: share || undefined },
            },
            { title: `Started ${container} in ${name}`, command },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Adds a temporary container with tools to the running pod and opens a shell in it. It stays
        until the pod is replaced; the pod’s own containers aren’t restarted.
      </p>
      <div role="radiogroup" aria-label="Image" className="space-y-1.5">
        {[...IMAGES, { image: 'custom', note: '' }].map((option) => (
          <label
            key={option.image}
            className={cn(
              'flex cursor-default items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
              image === option.image ? 'border-accent bg-accent-soft/60' : 'border-line',
            )}
          >
            <input
              type="radio"
              name="image"
              checked={image === option.image}
              onChange={() => setImage(option.image)}
              className="accent-[var(--accent)]"
            />
            {option.image === 'custom' ? (
              <input
                aria-label="Other image"
                placeholder="Other image, e.g. ubuntu:24.04"
                value={custom}
                spellCheck={false}
                onFocus={() => setImage('custom')}
                onChange={(event) => setCustom(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 font-mono text-xs text-ink-1 outline-none focus:border-accent"
              />
            ) : (
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs text-ink-1">{option.image}</span>
                <span className="block text-xs text-ink-3">{option.note}</span>
              </span>
            )}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">
        Share processes with
        <select
          aria-label="Share processes with"
          value={share}
          onChange={(event) => setShare(event.target.value)}
          className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {containers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="">no container</option>
        </select>
      </label>
    </ActionDialog>
  )
}

interface Port {
  label: string
  port: number
}

/** The ports a pod's containers or a service expose, to pick from. */
function portsOf(object: ActionProps['object']): Port[] {
  const label = (...parts: unknown[]) => parts.filter(Boolean).join(' · ')
  if (object.kind === 'Service') {
    return object.spec.ports.map((p: { name?: string; port: number; targetPort: unknown }) => ({
      label: label(p.name, `${p.port} → ${String(p.targetPort)}`),
      port: p.port,
    }))
  }
  return object.spec.containers.flatMap(
    (c: { name: string; ports?: { name?: string; containerPort: number }[] }) =>
      (c.ports ?? []).map((p) => ({
        label: label(c.name, p.name, p.containerPort),
        port: p.containerPort,
      })),
  )
}

/** Ports below 1024 need root on many systems, so those get a nearby high one by default. */
const localFor = (port: number) => (port < 1024 ? port + 8000 : port)

/** `kubectl port-forward`: a local port that reaches a pod, or a service's pod. */
export function PortForwardDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const kind = object.kind as ForwardKind
  const { name, namespace } = object.metadata
  const ports = portsOf(object)
  const [port, setPort] = useState(ports[0]?.port ?? 8080)
  const [local, setLocal] = useState(localFor(port))
  const [browser, setBrowser] = useState(false)
  const { pending, error, submit } = useSubmit(onClose)
  const command = kubectl(
    context,
    namespace,
    'port-forward',
    `${kind.toLowerCase()}/${name}`,
    `${Number.isInteger(local) ? local : ''}:${port}`,
  )
  const pick = (next: number) => {
    setPort(next)
    setLocal(localFor(next))
  }

  return (
    <ActionDialog
      icon={Cable}
      title={`Forward a port to ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Start forwarding"
      ready={Number.isInteger(port) && Number.isInteger(local)}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(async () => {
          const result = await api.forwards.start({
            context,
            namespace: namespace!,
            kind,
            name,
            port,
            localPort: local,
          })
          if (result.ok) {
            const url = `http://localhost:${result.data.localPort}`
            if (browser) void api.app.openExternal(url)
            toast({
              tone: 'success',
              title: `Forwarding localhost:${result.data.localPort} to ${name}:${port}`,
              action: { label: 'Open', run: () => void api.app.openExternal(url) },
            })
          }
          return result
        })
      }
    >
      {ports.length > 0 && (
        <div role="radiogroup" aria-label="Port" className="space-y-1">
          {ports.map((p) => (
            <label
              key={p.label}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors',
                port === p.port
                  ? 'border-accent bg-accent-soft/60 text-ink-1'
                  : 'border-line text-ink-2',
              )}
            >
              <input
                type="radio"
                name="port"
                checked={port === p.port}
                onChange={() => pick(p.port)}
                className="accent-[var(--accent)]"
              />
              {p.label}
            </label>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">
            {kind === 'Service' ? 'Service port' : 'Pod port'}
          </p>
          <Stepper label="Remote port" value={port} onChange={pick} min={1} max={65_535} />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">On this computer</p>
          <Stepper label="Local port" value={local} onChange={setLocal} min={1} max={65_535} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">
        <input
          type="checkbox"
          checked={browser}
          onChange={(event) => setBrowser(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        Open http://localhost:{Number.isInteger(local) ? local : '…'} in the browser
      </label>
    </ActionDialog>
  )
}
