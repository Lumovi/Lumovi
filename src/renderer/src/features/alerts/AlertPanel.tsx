/**
 * An alert, opened from the Alerts page by `?alert=<id>`, beside the list: what it says, the
 * object it's about, every label, its rule, and its runbook. Nothing in it changes anything.
 */
import { useLayout } from '@renderer/lib/layout'
import { ArrowLeft, BellRing, BookOpen, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react'
import type { PrometheusAlert } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { barButton } from '@renderer/components/Sheet'
import { EmptyState, Loading } from '@renderer/components/States'
import { Tooltip } from '@renderer/components/Tooltip'
import { TheirText } from '@renderer/plugins/TheirText'
import { opensExternally } from '@shared/external'
import { useAlerts } from '@renderer/hooks/history'
import { alertId, stateLine } from '@renderer/lib/alerts'
import { api } from '@renderer/lib/api'
import { age } from '@renderer/lib/format'
import { KeyValueGrid, Section } from '../details/sections'
import { SidePanel, type PanelFrame } from '../details/SidePanel'
import { ObjectLink, SeverityWord } from './parts'

export function AlertPanel() {
  return (
    <SidePanel
      param="alert"
      label={(value) => `Alert ${value.slice(0, value.indexOf('~'))}`}
      crashTitle="This alert couldn’t be displayed"
      content={AlertDetail}
    />
  )
}

/** "active 26m, firing 11m · since 14:06", or, pending, "pending 4m, fires in 11m if it holds". */
function standing(alert: PrometheusAlert, now: number): string {
  if (alert.activeAt === undefined) return alert.state === 'firing' ? 'firing' : 'pending'
  const active = age(new Date(alert.activeAt).toISOString(), now)
  const line = stateLine(alert, now)!
  const since = new Date(alert.activeAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return alert.state === 'firing'
    ? `active ${active}, firing ${line.replace(/^for /, '')} · since ${since}`
    : `pending ${active}, ${line} if it holds`
}

function AlertDetail({ value, expanded, over, onExpand, onClose }: PanelFrame) {
  const alerts = useAlerts()
  const phone = useLayout() === 'phone'
  const alert = alerts.data?.alerts.find((one) => alertId(one) === value)
  const now = alerts.dataUpdatedAt
  const name = alert?.name ?? value.slice(0, value.indexOf('~'))
  const body = alerts.isPending ? (
    <Loading label="Reading Prometheus’s alerts…" />
  ) : !alert ? (
    <EmptyState icon={BellRing} title="This alert isn’t firing or pending any more." />
  ) : (
    <AlertSections alert={alert} />
  )
  const under = alert && (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <SeverityWord alert={alert} />
      <span className="rounded-full bg-surface-3 px-2 py-0.5 text-xs font-medium text-ink-2">
        {alert.state === 'firing' ? 'Firing' : 'Pending'}
      </span>
    </div>
  )
  if (phone) {
    return (
      <>
        <header className="flex h-[52px] shrink-0 items-center border-b border-line bg-surface px-1">
          <button type="button" aria-label="Back" onClick={onClose} className={barButton}>
            <ArrowLeft />
          </button>
          <p className="min-w-0 flex-1 px-1 text-[15px] leading-5 font-semibold tracking-[-0.01em]">
            <MiddleTruncate text={name} />
          </p>
        </header>
        <div className="shrink-0 px-4 pt-4 pb-1">{under}</div>
        <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      </>
    )
  }
  return (
    <>
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-2">
          <BellRing className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink-3">
            Alert{alert && ` · ${standing(alert, now)}`}
          </p>
          <h2 className="line-clamp-2 text-[17px] leading-snug font-semibold tracking-[-0.01em] break-all selectable">
            {name}
          </h2>
          {under}
        </div>
        {!over && (
          <IconButton
            label={expanded ? 'Restore panel' : 'Expand panel'}
            onClick={onExpand}
            className="mt-0.5"
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        )}
        <IconButton label="Close (Esc)" onClick={onClose} className="mt-0.5">
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line">{body}</div>
    </>
  )
}

/** What it says, its object, its labels, its rule, and its runbook where its rule gives one. */
function AlertSections({ alert }: { alert: PrometheusAlert }) {
  const { summary, description, runbook_url: runbook } = alert.annotations
  const labels = Object.entries(alert.labels).sort(([a], [b]) =>
    a === 'alertname' ? -1 : b === 'alertname' ? 1 : a.localeCompare(b),
  )
  return (
    <div className="divide-y divide-line">
      {summary && (
        <Section title="Summary">
          <p className="text-[13px] font-medium text-ink-1 selectable">{summary}</p>
        </Section>
      )}
      {description && (
        <Section title="Description">
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2 selectable">
            {description}
          </p>
        </Section>
      )}
      <Section title="Object">
        <ObjectLink alert={alert} />
      </Section>
      <Section title="Labels">
        <ul className="flex flex-wrap gap-1.5">
          {labels.map(([key, value]) => (
            <li
              key={key}
              className="max-w-full rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs wrap-anywhere text-ink-2 selectable"
            >
              <span className="text-ink-3">{key}=</span>
              {value}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Rule">
        <KeyValueGrid
          entries={[
            {
              label: 'Waits',
              value:
                alert.for > 0
                  ? `${age(new Date(0).toISOString(), alert.for * 1000)} pending before it fires`
                  : 'Fires at once',
            },
            { label: 'Group', value: alert.group || '—' },
            { label: 'Value', value: alert.value ?? '—' },
          ]}
        />
      </Section>
      {runbook && <Runbook url={runbook} />}
    </div>
  )
}

/**
 * Its rule's runbook: a link built from what the rule's author wrote, so where it goes is said
 * before it's opened, its host beside its last part (drawn as a cluster's text is, marks and all)
 * and the whole of it in its tooltip. Offered only where Lumovi would open it: another is its
 * text, to copy.
 */
function Runbook({ url: text }: { url: string }) {
  let url: URL | undefined
  try {
    url = new URL(text)
  } catch {
    url = undefined
  }
  if (!url || !opensExternally(text)) {
    return (
      <Section title="Runbook">
        <p className="font-mono text-xs break-all text-ink-2 selectable">
          <TheirText text={text} />
        </p>
      </Section>
    )
  }
  const last = url.pathname.split('/').filter(Boolean).at(-1)
  return (
    <Section title="Runbook">
      <Tooltip content={<span className="break-all">{text}</span>}>
        <button
          type="button"
          onClick={() => void api.app.openExternal(text)}
          className="flex max-w-full items-center gap-1.5 text-[13px] text-accent-strong hover:underline"
        >
          <BookOpen aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            <TheirText text={last ? `${url.host} › ${last}` : url.host} inline />
          </span>
          <ExternalLink aria-hidden className="size-3 shrink-0" />
        </button>
      </Tooltip>
    </Section>
  )
}
