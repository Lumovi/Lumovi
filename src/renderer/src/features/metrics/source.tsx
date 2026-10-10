import { useLayout } from '@renderer/lib/layout'
import { ChartSpline, PackagePlus, RotateCw, Settings2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { HistorySource, MetricsService, MetricsStack } from '@shared/api'
import { METRICS_STACK } from '@shared/metrics-stack'
import { Button } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { useHistorySource, useMetricsStack, useResetSource } from '@renderer/hooks/history'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { InstallStackDialog, RemoveStackDialog } from './StackDialogs'

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
  // On a phone it says where history comes from, and isn't for changing that.
  const phone = useLayout() === 'phone'
  return (
    <button
      type="button"
      disabled={phone}
      onClick={() => open(true)}
      title={phone ? undefined : 'Change the metrics source'}
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
      `Lumovi looked for Prometheus and VictoriaMetrics among the services of ${context} and found neither. If yours runs in the cluster under another name, choose its service.`,
  },
  off: {
    title: 'Usage history is off',
    body: (context) => `Lumovi shows only live usage for ${context}, from the metrics API.`,
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
  const [installing, setInstalling] = useState(false)
  const phone = useLayout() === 'phone'
  // Lumovi's own stack is offered where nothing was found; once installed, it's waited for.
  const found = source.data?.state
  const stack = useMetricsStack(found === 'missing' || found === 'error').data
  const starting = found !== 'ready' && stack?.state === 'installed'
  const up = starting && stack.ready === true
  useEffect(() => {
    // Its Prometheus is up: history is looked for again until it answers, and the charts come.
    if (!up) return
    void reset()
    const again = setInterval(() => void reset(), 5_000)
    return () => clearInterval(again)
    // Only as it comes up: `reset` is made anew with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up])
  // Looking for a source answers rather than fails: a problem is a state of its own.
  if (!source.data) return <Loading label="Looking for Prometheus…" />
  if (source.data.state === 'ready') return children
  const { state } = source.data
  // Until it's up; once it is, what looking for it says (that it can't be reached, say) shows.
  const chosen = source.data.state === 'error' && source.data.configured
  if (starting && !chosen && (!stack.ready || state === 'missing')) {
    return <Starting stack={stack} compact={compact} />
  }
  // Offered where there's none, unless a policy says no (then it isn't mentioned).
  const offer =
    state === 'missing' && stack?.state !== 'installed' && stack?.off?.reason !== 'policy'
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
      {offer && stack && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          {phone
            ? 'Lumovi can install a small one, from a larger screen.'
            : stack.off
              ? stack.off.reason === 'admins'
                ? `Lumovi can install a small one. ${stack.off.message}`
                : 'Lumovi can install a small one, once the cluster isn’t read-only.'
              : 'Or let Lumovi install a small one: you review everything it makes first.'}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {offer && stack && !stack.off && !phone && (
          <Button variant="primary" onClick={() => setInstalling(true)}>
            <PackagePlus /> Install a metrics stack…
          </Button>
        )}
        {!phone && (
          <Button onClick={() => open(true)}>
            <Settings2 /> {state === 'off' ? 'Change' : 'Choose a service'}
          </Button>
        )}
        {state !== 'off' && (
          <Button variant="ghost" disabled={looking} onClick={() => void again()}>
            <RotateCw className={cn(looking && 'animate-spin')} /> Look again
          </Button>
        )}
      </div>
      {installing && stack && (
        <InstallStackDialog stack={stack} onClose={() => setInstalling(false)} />
      )}
    </div>
  )
}

/**
 * Lumovi's metrics stack, installed and not answering yet: starting, while it may be; then what
 * keeps it (as its pods say, or that it's taking long), and the way to take it out again.
 */
function Starting({ stack, compact }: { stack: MetricsStack; compact: boolean }) {
  const [removing, setRemoving] = useState(false)
  const phone = useLayout() === 'phone'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(tick)
  }, [])
  const late =
    stack.installedAt !== undefined &&
    now - Date.parse(stack.installedAt) > METRICS_STACK.startsWithinMs
  const stuck = !stack.ready && (Boolean(stack.problems?.length) || late)
  return (
    <div
      role={stuck ? 'alert' : undefined}
      className={cn(
        'mx-auto flex max-w-md animate-rise flex-col items-center text-center',
        compact ? 'py-10' : 'py-16',
      )}
    >
      {stuck ? (
        <>
          <div className="mb-4 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
            <ChartSpline className="size-5" />
          </div>
          <h3 className="text-[15px] font-semibold text-ink-1">The metrics stack isn’t starting</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            {stack.problems?.length
              ? `Lumovi installed it in ${stack.namespace}, but the cluster isn’t running it:`
              : `Lumovi installed it in ${stack.namespace}, and it still isn’t up. Its pods don’t say why yet: look at them in ${stack.namespace}.`}
          </p>
          {stack.problems?.map((problem) => (
            <p
              key={problem}
              className="mt-2 max-w-full rounded-md bg-surface-3 px-2.5 py-1.5 text-left font-mono text-xs break-words text-ink-2 selectable"
            >
              {problem}
            </p>
          ))}
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Lumovi keeps checking. Removing it takes all of it out of the cluster again.
          </p>
          {stack.off?.reason !== 'policy' && !phone && (
            <div className="mt-5">
              <Button onClick={() => setRemoving(true)}>Remove…</Button>
            </div>
          )}
        </>
      ) : (
        <>
          <Loading label="The metrics stack is starting…" />
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            The cluster is pulling its images and starting Prometheus in {stack.namespace}. Charts
            fill in a minute or two after it’s up.
          </p>
        </>
      )}
      {removing && <RemoveStackDialog stack={stack} onClose={() => setRemoving(false)} />}
    </div>
  )
}
