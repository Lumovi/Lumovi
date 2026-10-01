import { ChartSpline, RotateCw, Settings2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { HistorySource, MetricsService } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { useHistorySource, useResetSource } from '@renderer/hooks/history'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'

export const FLAVOR_NAMES = { prometheus: 'Prometheus', victoriametrics: 'VictoriaMetrics' }

export const serviceName = (service: MetricsService) => `${service.namespace}/${service.service}`

/** The proxy path kubectl can GET to ask a source a question. */
export const proxyPath = (service: MetricsService, query = 'up') =>
  `/api/v1/namespaces/${service.namespace}/services/${service.service}:${service.port}/proxy${service.path}/api/v1/query?query=${query}`

/** Where history comes from, as a chip that opens the source settings. */
export function SourceChip({ className }: { className?: string }) {
  // Shown only where the gate has let charts through, so there is a source.
  const source = useHistorySource().data as Extract<HistorySource, { state: 'ready' }>
  const open = useUi((ui) => ui.setMetricsSource)
  return (
    <button
      type="button"
      onClick={() => open(true)}
      title="Change the metrics source"
      className={cn(
        'flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink-1',
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-good" />
      <span className="shrink-0 font-medium">
        {FLAVOR_NAMES[source.flavor]}
        {source.version && ` ${source.version}`}
      </span>
      <span className="truncate text-ink-3">{serviceName(source.service)}</span>
    </button>
  )
}

const COPY: Record<
  Exclude<HistorySource['state'], 'ready'>,
  { title: string; body: (context: string) => string }
> = {
  missing: {
    title: 'No Prometheus found',
    body: (context) =>
      `KubeStacks looked for Prometheus and VictoriaMetrics among the services of ${context} and found neither. If yours runs in the cluster under another name, choose its service.`,
  },
  off: {
    title: 'Usage history is off',
    body: (context) => `KubeStacks shows only live usage for ${context}, from the metrics API.`,
  },
  error: {
    title: 'Can’t read usage history',
    body: () => 'The metrics source didn’t answer.',
  },
}

/** Shows `children` once the cluster has a working history source, and what to do if not. */
export function HistoryGate({
  children,
  compact = false,
}: {
  children: ReactNode
  compact?: boolean
}) {
  const { context } = useCluster()
  const source = useHistorySource()
  const reset = useResetSource()
  const open = useUi((ui) => ui.setMetricsSource)
  const [looking, setLooking] = useState(false)
  // Looking for a source answers rather than fails: a problem is a state of its own.
  if (!source.data) return <Loading label="Looking for Prometheus…" />
  if (source.data.state === 'ready') return children
  const { state } = source.data
  const again = async () => {
    setLooking(true)
    await reset()
    setLooking(false)
  }
  return (
    <div
      role={state === 'error' ? 'alert' : undefined}
      className={cn(
        'mx-auto flex max-w-md animate-rise flex-col items-center text-center',
        compact ? 'py-10' : 'py-16',
      )}
    >
      <div className="mb-4 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
        <ChartSpline className="size-5" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink-1">{COPY[state].title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{COPY[state].body(context)}</p>
      {source.data.state === 'error' && (
        <p className="mt-3 max-w-full rounded-md bg-surface-3 px-2.5 py-1.5 font-mono text-xs break-words text-ink-2 selectable">
          {source.data.message}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <Button onClick={() => open(true)}>
          <Settings2 /> {state === 'off' ? 'Change' : 'Choose a service'}
        </Button>
        {state !== 'off' && (
          <Button variant="ghost" disabled={looking} onClick={() => void again()}>
            <RotateCw className={cn(looking && 'animate-spin')} /> Look again
          </Button>
        )}
      </div>
    </div>
  )
}
