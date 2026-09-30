import { useQuery } from '@tanstack/react-query'
import { ArrowDown, Clock, History, Play, ScrollText, Search, WrapText } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { CopyButton } from '@renderer/components/CopyButton'
import { EmptyState, ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { Tooltip } from '@renderer/components/Tooltip'
import { api, unwrap, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'

const TAIL_OPTIONS = [100, 500, 2000]
const FOLLOW_INTERVAL = 2_000
/** How close to the bottom still counts as "at the end" for auto-scrolling. */
const STICKY_DISTANCE = 32

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

interface LogLine {
  time: string
  message: string
  level: Level
  /** Parsed fields when the line is a JSON object. */
  fields?: Record<string, unknown>
}

function parseLine(line: string): LogLine {
  const space = line.indexOf(' ')
  const time = new Date(line.slice(0, space)).toLocaleTimeString(undefined, { hour12: false })
  const message = line.slice(space + 1)
  let fields: Record<string, unknown> | undefined
  if (message.startsWith('{')) {
    try {
      fields = JSON.parse(message) as Record<string, unknown>
    } catch {
      // A truncated or malformed JSON line: show it as text.
    }
  }
  return { time, message, level: logLevel(message), fields }
}

/** Wraps matches of `needle` in <mark>. */
function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text
  const pattern = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-warn/40 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/** JSON lines: level and message first, the other fields dimmed. */
function Message({ line, needle }: { line: LogLine; needle: string }) {
  if (!line.fields) return <>{highlight(line.message, needle)}</>
  const { level, msg, ...rest } = line.fields
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return (
    <>
      {level !== undefined && (
        <span className="mr-2 rounded bg-current/10 px-1 text-2xs font-semibold uppercase">
          {String(level)}
        </span>
      )}
      {msg !== undefined && highlight(String(msg), needle)}
      <span className="ml-2 text-ink-3">{highlight(extra, needle)}</span>
    </>
  )
}

function Toggle({
  label,
  pressed,
  onChange,
  children,
}: {
  label: string
  pressed: boolean
  onChange: (pressed: boolean) => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={() => onChange(!pressed)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 aria-pressed:bg-accent-soft aria-pressed:text-accent-strong [&_svg]:size-4"
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function LogsTab({ pod }: { pod: KubeObject }) {
  const { context } = useCluster()
  const containers: string[] = [
    ...(pod.spec.initContainers ?? []).map((c: { name: string }) => c.name),
    ...pod.spec.containers.map((c: { name: string }) => c.name),
  ]
  const [container, setContainer] = useState<string>(pod.spec.containers[0].name)
  const [tailLines, setTailLines] = useState(500)
  const [previous, setPrevious] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [timestamps, setTimestamps] = useState(true)
  const [search, setSearch] = useState('')
  const [atEnd, setAtEnd] = useState(true)
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

  const needle = search.trim()
  const lines = (logs.data ?? '').split('\n').filter(Boolean).map(parseLine)
  const shown = needle
    ? lines.filter((line) => line.message.toLowerCase().includes(needle.toLowerCase()))
    : lines

  const scrollToEnd = () => {
    scrollRef.current!.scrollTo({ top: scrollRef.current!.scrollHeight })
    setAtEnd(true)
  }

  useEffect(() => {
    // Follow new lines only while the reader is at the end; scrolling up pauses it.
    // Searching and layout changes keep the end in view too.
    if (follow && atEnd) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [follow, atEnd, logs.data, needle, wrap, timestamps])

  let body: ReactNode
  if (logs.isPending) body = <Loading label="Fetching logs…" />
  else if (logs.data === undefined) {
    body = <ErrorState error={logs.error as KubeApiError} onRetry={() => void logs.refetch()} />
  } else if (lines.length === 0) {
    body = (
      <EmptyState icon={ScrollText} title="No output">
        This container has not written any logs yet.
      </EmptyState>
    )
  } else {
    body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {logs.isError && (
          <StaleNotice error={logs.error as KubeApiError} onRetry={() => void logs.refetch()} />
        )}
        <div
          ref={scrollRef}
          role="log"
          aria-label={`Logs for ${container}`}
          onScroll={(event) => {
            const el = event.currentTarget
            setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_DISTANCE)
          }}
          className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-2 font-mono text-[12px] leading-[1.65] selectable"
        >
          {shown.map((line, index) => (
            <div
              key={index}
              data-level={line.level}
              className={cn('flex gap-3 px-5', LEVEL_CLASS[line.level])}
            >
              {timestamps && <span className="shrink-0 text-ink-3 select-none">{line.time}</span>}
              <span className={wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}>
                <Message line={line} needle={needle} />
              </span>
            </div>
          ))}
          {shown.length === 0 && (
            <p className="px-5 py-8 text-center font-sans text-ink-3">No lines match “{needle}”.</p>
          )}
        </div>
        {follow && !atEnd && (
          <button
            type="button"
            onClick={scrollToEnd}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full bg-ink-1 px-3 py-1.5 text-xs font-medium text-surface shadow-pop"
          >
            <ArrowDown className="size-3.5" /> Jump to latest
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-5 py-2 text-xs text-ink-2">
        <select
          aria-label="Container"
          value={container}
          onChange={(event) => setContainer(event.target.value)}
          className="h-7 max-w-40 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {containers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Lines"
          value={tailLines}
          onChange={(event) => setTailLines(Number(event.target.value))}
          className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              Last {n}
            </option>
          ))}
        </select>
        <label className="flex h-7 min-w-24 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent">
          <Search className="size-3.5 shrink-0 text-ink-3" />
          <input
            aria-label="Search logs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // Clear the search instead of closing the panel.
                event.stopPropagation()
                setSearch('')
              }
            }}
            placeholder="Search"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-ink-1 outline-none placeholder:text-ink-3"
          />
          {needle && (
            <span className="shrink-0 text-ink-3 tabular-nums">
              {shown.length}/{lines.length}
            </span>
          )}
        </label>
        <Toggle label="Follow" pressed={follow} onChange={setFollow}>
          <Play />
        </Toggle>
        <Toggle label="Previous container" pressed={previous} onChange={setPrevious}>
          <History />
        </Toggle>
        <Toggle label="Timestamps" pressed={timestamps} onChange={setTimestamps}>
          <Clock />
        </Toggle>
        <Toggle label="Wrap lines" pressed={wrap} onChange={setWrap}>
          <WrapText />
        </Toggle>
        <CopyButton text={logs.data ?? ''} label="Copy logs" />
      </div>
      {body}
    </div>
  )
}
