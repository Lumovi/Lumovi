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

/** A diff's lines: additions in green, removals in red, the rest folded. */
export function DiffView({ diff, label }: { diff: { lines: DiffLine[] }; label: string }) {
  return (
    <pre
      aria-label={label}
      className="min-h-0 flex-1 overflow-auto bg-surface-2/60 py-3 font-mono text-[12px] leading-[1.7] selectable"
    >
      {diff.lines.map((line, i) => (
        <div
          key={i}
          data-change={line.type}
          className={cn(
            'px-5 whitespace-pre',
            line.type === 'added' && 'bg-good/10 text-good-text',
            line.type === 'removed' && 'bg-critical/10 text-critical-text',
            line.type === 'same' && 'text-ink-2',
            line.type === 'gap' && 'my-1 bg-surface-3/60 py-0.5 font-sans text-2xs text-ink-3',
          )}
        >
          <span className="mr-3 inline-block w-3 text-ink-3 select-none">
            {{ added: '+', removed: '−', same: ' ', gap: '⋯' }[line.type]}
          </span>
          {line.text}
        </div>
      ))}
    </pre>
  )
}
