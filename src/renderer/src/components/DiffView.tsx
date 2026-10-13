import type { CSSProperties } from 'react'
import { useLayout } from '@renderer/lib/layout'
import { diffLines } from 'diff'
import { cn } from '@renderer/lib/cn'

/** Unchanged lines shown around each change. */
const CONTEXT = 3

interface DiffLine {
  type: 'added' | 'removed' | 'same' | 'gap'
  text: string
}

/** A unified diff with unchanged stretches folded away, and how many lines it adds and removes. */
export function unifiedDiff(
  before: string,
  after: string,
): { lines: DiffLine[]; added: number; removed: number } {
  const all: DiffLine[] = diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, '')
      .split('\n')
      .map(
        (text) =>
          ({ type: part.added ? 'added' : part.removed ? 'removed' : 'same', text }) as DiffLine,
      ),
  )
  const near = (i: number) =>
    all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((line) => line.type !== 'same')
  const lines: DiffLine[] = []
  let skipped = 0
  all.forEach((line, i) => {
    if (near(i)) {
      if (skipped) lines.push({ type: 'gap', text: `${skipped} unchanged lines` })
      skipped = 0
      lines.push(line)
    } else skipped++
  })
  if (skipped) lines.push({ type: 'gap', text: `${skipped} unchanged lines` })
  return {
    lines,
    added: all.filter((l) => l.type === 'added').length,
    removed: all.filter((l) => l.type === 'removed').length,
  }
}

/**
 * A diff's lines: additions in green, removals in red, the rest folded. Where it `wraps` (a
 * phone's always do), a long line wraps whole: what runs over goes under its own text, set in, the
 * sign on its first row only, and nothing of it is cut at the edge or scrolls sideways.
 */
export function DiffView({
  diff,
  label,
  wraps = false,
  flush = false,
}: {
  diff: { lines: DiffLine[] }
  label: string
  wraps?: boolean
  /** Its holder scrolls it, and has what stands round its lines: these are only the lines. */
  flush?: boolean
}) {
  const phone = useLayout() === 'phone'
  const wrapping = wraps || phone
  return (
    <pre
      aria-label={label}
      className={cn(
        'font-mono text-[12px] leading-[1.7] selectable',
        !flush && 'min-h-0 flex-1 overflow-auto bg-surface-2/60 py-3 phone:overflow-x-hidden',
        !flush && wraps && 'overflow-x-hidden',
      )}
    >
      {diff.lines.map((line, i) => (
        <div
          key={i}
          data-change={line.type}
          // What runs over a wrapped line goes under its own text, two characters in: past the
          // sign's column and the line's own indent.
          style={
            wrapping && line.type !== 'gap'
              ? ({
                  '--lead': `${line.text.length - line.text.trimStart().length + 2}ch`,
                } as CSSProperties)
              : undefined
          }
          className={cn(
            'px-5 whitespace-pre',
            wrapping &&
              line.type !== 'gap' &&
              (phone
                ? 'pr-4 pl-[calc(1rem+1.5rem+var(--lead))] -indent-[calc(1.5rem+var(--lead))] wrap-anywhere whitespace-pre-wrap'
                : 'pr-5 pl-[calc(1.25rem+1.5rem+var(--lead))] -indent-[calc(1.5rem+var(--lead))] wrap-anywhere whitespace-pre-wrap'),
            line.type === 'added' && 'bg-good/10 text-good-text',
            line.type === 'removed' && 'bg-critical/10 text-critical-text',
            line.type === 'same' && 'text-ink-2',
            line.type === 'gap' && 'my-1 bg-surface-3/60 py-0.5 font-sans text-2xs text-ink-3',
          )}
        >
          {/* (Not indented as its line is: a wrapped line's negative indent would take the sign
              out of its column.) */}
          <span className="mr-3 inline-block w-3 indent-0 text-ink-3 select-none">
            {{ added: '+', removed: '−', same: ' ', gap: '⋯' }[line.type]}
          </span>
          {line.text}
        </div>
      ))}
    </pre>
  )
}
