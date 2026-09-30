import { Plus, Tags, X } from 'lucide-react'
import { useState } from 'react'
import { useChange } from '@renderer/hooks/change'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

type Field = 'labels' | 'annotations'
type Pairs = Record<string, string>

/** Managed by `kubectl apply`, huge, and not meant to be edited by hand. */
const HIDDEN = new Set(['kubectl.kubernetes.io/last-applied-configuration'])

const NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const PREFIX = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

/** Why a key is invalid, like the API server would say, or undefined. */
function keyError(key: string): string | undefined {
  if (key === '') return 'Enter a key'
  const slash = key.lastIndexOf('/')
  if (slash >= 0 && !PREFIX.test(key.slice(0, slash))) {
    return 'The prefix must be a DNS subdomain, like example.com'
  }
  return NAME.test(key.slice(slash + 1))
    ? undefined
    : 'Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit'
}

function valueError(field: Field, value: string): string | undefined {
  if (field === 'annotations' || value === '' || NAME.test(value)) return undefined
  return 'Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit'
}

interface Row {
  id: number
  key: string
  value: string
}

let nextRow = 1
const rowsOf = (pairs: Pairs): Row[] =>
  Object.entries(pairs)
    .filter(([key]) => !HIDDEN.has(key))
    .map(([key, value]) => ({ id: nextRow++, key, value }))

/** The merge patch that turns `from` into `to`: changed keys, and null for removed ones. */
function diff(from: Pairs, to: Pairs): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  for (const key of Object.keys(from)) if (!(key in to)) patch[key] = null
  for (const [key, value] of Object.entries(to)) if (from[key] !== value) patch[key] = value
  return patch
}

/** `kubectl label a=b c-` for a patch; annotations use `kubectl annotate`. */
function commandArgs(field: Field, patch: Record<string, string | null>): string[] | undefined {
  const args = Object.entries(patch).map(([key, value]) =>
    value === null ? `${key}-` : `${key}=${value}`,
  )
  if (args.length === 0) return undefined
  return [field === 'labels' ? 'label' : 'annotate', ...args, '--overwrite']
}

export function LabelsDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const { name, namespace } = object.metadata
  const original: Record<Field, Pairs> = {
    labels: object.metadata.labels ?? {},
    annotations: Object.fromEntries(
      Object.entries(object.metadata.annotations ?? {}).filter(([key]) => !HIDDEN.has(key)),
    ),
  }
  const [field, setField] = useState<Field>('labels')
  const [rows, setRows] = useState<Record<Field, Row[]>>(() => ({
    labels: rowsOf(original.labels),
    annotations: rowsOf(original.annotations),
  }))
  const { pending, error, submit } = useSubmit(onClose)

  const pairs = (f: Field): Pairs => Object.fromEntries(rows[f].map((r) => [r.key.trim(), r.value]))
  const duplicates = (f: Field) => {
    const seen = new Set<string>()
    return new Set(
      rows[f].map((r) => r.key.trim()).filter((key) => seen.has(key) || !seen.add(key)),
    )
  }
  const invalid = (['labels', 'annotations'] as Field[]).some(
    (f) =>
      duplicates(f).size > 0 ||
      rows[f].some((r) => keyError(r.key.trim()) || valueError(f, r.value)),
  )
  const patches = {
    labels: diff(original.labels, pairs('labels')),
    annotations: diff(original.annotations, pairs('annotations')),
  }
  const inverse = {
    labels: diff(pairs('labels'), original.labels),
    annotations: diff(pairs('annotations'), original.annotations),
  }
  const changes = Object.keys(patches.labels).length + Object.keys(patches.annotations).length
  const commandFor = (p: typeof patches) =>
    (['labels', 'annotations'] as Field[])
      .map((f) => commandArgs(f, p[f]))
      .filter((args) => args !== undefined)
      .map((args) =>
        kubectl(context, namespace, args[0]!, objectArg(kindOf(object), name), ...args.slice(1)),
      )
      .join('\n')
  const command =
    commandFor(patches) || kubectl(context, namespace, 'label', objectArg(kindOf(object), name))
  const patchOf = (p: typeof patches) => ({
    metadata: { labels: p.labels, annotations: p.annotations },
  })

  const update = (id: number, patch: Partial<Row>) =>
    setRows({ ...rows, [field]: rows[field].map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  const dupes = duplicates(field)

  return (
    <ActionDialog
      icon={Tags}
      title={`Labels and annotations of ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Save"
      wide
      ready={changes > 0 && !invalid}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: { action: 'patch', patchType: 'merge', patch: patchOf(patches) },
            },
            {
              title: `Updated the labels and annotations of ${name}`,
              command,
              undo: {
                change: {
                  ...target(object),
                  change: { action: 'patch', patchType: 'merge', patch: patchOf(inverse) },
                },
                meta: {
                  title: `Restored the labels and annotations of ${name}`,
                  command: commandFor(inverse),
                },
              },
            },
          ),
        )
      }
    >
      <div
        role="tablist"
        aria-label="Metadata"
        className="flex gap-1 rounded-lg bg-surface-3 p-0.5"
      >
        {(['labels', 'annotations'] as Field[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={field === f}
            onClick={() => setField(f)}
            className="h-7 flex-1 rounded-md text-[13px] font-medium text-ink-2 capitalize transition-colors aria-selected:bg-surface aria-selected:text-ink-1 aria-selected:shadow-xs"
          >
            {f} <span className="text-ink-3 tabular-nums">{rows[f].length}</span>
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={field} className="space-y-2">
        {rows[field].length === 0 && (
          <p className="py-2 text-center text-[13px] text-ink-3">No {field} yet.</p>
        )}
        {rows[field].map((row) => {
          const problem =
            (dupes.has(row.key.trim()) ? 'This key is used twice' : undefined) ??
            keyError(row.key.trim()) ??
            valueError(field, row.value)
          return (
            <div key={row.id}>
              <div className="flex items-center gap-1.5">
                <input
                  aria-label="Key"
                  value={row.key}
                  placeholder="key"
                  spellCheck={false}
                  onChange={(event) => update(row.id, { key: event.target.value })}
                  className={cn(
                    'h-8 min-w-0 flex-1 rounded-lg border bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft',
                    problem ? 'border-critical/60' : 'border-line-strong',
                  )}
                />
                <span className="text-ink-3">=</span>
                <input
                  aria-label={`Value of ${row.key || 'new key'}`}
                  value={row.value}
                  placeholder="value"
                  spellCheck={false}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  className="h-8 min-w-0 flex-[1.4] rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
                />
                <button
                  type="button"
                  aria-label={`Remove ${row.key || 'new key'}`}
                  onClick={() =>
                    setRows({ ...rows, [field]: rows[field].filter((r) => r.id !== row.id) })
                  }
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink-1"
                >
                  <X className="size-4" />
                </button>
              </div>
              {problem && row.key !== '' && (
                <p className="mt-1 text-xs text-critical-text">{problem}</p>
              )}
            </div>
          )
        })}
        <button
          type="button"
          onClick={() =>
            setRows({ ...rows, [field]: [...rows[field], { id: nextRow++, key: '', value: '' }] })
          }
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-accent-strong hover:bg-accent-soft"
        >
          <Plus className="size-4" /> Add {field === 'labels' ? 'label' : 'annotation'}
        </button>
      </div>
      <p className="text-xs text-ink-3" aria-live="polite">
        {changes === 0
          ? 'No changes yet.'
          : `${changes} ${changes === 1 ? 'change' : 'changes'} to save.`}
      </p>
    </ActionDialog>
  )
}
