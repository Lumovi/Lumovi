import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { FieldSchema } from '@shared/api'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'

/** Nested fields deeper than this start folded. */
const OPEN_DEPTH = 2
/** How far each level is indented (its margin, border and padding), in rem. */
const INDENT = 1.7
/** Long descriptions are cut in the tooltip; the full text is in the schema. */
const MAX_DESCRIPTION = 320

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNested = (value: unknown) =>
  isObject(value)
    ? Object.keys(value).length > 0
    : Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null)

/**
 * An object's fields as a tree: values inline, nested objects and lists
 * indented, each field explained by its schema when the cluster has one.
 */
export function FieldTree({
  value,
  schema,
  label,
}: {
  value: Record<string, unknown>
  schema?: FieldSchema
  label: string
}) {
  return (
    <div role="tree" aria-label={label} className="space-y-1 text-[13px]">
      <Fields value={value} schema={schema} depth={0} />
    </div>
  )
}

function Fields({
  value,
  schema,
  depth,
}: {
  value: Record<string, unknown> | unknown[]
  schema?: FieldSchema
  depth: number
}) {
  const entries: [string, unknown, FieldSchema | undefined][] = Array.isArray(value)
    ? value.map((item, i) => [itemLabel(item, i), item, schema?.items])
    : Object.entries(value).map(([key, item]) => [
        key,
        item,
        schema?.properties?.[key] ?? schema?.additionalProperties,
      ])
  return (
    <>
      {entries.map(([key, item, field]) => (
        <Field key={key} name={key} value={item} schema={field} depth={depth} />
      ))}
    </>
  )
}

/** List items go by their name when they have one (containers, ports…), else their position. */
function itemLabel(item: unknown, index: number): string {
  return isObject(item) && typeof item.name === 'string' ? item.name : `#${index + 1}`
}

function Field({
  name,
  value,
  schema,
  depth,
}: {
  name: string
  value: unknown
  schema?: FieldSchema
  depth: number
}) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH)
  const key = <FieldName name={name} description={schema?.description} />
  if (!isNested(value)) {
    return (
      <div role="treeitem" aria-label={name} className="flex min-w-0 gap-3">
        {/* Narrower as it's nested deeper, so values line up in one column. */}
        <span className="shrink-0" style={{ width: `max(6rem, ${11 - depth * INDENT}rem)` }}>
          {key}
        </span>
        <span className="min-w-0 flex-1">
          <Scalar value={value} />
        </span>
      </div>
    )
  }
  const count = Array.isArray(value) ? value.length : Object.keys(value as object).length
  const noun = Array.isArray(value)
    ? count === 1
      ? 'item'
      : 'items'
    : count === 1
      ? 'field'
      : 'fields'
  return (
    <div role="treeitem" aria-label={name} aria-expanded={open}>
      <span className="flex items-center gap-1">
        <button
          type="button"
          aria-label={open ? `Fold ${name}` : `Unfold ${name}`}
          onClick={() => setOpen(!open)}
          className="-ml-5 grid size-4 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink-1"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        {key}
        {!open && (
          <span className="text-xs text-ink-3">
            {count} {noun}
          </span>
        )}
      </span>
      {open && (
        <div
          role="group"
          className="mt-1 ml-1.5 space-y-1 border-l border-line pl-[calc(1.325rem-1px)]"
        >
          <Fields
            value={value as Record<string, unknown> | unknown[]}
            schema={schema}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  )
}

/** A field's name, with its description in a tooltip when the schema has one. */
function FieldName({ name, description }: { name: string; description?: string }): ReactNode {
  const text = <span className="font-mono text-xs text-ink-2">{name}</span>
  if (!description) return text
  const short =
    description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description
  return (
    <Tooltip content={short} side="right">
      <span
        tabIndex={0}
        aria-description={description}
        className="cursor-help font-mono text-xs text-ink-2 underline decoration-line-strong decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {name}
      </span>
    </Tooltip>
  )
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-ink-3">null</span>
  if (Array.isArray(value)) {
    return value.length ? (
      <span className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          <span
            key={i}
            className="rounded bg-surface-3 px-1.5 font-mono text-xs text-ink-1 selectable"
          >
            {String(item)}
          </span>
        ))}
      </span>
    ) : (
      <span className="text-ink-3">[]</span>
    )
  }
  if (isObject(value)) return <span className="text-ink-3">{'{}'}</span>
  return (
    <span
      title={String(value)}
      className={cn(
        'line-clamp-3 font-mono text-xs break-all selectable',
        typeof value === 'string' ? 'text-ink-1' : 'text-accent-strong',
      )}
    >
      {String(value)}
    </span>
  )
}
