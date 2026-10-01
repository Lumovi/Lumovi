import { CircleCheck, CircleX, LoaderCircle, Settings2 } from 'lucide-react'
import { useState } from 'react'
import type { HistorySource, KubeObject, MetricsService, MetricsSourceSetting } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { useHistorySource, useResetSource } from '@renderer/hooks/history'
import { useList } from '@renderer/hooks/queries'
import { useSettings } from '@renderer/hooks/settings'
import { api, unwrap } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { useUi } from '@renderer/state/ui'
import { ActionDialog } from '../actions/ActionDialog'
import { FLAVOR_NAMES, proxyPath, serviceName } from './source'

type Mode = MetricsSourceSetting['mode']

/** The source settings for the current cluster: detection, a chosen service, or none. */
export function SourceDialog() {
  const open = useUi((ui) => ui.metricsSource)
  const setOpen = useUi((ui) => ui.setMetricsSource)
  return open ? <Dialog onClose={() => setOpen(false)} /> : null
}

const field =
  'h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

function Dialog({ onClose }: { onClose: () => void }) {
  const { context } = useCluster()
  const stored = useSettings().data?.metricsSource?.[context] ?? { mode: 'auto' as const }
  const source = useHistorySource().data
  const reset = useResetSource()
  const [mode, setMode] = useState<Mode>(stored.mode)
  // Start from the chosen service, or what was detected, or a likely namespace.
  const [service, setService] = useState<MetricsService>(
    stored.mode === 'service'
      ? stored.service
      : source?.state === 'ready'
        ? source.service
        : { namespace: 'monitoring', service: '', port: '', path: '' },
  )
  const [test, setTest] = useState<HistorySource | 'testing'>()
  const [pending, setPending] = useState(false)
  const change = (patch: Partial<MetricsService>) => {
    setService({ ...service, ...patch })
    setTest(undefined)
  }
  const complete = service.namespace !== '' && service.service !== '' && service.port !== ''

  const check = async () => {
    setTest('testing')
    const result = await unwrap(api.usage.test(context, service)).catch((e: Error) => ({
      state: 'error' as const,
      configured: true,
      message: e.message,
    }))
    setTest(result)
    return result
  }

  // A chosen service is saved only once it answers; the test's result says why not.
  const save = async () => {
    setPending(true)
    if (mode === 'service' && (await check()).state !== 'ready') {
      setPending(false)
      return
    }
    await reset(mode === 'service' ? { mode, service } : { mode })
    toast({ tone: 'success', title: 'Metrics source saved' })
    onClose()
  }

  const command =
    mode === 'off'
      ? kubectl(context, undefined, 'top', 'pods', '--all-namespaces')
      : mode === 'service' && complete
        ? kubectl(context, undefined, 'get', '--raw', proxyPath(service))
        : source?.state === 'ready'
          ? kubectl(context, undefined, 'get', '--raw', proxyPath(source.service))
          : kubectl(context, undefined, 'get', 'services', '--all-namespaces')

  return (
    <ActionDialog
      icon={Settings2}
      title="Metrics source"
      subject="Usage history"
      command={command}
      confirmLabel="Save"
      wide
      ready={mode !== 'service' || complete}
      pending={pending}
      onClose={onClose}
      onSubmit={() => void save()}
    >
      <div role="radiogroup" aria-label="Metrics source" className="space-y-2">
        <Option
          mode="auto"
          current={mode}
          onPick={setMode}
          title="Find it automatically"
          note={
            source?.state === 'ready' && !source.configured
              ? `Found ${FLAVOR_NAMES[source.flavor]} at ${serviceName(source.service)}.`
              : 'Looks for Prometheus and VictoriaMetrics among the cluster’s services.'
          }
        />
        <Option
          mode="service"
          current={mode}
          onPick={setMode}
          title="Use a service"
          note="A Prometheus-compatible service in the cluster, reached through the API server."
        >
          {mode === 'service' && (
            <ServiceFields
              service={service}
              onChange={change}
              test={test}
              onTest={() => void check()}
            />
          )}
        </Option>
        <Option
          mode="off"
          current={mode}
          onPick={setMode}
          title="Don’t use history"
          note="Live usage only, from the metrics API."
        />
      </div>
    </ActionDialog>
  )
}

