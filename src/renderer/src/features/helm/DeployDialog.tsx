import { ArrowUpCircle, ArrowLeft, LoaderCircle, PackagePlus, Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { formatElapsed, useTicking } from '@renderer/components/Busy'
import { parse } from 'yaml'
import type { ChartSearchResult, ChartSource, HelmDeployed, HelmReleaseDetail } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { useHelmChange } from '@renderer/hooks/helm'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { undoneBy } from '@renderer/lib/helm-diff'
import { helm } from '@renderer/lib/kubectl'
import { toYaml } from '@renderer/lib/yaml'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'
import { LintFindings, LocalChartPanel, useLocalChart } from './LocalChart'
import { FluxWarning } from './ReleaseDialogs'
import { useAccessHere } from '../access/use-access'

/** Where the chart comes from: stored with the release, a repository or registry, or this computer. */
type ChartMode = 'stored' | 'repository' | 'local'

const field =
  'h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

/**
 * `helm upgrade` (with a release) or `helm install` (without): the chart, all
 * the values set, then a dry run on the API server that shows what changes
 * before anything does.
 */
export function DeployDialog({
  release,
  onClose,
}: {
  release?: HelmReleaseDetail
  onClose: () => void
}) {
  const { context, namespace: picked } = useCluster()
  const change = useHelmChange()
  const install = !release
  // A chart without subcharts is stored whole with its release: it can upgrade as it is.
  const canReuse = release !== undefined && release.chartInfo.dependencies.length === 0
  const [source, setSource] = useState<ChartSource>({ chart: release?.chart ?? '' })
  const [name, setName] = useState(release?.name ?? '')
  const [namespace, setNamespace] = useState(release?.namespace ?? picked ?? 'default')
  // A release deployed from a chart on this computer is likely to be again, from there.
  const releaseKey = `${context}/${namespace}/${name}`
  const remembered = usePrefs((prefs) => prefs.localCharts[releaseKey])
  const setLocalChart = usePrefs((prefs) => prefs.setLocalChart)
  const [mode, setMode] = useState<ChartMode>(
    remembered ? 'local' : canReuse ? 'stored' : 'repository',
  )
  const [localPath, setLocalPath] = useState(remembered ?? '')
  const [createNamespace, setCreateNamespace] = useState(false)
  // What Helm waits for, undoes and how long (off and blank each time: never remembered).
  const [wait, setWait] = useState(false)
  const [undo, setUndo] = useState(false)
  const [timeoutText, setTimeoutText] = useState('')
  const minutes = timeoutText.trim() === '' ? undefined : Number(timeoutText)
  const badTimeout =
    minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 60)
  const waits = undo || wait
  const [since, setSince] = useState<number>()
  const current = release?.revisions[0]
  const initial = current && Object.keys(current.values).length ? toYaml(current.values) : ''
  const [values, setValues] = useState(initial)
  const checked = useLocalChart(localPath, values, mode === 'local')
  // The editor starts over when values are loaded into it.
  const [loads, setLoads] = useState(0)
  const [reviewed, setReviewed] = useState<HelmDeployed>()
  const [problem, setProblem] = useState<string>()
  const [checking, setChecking] = useState(false)
  const { pending, error, submit } = useSubmit(() => {
    if (mode === 'local') setLocalChart(releaseKey, localPath)
    onClose()
  })
  const load = (text: string) => {
    setValues(text)
    setLoads(loads + 1)
  }

  const chartSource: ChartSource = mode === 'local' ? { chart: localPath } : source
  const chartArgs =
    mode === 'stored'
      ? [`./${release!.chart}-${release!.chartVersion}`]
      : [
          chartSource.chart || '<chart>',
          ...(chartSource.repository ? ['--repo', chartSource.repository] : []),
          ...(chartSource.version ? ['--version', chartSource.version] : []),
        ]
  const command = helm(
    context,
    namespace,
    install ? 'install' : 'upgrade',
    name || '<name>',
    ...chartArgs,
    '--values',
    'values.yaml',
    ...(install && createNamespace ? ['--create-namespace'] : []),
    // (Undoing a failure waits for it, as Helm's flag sets: it's said alone.)
    ...(undo ? ['--rollback-on-failure'] : wait ? ['--wait'] : []),
    ...(minutes !== undefined && !badTimeout ? ['--timeout', `${minutes}m0s`] : []),
  )
  const request = (dryRun: boolean) => ({
    context,
    namespace,
    name,
    source: mode === 'stored' ? ('stored' as const) : chartSource,
    values,
    install,
    createNamespace,
    dryRun,
    ...(wait ? { wait } : {}),
    ...(undo ? { rollbackOnFailure: undo } : {}),
    ...(minutes !== undefined ? { timeoutSeconds: minutes * 60 } : {}),
  })
  const chartReady = {
    stored: true,
    repository: source.chart !== '',
    // Read and checked as it is now (a failed read keeps the last one's data).
    local: checked.isSuccess,
  }[mode]
  // Installing where the person's access doesn't let them is said before they try.
  const here = useAccessHere()
  const notAllowed =
    install && namespace !== ''
      ? (here.whyNot('changes', 'write', namespace) ??
        here.whyNot('helm', 'install', namespace, 'install charts'))
      : undefined
  const ready =
    (install ? name !== '' && namespace !== '' : true) && chartReady && !notAllowed && !badTimeout

  const review = async () => {
    try {
      parse(values)
    } catch (e) {
      setProblem(`The values aren’t valid YAML: ${(e as Error).message}`)
      return
    }
    setChecking(true)
    setProblem(undefined)
    // A chart being worked on is checked again first, with these values.
    if (mode === 'local' && (await checked.refetch()).isError) {
      setChecking(false)
      return
    }
    const result = await api.helm.deploy(request(true))
    setChecking(false)
    if (result.ok) setReviewed(result.data)
    else setProblem(result.error.message)
  }
  const apply = () => {
    setSince(Date.now())
    return submit(() =>
      change(() => api.helm.deploy(request(false)), {
        title: install ? `Installed ${name}` : `Upgraded ${name}`,
        command,
      }),
    )
  }
  // A failure Helm undid: said in Lumovi's words first (a timeout's, where it ran out).
  const undone = error ? undoneBy(error) : undefined
  const ranOut = error !== undefined && /deadline exceeded|timed out/i.test(error)
  const errorLead = undone
    ? `${ranOut ? `It wasn’t ready within ${minutes ?? 5} ${minutes === 1 ? 'minute' : 'minutes'}` : 'It failed'}, so Helm ${
        undone === 'rolled-back'
          ? `rolled it back to revision ${current?.revision}`
          : 'uninstalled it'
      }.`
    : undefined

  const diff = reviewed && unifiedDiff(current?.manifest ?? '', reviewed.manifest)
  return (
    <ActionDialog
      icon={install ? PackagePlus : ArrowUpCircle}
      title={install ? 'Install a chart' : `Upgrade ${release.name}`}
      name={install ? undefined : release.name}
      subject={install ? 'Helm' : `Helm release · ${release.namespace}`}
      command={command}
      confirmLabel={reviewed ? (install ? 'Install' : 'Upgrade') : 'Review'}
      wide
      ready={ready && !checking}
      pending={pending || checking}
      error={error ?? problem ?? notAllowed}
      errorLead={errorLead}
      // (Closing it doesn't stop what Helm's doing.)
      cancelLabel={pending && reviewed ? 'Close' : 'Cancel'}
      onClose={onClose}
      onSubmit={() => void (reviewed ? apply() : review())}
    >
      {release && <FluxWarning release={release} />}
      {reviewed ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setReviewed(undefined)}
            >
              <ArrowLeft /> Back to editing
            </Button>
            <span className="text-xs text-ink-2">
              The cluster accepts it ·{' '}
              <span className="font-medium text-good-text tabular-nums">+{diff!.added}</span>{' '}
              <span className="font-medium text-critical-text tabular-nums">−{diff!.removed}</span>{' '}
              lines of manifest
            </span>
          </div>
          {mode === 'local' && <LintFindings lint={checked.data!.lint} />}
          {diff!.added + diff!.removed === 0 ? (
            <p className="text-[13px] text-ink-2">Nothing it makes changes.</p>
          ) : (
            <div className="flex max-h-[45vh] min-h-0 flex-col overflow-hidden rounded-lg border border-line">
              <DiffView diff={diff!} label="Manifest changes" />
            </div>
          )}
          {pending && waits && since !== undefined && (
            <Waiting since={since} minutes={minutes ?? 5} install={install} />
          )}
          {reviewed.notes?.trim() && (
            <pre className="max-h-32 overflow-auto rounded-lg bg-surface-3/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-2">
              {reviewed.notes.trim()}
            </pre>
          )}
        </div>
      ) : (
        <>
          {install && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-2">Release name</span>
                <input
                  aria-label="Release name"
                  value={name}
                  onChange={(event) => setName(event.target.value.trim())}
                  spellCheck={false}
                  className={field}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-2">Namespace</span>
                <input
                  aria-label="Namespace"
                  value={namespace}
                  onChange={(event) => setNamespace(event.target.value.trim())}
                  spellCheck={false}
                  className={field}
                />
              </label>
              <label className="col-span-2 flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={createNamespace}
                  onChange={(event) => setCreateNamespace(event.target.checked)}
                  className="accent-[var(--accent)]"
                />
                Create the namespace if it doesn’t exist
              </label>
            </div>
          )}
          <ChartPicker
            release={release}
            canReuse={canReuse}
            mode={mode}
            onMode={setMode}
            source={source}
            onSource={setSource}
            local={
              <LocalChartPanel
                path={localPath}
                onPath={setLocalPath}
                checked={checked}
                release={release}
              />
            }
          />
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="flex-1 text-xs font-medium text-ink-2">Values</span>
              {mode === 'local' && Boolean(checked.data?.chart.valuesFiles.length) && (
                <select
                  aria-label="Load values from"
                  value=""
                  onChange={async (event) => {
                    const file = await api.localCharts!.valuesFile(localPath, event.target.value)
                    if (file.ok) load(file.data)
                    else setProblem(file.error.message)
                  }}
                  className="h-7 max-w-44 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
                >
                  <option value="">Load values from…</option>
                  {checked.data!.chart.valuesFiles.map((file) => (
                    <option key={file} value={file}>
                      {file}
                    </option>
                  ))}
                </select>
              )}
              {mode !== 'stored' && (
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={!chartSource.chart}
                  onClick={async () => {
                    const defaults = await api.helm.defaults(chartSource)
                    if (defaults.ok) load(defaults.data)
                    else setProblem(defaults.error.message)
                  }}
                >
                  Start from the chart’s defaults
                </Button>
              )}
            </div>
            <p className="mb-1.5 text-xs text-ink-3">
              Everything set here; the chart’s defaults fill in the rest.
            </p>
            <div className="h-56 overflow-hidden rounded-lg border border-line bg-surface-2/60">
              <CodeEditor
                key={loads}
                value={values}
                onChange={setValues}
                onSave={() => void review()}
                label="Values"
              />
            </div>
          </div>
          <DeployOptions
            install={install}
            revision={current?.revision}
            wait={wait}
            undo={undo}
            timeout={timeoutText}
            badTimeout={badTimeout}
            onWait={setWait}
            onUndo={setUndo}
            onTimeout={setTimeoutText}
          />
        </>
      )}
    </ActionDialog>
  )
}

