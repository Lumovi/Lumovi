/** An alert's parts, as its row and its panel draw them. */
import type { PrometheusAlert } from '@shared/api'
import { KindIcon } from '@renderer/components/KindIcon'
import { StatusDot, StatusPill } from '@renderer/components/Status'
import { Tooltip } from '@renderer/components/Tooltip'
import { useUpdateParams } from '@renderer/hooks/update-params'
import {
  objectOf,
  SEVERITY_LEVEL,
  SEVERITY_WORDS,
  severityOf,
  stateLine,
} from '@renderer/lib/alerts'
import { cn } from '@renderer/lib/cn'
import { formatRef } from '@renderer/lib/routes'

/** Its name with its severity's dot, and its summary under it, as its rule's author wrote it. */
export function AlertLead({ alert }: { alert: PrometheusAlert }) {
  const severity = severityOf(alert)
  const summary = alert.annotations.summary
  return (
    <span className="flex min-w-0 items-start gap-2">
      <StatusDot
        health={SEVERITY_LEVEL[severity]}
        className={cn('mt-1.5', severity === 'none' && 'invisible')}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-ink-1">{alert.name}</span>
        {summary && (
          <span className="truncate text-xs text-ink-3" title={summary}>
            {summary}
          </span>
        )}
      </span>
    </span>
  )
}

/** Critical and Warning with their level's look and icon; Info and none quiet words. */
export function SeverityWord({ alert }: { alert: PrometheusAlert }) {
  const severity = severityOf(alert)
  if (severity === 'critical' || severity === 'warning') {
    return (
      <StatusPill status={{ health: SEVERITY_LEVEL[severity], label: SEVERITY_WORDS[severity] }} />
    )
  }
  // (Another word than these four is the rule's own, said as it is.)
  const said = alert.labels.severity
  return (
    <span className="truncate text-xs text-ink-3">
      {severity === 'none' && said && said.toLowerCase() !== 'none'
        ? said
        : SEVERITY_WORDS[severity]}
    </span>
  )
}

/** Firing over how long it has, or Pending (quieter) over when it fires, if its condition holds. */
export function StateCell({ alert, now }: { alert: PrometheusAlert; now: number }) {
  const line = stateLine(alert, now)
  const cell = (
    <span className="flex min-w-0 flex-col">
      <span
        className={cn(
          'text-[13px]',
          alert.state === 'firing' ? 'font-medium text-ink-1' : 'text-ink-2',
        )}
      >
        {alert.state === 'firing' ? 'Firing' : 'Pending'}
      </span>
      {line && <span className="truncate text-xs text-ink-3 tabular-nums">{line}</span>}
    </span>
  )
  return alert.state === 'pending' && line ? (
    <Tooltip content={`${line[0]!.toUpperCase()}${line.slice(1)} if it holds`}>{cell}</Tooltip>
  ) : (
    cell
  )
}

/** The object its labels name, as a link that opens it; a dash where they name none. */
export function ObjectLink({ alert }: { alert: PrometheusAlert }) {
  const object = objectOf(alert)
  const updateParams = useUpdateParams()
  if (!object) return <span className="text-ink-3">—</span>
  const named = object.namespace ? `${object.namespace}/${object.name}` : object.name
  return (
    <button
      type="button"
      // (Its own: the row it's in opens the alert.)
      onClick={(event) => {
        event.stopPropagation()
        updateParams((params) => {
          params.delete('alert')
          params.set('open', formatRef(object))
        })
      }}
      className="flex min-w-0 items-center gap-1.5 rounded text-left text-[13px] text-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <KindIcon kind={object.kind} className="size-3.5 shrink-0 text-ink-3" />
      <span className="truncate">
        {object.kind} {named}
      </span>
    </button>
  )
}
