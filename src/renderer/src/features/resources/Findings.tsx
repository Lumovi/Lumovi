import { TriangleAlert } from 'lucide-react'
import { StatusPill } from '@renderer/components/Status'
import { Tooltip } from '@renderer/components/Tooltip'
import { apiKindOf } from '@shared/resources'
import { resourceFor } from '@renderer/hooks/resources'
import type { Finding, Findings } from '@renderer/lib/findings'
import { pluginWords } from '../details/PointsHere'

/** How many findings a tooltip says, before how many more. */
const SAID_MOST = 5

/**
 * A finding in words: "9 critical, the api container · from the plugin Trivy 1.1.0"; without
 * what it's about, "2 high, from the plugin Trivy 1.1.0".
 */
export function findingText({ status, about, view }: Finding): string {
  const { label, version } = pluginWords(view.plugin)
  const from = `from the plugin ${label}${version ? ` ${version}` : ''}`
  return about ? `${status.label}, ${about} · ${from}` : `${status.label}, ${from}`
}

/** A plugin as a heading says it: "From the plugin Trivy 1.1.0". */
function fromPlugin(plugin: string): string {
  const { label, version } = pluginWords(plugin)
  return `From the plugin ${label}${version ? ` ${version}` : ''}`
}

/**
 * What a workload's findings say, under a pointer: the first five, worst first, under the plugin
 * each is from ("9 critical, the api container"), and how many more.
 */
function FindingsTip({ findings }: { findings: readonly Finding[] }) {
  const said = findings.slice(0, SAID_MOST)
  const byPlugin = new Map<string, Finding[]>()
  for (const finding of said) {
    byPlugin.set(finding.view.plugin, [...(byPlugin.get(finding.view.plugin) ?? []), finding])
  }
  return (
    <span className="flex flex-col gap-0.5">
      {[...byPlugin].map(([plugin, each]) => (
        <span key={plugin} className="flex flex-col gap-0.5">
          <span className="text-surface/70">{fromPlugin(plugin)}</span>
          {each.map((finding, i) => (
            <span key={i}>
              {finding.about ? `${finding.status.label}, ${finding.about}` : finding.status.label}
            </span>
          ))}
        </span>
      ))}
      {findings.length > said.length && (
        <span className="text-surface/70">and {findings.length - said.length} more</span>
      )}
    </span>
  )
}

/**
 * Why a dash may not mean none: a line for each counting kind that couldn't all be read, named as
 * the cluster names its kind ("VulnerabilityReports").
 */
export function unreadWords(unread: Findings['unread']): string[] {
  return unread.map(
    ({ kind, view }) =>
      `Couldn’t read all of ${pluginWords(view.plugin).label}’s ${resourceFor(kind)?.label ?? apiKindOf(kind)} here: what’s missing isn’t counted, so a dash may not mean none.`,
  )
}

/**
 * What the Findings heading says under a pointer, where a counting kind's objects couldn't all be
 * read: that what's missing isn't counted.
 */
export function FindingsUnread({ unread }: { unread: Findings['unread'] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {unreadWords(unread).map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  )
}

/**
 * The same, on a phone, where a list has no heading: a line above it, while the read is partial.
 */
export function FindingsUnreadLine({ unread }: { unread?: Findings['unread'] }) {
  if (!unread?.length) return null
  return (
    <p className="flex items-start gap-1.5 pb-2 text-xs text-ink-3">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn-text" aria-hidden />
      <span className="flex min-w-0 flex-col">
        {unreadWords(unread).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </p>
  )
}

/** What plugins say of a workload, in its row: the worst as its pill, and each under a pointer. */
export function FindingsCell({ findings }: { findings: readonly Finding[] }) {
  const [worst] = findings as [Finding]
  return (
    <Tooltip content={<FindingsTip findings={findings} />}>
      <span className="flex min-w-0">
        <StatusPill status={worst.status} />
      </span>
    </Tooltip>
  )
}

/** What plugins say of a workload, in a phone's row: "Findings" and the worst one's pill. */
export function FindingsFact({ findings }: { findings: readonly Finding[] }) {
  const [worst] = findings as [Finding]
  return (
    <span className="inline-flex items-center gap-1 align-bottom" title={findingText(worst)}>
      <span className="shrink-0">Findings</span> <StatusPill status={worst.status} />
    </span>
  )
}
