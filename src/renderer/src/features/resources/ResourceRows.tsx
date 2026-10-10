import { useVirtualizer } from '@tanstack/react-virtual'
import { Fragment, useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react'
import type { KubeObject } from '@shared/api'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { objectKey } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import type { CellContext, Column } from './columns'

/** A row's height: two lines, and a finger's worth around them. */
export const PHONE_ROW_HEIGHT = 60
/** How many of a kind's own columns a row's second line says. */
const FACTS = 2
/** What a row shows in places of its own: not among its facts. */
const PLACED = new Set(['name', 'status', 'age', 'lastSeen'])

/**
 * A list on a phone: one column, two lines an object. Its name and its status (the table's own
 * pill, whole); then its namespace where every namespace is listed, the first of its kind's
 * columns as a line of facts, and its age. A name gives way in its middle, and the facts at
 * their end; the status and the age never do. A tap opens it: there's nothing else to do to a
 * row here, and nothing to pick.
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
}) {
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
    estimateSize: () => PHONE_ROW_HEIGHT,
    overscan: 8,
  })

  const name = columns.find((column) => column.id === 'name')
  const status = columns.find((column) => column.id === 'status')
  const when = columns.find((column) => column.id === 'age' || column.id === 'lastSeen')
  const said = columns.filter((column) => !PLACED.has(column.id) && column.fact !== false)
  // A kind without names worth reading (an event's is a hash) leads with its first column.
  const lead = name ? undefined : said[0]
  const facts = said.slice(lead ? 1 : 0, (lead ? 1 : 0) + FACTS)
  const factOf = (column: Column, object: KubeObject) => (column.fact || column.cell)(object, ctx)

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <ul aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const object = rows[item.index]!
          const line: ReactNode[] = [
            ...(name?.namespaced && object.metadata.namespace ? [object.metadata.namespace] : []),
            ...facts.map((column) => factOf(column, object)),
          ]
          return (
            <li
              key={rowKey(object)}
              className="absolute inset-x-0 top-0"
              style={{ height: PHONE_ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
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
                status={status?.cell(object, ctx)}
                facts={line}
                when={when?.cell(object, ctx)}
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
  when,
  onOpen,
  className,
}: {
  /** Its first line's start: it takes the room, and at least 120 px. */
  name: ReactNode
  status?: ReactNode
  facts: ReactNode[]
  when?: ReactNode
  onOpen: () => void
  className?: string
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
        <span className="min-w-0 flex-1 truncate [&_*]:text-xs">
          {facts.map((fact, i) => (
            <Fragment key={i}>
              {i > 0 && ' · '}
              {fact}
            </Fragment>
          ))}
        </span>
        {when && <span className="shrink-0 tabular-nums">{when}</span>}
      </span>
    </button>
  )
}
