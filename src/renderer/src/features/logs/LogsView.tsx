import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  Check,
  CircleAlert,
  Clock,
  Copy,
  Download,
  Ellipsis,
  History,
  Play,
  ScrollText,
  TriangleAlert,
  WrapText,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject, PluginVia } from '@shared/api'
import { CopyButton } from '@renderer/components/CopyButton'
import { Sheet } from '@renderer/components/Sheet'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { Tooltip } from '@renderer/components/Tooltip'
import {
  MAX_LINES,
  useLogStreams,
  type LogOptions,
  type LogSource,
  type StreamState,
} from '@renderer/hooks/log-streams'
import { useList } from '@renderer/hooks/queries'
import { api, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { Picker } from '@renderer/components/Picker'
import { useLayout, useTouch } from '@renderer/lib/layout'
import {
  NO_QUERY,
  search as searchFor,
  shownParts,
  type LogQuery,
  type Runnable,
  type Search as Searched,
} from '@renderer/lib/log-search'
import { shortNames, type Level, type LogLine, type Segment } from '@renderer/lib/logs'
import { toast } from '@renderer/state/toasts'
import type { PodQuery } from '../details/PodsTab'
import { NotAllowed } from '../access/NotAllowed'
import { useAccessHere } from '../access/use-access'
import { momentOf } from '@renderer/lib/log-since'
import { useCluster } from '@renderer/state/cluster'
import { useLineSearch } from './line-search'
import { RANGES, RangePicker, type Picked } from './RangePicker'
import { Histogram, stretchSaid, type Stretch } from './Histogram'
import { SearchField, SearchSteps, SearchToggles, type Count } from './SearchField'
import { withTime } from '@renderer/lib/time'

/** A search the lines can be filtered by: anything but an expression that isn't one. */
type Usable = Exclude<Searched, { kind: 'invalid' }>

/** What the worker is given of a search. */
const runnableOf = (search: Exclude<Usable, { kind: 'none' }>): Runnable =>
  search.kind === 'plain'
    ? { kind: 'plain', needle: search.needle, matchCase: search.matchCase }
    : { kind: 'regex', source: search.source, flags: search.flags }

/**
 * What was typed in each Logs view this session, by the view (its cluster, namespace and
 * name): drawn again (a phone turned, so a page becomes a panel), it's there still. Never kept
 * beyond the session, nor shared between views.
 */
const typedIn = new Map<string, string>()

/** The search's toggles are remembered for the Logs view (not its text). */
const REMEMBERED = 'lumovi:logs-search'
function rememberedQuery(): LogQuery {
  try {
    const kept = JSON.parse(localStorage.getItem(REMEMBERED) ?? '{}') as Partial<LogQuery>
    return {
      ...NO_QUERY,
      regex: kept.regex === true,
      matchCase: kept.matchCase === true,
      exclude: kept.exclude === true,
    }
  } catch {
    return NO_QUERY
  }
}
function remember({ regex, matchCase, exclude }: LogQuery) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify({ regex, matchCase, exclude }))
  } catch {
    // (Nowhere to keep it: a private window, say. It's only a convenience.)
  }
}

/** The furthest back a span of seconds is asked for as one; past it, as a moment. */
const MOST_SINCE_SECONDS = 30 * 86_400

/** The fewest lines a container of several is asked for, where a span is shared out. */
const LEAST_SHARE = 2000

/**
 * The lines each container is asked for over a span: as many as the view keeps, shared out
 * among several (each keeps its own newest lines), but never fewer than `LEAST_SHARE`.
 */
export const shareOf = (containers: number) =>
  containers > 1 ? Math.max(LEAST_SHARE, Math.floor(MAX_LINES / containers)) : MAX_LINES

/**
 * What the streams are asked for, by what's picked. A span keeps only each container's last
 * lines (`shareOf`): a long one is cut there, and says so.
 */
