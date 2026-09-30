import type { Health } from '@renderer/lib/health'
import { HEALTH_STYLE } from './Status'
import { Tooltip } from './Tooltip'

export interface Segment {
  health: Health
  label: string
  value: number
}

/** Part-to-whole by status: 2px surface gaps between segments, legend with counts below. */
export function StackedBar({ segments, label }: { segments: Segment[]; label: string }) {
  const visible = segments.filter((s) => s.value > 0)
  return (
    <div>
      <div
        role="list"
        aria-label={label}
        className="flex h-2.5 gap-[2px] overflow-hidden rounded-full"
      >
        {visible.map((segment) => (
          <Tooltip key={segment.label} side="top" content={`${segment.label}: ${segment.value}`}>
            <div
              role="listitem"
              aria-label={`${segment.label}: ${segment.value}`}
              className={`${HEALTH_STYLE[segment.health].dot} min-w-1.5 transition-[flex-grow] duration-500 hover:brightness-110`}
              style={{ flexGrow: segment.value }}
            />
          </Tooltip>
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2 text-xs text-ink-2">
            <span
              aria-hidden
              className={`size-2 rounded-[3px] ${HEALTH_STYLE[segment.health].dot}`}
            />
            {segment.label}
            <span className="font-semibold text-ink-1 tabular-nums">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
