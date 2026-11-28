import { useState, type CSSProperties } from 'react'
import { useLayout } from '@renderer/lib/layout'
import { diffLines } from 'diff'
import { cn } from '@renderer/lib/cn'
import type { FindControl } from '@renderer/lib/find'
import { Findable, useFold, useFoldCount } from './Findable'

/** Unchanged lines shown around each change. */
const CONTEXT = 3

interface DiffLine {
  type: 'added' | 'removed' | 'same' | 'gap'
  text: string
  /** A gap's: the unchanged lines folded away, as they'd be shown. */
  folded?: DiffLine[]
}

/**
 * A unified diff with unchanged stretches folded away, and how many lines it adds and removes.
 * `shown`: what each side's lines are shown as (line for line, a masked copy of each), where the
 * diff is worked out on the real text: a change is never hidden by what it's shown as.
 */
export function unifiedDiff(
  before: string,
  after: string,
  shown?: { before: string; after: string },
): { lines: DiffLine[]; added: number; removed: number } {
  const show = shown && { before: shown.before.split('\n'), after: shown.after.split('\n') }
  let inBefore = 0
  let inAfter = 0
  const all: DiffLine[] = diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, '')
      .split('\n')
      .map((text) => {
        const type = part.added ? 'added' : part.removed ? 'removed' : 'same'
        // (A line the before has is shown as the before shows it; one only the after has, so.)
        const at = type === 'added' ? inAfter++ : inBefore++
        if (type === 'same') inAfter++
        const as = type === 'added' ? show?.after[at] : show?.before[at]
        return { type, text: as ?? text } as DiffLine
      }),
  )
  const near = (i: number) =>
    all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((line) => line.type !== 'same')
  const lines: DiffLine[] = []
  let skipped: DiffLine[] = []
  const gap = () => {
    if (skipped.length) {
      lines.push({ type: 'gap', text: `${skipped.length} unchanged lines`, folded: skipped })
    }
    skipped = []
  }
  all.forEach((line, i) => {
    if (near(i)) {
      gap()
      lines.push(line)
    } else skipped.push(line)
  })
  gap()
  return {
    lines,
    added: all.filter((l) => l.type === 'added').length,
    removed: all.filter((l) => l.type === 'removed').length,
  }
}

/**
 * A diff's lines: additions in green, removals in red, the rest folded. Where it `wraps` (a
 * phone's always do), a long line wraps whole: what runs over goes under its own text, set in, the
 * sign on its first row only, and nothing of it is cut at the edge or scrolls sideways. ⌘F finds
 * in its lines as they're shown (a masked copy's, where there's one), the folded ones too: a
 * step to a match in a fold unfolds it.
 */
export function DiffView({
  diff,
  label,
  wraps = false,
  flush = false,
  find,
}: {
  diff: { lines: DiffLine[] }
  label: string
  wraps?: boolean
  /** Its holder scrolls it, and has what stands round its lines: these are only the lines. */
  flush?: boolean
  /** Its toolbar's Find, where it has one. */
  find?: FindControl
}) {
  const phone = useLayout() === 'phone'
  const wrapping = wraps || phone
  // The folds a find's step has unfolded: by where they are, and what they say.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  return (
    <Findable label={label} inside={flush} control={find}>
      <pre
        aria-label={label}
        className={cn(
          'font-mono text-[12px] leading-[1.7] selectable',
          !flush && 'min-h-0 flex-1 overflow-auto bg-surface-2/60 py-3 phone:overflow-x-hidden',
          !flush && wraps && 'overflow-x-hidden',
        )}
      >
        {diff.lines.flatMap((line, i) => {
          const key = `${i}:${line.text}`
          if (line.type !== 'gap') {
            return [<Line key={i} line={line} wrapping={wrapping} phone={phone} />]
          }
          if (opened.has(key)) {
            return (line.folded ?? []).map((same, j) => (
              <Line key={`${i}.${j}`} line={same} wrapping={wrapping} phone={phone} />
            ))
          }
          return [
            <Gap key={i} line={line} onUnfold={() => setOpened((was) => new Set(was).add(key))} />,
          ]
        })}
      </pre>
    </Findable>
  )
}

const SIGN = { added: '+', removed: '−', same: ' ', gap: '⋯' }

function Line({ line, wrapping, phone }: { line: DiffLine; wrapping: boolean; phone: boolean }) {
  return (
    <div
      data-change={line.type}
      data-find-text=""
      // What runs over a wrapped line goes under its own text, two characters in: past the
      // sign's column and the line's own indent.
      style={
        wrapping
          ? ({
              '--lead': `${line.text.length - line.text.trimStart().length + 2}ch`,
            } as CSSProperties)
          : undefined
      }
      className={cn(
        'px-5 whitespace-pre',
        wrapping &&
          (phone
            ? 'pr-4 pl-[calc(1rem+1.5rem+var(--lead))] -indent-[calc(1.5rem+var(--lead))] wrap-anywhere whitespace-pre-wrap'
            : 'pr-5 pl-[calc(1.25rem+1.5rem+var(--lead))] -indent-[calc(1.5rem+var(--lead))] wrap-anywhere whitespace-pre-wrap'),
        line.type === 'added' && 'bg-good/10 text-good-text',
        line.type === 'removed' && 'bg-critical/10 text-critical-text',
        line.type === 'same' && 'text-ink-2',
      )}
    >
      {/* (Not indented as its line is: a wrapped line's negative indent would take the sign
          out of its column.) */}
      <span data-find-skip="" className="mr-3 inline-block w-3 indent-0 text-ink-3 select-none">
        {SIGN[line.type]}
      </span>
      {line.text}
    </div>
  )
}

/**
 * Unchanged lines, folded away: how many, and (while there's a search) how many of its matches
 * are in them. A find counts them, and unfolds them for a step to one.
 */
function Gap({ line, onUnfold }: { line: DiffLine; onUnfold: () => void }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useFold(element, {
    texts: (line.folded ?? []).map((same) => same.text),
    unfold: onUnfold,
  })
  const matches = useFoldCount(element)
  return (
    <div
      ref={setElement}
      data-change="gap"
      data-find-fold=""
      className="my-1 bg-surface-3/60 px-5 py-0.5 font-sans text-2xs whitespace-pre text-ink-3"
    >
      <span className="mr-3 inline-block w-3 indent-0 text-ink-3 select-none">{SIGN.gap}</span>
      {line.text}
      {matches > 0 && ` · ${matches.toLocaleString()} ${matches === 1 ? 'match' : 'matches'}`}
    </div>
  )
}
