import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Fragment,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import type { KubeObject } from '@shared/api'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { objectKey } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import type { TableLayout } from './ColumnsMenu'
import type { CellContext, Column } from './columns'

/** A row's height: two lines, and a finger's worth around them. */
export const PHONE_ROW_HEIGHT = 60
/** A row's, where columns were chosen: its name, and its facts on two lines at most. */
const CHOSEN_ROW_HEIGHT = 80
/** How many of a kind's own columns a row's second line says. */
const FACTS = 2
/** What a row shows in places of its own: not among its facts. */
const PLACED = new Set(['name', 'status', 'age', 'lastSeen'])

/**
 * A list on a phone: one column, two lines an object. Its name and its status (the table's own
 * pill, whole); then its namespace where every namespace is listed, the first of its kind's
 * columns as a line of facts, and its age. A name gives way in its middle, and the facts at
 * their end; the status and the age never do. What manages it, where something does, is said
 * after the kind's first, and gives way only down to its least. A tap opens it: there's nothing
 * else to do to a row here, and nothing to pick.
 *
 * Where the person chose its columns, a row is its name, then the shown columns as its facts, in
 * their order (the status as its pill), wrapping to a second line and no further; a fact the
 * object hasn't is left out.
 */
export function ResourceRows({
  ref,
  label,
  columns,
  rows,
  ctx,
  onOpen,
  resetKey,
  rowKey = objectKey,
  layout,
}: {
  ref?: Ref<HTMLDivElement>
  label: string
  columns: Column[]
  rows: KubeObject[]
  ctx: CellContext
  onOpen: (object: KubeObject) => void
  /** Changes when a different page is shown: scroll starts over. */
  resetKey?: string | number
  rowKey?: (object: KubeObject) => string
  layout?: TableLayout
}) {
  const chosen = layout?.chosen === true
  const height = chosen ? CHOSEN_ROW_HEIGHT : PHONE_ROW_HEIGHT
  const scrollRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => scrollRef.current!, [])
  useEffect(() => {
    scrollRef.current!.scrollTo({ top: 0 })
  }, [resetKey])
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: 8,
  })

  const name = columns.find((column) => column.id === 'name')
  const status = columns.find((column) => column.id === 'status')
  const when = columns.find((column) => column.id === 'age' || column.id === 'lastSeen')
  const said = columns.filter((column) => !PLACED.has(column.id) && column.fact !== false)
  // A kind without names worth reading (an event's is a hash) leads with its first column.
  const lead = name ? undefined : said[0]
  const facts = said.slice(lead ? 1 : 0, (lead ? 1 : 0) + FACTS)
  // (Only what manages a workload is, so far: the row holds the first of them firm, and any other
  // would come after it, giving way first.)
  const always = said.filter((column) => column.alwaysSaid && !facts.includes(column))
  const factOf = (column: Column, object: KubeObject) => (column.fact || column.cell)(object, ctx)

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <ul aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const object = rows[item.index]!
          const first: ReactNode[] = [
            ...(name?.namespaced && object.metadata.namespace ? [object.metadata.namespace] : []),
            ...facts.slice(0, 1).map((column) => factOf(column, object)),
          ]
          // (After the kind's first, what a list is scanned for, and before the rest.)
          const said = always
            .map((column) => factOf(column, object))
            .filter((fact) => fact !== undefined && fact !== null && fact !== '')
          const line: ReactNode[] = chosen
            ? columns
                .filter((column) => column.id !== 'name' && column.fact !== false)
                .map((column) =>
                  column.id === 'status' ? column.cell(object, ctx) : factOf(column, object),
                )
                .filter((fact) => fact !== undefined && fact !== null && fact !== '')
            : [...first, ...said, ...facts.slice(1).map((column) => factOf(column, object))]
          return (
            <li
              key={rowKey(object)}
              className="absolute inset-x-0 top-0"
              style={{ height, transform: `translateY(${item.start}px)` }}
            >
              <PhoneRow
                onOpen={() => onOpen(object)}
                name={
                  lead ? (
                    <span className="flex min-w-[120px] flex-1 font-medium text-ink-1 [&>*]:truncate">
                      {factOf(lead, object)}
                    </span>
                  ) : (
                    <MiddleTruncate
                      text={object.metadata.name}
                      className="min-w-[120px] flex-1 font-medium text-ink-1"
                    />
                  )
                }
                status={chosen ? undefined : status?.cell(object, ctx)}
                facts={line}
                firm={chosen || said.length === 0 ? undefined : first.length}
                when={chosen ? undefined : when?.cell(object, ctx)}
                wrap={chosen}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The row itself, wherever a phone lists objects (a list, the overview's cards): its name and
 * its status, whole; then a line of facts, which gives way at its end, and when.
 */
export function PhoneRow({
  name,
  status,
  facts,
  firm,
  when,
  onOpen,
  className,
  wrap = false,
}: {
  /** Its first line's start: it takes the room, and at least 120 px. */
  name: ReactNode
  status?: ReactNode
  facts: ReactNode[]
  /** Which of its facts is always said (`FirmFacts`), where one is. */
  firm?: number
  when?: ReactNode
  onOpen: () => void
  className?: string
  /** Facts that wrap to a second line, and no further, each whole. */
  wrap?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex h-full w-full flex-col justify-center gap-[3px] border-b border-line px-4 text-left outline-offset-[-2px] active:bg-surface-3/50',
        className,
      )}
    >
      <span className="flex w-full items-center gap-3">
        {name}
        {status && <span className="flex max-w-[200px] shrink-0">{status}</span>}
      </span>
      <span className="flex w-full gap-3 text-xs text-ink-3">
        {wrap ? (
          <span className="flex max-h-[42px] min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden [&_*]:text-xs [&>*]:max-w-full [&>*]:truncate">
            {facts.map((fact, i) => (
              <span key={i} className="flex h-5 items-center">
                {fact}
              </span>
            ))}
          </span>
        ) : firm === undefined ? (
          <span className="min-w-0 flex-1 truncate [&_*]:text-xs">{joined(facts)}</span>
        ) : (
          <FirmFacts facts={facts} firm={firm} />
        )}
        {when && <span className="shrink-0 tabular-nums">{when}</span>}
      </span>
    </button>
  )
}

