/**
 * A field of chips, for a cluster's labels and groups: the Fleet page's dialogs share it.
 */
import { X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { labelKeyError, labelValueError } from '@shared/fleet'
import { cn } from '@renderer/lib/cn'

/** Why a label, as `key=value`, is invalid, or undefined. */
export function labelError(text: string): string | undefined {
  const at = text.indexOf('=')
  return (
    labelKeyError(at < 0 ? text : text.slice(0, at)) ??
    (at < 0 ? 'A label is key=value' : labelValueError(text.slice(at + 1)))
  )
}

/** Labels, as `key=value`: a key once, the last value given for it. */
export const lastOfEachKey = (labels: string[]) =>
  labels.filter((label, i) => !labels.slice(i + 1).some((later) => keyOf(later) === keyOf(label)))

/** Labels, as `key=value`, as a map. */
export const labelMap = (labels: string[]): Record<string, string> =>
  Object.fromEntries(labels.map((label) => [keyOf(label), label.slice(label.indexOf('=') + 1)]))

const keyOf = (label: string) => label.slice(0, label.indexOf('='))

/**
 * Values as chips, each added as it's typed (Enter or a comma), checked first; removed with its
 * X, or Backspace in an empty field. Locked, they're only shown.
 */
export function ChipsField({
  id,
  label,
  values,
  locked,
  placeholder,
  check,
  onChange,
  mono = false,
}: {
  id: string
  /** What each is, in words: "label". */
  label: string
  values: string[]
  locked: boolean
  placeholder: string
  check: (text: string) => string | undefined
  onChange: (values: string[]) => void
  mono?: boolean
}) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string>()
  const add = () => {
    const value = text.trim()
    if (!value) return
    const error = check(value)
    if (error) {
      setProblem(error)
      return
    }
    onChange([...values, value])
    setText('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',') && text.trim()) {
      // Enter adds it, not saves (with nothing typed, it saves).
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }
  return (
    <>
      <div
        className={cn(
          'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border px-1.5 py-1',
          locked
            ? 'border-line bg-surface-2'
            : problem
              ? 'border-critical bg-surface focus-within:ring-3 focus-within:ring-critical/15'
              : 'border-line-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        )}
      >
        {values.map((value) => (
          <span
            key={value}
            className={cn(
              'flex h-5 items-center gap-0.5 rounded-md text-2xs',
              mono && 'font-mono',
              locked
                ? 'border border-line bg-transparent px-1.5 text-ink-2'
                : 'bg-surface-3 pr-1 pl-1.5 text-ink-1',
            )}
          >
            {value}
            {!locked && (
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="grid place-items-center rounded text-ink-3 hover:text-ink-1"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {locked ? (
          values.length === 0 && <span className="px-1 text-xs text-ink-3">None</span>
        ) : (
          <input
            id={id}
            value={text}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Add a ${label}`}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(event) => {
              setText(event.target.value)
              setProblem(undefined)
            }}
            onKeyDown={onKeyDown}
            onBlur={add}
            className={cn(
              'h-5 min-w-28 flex-1 bg-transparent px-1 text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-xs placeholder:text-ink-3',
              mono && 'font-mono text-2xs',
            )}
          />
        )}
      </div>
      {problem && (
        <p role="alert" className="mt-1.5 text-xs text-critical-text">
          {problem}.
        </p>
      )}
    </>
  )
}
