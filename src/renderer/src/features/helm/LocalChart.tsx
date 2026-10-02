import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  FolderOpen,
  Info,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import type { HelmReleaseDetail, LintResult, LocalChart } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { api, unwrap } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { pluralize } from '@renderer/lib/format'
import { compareVersions } from '@renderer/lib/helm'
import { menuContent, menuItem } from '../shell/menu-styles'

/** In its charts/ folder, packed or unpacked. */
const PRESENT = new Set(['ok', 'unpacked'])

export interface CheckedChart {
  chart: LocalChart
  lint: LintResult
}

/**
 * A chart on this computer, read and checked with `helm lint` against the
 * values being edited; fetching it again checks it again. Only the desktop
 * app has charts on this computer (`api.localCharts`).
 */
export function useLocalChart(path: string, values: string, enabled: boolean) {
  return useQuery({
    queryKey: ['helm-local', path],
    queryFn: async (): Promise<CheckedChart> => {
      const chart = await unwrap(api.localCharts!.read(path))
      return { chart, lint: await unwrap(api.localCharts!.lint(chart.path, values)) }
    },
    enabled: enabled && path !== '',
    gcTime: 0,
  })
}

const SEVERITY = {
  error: { icon: CircleAlert, className: 'text-critical-text' },
  warning: { icon: TriangleAlert, className: 'text-warn-text' },
  info: { icon: Info, className: 'text-ink-3' },
}

/** What helm lint found, errors first. */
export function LintFindings({ lint }: { lint: LintResult }) {
  const count = (severity: string) => lint.messages.filter((m) => m.severity === severity).length
  const [errors, warnings] = [count('error'), count('warning')]
  const found = [
    errors ? pluralize(errors, 'error') : '',
    warnings ? pluralize(warnings, 'warning') : '',
  ].filter(Boolean)
  return (
    <div className="space-y-1">
      <p
        className={cn(
          'flex items-center gap-1.5 text-xs font-medium',
          errors ? 'text-critical-text' : warnings ? 'text-warn-text' : 'text-good-text',
        )}
      >
        {found.length ? <CircleAlert className="size-3.5" /> : <CircleCheck className="size-3.5" />}
        {found.length ? `helm lint: ${found.join(', ')}` : 'helm lint found no problems'}
      </p>
      {lint.messages.length > 0 && (
        <ul aria-label="helm lint" className="space-y-0.5">
          {lint.messages.map((message, i) => {
            const { icon: Icon, className } = SEVERITY[message.severity]
            return (
              <li key={i} className={cn('flex gap-1.5 text-xs', className)}>
                <Icon aria-label={message.severity} className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 font-mono break-words whitespace-pre-wrap">
                  {message.text}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Where a chart on this computer is (typed, or chosen), and what it is. */
export function LocalChartPanel({
  path,
  onPath,
  checked,
  release,
}: {
  path: string
  onPath: (path: string) => void
  checked: UseQueryResult<CheckedChart>
  release?: HelmReleaseDetail
}) {
  const [draft, setDraft] = useState(path)
  const [problem, setProblem] = useState<string>()
  const [downloading, setDownloading] = useState(false)
  const open = (next: string) => {
    setDraft(next)
    setProblem(undefined)
    if (next === path) void checked.refetch()
    else onPath(next)
  }
  const choose = async (kind: 'folder' | 'archive') => {
    const chosen = await api.localCharts!.choose(kind)
    if (chosen) open(chosen)
  }
  const data = checked.data
  const missing = data?.chart.dependencies.filter((d) => !PRESENT.has(d.status)) ?? []
  const download = async () => {
    setDownloading(true)
    const result = await api.localCharts!.updateDependencies(data!.chart.path)
    setDownloading(false)
    if (result.ok) void checked.refetch()
    else setProblem(result.error.message)
  }
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex gap-2">
        <input
          aria-label="Chart path"
          placeholder="~/charts/web, or a packaged chart (.tgz)"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              open(draft.trim())
            }
          }}
          onBlur={() => {
            if (draft.trim() !== path) open(draft.trim())
          }}
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft"
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="secondary" className="h-8 text-xs">
              <FolderOpen /> Choose…
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
              <DropdownMenu.Item className={menuItem} onSelect={() => void choose('folder')}>
                Chart folder…
              </DropdownMenu.Item>
              <DropdownMenu.Item className={menuItem} onSelect={() => void choose('archive')}>
                Packaged chart (.tgz)…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {checked.isFetching && (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <LoaderCircle className="size-3.5 animate-spin" /> Reading and checking the chart…
        </p>
      )}
      {(problem ?? checked.error) && (
        <p role="alert" className="text-xs text-critical-text">
          {problem ?? (checked.error as Error).message}
        </p>
      )}
      {data && (
        <div className="space-y-2 rounded-md bg-surface-2 px-3 py-2.5">
          <div>
            <p className="text-[13px] text-ink-1">
              <span className="font-semibold">{data.chart.name}</span> {data.chart.version}
              <span className="text-ink-3">
                {data.chart.appVersion && ` · app ${data.chart.appVersion}`}
                {data.chart.archive && ' · packaged'}
              </span>
            </p>
            {data.chart.description && (
              <p className="text-xs text-ink-3">{data.chart.description}</p>
            )}
          </div>
          {release && data.chart.name !== release.chart && (
            <p className="flex gap-1.5 text-xs text-warn-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {release.name} runs the {release.chart} chart; this one is {data.chart.name}.
            </p>
          )}
          {release && compareVersions(data.chart.version, release.chartVersion) < 0 && (
            <p className="flex gap-1.5 text-xs text-warn-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              It’s older than the {release.chartVersion} {release.name} runs.
            </p>
          )}
          {missing.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-warn-text">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="flex-1">
                Its charts/ folder is missing{' '}
                {missing.map((d) => `${d.name} ${d.version}`).join(', ')}.
              </span>
              <Button
                variant="secondary"
                className="h-7 text-xs"
                disabled={downloading}
                onClick={() => void download()}
              >
                {downloading && <LoaderCircle className="animate-spin" />} Download dependencies
              </Button>
            </div>
          )}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <LintFindings lint={data.lint} />
            </div>
            <Button
              variant="ghost"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={checked.isFetching}
              // Against the values as they are now.
              onClick={() => void checked.refetch()}
            >
              Check again
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