function Option({
  mode,
  current,
  onPick,
  title,
  note,
  children,
}: {
  mode: Mode
  current: Mode
  onPick: (mode: Mode) => void
  title: string
  note: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3 transition-colors',
        current === mode ? 'border-accent bg-accent-soft/50' : 'border-line',
      )}
    >
      <label className="flex cursor-default items-start gap-3">
        <input
          type="radio"
          name="source"
          checked={current === mode}
          onChange={() => onPick(mode)}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-ink-1">{title}</span>
          <span className="block text-xs leading-relaxed text-ink-3">{note}</span>
        </span>
      </label>
      {children}
    </div>
  )
}

/** Namespace, service and port: picked from the cluster when it lists them, typed otherwise. */
function ServiceFields({
  service,
  onChange,
  test,
  onTest,
}: {
  service: MetricsService
  onChange: (patch: Partial<MetricsService>) => void
  test: HistorySource | 'testing' | undefined
  onTest: () => void
}) {
  const namespaces = useList('Namespace', { namespace: null })
  const services = useList('Service', {
    namespace: service.namespace,
    enabled: service.namespace !== '',
  })
  const chosen = services.data?.find((s) => s.metadata.name === service.service)
  const ports: { name?: string; port: number }[] = chosen?.spec.ports ?? []
  const names = (items: KubeObject[] | undefined) => items?.map((o) => o.metadata.name)
  return (
    <div className="mt-3 grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 pl-7">
      <Field label="Namespace">
        <Choice
          label="Namespace"
          value={service.namespace}
          options={names(namespaces.data)}
          onChange={(namespace) => onChange({ namespace, service: '', port: '' })}
        />
      </Field>
      <Field label="Service">
        <Choice
          label="Service"
          value={service.service}
          options={names(services.data)}
          onChange={(name) => {
            const picked = services.data?.find((s) => s.metadata.name === name)
            const first = (picked?.spec.ports as { name?: string; port: number }[] | undefined)?.[0]
            onChange({ service: name, port: first ? (first.name ?? String(first.port)) : '' })
          }}
        />
      </Field>
      <Field label="Port">
        <Choice
          label="Port"
          value={service.port}
          options={chosen ? ports.map((p) => p.name ?? String(p.port)) : undefined}
          describe={(value) => {
            const port = ports.find((p) => (p.name ?? String(p.port)) === value)!
            return port.name ? `${port.name} · ${port.port}` : value
          }}
          onChange={(port) => onChange({ port })}
        />
      </Field>
      <div className="col-span-3">
        <Field label="Path">
          <input
            aria-label="Path"
            value={service.path}
            spellCheck={false}
            placeholder="Empty for Prometheus; /select/0/prometheus for vmselect"
            onChange={(event) => onChange({ path: event.target.value.trim() })}
            className={cn(field, 'font-mono text-xs')}
          />
        </Field>
      </div>
      <div className="col-span-3 flex items-center gap-3">
        <Button
          disabled={test === 'testing' || !service.namespace || !service.service || !service.port}
          onClick={onTest}
        >
          Test
        </Button>
        {test === 'testing' ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <LoaderCircle className="size-3.5 animate-spin" /> Asking {service.service}…
          </span>
        ) : test?.state === 'ready' ? (
          <span role="status" className="flex items-center gap-1.5 text-xs text-good-text">
            <CircleCheck className="size-3.5" /> Answered: {FLAVOR_NAMES[test.flavor]}
            {test.version && ` ${test.version}`}
          </span>
        ) : test?.state === 'error' ? (
          <span
            role="status"
            className="flex min-w-0 items-start gap-1.5 text-xs text-critical-text"
          >
            <CircleX className="mt-px size-3.5 shrink-0" />
            <span className="break-words">{test.message}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-ink-2">{label}</p>
      {children}
    </div>
  )
}

/** A select of what the cluster lists, or a text field when it can't (or doesn't) list them. */
function Choice({
  label,
  value,
  options,
  describe = (option) => option,
  onChange,
}: {
  label: string
  value: string
  options: string[] | undefined
  describe?: (option: string) => string
  onChange: (value: string) => void
}) {
  if (!options) {
    return (
      <input
        aria-label={label}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value.trim())}
        className={field}
      />
    )
  }
  return (
    <select
      aria-label={label}
      value={options.includes(value) ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      className={field}
    >
      {!options.includes(value) && <option value="">Choose…</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {describe(option)}
        </option>
      ))}
    </select>
  )
}
