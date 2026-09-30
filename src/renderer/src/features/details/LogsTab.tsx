import { useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { CopyButton } from '@renderer/components/CopyButton'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { api, unwrap, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'

const TAIL_OPTIONS = [100, 500, 2000]
const FOLLOW_INTERVAL = 2_000

type Level = 'error' | 'warn' | 'info'

const LEVEL_CLASS: Record<Level, string> = {
  error: 'bg-critical/8 text-critical-text',
  warn: 'bg-warn/8 text-warn-text',
  info: 'text-ink-1',
}

// A declared level (`"level":"warn"`, `level=WARN`) wins over keywords in the message.
const LEVEL_FIELD = /\blevel"?\s*[:=]\s*"?([a-z]+)/i

export function logLevel(message: string): Level {
  const text = LEVEL_FIELD.exec(message)?.[1] ?? message
  if (/\b(error|fatal|panic|crit(ical)?|exception)\b/i.test(text)) return 'error'
  return /\bwarn(ing)?\b/i.test(text) ? 'warn' : 'info'
}

/** Splits `2026-09-30T12:00:00.123456789Z message` into a local time and the message. */
function splitTimestamp(line: string): { time: string; message: string } {
  const space = line.indexOf(' ')
  const time = new Date(line.slice(0, space)).toLocaleTimeString(undefined, { hour12: false })
  return { time, message: line.slice(space + 1) }
}

export function LogsTab({ pod }: { pod: KubeObject }) {
  const { context } = useCluster()
  const containers: string[] = [
    ...(pod.spec.initContainers ?? []).map((c: { name: string }) => `${c.name}`),
    ...pod.spec.containers.map((c: { name: string }) => c.name),
  ]
  const [container, setContainer] = useState<string>(pod.spec.containers[0].name)
  const [tailLines, setTailLines] = useState(500)
  const [previous, setPrevious] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const logs = useQuery({
    queryKey: [
      'logs',
      context,
      pod.metadata.namespace,
      pod.metadata.name,
      container,
      tailLines,
      previous,
    ],
    queryFn: () =>
      unwrap(
        api.kube.logs({
          context,
          namespace: pod.metadata.namespace!,
          pod: pod.metadata.name,
          container,
          tailLines,
          previous,
        }),
      ),
    refetchInterval: follow ? FOLLOW_INTERVAL : false,
  })

  const lines = (logs.data ?? '').split('\n').filter(Boolean)

  useEffect(() => {
    // Keep the newest lines in view while following.
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [follow, logs.data])

  let body: ReactNode
  if (logs.isPending) body = <Loading label="Fetching logs…" />
  else if (logs.isError)
    body = <ErrorState error={logs.error as KubeApiError} onRetry={() => void logs.refetch()} />
  else if (lines.length === 0) {
    body = (
      <EmptyState icon={ScrollText} title="No output">
        This container has not written any logs yet.
      </EmptyState>
    )
  } else {
    body = (
      <div
        ref={scrollRef}
        role="log"
        aria-label={`Logs for ${container}`}
        className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-2 font-mono text-[12px] leading-[1.65] selectable"
      >
        {lines.map((line, index) => {
          const { time, message } = splitTimestamp(line)
          return (
            <div
              key={index}
              data-level={logLevel(message)}
              className={cn('flex gap-3 px-5', LEVEL_CLASS[logLevel(message)])}
            >
              <span className="shrink-0 text-ink-3 select-none">{time}</span>
              <span className={wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}>
                {message}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2 text-xs text-ink-2">
        <label className="flex items-center gap-2">
          Container
          <select
            aria-label="Container"
            value={container}
            onChange={(event) => setContainer(event.target.value)}
            className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
          >
            {containers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Lines
          <select
            aria-label="Lines"
            value={tailLines}
            onChange={(event) => setTailLines(Number(event.target.value))}
            className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Toggle checked={previous} onChange={setPrevious}>
          Previous container
        </Toggle>
        <Toggle checked={follow} onChange={setFollow}>
          Follow
        </Toggle>
        <Toggle checked={wrap} onChange={setWrap}>
          Wrap lines
        </Toggle>
        <span className="flex-1" />
        <CopyButton text={logs.data ?? ''} label="Copy logs" />
      </div>
      {body}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="relative flex cursor-default items-center gap-2 select-none">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className="relative h-4 w-7 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-3"
      />
      {children}
    </label>
  )
}