function windowOf(
  picked: Picked,
  containers: number,
): Pick<LogOptions, 'tailLines' | 'sinceSeconds' | 'sinceTime'> {
  const tailLines = shareOf(containers)
  if ('range' in picked) {
    const range = RANGES.find((r) => r.value === picked.range)!
    return 'tailLines' in range
      ? { tailLines: range.tailLines }
      : { sinceSeconds: range.sinceSeconds, tailLines }
  }
  return 'seconds' in picked.since
    ? { sinceSeconds: picked.since.seconds, tailLines }
    : { sinceTime: new Date(picked.since.at).toISOString(), tailLines }
}

/** How many seconds back a pick starts, where it's a span (not a count of lines). */
function secondsOf(picked: Picked): number | undefined {
  if ('since' in picked) return 'seconds' in picked.since ? picked.since.seconds : undefined
  const range = RANGES.find((r) => r.value === picked.range)!
  return 'sinceSeconds' in range ? range.sinceSeconds : undefined
}
/** Every container of the pods, together. */
const ALL = '*'
/** The most containers streamed at once (a DaemonSet can have hundreds of pods). */
export const MAX_STREAMS = 30
const LINE_HEIGHT = 20
/** How close to the bottom still counts as "at the end" for auto-scrolling. */
const STICKY_DISTANCE = 32
/** How long after the reader's wheel, touch or key a scroll of the log is still theirs. */
const READER_MS = 800
/** Keys that scroll up what has the focus (or was last clicked), with Shift for the space bar. */
const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home', ' '])
/** Pods' colors, in the charts' order; the ninth and later are gray. */
const POD_COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`)
const OTHER_COLOR = 'var(--series-other)'

/** Each level's tint, a step stronger under the pointer. */
const LEVEL_CLASS: Record<Level, string> = {
  error: 'bg-critical/8 text-critical-text hover:bg-critical/16',
  warn: 'bg-warn/8 text-warn-text hover:bg-warn/16',
  info: 'text-ink-1 hover:bg-surface-3',
}

const time = (line: LogLine) =>
  new Date(line.at).toLocaleTimeString(undefined, withTime({ hour12: false }))

/** A match in one of the texts a line shows: where, and whether it's the current one. */
type Mark = readonly [start: number, end: number, current?: boolean]
/** Where a line's matches are, in each of the texts it shows (`shownParts`). */
type Marks = (part: number) => readonly Mark[]
const NO_MARKS: Marks = () => []

/** A text with its matches in <mark>: from where they were found, never by searching here. */
function marked(text: string, ranges: readonly Mark[]): ReactNode {
  if (ranges.length === 0) return text
  const pieces: ReactNode[] = []
  let at = 0
  for (const [start, end, current] of ranges) {
    if (start < at) continue
    if (start > at) pieces.push(text.slice(at, start))
    pieces.push(
      <mark
        key={start}
        data-current={current || undefined}
        className={cn(
          'rounded-sm',
          current ? 'bg-accent text-on-accent' : 'bg-warn/40 text-inherit',
        )}
      >
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  if (at < text.length) pieces.push(text.slice(at))
  return pieces
}

/** Text in the styles its escape codes set (its marks found in the text they make together). */
function Styled({ segments, marks }: { segments: Segment[]; marks: Marks }) {
  let offset = 0
  return segments.map((s, i) => {
    const from = offset
    offset += s.text.length
    const ranges = marks(0)
      .filter(([start, end]) => end > from && start < offset)
      .map(
        ([start, end, current]) =>
          [Math.max(start, from) - from, Math.min(end, offset) - from, current] as const,
      )
    return (
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
        {marked(s.text, ranges)}
      </span>
    )
  })
}

/** JSON lines: level and message first, the other fields dimmed. Others in their colors. */
function Message({ line, marks }: { line: LogLine; marks: Marks }) {
  if (!line.fields) {
    return line.segments ? (
      <Styled segments={line.segments} marks={marks} />
    ) : (
      <>{marked(line.message, marks(0))}</>
    )
  }
  const [msg, extra] = shownParts(line)
  return (
    <>
      {line.fields.level !== undefined && (
        <span className="mr-2 rounded bg-current/10 px-1 text-2xs font-semibold uppercase">
          {String(line.fields.level)}
        </span>
      )}
      {line.fields.msg !== undefined && marked(msg!, marks(0))}
      <span className="ml-2 text-ink-3">{marked(extra!, marks(1))}</span>
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
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 aria-pressed:bg-accent-soft aria-pressed:text-accent-strong touch:size-11 touch:rounded-lg [&_svg]:size-4"
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
        'flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors touch:finger',
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
  return [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].map(
    (c: { name: string }) => c.name,
  )
}

/**
 * The logs of some pods (one pod's, or every pod of a workload), streamed as
 * they're written and merged in that order, each line marked with its pod.
 */
/** Pods' logs, where the person's access lets them read them. */
export function LogsView({
  pods,
  name,
  container: asked,
  via,
  paused = false,
}: {
  pods: KubeObject[]
  name: string
  /** The container to show first, where one asked for it is among the pods'. */
  container?: string
  /** Shown on a plugin's page: which plugin's page asked Lumovi to show them. */
  via?: PluginVia
  /** Opened from a link: without following, until asked to. */
  paused?: boolean
}) {
  const notAllowed = useAccessHere().whyNot('logs', 'on', pods[0]!.metadata.namespace)
  if (notAllowed) return <NotAllowed title="You can’t read logs here" reason={notAllowed} />
  return (
    <Logs
      pods={pods}
      name={name}
      {...(asked !== undefined ? { asked } : {})}
      {...(via ? { via } : {})}
      paused={paused}
    />
  )
}

function Logs({
  pods,
  name,
  asked,
  via,
  paused = false,
}: {
  pods: KubeObject[]
  name: string
  asked?: string
  via?: PluginVia
  paused?: boolean
}) {
  const sorted = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const names = [...new Set(sorted.flatMap(containerNames))]
  const [container, setContainer] = useState<string>(
    asked !== undefined && names.includes(asked)
      ? asked
      : (sorted[0]?.spec?.containers?.[0]?.name ?? names[0] ?? ''),
  )
  const [picked, setPickedState] = useState<Picked>({ range: '500' })
  /** When it was picked: where a span's start is counted from, to say it. */
  const [pickedAt, setPickedAt] = useState(() => Date.now())
  const setPicked = (next: Picked) => {
    const now = Date.now()
    // (A span too long to ask for as one is asked for from its moment.)
    setPickedState(
      'since' in next && 'seconds' in next.since && next.since.seconds > MOST_SINCE_SECONDS
        ? { since: { at: now - next.since.seconds * 1000 } }
        : next,
    )
    setPickedAt(now)
  }
  const [previous, setPrevious] = useState(false)
  const [follow, setFollow] = useState(!paused)
  // On a narrow page lines always wrap (nothing scrolls sideways under 1024 px: a panel there is
  // too narrow for whole lines, with a mouse too). With room, wrapping is chosen, and starts on
  // under a finger. On a phone the time each line was written, a third of its width, starts off.
  const layout = useLayout()
  const phone = layout === 'phone'
  const narrow = layout !== 'wide'
  const touch = useTouch()
  const [wraps, setWrap] = useState(touch)
  const wrap = wraps || narrow
  const [timestamps, setTimestamps] = useState(!phone)
  /** A stretch of time picked on the histogram: only its lines are shown. */
  const [stretch, setStretch] = useState<Stretch>()
  /** The search field has the focus (on a phone, its third row shows). */
  const [fieldFocus, setFieldFocus] = useState(false)
  const [more, setMore] = useState(false)
  const { context } = useCluster()
  const view = `${context}/${sorted[0]!.metadata.namespace}/${name}`
  const [query, setQueryState] = useState<LogQuery>(() => ({
    ...rememberedQuery(),
    text: typedIn.get(view) ?? '',
  }))
  const searcher = useLineSearch()
  /** The last search that worked: what the lines show while the one typed doesn't. */
  const [kept, setKept] = useState<Usable>({ kind: 'none' })
  /** The match stepped to, of all those shown (none until the person steps). */
  const [current, setCurrent] = useState<number>()
  const setQuery = (next: LogQuery) => {
    setQueryState(next)
    setCurrent(undefined)
    remember(next)
    if (next.text) typedIn.set(view, next.text)
    else typedIn.delete(view)
  }
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [levels, setLevels] = useState<ReadonlySet<Level>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const [atEnd, setAtEnd] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Where the log was scrolled to last, to tell the reader scrolling up from lines arriving. */
  const lastTop = useRef(0)
  /**
   * When the reader last moved the log themselves (a wheel, a touch, a key, stepping to a match),
   * and whether their pointer is down on it (its scroll bar, a selection). Only their own scroll
   * up stops following: the log moving for anything else, as its length changes with a search, a
   * filter or a level, never does.
   */
  const readerAt = useRef(-Infinity)
  const pressing = useRef(false)
  const theirs = () => pressing.current || performance.now() - readerAt.current < READER_MS
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) {
        return
      }
      if (SCROLL_UP_KEYS.has(event.key)) readerAt.current = performance.now()
    }
    const released = () => (pressing.current = false)
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerup', released, true)
    window.addEventListener('pointercancel', released, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerup', released, true)
      window.removeEventListener('pointercancel', released, true)
    }
  }, [])

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
  const { tailLines, sinceSeconds, sinceTime } = windowOf(picked, streamed.length)
  /** Where a span starts, to say where a long one was cut (none for a count of lines). */
  const seconds = secondsOf(picked)
  const since =
    'since' in picked && 'at' in picked.since
      ? picked.since.at
      : seconds === undefined
        ? undefined
        : pickedAt - seconds * 1000
  const { lines, states, full } = useLogStreams(streamed, {
    tailLines,
    sinceSeconds,
    sinceTime,
    previous,
    follow,
    attempt,
    container,
    ...(via ? { via } : {}),
  })

  const podOf = (line: LogLine) => line.source.slice(0, line.source.indexOf('/'))
  const visible = lines.filter((line) => !hidden.has(podOf(line)))
  const levelCounts = new Map<Level, number>()
  const podCounts = new Map<string, number>()
  for (const line of visible) levelCounts.set(line.level, (levelCounts.get(line.level) ?? 0) + 1)
  for (const line of lines) podCounts.set(podOf(line), (podCounts.get(podOf(line)) ?? 0) + 1)

  // What's searched for, in the worker. An expression that isn't one, or a search that took too
  // long, leaves the lines as the last one that worked left them, dimmed, and says why.
  const wanted = searchFor(query)
  const usable = (it: Searched): it is Usable =>
    it.kind !== 'invalid' && !(it.kind !== 'none' && searcher.isSlow(runnableOf(it)))
  const good = usable(wanted)
  // Shown once it has run on every line: until then, the last one that did (a search still
  // running may yet turn out too slow, and its answers so far are only some of them).
  const finished = good && (wanted.kind === 'none' || searcher.done(runnableOf(wanted)))
  const used = finished ? wanted : kept
  const wantedKey = JSON.stringify(wanted)
  useEffect(() => {
    if (finished) setKept(JSON.parse(wantedKey) as Usable)
  }, [finished, wantedKey])
  const trouble = wanted.kind === 'invalid' ? 'bad' : good ? undefined : 'slow'
  const problem =
    wanted.kind === 'invalid'
      ? wanted.why
      : trouble === 'slow'
        ? wanted.kind === 'regex'
          ? `This expression took too long on ${lines.length.toLocaleString()} lines, so Lumovi stopped it. Try a simpler one. The lines are from the last one that worked.`
          : `This search took too long on ${lines.length.toLocaleString()} lines, so Lumovi stopped it. The lines are from the last one that worked.`
        : undefined
  useEffect(() => {
    // What's typed is run; while it can't be, the last one that worked goes on with new lines.
    const running = good ? wanted : kept
    if (running.kind !== 'none') searcher.run(runnableOf(running), lines)
  })
  /** What the worker has said of each line, for the search shown. */
  const knownOf = used.kind === 'none' ? () => undefined : searcher.lookup(runnableOf(used))
  const shown = visible
    .filter((line) => levels.size === 0 || levels.has(line.level))
    .filter((line) => !stretch || (line.at >= stretch.from && line.at < stretch.to))
    .filter((line) => {
      if (used.kind === 'none') return true
      const match = knownOf(line)?.match
      return match !== undefined && match !== used.exclude
    })
  const searching = used.kind !== 'none'
  /** What the search shown is for, as typed. */
  const usedText = used.kind === 'plain' ? used.needle : used.kind === 'regex' ? used.source : ''
  const marking = searching && !used.exclude
  // Every match in the lines shown, in order: where each line's first one is counted from.
  const firstOf: number[] = []
  let total = 0
  for (const line of shown) {
    firstOf.push(total)
    if (marking) total += knownOf(line)?.ranges.length ?? 0
  }
  const at = current === undefined || total === 0 ? undefined : Math.min(current, total - 1)
  /** The shown line the current match is in. */
  const currentLine = at === undefined ? undefined : firstOf.findLastIndex((first) => first <= at)
  const count: Count | undefined = !searching
    ? undefined
    : used.exclude
      ? { lines: shown.length }
      : { current: at ?? -1, total }
  const step = (by: 1 | -1) => {
    if (total === 0) return
    // (The log goes to the match: the reader's own move.)
    readerAt.current = performance.now()
    setCurrent(at === undefined ? (by === 1 ? 0 : total - 1) : (at + by + total) % total)
  }
  /** Where a line's matches are marked, the current one among them. */
  const marksOf = (line: LogLine, index: number): Marks => {
    if (!marking) return NO_MARKS
    const ranges = knownOf(line)?.ranges ?? []
    const mine = at === undefined ? -1 : at - firstOf[index]!
    return (part) =>
      ranges.flatMap(([of, start, end], i) =>
        of === part ? [[start, end, i === mine] as const] : [],
      )
  }

  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  })

  /**
   * Following, the end is held: new lines arrive in view. While the reader is at the end, until
   * they scroll up (not while a match is current: the view would run off from under it).
   */
  const holding = follow && atEnd && at === undefined
  const toEnd = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }
  useEffect(() => {
    // Anything that changes the height (lines, searching, wrapping) keeps the end in view.
    if (holding && scrollRef.current) toEnd(scrollRef.current)
  })
  /** Follow as the button has it: on is the end held, and pressed while it isn't, it's held again. */
  const setFollowing = (on: boolean) => {
    setFollow(on)
    if (!on) return
    setAtEnd(true)
    setCurrent(undefined)
  }
  useEffect(() => {
    if (currentLine !== undefined) virtualizer.scrollToIndex(currentLine, { align: 'center' })
  }, [at, currentLine, virtualizer])

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
    // (A file that isn't the whole log says so in its name.)
    const narrowed = searching || levels.size > 0 || hidden.size > 0 || stretch !== undefined
    const saved = await api.app.saveFile(`${name}${narrowed ? '-filtered' : ''}.log`, `${text()}\n`)
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
          onWheel={() => (readerAt.current = performance.now())}
          onTouchMove={() => (readerAt.current = performance.now())}
          onPointerDown={() => (pressing.current = true)}
          onScroll={(event) => {
            const el = event.currentTarget
            const up = el.scrollTop < lastTop.current
            lastTop.current = el.scrollTop
            if (el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_DISTANCE) setAtEnd(true)
            else if (up && theirs()) setAtEnd(false)
            // Moved, but not by the reader (the lines shorter or longer, a scroll position read
            // as they changed): the end stays held.
            else if (holding && !theirs()) toEnd(el)
          }}
          className={cn(
            'min-h-0 flex-1 overflow-auto bg-surface-2/60 py-2 font-mono text-[12px] leading-5 selectable',
            trouble && 'opacity-55',
          )}
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
                    'absolute top-0 left-0 flex min-w-full gap-3 px-5 phone:w-full phone:px-4',
                    !wrap && 'w-max',
                    LEVEL_CLASS[line.level],
                    item.index === currentLine && 'shadow-[inset_3px_0_0_var(--accent)]',
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
                    className={
                      narrow
                        ? // What runs over hangs under its line, so one long line doesn't read as two.
                          'min-w-0 wrap-hanging'
                        : wrap
                          ? 'min-w-0 break-all whitespace-pre-wrap'
                          : 'whitespace-pre'
                    }
                  >
                    <Message line={line} marks={marksOf(line, item.index)} />
                  </span>
                </div>
              )
            })}
          </div>
          {shown.length === 0 && (
            <p className="px-5 py-8 text-center font-sans text-ink-3">
              {searching
                ? used.exclude
                  ? `Every line matches “${usedText}”, so none is shown.`
                  : `No lines match “${usedText}”.`
                : 'No lines to show.'}
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
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full bg-ink-1 px-3 py-1.5 text-xs font-medium text-surface shadow-pop touch:finger"
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
      {phone ? (
        // On a phone: which container and how far back, then the search and what's toggled most.
        <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2">
          <div className="flex gap-2">
            <select
              aria-label="Container"
              value={container}
              onChange={(event) => setContainer(event.target.value)}
              className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-ink-1"
            >
              {names.length > 1 && <option value={ALL}>All containers</option>}
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <RangePicker phone picked={picked} onPick={setPicked} />
          </div>
          <div className="flex items-center gap-1">
            <SearchField
              phone
              query={query}
              onQuery={setQuery}
              count={count}
              stale={trouble !== undefined}
              trouble={trouble}
              onStep={step}
              onFocusChange={setFieldFocus}
            />
            <Toggle label="Follow" pressed={holding} onChange={setFollowing}>
              <Play />
            </Toggle>
            <button
              type="button"
              aria-label="More"
              onClick={() => setMore(true)}
              className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-3 [&_svg]:size-4"
            >
              <Ellipsis />
            </button>
          </div>
          {(fieldFocus || query.text !== '') && (
            // (Pressing here keeps the field's focus, so the row stays while it's used.)
            <div
              className="flex items-center gap-1"
              onPointerDown={(event) => event.preventDefault()}
            >
              <SearchToggles big query={query} onQuery={setQuery} />
              <span className="flex-1" />
              <SearchSteps big count={count} stale={trouble !== undefined} onStep={step} />
            </div>
          )}
          {more && (
            <Sheet title="Logs" onClose={() => setMore(false)}>
              <ul className="px-2 pb-3">
                {(
                  [
                    [
                      previous ? 'Show the running container' : 'Show the previous container',
                      History,
                      () => setPrevious(!previous),
                    ],
                    // (A setting: its name stays, and a check says it's on.)
                    ['Timestamps', Clock, () => setTimestamps(!timestamps), timestamps],
                    ['Copy logs', Copy, () => void navigator.clipboard.writeText(text())],
                    ['Download', Download, () => void download()],
                  ] as const
                ).map(([label, Icon, act, pressed]) => (
                  <li key={label}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => {
                        act()
                        setMore(false)
                      }}
                      className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink-1 outline-offset-[-2px] active:bg-surface-3"
                    >
                      <Icon className="size-4 text-ink-3" />
                      <span className="flex-1">{label}</span>
                      {pressed && <Check className="size-4 text-accent" />}
                    </button>
                  </li>
                ))}
              </ul>
            </Sheet>
          )}
        </div>
      ) : (
        // (On a narrow page it keeps to one row: its fields give way, and what's done least is
        // behind a button.)
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-2 text-xs text-ink-2 narrow:flex-nowrap">
          <select
            aria-label="Container"
            value={container}
            onChange={(event) => setContainer(event.target.value)}
            className="h-7 max-w-40 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1 narrow:min-w-16 narrow:shrink touch:h-11"
          >
            {names.length > 1 && <option value={ALL}>All containers</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <RangePicker phone={false} picked={picked} onPick={setPicked} />
          <SearchField
            query={query}
            onQuery={setQuery}
            count={count}
            stale={trouble !== undefined}
            trouble={trouble}
            onStep={step}
          />
          <Toggle label="Follow" pressed={holding} onChange={setFollowing}>
            <Play />
          </Toggle>
          <Toggle label="Previous container" pressed={previous} onChange={setPrevious}>
            <History />
          </Toggle>
          <Toggle label="Timestamps" pressed={timestamps} onChange={setTimestamps}>
            <Clock />
          </Toggle>
          {!narrow && (
            <Toggle label="Wrap lines" pressed={wraps} onChange={setWrap}>
              <WrapText />
            </Toggle>
          )}
          {narrow ? (
            <Picker
              open={more}
              onOpenChange={setMore}
              title="Logs"
              align="end"
              className="min-w-44"
              trigger={
                <button
                  type="button"
                  aria-label="More"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3 touch:size-11 touch:rounded-lg [&_svg]:size-4"
                >
                  <Ellipsis />
                </button>
              }
            >
              {(
                [
                  ['Copy logs', Copy, () => void navigator.clipboard.writeText(text())],
                  ['Download', Download, () => void download()],
                ] as const
              ).map(([label, Icon, act]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    act()
                    setMore(false)
                  }}
                  className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink-1 hover:bg-surface-3 touch:h-11"
                >
                  <Icon className="size-4 text-ink-3" />
                  {label}
                </button>
              ))}
            </Picker>
          ) : (
            <>
              <CopyButton text={text} label="Copy logs" />
              <Tooltip content="Download">
                <button
                  type="button"
                  aria-label="Download"
                  onClick={() => void download()}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 touch:size-11 touch:rounded-lg [&_svg]:size-4"
                >
                  <Download />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      )}
      {problem && (
        <p
          role="alert"
          className={cn(
            'flex shrink-0 items-start gap-2 border-b border-line px-5 py-1.5 text-xs leading-[18px] phone:px-4',
            trouble === 'bad' ? 'bg-critical/6 text-critical-text' : 'bg-warn/8 text-warn-text',
          )}
        >
          {trouble === 'bad' ? (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{problem}</span>
        </p>
      )}
      {(multiple || levelCounts.size > 1 || stretch) && (
        <div
          role="group"
          aria-label="Show lines from"
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-5 py-1.5 narrow:flex-wrap narrow:overflow-visible phone:px-4 touch:flex-wrap touch:gap-x-2 touch:gap-y-5 touch:overflow-visible touch:py-2.5"
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
          {stretch && (
            <span
              aria-label={`Only lines from ${stretchSaid(stretch).replace('–', ' to ')}`}
              className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent bg-accent-soft pr-0.5 pl-2 text-xs text-ink-1 tabular-nums touch:finger"
            >
              {stretchSaid(stretch)}
              <button
                type="button"
                aria-label="Show all times again"
                onClick={() => setStretch(undefined)}
                className="grid size-5 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink-1"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
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
      {!phone && (
        <Histogram
          lines={visible}
          stretch={stretch}
          onStretch={(picked) => {
            setStretch(picked)
            // (Picked, the lines stay still: new ones would pass it by.)
            if (picked) setFollow(false)
          }}
        />
      )}
      {sources.length > MAX_STREAMS && (
        <p
          role="note"
          className="shrink-0 border-b border-line bg-surface-2 px-5 py-1.5 text-xs text-ink-2"
        >
          Streaming the first {MAX_STREAMS} of {sources.length} containers. Pick a container, or
          open a pod, to see the rest.
        </p>
      )}
      {since !== undefined && streamed.length > 1 && full.length > 0 ? (
        // (A span shared out among several containers, and one of them had more than its share:
        // which were cut, one a line, where a pointer asks.)
        <p
          role="note"
          title={full.join('\n')}
          className="shrink-0 border-b border-line px-5 py-1.5 text-xs text-ink-3"
        >
          Showing at most {tailLines!.toLocaleString()} lines of each container since{' '}
          {momentOf(since, pickedAt)}, the newest of each. Pick a later time, or one container, to
          see every line from it.
        </p>
      ) : (
        lines.length >= MAX_LINES && (
          <p role="note" className="shrink-0 border-b border-line px-5 py-1.5 text-xs text-ink-3">
            {since === undefined
              ? `Showing the latest ${MAX_LINES.toLocaleString()} lines.`
              : `Showing the last ${MAX_LINES.toLocaleString()} lines since ${momentOf(since, pickedAt)}. Pick a later time to see every line from it.`}
          </p>
        )
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
  /** `null` for every namespace. */
  namespace: string | null
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