/**
 * Where the chart comes from: as the release stores it, a repository or
 * registry (typed, or found on Artifact Hub), or this computer.
 */
function ChartPicker({
  release,
  canReuse,
  mode,
  onMode,
  source,
  onSource,
  local,
}: {
  release?: HelmReleaseDetail
  canReuse: boolean
  mode: ChartMode
  onMode: (mode: ChartMode) => void
  source: ChartSource
  onSource: (source: ChartSource) => void
  /** The panel for a chart on this computer. */
  local: ReactNode
}) {
  const [query, setQuery] = useState(release?.chart ?? '')
  const [results, setResults] = useState<ChartSearchResult[]>()
  const [versions, setVersions] = useState<string[]>()
  const [problem, setProblem] = useState<string>()
  const search = async () => {
    const found = await api.helm.search(query.trim())
    setProblem(found.ok ? undefined : found.error.message)
    if (found.ok) setResults(found.data)
  }
  const set = (patch: Partial<ChartSource>) => {
    onSource({ ...source, ...patch })
    setVersions(undefined)
  }
  const options: { mode: ChartMode; label: string; hint: string; disabled?: boolean }[] = [
    ...(release
      ? [
          {
            mode: 'stored' as const,
            label: `The chart it runs: ${release.chart} ${release.chartVersion}`,
            hint: canReuse
              ? 'As the cluster stores it with the release: to change values.'
              : `It has subcharts (${release.chartInfo.dependencies.join(', ')}), which Helm doesn’t store with releases.`,
            disabled: !canReuse,
          },
        ]
      : []),
    {
      mode: 'repository',
      label: 'A chart from a repository or a registry',
      hint: 'To change its version, or its chart.',
    },
    // Only the desktop app has a computer's files to use.
    ...(api.localCharts
      ? [
          {
            mode: 'local' as const,
            label: 'A chart on this computer',
            hint: 'A chart folder or a packaged chart: one you’re working on, say.',
          },
        ]
      : []),
  ]
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-medium text-ink-2">Chart</legend>
      <div role="radiogroup" aria-label="Chart" className="space-y-1.5">
        {options.map((option) => (
          <label
            key={option.mode}
            className={cn('flex gap-2.5 text-[13px]', option.disabled && 'text-ink-3')}
          >
            <input
              type="radio"
              name="chart"
              checked={mode === option.mode}
              disabled={option.disabled}
              onChange={() => onMode(option.mode)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              {option.label}
              <span className="block text-xs text-ink-3">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'local' && local}
      {mode === 'repository' && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <div className="grid grid-cols-[1fr_1fr_8rem] gap-2">
            <input
              aria-label="Chart name or reference"
              placeholder={
                api.localCharts ? 'nginx, oci://…, ./chart' : 'nginx, oci://…, https://…/chart.tgz'
              }
              value={source.chart}
              onChange={(event) => set({ chart: event.target.value.trim() })}
              spellCheck={false}
              className={field}
            />
            <input
              aria-label="Repository URL"
              placeholder="https://charts.example.com"
              value={source.repository ?? ''}
              onChange={(event) => set({ repository: event.target.value.trim() || undefined })}
              spellCheck={false}
              className={field}
            />
            {versions ? (
              <select
                aria-label="Version"
                value={source.version ?? ''}
                onChange={(event) =>
                  onSource({ ...source, version: event.target.value || undefined })
                }
                className={field}
              >
                <option value="">Latest</option>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Version"
                placeholder="Latest"
                value={source.version ?? ''}
                onChange={(event) => set({ version: event.target.value.trim() || undefined })}
                spellCheck={false}
                className={field}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!source.repository || !source.chart}
              onClick={async () => {
                const listed = await api.helm.versions(source.repository!, source.chart)
                setProblem(listed.ok ? undefined : listed.error.message)
                if (listed.ok) setVersions(listed.data)
              }}
            >
              List its versions
            </Button>
            <span className="flex-1" />
            <input
              aria-label="Search Artifact Hub"
              placeholder="Search Artifact Hub"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Searches, rather than submitting the dialog.
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (query.trim()) void search()
              }}
              className={cn(field, 'w-48 font-sans')}
            />
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!query.trim()}
              onClick={search}
            >
              <Search /> Search
            </Button>
          </div>
          {problem && (
            <p role="alert" className="text-xs text-critical-text">
              {problem}
            </p>
          )}
          {results && (
            <ul
              aria-label="Charts found"
              className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line"
            >
              {results.length === 0 && (
                <li className="px-3 py-2 text-xs text-ink-3">No charts match.</li>
              )}
              {results.map((result) => (
                <li key={`${result.repository.url}/${result.name}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onSource({
                        chart: result.name,
                        repository: result.repository.url,
                        version: result.version,
                      })
                      setResults(undefined)
                    }}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-3/60"
                  >
                    <span className="text-[13px] font-medium text-ink-1">
                      {result.repository.name}/{result.name}
                    </span>
                    <span className="ml-2 text-xs text-ink-3">
                      {result.version}
                      {result.appVersion && ` · app ${result.appVersion}`}
                    </span>
                    {result.description && (
                      <span className="block truncate text-xs text-ink-2">
                        {result.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </fieldset>
  )
}

/**
 * What Helm waits for, whether it undoes a failure, and how long it gives it (LMV-353): off and
 * blank, as Helm has them, each with what it does and Helm's own flag beside it.
 */
function DeployOptions({
  install,
  revision,
  wait,
  undo,
  timeout,
  badTimeout,
  onWait,
  onUndo,
  onTimeout,
}: {
  install: boolean
  /** The revision an upgrade that fails goes back to. */
  revision?: number
  wait: boolean
  undo: boolean
  timeout: string
  badTimeout: boolean
  onWait: (wait: boolean) => void
  onUndo: (undo: boolean) => void
  onTimeout: (timeout: string) => void
}) {
  const flag = (text: string) => (
    <code className="font-mono text-[11px] text-ink-3 phone:hidden">{text}</code>
  )
  const line = 'mt-0.5 text-xs text-ink-3'
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-xs font-medium text-ink-2">Options</legend>
      <div>
        <label className="flex items-center gap-2 text-[13px] text-ink-1">
          <input
            type="checkbox"
            checked={wait || undo}
            disabled={undo}
            onChange={(event) => onWait(event.target.checked)}
            className="accent-[var(--accent)] disabled:opacity-60"
          />
          <span className={cn(undo && 'text-ink-2')}>Wait until it’s ready</span>
          {flag('--wait')}
        </label>
        <p className={cn(line, 'pl-6')}>
          {undo
            ? 'On, as undoing a failure has to wait to see it.'
            : 'Helm waits until what it made is ready, and fails if the timeout runs out first.'}
        </p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-[13px] text-ink-1">
          <input
            type="checkbox"
            checked={undo}
            onChange={(event) => onUndo(event.target.checked)}
            className="accent-[var(--accent)]"
          />
          Undo it if it fails
          {flag('--rollback-on-failure')}
        </label>
        <p className={cn(line, 'pl-6')}>
          {install
            ? 'If it fails, or isn’t ready in time, Helm uninstalls it.'
            : `If it fails, or isn’t ready in time, Helm rolls it back to revision ${revision}.`}
        </p>
      </div>
      <div className="pl-6">
        <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink-1">
          Timeout
          <input
            aria-label="Timeout"
            inputMode="numeric"
            value={timeout}
            placeholder="5 minutes, Helm’s default"
            onChange={(event) => onTimeout(event.target.value.trim())}
            aria-invalid={badTimeout || undefined}
            className={cn(field, 'h-8 w-48', badTimeout && 'border-critical focus:border-critical')}
          />
          {timeout !== '' && <span className="text-xs text-ink-2">minutes</span>}
          {flag('--timeout')}
        </label>
        {badTimeout && <p className="mt-1 text-xs text-critical-text">From 1 to 60 minutes.</p>}
        <p className={line}>
          How long Helm gives each step, hooks included, and the wait, before it calls it failed.
        </p>
      </div>
    </fieldset>
  )
}

/** While Helm installs or upgrades and then waits: what for, how long it may, and so far. */
function Waiting({
  since,
  minutes,
  install,
}: {
  since: number
  minutes: number
  install: boolean
}) {
  const now = useTicking(true)
  return (
    <p role="status" className="flex gap-2 text-xs text-ink-2">
      <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-ink-3" />
      <span>
        {install ? 'Installing' : 'Upgrading'}, then waiting until it’s ready: up to {minutes}{' '}
        {minutes === 1 ? 'minute' : 'minutes'}, {formatElapsed(now - since)} so far.
        <span className="block text-ink-3">
          Closing this doesn’t stop it. The release’s page says how it ended.
        </span>
      </span>
    </p>
  )
}
