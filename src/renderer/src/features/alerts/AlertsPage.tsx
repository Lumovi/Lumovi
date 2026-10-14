/**
 * The Alerts page: the alerts the cluster's Prometheus holds, firing and pending, worst first.
 * They come from the source the Metrics page uses, read through the cluster as the person, again
 * every 30 seconds while the page is shown. A row is an alert (one an instance of its rule: two
 * pods crash-looping are two rows), and one opens in the detail panel.
 */
import { useLayout } from '@renderer/lib/layout'
import { Bell, CircleCheck, SearchX, ServerOff, ShieldAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject, PrometheusAlert } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { EmptyState, Loading, StaleNotice } from '@renderer/components/States'
import { Tooltip } from '@renderer/components/Tooltip'
import { useAlerts, useHistorySource } from '@renderer/hooks/history'
import { useUpdateParams } from '@renderer/hooks/update-params'
import {
  alertId,
  byConcern,
  inNamespaces,
  matchesText,
  ruleCounts,
  SEVERITIES,
  SEVERITY_LEVEL,
  SEVERITY_WORDS,
  severityOf,
  stateLine,
  type Severity,
} from '@renderer/lib/alerts'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { useListColumns } from '../resources/ColumnsMenu'
import { sortRows, type CellContext, type Column } from '../resources/columns'
import { ListBar } from '../resources/ListToolbar'
import { ResourceTable } from '../resources/ResourceTable'
import { AlertLead, ObjectLink, SeverityWord, StateCell } from './parts'

/** An alert as a table row: the table lists objects, keyed here by the alert's own id. */
type Row = KubeObject & { alert: PrometheusAlert }
const alertOf = (o: KubeObject) => (o as Row).alert
const rowKey = (o: KubeObject) => o.metadata.uid!

const COLUMNS: Column[] = [
  {
    id: 'alert',
    header: 'Alert',
    width: 'minmax(240px, 2.2fr)',
    priority: 1,
    cell: (o) => <AlertLead alert={alertOf(o)} />,
    text: (o) => alertOf(o).name,
    sort: (o) => alertOf(o).name,
  },
  {
    id: 'severity',
    header: 'Severity',
    width: '104px',
    priority: 1,
    cell: (o) => <SeverityWord alert={alertOf(o)} />,
    text: (o) => SEVERITY_WORDS[severityOf(alertOf(o))],
    // (Worst first, firing before pending: the rows come in the rest of that order already.)
    sort: (o) =>
      SEVERITIES.indexOf(severityOf(alertOf(o))) * 2 + Number(alertOf(o).state === 'pending'),
  },
  {
    id: 'state',
    header: 'State',
    width: '112px',
    priority: 1,
    cell: (o, ctx) => <StateCell alert={alertOf(o)} now={ctx.now} />,
    // (On a phone, a fact on one line: "Firing, 11m", "Pending, fires in 11m".)
    fact: (o, ctx) => {
      const alert = alertOf(o)
      const line = stateLine(alert, ctx.now)
      if (alert.state === 'pending') return line ? `Pending, ${line}` : 'Pending'
      return line ? `Firing, ${line.replace(/^for /, '')}` : 'Firing'
    },
    text: (o) => (alertOf(o).state === 'firing' ? 'Firing' : 'Pending'),
    sort: (o) => Number(alertOf(o).state === 'pending'),
  },
  {
    id: 'object',
    header: 'Object',
    width: 'minmax(160px, 1.5fr)',
    priority: 2,
    cell: (o) => <ObjectLink alert={alertOf(o)} />,
  },
  {
    id: 'active',
    header: 'Active',
    width: '72px',
    align: 'right',
    priority: 2,
    cell: (o, ctx) => {
      const at = alertOf(o).activeAt
      return (
        <span className="text-ink-2 tabular-nums">
          {at === undefined ? '—' : age(new Date(at).toISOString(), ctx.now)}
        </span>
      )
    },
    csv: { value: (o) => alertOf(o).activeAt && new Date(alertOf(o).activeAt!).toISOString() },
    sort: (o) => -(alertOf(o).activeAt ?? 0),
  },
]

/** The chips' filters: severities, and firing or pending. */
type StateFilter = 'firing' | 'pending'