/** Facts, with a dot between each two. */
const joined = (facts: ReactNode[]) =>
  facts.map((fact, i) => (
    <Fragment key={i}>
      {i > 0 && ' · '}
      {fact}
    </Fragment>
  ))

/**
 * A row's facts with one that's always said (what manages a workload): those before it on their
 * line, which gives way at its end; it, on what's left of that line, down to its least (as narrow
 * as it can be laid out) and no further, or else starting the second line, all of it there that
 * fits; and those after it on the second line, after it where it moved, giving way first.
 */
function FirmFacts({ facts, firm }: { facts: ReactNode[]; firm: number }) {
  const before = facts.slice(0, firm)
  const after = facts.slice(firm + 1)
  const kept = useRef<HTMLSpanElement>(null)
  const [moved, setMoved] = useState(false)
  useLayoutEffect(() => {
    const span = kept.current!
    const lines = span.parentElement!
    // (Each change of where it is changes how many lines there are, and so their height.)
    const fit = () =>
      setMoved(span.getBoundingClientRect().top > lines.getBoundingClientRect().top + 1)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(lines)
    return () => observer.disconnect()
  }, [])
  return (
    <span className="flex min-w-0 flex-1 flex-wrap [&_*]:text-xs">
      {before.length > 0 && (
        <span className="max-w-full shrink-0 truncate">
          {joined(before)}
          <span className="whitespace-pre"> · </span>
        </span>
      )}
      {/* (Laid out at its least, so it's moved only where that doesn't fit; then all it can be.) */}
      <span ref={kept} className="flex w-min max-w-max grow-[999]">
        {facts[firm]}
        {after.length > 0 && <span className="shrink-0 whitespace-pre"> · </span>}
      </span>
      {after.length > 0 && (
        <span className={cn('min-w-0 truncate', moved ? 'flex-1 basis-0' : 'basis-full')}>
          {joined(after)}
        </span>
      )}
    </span>
  )
}
