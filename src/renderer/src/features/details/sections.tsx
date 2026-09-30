import { Check, Eye, EyeOff, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ContainerUsage, KubeObject } from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { Meter } from '@renderer/components/Meter'
import { StatusDot } from '@renderer/components/Status'
import { age, formatBytes, formatCpu, percent } from '@renderer/lib/format'
import type { Health } from '@renderer/lib/health'
import { allocatable } from '@renderer/lib/usage'
import { MASK } from './YamlTab'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <h3 className="mb-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">{title}</h3>
      {children}
    </section>
  )
}

export function KeyValueGrid({ entries }: { entries: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2 text-[13px]">
      {entries.map((entry) => (
        <div key={entry.label} className="contents">
          <dt className="text-ink-3">{entry.label}</dt>
          <dd className="min-w-0 break-words text-ink-1 selectable">{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ——— Pods ———

interface ContainerSpec {
  name: string
  image: string
  ports?: { containerPort: number; protocol: string; name?: string }[]
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
}

interface ContainerState {
  name: string
  ready: boolean
  restartCount: number
  state: {
    running?: { startedAt: string }
    waiting?: { reason: string; message?: string }
    terminated?: { reason: string; exitCode: number; finishedAt?: string }
  }
  lastState?: { terminated?: { reason: string; exitCode: number; finishedAt?: string } }
}

function describeState(status: ContainerState | undefined): {
  health: Health
  text: string
  detail?: string
} {
  const state = status?.state
  if (state?.running) {
    return status!.ready
      ? { health: 'healthy', text: `Running for ${age(state.running.startedAt)}` }
      : { health: 'warning', text: `Running for ${age(state.running.startedAt)}, not ready` }
  }
  if (state?.waiting)
    return { health: 'critical', text: state.waiting.reason, detail: state.waiting.message }
  if (state?.terminated) {
    const { reason, exitCode } = state.terminated
    return {
      health: exitCode === 0 ? 'neutral' : 'critical',
      text: `${reason} (exit code ${exitCode})`,
    }
  }
  return { health: 'neutral', text: 'Not started' }
}

function resourceText(values: Record<string, string> | undefined, key: 'cpu' | 'memory'): string {
  const value = values?.[key]
  if (!value) return '—'
  return key === 'cpu' ? formatCpu(parseQuantity(value)) : formatBytes(parseQuantity(value))
}

export function Containers({ pod, usage }: { pod: KubeObject; usage?: ContainerUsage[] }) {
  const statuses: ContainerState[] = [
    ...(pod.status.initContainerStatuses ?? []),
    ...(pod.status.containerStatuses ?? []),
  ]
  const specs: (ContainerSpec & { init: boolean })[] = [
    ...(pod.spec.initContainers ?? []).map((c: ContainerSpec) => ({ ...c, init: true })),
    ...pod.spec.containers.map((c: ContainerSpec) => ({ ...c, init: false })),
  ]
  return (
    <div className="space-y-2">
      {specs.map((spec) => {
        const status = statuses.find((s) => s.name === spec.name)
        const state = describeState(status)
        const live = usage?.find((u) => u.name === spec.name)
        const last = status?.lastState?.terminated
        return (
          <article
            key={spec.name}
            aria-label={`Container ${spec.name}`}
            className="rounded-xl border border-line bg-surface-2 p-3.5"
          >
            <header className="flex items-center gap-2.5">
              <StatusDot health={state.health} />
              <h4 className="font-semibold text-ink-1">{spec.name}</h4>
              {spec.init && (
                <span className="rounded bg-surface-3 px-1.5 text-2xs font-medium text-ink-2">
                  init
                </span>
              )}
              <span className="flex-1" />
              <span className="text-xs text-ink-3 tabular-nums">
                {status?.restartCount ?? 0} restarts
              </span>
            </header>
            <p
              className="mt-1.5 truncate font-mono text-xs text-ink-2 selectable"
              title={spec.image}
            >
              {spec.image}
            </p>
            <p className="mt-2 text-[13px] text-ink-1">{state.text}</p>
            {state.detail && (
              <p className="mt-0.5 text-xs leading-relaxed text-ink-2 selectable">{state.detail}</p>
            )}
            {last && (
              <p className="mt-1 text-xs text-ink-3">
                Last terminated: {last.reason} (exit code {last.exitCode})
              </p>
            )}
            <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
              {(['cpu', 'memory'] as const).map((key) => (
                <div key={key}>
                  <dt className="text-ink-3">{key === 'cpu' ? 'CPU' : 'Memory'}</dt>
                  <dd className="mt-0.5 text-ink-1 tabular-nums">
                    {live ? (key === 'cpu' ? formatCpu(live.cpu) : formatBytes(live.memory)) : '—'}
                    <span className="text-ink-3">
                      {' '}
                      · req {resourceText(spec.resources?.requests, key)} · lim{' '}
                      {resourceText(spec.resources?.limits, key)}
                    </span>
                  </dd>
                </div>
              ))}
              <div>
                <dt className="text-ink-3">Ports</dt>
                <dd className="mt-0.5 font-mono text-ink-1">
                  {spec.ports?.map((p) => `${p.containerPort}/${p.protocol}`).join(', ') || '—'}
                </dd>
              </div>
            </dl>
          </article>
        )
      })}
    </div>
  )
}

// ——— Nodes ———

export function NodeCapacity({
  node,
  usage,
}: {
  node: KubeObject
  usage?: { cpu: number; memory: number }
}) {
  const alloc = allocatable(node)
  const rows = [
    {
      label: 'CPU',
      used: usage?.cpu,
      total: alloc.cpu,
      format: (v: number) => `${formatCpu(v)} cores`,
    },
    { label: 'Memory', used: usage?.memory, total: alloc.memory, format: formatBytes },
  ]
  return (
    <div className="space-y-3.5">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
            <span className="text-ink-2">{row.label}</span>
            <span className="text-xs text-ink-3 tabular-nums">
              {row.used === undefined ? (
                `${row.format(row.total)} allocatable`
              ) : (
                <>
                  <span className="font-medium text-ink-1">{percent(row.used / row.total)}</span> ·{' '}
                  {row.format(row.used)} of {row.format(row.total)}
                </>
              )}
            </span>
          </div>
          <Meter value={(row.used ?? 0) / row.total} label={`${row.label} usage`} />
        </div>
      ))}
      <p className="text-xs text-ink-3">Up to {alloc.pods} pods can be scheduled on this node.</p>
    </div>
  )
}

export function Taints({ taints }: { taints: { key: string; value?: string; effect: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {taints.map((t) => (
        <li
          key={`${t.key}:${t.effect}`}
          className="rounded-md bg-warn/10 px-2 py-0.5 font-mono text-xs text-warn-text"
        >
          {t.key}
          {t.value && `=${t.value}`}:{t.effect}
        </li>
      ))}
    </ul>
  )
}

// ——— Networking ———

export function ServicePorts({ service }: { service: KubeObject }) {
  const ports: {
    name?: string
    port: number
    targetPort: number | string
    nodePort?: number
    protocol: string
  }[] = service.spec.ports ?? []
  return (
    <SimpleTable
      headers={['Name', 'Port', 'Target', 'Node port', 'Protocol']}
      rows={ports.map((p) => [p.name ?? '—', p.port, p.targetPort, p.nodePort ?? '—', p.protocol])}
    />
  )
}

export function IngressRules({ ingress }: { ingress: KubeObject }) {
  type Path = {
    path?: string
    backend: { service: { name: string; port: { number?: number; name?: string } } }
  }
  const rows = (ingress.spec.rules as { host?: string; http: { paths: Path[] } }[]).flatMap(
    (rule) =>
      rule.http.paths.map((p) => [
        rule.host ?? '*',
        p.path ?? '/',
        `${p.backend.service.name}:${p.backend.service.port.number ?? p.backend.service.port.name}`,
      ]),
  )
  return <SimpleTable headers={['Host', 'Path', 'Backend']} rows={rows} />
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-surface-2 text-2xs tracking-wider text-ink-3 uppercase">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 font-mono text-xs text-ink-1 selectable">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ——— Status ———

export function Conditions({
  conditions,
}: {
  conditions: {
    type: string
    status: string
    reason?: string
    message?: string
    lastTransitionTime?: string
  }[]
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {conditions.map((c) => {
        const ok = c.status === 'True'
        return (
          <li key={c.type} className="flex gap-3 px-3.5 py-2.5">
            {ok ? (
              <Check className="mt-0.5 size-4 shrink-0 text-good" />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-ink-3" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-ink-1">{c.type}</span>
                <span className="text-xs text-ink-3">{c.reason}</span>
                <span className="flex-1" />
                {c.lastTransitionTime && (
                  <span className="text-xs text-ink-3">{age(c.lastTransitionTime)} ago</span>
                )}
              </div>
              {c.message && (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-2 selectable">{c.message}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function Labels({ labels }: { labels: Record<string, string> }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {Object.entries(labels).map(([key, value]) => (
        <li
          key={key}
          className="max-w-full truncate rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs selectable"
        >
          <span className="text-ink-3">{key}=</span>
          <span className="text-ink-1">{value}</span>
        </li>
      ))}
    </ul>
  )
}

// ——— Config ———

function decode(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** ConfigMap and Secret data. Secret values are decoded but hidden until revealed. */
export function DataEntries({ data, secret }: { data: Record<string, string>; secret: boolean }) {
  return (
    <div className="space-y-2">
      {Object.entries(data).map(([key, value]) => (
        <DataEntry key={key} name={key} value={secret ? decode(value) : value} secret={secret} />
      ))}
    </div>
  )
}

function DataEntry({ name, value, secret }: { name: string; value: string; secret: boolean }) {
  const [revealed, setRevealed] = useState(!secret)
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center gap-2 bg-surface-2 py-1 pr-1 pl-3">
        <span className="flex-1 truncate font-mono text-xs font-medium text-ink-1">{name}</span>
        {secret && (
          <IconButton
            label={revealed ? `Hide ${name}` : `Reveal ${name}`}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </IconButton>
        )}
        <CopyButton text={value} label={`Copy ${name}`} />
      </div>
      <pre className="max-h-72 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-1 selectable">
        {revealed ? value : MASK}
      </pre>
    </div>
  )
}