export function AlertsPage() {
  const { namespaces } = useCluster()
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const source = useHistorySource()
  const alerts = useAlerts()
  const chooseSource = useUi((ui) => ui.setMetricsSource)
  const phone = useLayout() === 'phone'
  const [filter, setFilter] = useState('')
  const [severities, setSeverities] = useState<Severity[]>([])
  const [states, setStates] = useState<StateFilter[]>([])
  const [sort, setSort] = useState({ id: 'severity', desc: false })
  const gridRef = useRef<HTMLDivElement>(null)

  const answer = alerts.data
  // Under the header's namespaces: one with no namespace only under all of them.
  const here = (answer?.alerts ?? [])
    .filter((alert) => inNamespaces(alert, namespaces))
    .sort(byConcern)
  const rows: Row[] = here.map((alert) => ({
    metadata: { name: alert.name, namespace: alert.labels.namespace, uid: alertId(alert) },
    alert,
  }))
  const ctx: CellContext = { now: alerts.dataUpdatedAt }
  const chosen = useListColumns({
    list: 'alerts',
    columns: COLUMNS,
    listed: rows,
    ctx,
    title: 'Alerts',
    count: (n) => `${n} ${n === 1 ? 'alert' : 'alerts'}`,
    namespaced: false,
    labelled: false,
  })
  const column =
    chosen.columns.find((c) => c.id === sort.id && c.sort) ??
    chosen.columns.find((c) => c.id === 'severity')!
  const shown = sortRows(
    rows.filter(
      ({ alert }) =>
        (severities.length === 0 || severities.includes(severityOf(alert))) &&
        (states.length === 0 || states.includes(alert.state)) &&
        matchesText(alert, filter.trim()),
    ),
    column,
    sort.desc,
    ctx,
  )
  const open = (o: KubeObject) => updateParams((p) => p.set('alert', rowKey(o)))
  const toggle = <T,>(list: T[], set: (next: T[]) => void, one: T) =>
    set(list.includes(one) ? list.filter((x) => x !== one) : [...list, one])

  // (Severity none, as Watchdog's, fires on purpose: never counted as firing, nor as quiet.)
  const counted = here.filter((alert) => severityOf(alert) !== 'none')
  const firing = counted.filter((alert) => alert.state === 'firing').length
  const rules = answer ? ruleCounts(answer) : undefined

  // A list to show: rules, an alert that counts (or None asked for), and one the filters keep.
  // (Where the last read failed, a list read before stays, with what failed over it; anything
  // else says what failed.)
  const listing =
    !!answer &&
    answer.rules.length > 0 &&
    (counted.length > 0 || severities.includes('none')) &&
    shown.length > 0
  let body
  if (source.isPending || (source.data?.state === 'ready' && alerts.isPending)) {
    body = <Loading label="Reading Prometheus’s alerts…" />
  } else if (source.data?.state !== 'ready') {
    body = (
      <EmptyState
        icon={Bell}
        title="Lumovi found no Prometheus in this cluster."
        footer={
          !phone && (
            <Button variant="secondary" onClick={() => chooseSource(true)}>
              Metrics source…
            </Button>
          )
        }
      >
        Alerts come from the Prometheus the Metrics page uses.
      </EmptyState>
    )
  } else if (!answer || (alerts.isError && !listing)) {
    const error = alerts.error as KubeApiError
    const refused = ['forbidden', 'unauthorized', 'timeout', 'unreachable'].includes(
      error.code ?? '',
    )
    body = (
      <EmptyState
        icon={refused ? ShieldAlert : ServerOff}
        title={
          refused
            ? 'Lumovi couldn’t read Prometheus’s alerts:'
            : 'Prometheus answered, but not with alerts:'
        }
        footer={
          <Button variant="secondary" onClick={() => void alerts.refetch()}>
            Try again
          </Button>
        }
      >
        <code className="block font-mono text-xs wrap-anywhere selectable">{error.message}</code>
      </EmptyState>
    )
  } else if (answer.rules.length === 0) {
    body = <EmptyState icon={Bell} title="Prometheus has no alerting rules, so nothing can fire." />
  } else if (counted.length === 0 && !severities.includes('none')) {
    body = (
      <EmptyState
        icon={CircleCheck}
        title={`No alerts are firing. ${rules!.quiet} alerting ${rules!.quiet === 1 ? 'rule is' : 'rules are'} quiet.`}
        footer={
          here.length > 0 && (
            <Button variant="secondary" onClick={() => setSeverities(['none'])}>
              Show None
            </Button>
          )
        }
      >
        {rules!.none > 0 && (
          <>
            Not counted: {rules!.none} with severity none
            {rules!.firstNone && (
              <>
                , like <span className="font-medium text-ink-1">{rules!.firstNone}</span>
              </>
            )}
            , which fire all the time on purpose.
          </>
        )}
      </EmptyState>
    )
  } else if (shown.length === 0) {
    body = <EmptyState icon={SearchX} title="No alerts match." />
  } else {
    body = (
      <>
        {alerts.isError && (
          <StaleNotice error={alerts.error as KubeApiError} onRetry={() => void alerts.refetch()} />
        )}
        <ResourceTable
          ref={gridRef}
          label="Alerts"
          columns={chosen.columns}
          rows={shown}
          ctx={ctx}
          rowKey={rowKey}
          selected={params.get('alert') ?? undefined}
          sort={{ id: column.id, desc: sort.desc }}
          onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
          onOpen={open}
          followSelection={params.has('alert')}
          layout={chosen.layout}
        />
      </>
    )
  }

  const sevCounts = new Map(
    SEVERITIES.map((s) => [s, here.filter((a) => severityOf(a) === s).length]),
  )
  const stateCounts = new Map<StateFilter, number>([
    ['firing', here.filter((a) => a.state === 'firing').length],
    ['pending', here.filter((a) => a.state === 'pending').length],
  ])
  return (
    <div className="relative flex h-full flex-col">
      <ListBar
        count={answer ? `${firing} firing · ${rules!.quiet} quiet` : 'Alerts'}
        chips={
          answer &&
          here.length > 0 && (
            <>
              {SEVERITIES.filter((s) => sevCounts.get(s)).map((severity) => (
                <Chip
                  key={severity}
                  on={severities.includes(severity)}
                  dot={HEALTH_STYLE[SEVERITY_LEVEL[severity]].dot}
                  count={sevCounts.get(severity)!}
                  onClick={() => toggle(severities, setSeverities, severity)}
                >
                  {SEVERITY_WORDS[severity]}
                </Chip>
              ))}
              {(['firing', 'pending'] as const)
                .filter((s) => stateCounts.get(s))
                .map((state) => (
                  <Chip
                    key={state}
                    on={states.includes(state)}
                    count={stateCounts.get(state)!}
                    onClick={() => toggle(states, setStates, state)}
                  >
                    {state === 'firing' ? 'Firing' : 'Pending'}
                  </Chip>
                ))}
            </>
          )
        }
        filter={filter}
        noun="alerts"
        onFilter={setFilter}
        onArrowDown={() => gridRef.current?.focus()}
        after={chosen.button(shown)}
      />
      {answer && source.data?.state === 'ready' && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-1.5 border-b border-line px-5 py-2 text-xs text-ink-3">
          <span>
            From <span className="font-medium text-ink-2">{source.data.service.service}</span> in{' '}
            {source.data.service.namespace}, the Metrics page’s source · {answer.rules.length}{' '}
            alerting {answer.rules.length === 1 ? 'rule' : 'rules'}
          </span>
          {!phone && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => chooseSource(true)}
                className="font-medium text-accent-strong hover:underline"
              >
                Metrics source…
              </button>
            </>
          )}
        </p>
      )}
      {body}
    </div>
  )
}

/** A filter chip, as the lists' health chips are: a dot where it has one, its name, how many. */
function Chip({
  on,
  dot,
  count,
  onClick,
  tip,
  children,
}: {
  on: boolean
  dot?: string
  count: number
  onClick: () => void
  tip?: string
  children: string
}) {
  const chip = (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors touch:finger',
        on
          ? 'border-transparent bg-ink-1 text-surface'
          : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
      )}
    >
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />}
      {children}
      <span className="font-semibold tabular-nums">{count}</span>
    </button>
  )
  return tip ? <Tooltip content={tip}>{chip}</Tooltip> : chip
}
