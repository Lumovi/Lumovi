import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  Clock,
  Download,
  History,
  Play,
  ScrollText,
  Search,
  WrapText,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { CopyButton } from '@renderer/components/CopyButton'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { Tooltip } from '@renderer/components/Tooltip'
import {
  MAX_LINES,
  useLogStreams,
  type LogSource,
  type StreamState,
} from '@renderer/hooks/log-streams'
import { useList } from '@renderer/hooks/queries'
import { api, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { shortNames, type Level, type LogLine, type Segment } from '@renderer/lib/logs'
import { toast } from '@renderer/state/toasts'
import type { PodQuery } from '../details/PodsTab'

/** Where the logs start: each container's last lines, or a span of time. */
const RANGES = [
  { value: '100', label: 'Last 100 lines', tailLines: 100 },
  { value: '500', label: 'Last 500 lines', tailLines: 500 },
  { value: '2000', label: 'Last 2,000 lines', tailLines: 2000 },
  { value: '5m', label: 'Last 5 minutes', sinceSeconds: 300 },
  { value: '1h', label: 'Last hour', sinceSeconds: 3600 },
  { value: '1d', label: 'Last day', sinceSeconds: 86_400 },
]
/** Every container of the pods, together. */
const ALL = '*'
/** The most containers streamed at once (a DaemonSet can have hundreds of pods). */
export const MAX_STREAMS = 30
const LINE_HEIGHT = 20
/** How close to the bottom still counts as "at the end" for auto-scrolling. */
const STICKY_DISTANCE = 32
/** Pods' colors, in the charts' order; the ninth and later are gray. */
const POD_COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`)
const OTHER_COLOR = 'var(--series-other)'

/** Each level's tint, a step stronger under the pointer. */
const LEVEL_CLASS: Record<Level, string> = {
  error: 'bg-critical/8 text-critical-text hover:bg-critical/16',
  warn: 'bg-warn/8 text-warn-text hover:bg-warn/16',
  info: 'text-ink-1 hover:bg-surface-3',
}

const time = (line: LogLine) => new Date(line.at).toLocaleTimeString(undefined, { hour12: false })

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

/** Text in the styles its escape codes set. */
function Styled({ segments, needle }: { segments: Segment[]; needle: string }) {
  return segments.map((s, i) => (
    <span
      key={i}
      className={s.background ? 'ansi-bg' : undefined}
      style={{
        color: s.color,
        background: s.background,
        fontWeight: s.bold ? 600 : undefined,
        opacity: s.dim ? 0.7 : undefined,
        fontStyle: s.italic ? 'italic' : undefined,
        textDecoration: s.underline ? 'underline' : undefined,
      }}
    >
      {highlight(s.text, needle)}
    </span>
  ))
}

/** JSON lines: level and message first, the other fields dimmed. Others in their colors. */
function Message({ line, needle }: { line: LogLine; needle: string }) {
  if (!line.fields) {
    return line.segments ? (
      <Styled segments={line.segments} needle={needle} />
    ) : (
      <>{highlight(line.message, needle)}</>
    )
  }
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

/**
 * A pill that picks some of the lines, with how many there are: a level to
 * see only it, or a pod to leave out (struck through) or bring back.
 */
function Chip({
  label,
  count,
  pressed,
  struck = false,
  color,
  title,
  onClick,
}: {
  label: string
  count: number
  pressed: boolean
  struck?: boolean
  color: string
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors',
        pressed
          ? 'border-line-strong bg-surface-3 text-ink-1'
          : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
        struck && 'text-ink-3 line-through decoration-ink-3/60',
      )}
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="max-w-32 truncate font-mono">{label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  )
}

/** The containers a pod runs, init containers first, as `kubectl logs` names them. */
function containerNames(pod: KubeObject): string[] {
  return [...(pod.spec.initContainers ?? []), ...pod.spec.containers].map(
    (c: { name: string }) => c.name,
  )
}

/**
 * The logs of some pods (one pod's, or every pod of a workload), streamed as
 * they're written and merged in that order, each line marked with its pod.
 */
export function LogsView({ pods, name }: { pods: KubeObject[]; name: string }) {
  const sorted = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const names = [...new Set(sorted.flatMap(containerNames))]
  const [container, setContainer] = useState<string>(sorted[0]!.spec.containers[0].name)
  const [range, setRange] = useState('500')
  const [previous, setPrevious] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [timestamps, setTimestamps] = useState(true)
  const [search, setSearch] = useState('')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [levels, setLevels] = useState<ReadonlySet<Level>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const [atEnd, setAtEnd] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Where the log was scrolled to last, to tell the reader scrolling up from lines arriving. */
  const lastTop = useRef(0)

  const multiple = sorted.length > 1
  const short = shortNames(sorted.map((pod) => pod.metadata.name))
  const color = new Map(
    sorted.map((pod, i) => [pod.metadata.name, POD_COLORS[i] ?? OTHER_COLOR] as const),
  )
  const sources: LogSource[] = sorted.flatMap((pod) =>
    containerNames(pod)
      .filter((c) => container === ALL || c === container)
      .map((c) => ({
        key: `${pod.metadata.name}/${c}`,
        namespace: pod.metadata.namespace!,
        pod: pod.metadata.name,
        container: c,
      })),
  )
  const streamed = sources.slice(0, MAX_STREAMS)
  /** What marks a line: its pod when there are several, and its container when all are shown. */
  const labelOf = (source: LogSource) =>
    `${multiple ? short.get(source.pod) : ''}${container === ALL ? `${multiple ? '/' : ''}${source.container}` : ''}`
  const labels = new Map(streamed.map((source) => [source.key, labelOf(source)]))
  const labelWidth = Math.max(...[...labels.values()].map((label) => label.length))
  const { tailLines, sinceSeconds } = RANGES.find((r) => r.value === range)!
  const { lines, states } = useLogStreams(streamed, {
    tailLines,
    sinceSeconds,
    previous,
    follow,
    attempt,
    container,
  })

  const podOf = (line: LogLine) => line.source.slice(0, line.source.indexOf('/'))
  const needle = search.trim()
  const visible = lines.filter((line) => !hidden.has(podOf(line)))
  const levelCounts = new Map<Level, number>()
  const podCounts = new Map<string, number>()
  for (const line of visible) levelCounts.set(line.level, (levelCounts.get(line.level) ?? 0) + 1)
  for (const line of lines) podCounts.set(podOf(line), (podCounts.get(podOf(line)) ?? 0) + 1)
  const shown = visible
    .filter((line) => levels.size === 0 || levels.has(line.level))
    .filter((line) => !needle || line.message.toLowerCase().includes(needle.toLowerCase()))

  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  })

  useEffect(() => {
    // Follow new lines only while the reader is at the end; scrolling up pauses it.
    // Anything that changes the height (lines, searching, wrapping) keeps the end in view.
    const el = scrollRef.current
    if (follow && atEnd && el) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
    }
  })

  /** The lines as plain text: with their pods and containers when there are several. */
  const text = () =>
    shown
      .map((line) => {
        const timestamp = line.raw.slice(0, line.raw.indexOf(' '))
        return labelWidth > 0
          ? `${timestamp} ${line.source} ${line.message}`
          : `${timestamp} ${line.message}`
      })
      .join('\n')

  const download = async () => {
    const saved = await api.app.saveFile(`${name}.log`, `${text()}\n`)
    if (!saved.ok)
      toast({ tone: 'error', title: 'Couldn’t save the logs', description: saved.error.message })
    else if (saved.data) toast({ tone: 'success', title: `Saved the logs of ${name}` })
  }

  const all = Object.values(states)
  const failure = (state: StreamState) => ('error' in state ? state.error : undefined)
  const errors = Object.entries(states).filter(([, state]) => failure(state))
  let body: ReactNode
  if (lines.length === 0 && (all.length === 0 || all.some((s) => s.status === 'connecting'))) {
    body = <Loading label="Fetching logs…" />
  } else if (lines.length === 0 && errors.length === all.length) {
    body = (
      <ErrorState
        error={failure(errors[0]![1]) as KubeApiError}
        onRetry={() => setAttempt(attempt + 1)}
      />
    )
  } else if (lines.length === 0) {
    body = (
      <EmptyState icon={ScrollText} title="No output">
        {multiple ? 'These containers have' : 'This container has'} not written any logs yet.
      </EmptyState>
    )
  } else {
    body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {errors.length > 0 && (
          <div role="status" className="shrink-0 border-b border-warn/25 bg-warn/10 px-5 py-1.5">
            {errors.map(([key, state]) => (
              <p key={key} className="truncate text-xs text-warn-text">
                {multiple ? `${short.get(key.slice(0, key.indexOf('/')))}: ` : ''}
                {failure(state)!.message}
                {state.status === 'reconnecting' && ' · Trying again…'}
              </p>
            ))}
          </div>
        )}
        <div
          ref={scrollRef}
          role="log"
          aria-label={`Logs for ${container === ALL ? 'all containers' : container}`}
          onScroll={(event) => {
            const el = event.currentTarget
            const up = el.scrollTop < lastTop.current
            lastTop.current = el.scrollTop
            if (el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_DISTANCE) setAtEnd(true)
            else if (up) setAtEnd(false)
          }}
          className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-2 font-mono text-[12px] leading-5 selectable"
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = shown[item.index]!
              const pod = podOf(line)
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  data-level={line.level}
                  style={{ transform: `translateY(${item.start}px)` }}
                  className={cn(
                    'absolute top-0 left-0 flex min-w-full gap-3 px-5',
                    !wrap && 'w-max',
                    LEVEL_CLASS[line.level],
                  )}
                >
                  {timestamps && (
                    <span className="shrink-0 text-ink-3 select-none">{time(line)}</span>
                  )}
                  {labelWidth > 0 && (
                    // On the first line, next to the time, however long the line wraps.
                    <span
                      data-label
                      className="flex shrink-0 items-start gap-1.5 text-ink-3 select-none"
                    >
                      <span
                        aria-hidden
                        className="mt-1 h-3 w-0.5 shrink-0 rounded-full"
                        style={{ background: color.get(pod) }}
                      />
                      <span className="truncate" style={{ width: `${labelWidth}ch` }}>
                        {/* A pod that has gone keeps its lines, under its name. */}
                        {labels.get(line.source) ?? pod}
                      </span>
                    </span>
                  )}
                  <span
                    className={wrap ? 'min-w-0 break-all whitespace-pre-wrap' : 'whitespace-pre'}
                  >
                    <Message line={line} needle={needle} />
                  </span>
                </div>
              )
            })}
          </div>
          {shown.length === 0 && (
            <p className="px-5 py-8 text-center font-sans text-ink-3">
              {needle ? `No lines match “${needle}”.` : 'No lines to show.'}
            </p>
          )}
        </div>
        {follow && !atEnd && (
          <button
            type="button"
            onClick={() => {
              scrollRef.current!.scrollTop = scrollRef.current!.scrollHeight
              setAtEnd(true)
            }}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full bg-ink-1 px-3 py-1.5 text-xs font-medium text-surface shadow-pop"
          >
            <ArrowDown className="size-3.5" /> Jump to latest
          </button>
        )}
      </div>
    )
  }

  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set)
    if (!next.delete(value)) next.add(value)
    return next
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-2 text-xs text-ink-2">
        <select
          aria-label="Container"
          value={container}
          onChange={(event) => setContainer(event.target.value)}
          className="h-7 max-w-40 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {names.length > 1 && <option value={ALL}>All containers</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          aria-label="Show"
          value={range}
          onChange={(event) => setRange(event.target.value)}
          className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
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
              {shown.length}/{visible.length}
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
        <CopyButton text={text} label="Copy logs" />
        <Tooltip content="Download">
          <button
            type="button"
            aria-label="Download"
            onClick={() => void download()}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 [&_svg]:size-4"
          >
            <Download />
          </button>
        </Tooltip>
      </div>
      {(multiple || levelCounts.size > 1) && (
        <div
          role="group"
          aria-label="Show lines from"
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-5 py-1.5"
        >
          {(['error', 'warn'] as const)
            .filter((level) => levelCounts.has(level))
            .map((level) => (
              <Chip
                key={level}
                label={level === 'error' ? 'Errors' : 'Warnings'}
                count={levelCounts.get(level)!}
                // Pressed means "only these": none pressed shows every level.
                pressed={levels.has(level)}
                color={level === 'error' ? 'var(--critical)' : 'var(--warn)'}
                onClick={() => setLevels(toggle(levels, level))}
              />
            ))}
          {multiple && <span className="mx-1 h-4 w-px shrink-0 bg-line" />}
          {multiple &&
            sorted.map((pod) => {
              const podName = pod.metadata.name
              return (
                <Chip
                  key={podName}
                  label={short.get(podName)!}
                  title={podName}
                  count={podCounts.get(podName) ?? 0}
                  pressed={!hidden.has(podName)}
                  struck={hidden.has(podName)}
                  color={color.get(podName)!}
                  onClick={() => setHidden(toggle(hidden, podName))}
                />
              )
            })}
        </div>
      )}
      {sources.length > MAX_STREAMS && (
        <p
          role="note"
          className="shrink-0 border-b border-line bg-accent-soft px-5 py-1.5 text-xs text-ink-2"
        >
          Streaming the first {MAX_STREAMS} of {sources.length} containers. Pick a container, or
          open a pod, to see the rest.
        </p>
      )}
      {lines.length >= MAX_LINES && (
        <p role="note" className="shrink-0 border-b border-line px-5 py-1.5 text-xs text-ink-3">
          Showing the latest {MAX_LINES.toLocaleString()} lines.
        </p>
      )}
      {body}
    </div>
  )
}

/** The logs of every pod a workload (or a service) has: they come and go as it runs. */
export function PodLogs({
  namespace,
  query,
  name,
}: {
  namespace: string
  query: PodQuery
  name: string
}) {
  const pods = useList('Pod', { namespace, ...query })
  if (pods.isPending) return <Loading label="Finding its pods…" />
  if (!pods.data) {
    return <ErrorState error={pods.error as KubeApiError} onRetry={() => void pods.refetch()} />
  }
  if (pods.data.length === 0) {
    return (
      <EmptyState icon={KIND_ICONS.Pod} title="No pods">
        Nothing is running for this right now, so there are no logs to show.
      </EmptyState>
    )
  }
  return <LogsView pods={pods.data} name={name} />
}
