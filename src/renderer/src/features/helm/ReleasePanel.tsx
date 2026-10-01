import { useQueries } from '@tanstack/react-query'
import { ArrowUpCircle, History, Maximize2, Minimize2, ShipWheel, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { HelmReleaseDetail, KubeObject } from '@shared/api'
import { Button, IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { KindIcon } from '@renderer/components/KindIcon'
import { ErrorState, Loading } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { Tooltip } from '@renderer/components/Tooltip'
import { YamlText } from '@renderer/components/YamlText'
import { useGo } from '@renderer/hooks/go'
import { useHelmCli, useHelmRelease } from '@renderer/hooks/helm'
import { listPollInterval } from '@renderer/hooks/queries'
import { resourceFor } from '@renderer/hooks/resources'
import { useReadOnly } from '@renderer/hooks/settings'
import { api, unwrap, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age, formatDateTime } from '@renderer/lib/format'
import { statusFor } from '@renderer/lib/health'
import { coalesce, manifestObjects, releaseStatus, type ManifestObject } from '@renderer/lib/helm'
import { formatRef, kindPath } from '@renderer/lib/routes'
import { toYaml } from '@renderer/lib/yaml'
import { useCluster } from '@renderer/state/cluster'
import { ReadOnlyBadge } from '../actions/ActionSurfaces'
import { KeyValueGrid, Section } from '../details/sections'
import { SidePanel, type PanelFrame } from '../details/SidePanel'
import { DeployDialog } from './DeployDialog'
import { RollbackReleaseDialog, UninstallReleaseDialog } from './ReleaseDialogs'

/** The release named by `?release=namespace/name`, next to the list. */
export function ReleasePanel() {
  return (
    <SidePanel
      param="release"
      label={(value) => `Helm release ${value.slice(value.indexOf('/') + 1)}`}
      crashTitle="This release couldn’t be displayed"
      content={ReleaseDetail}
    />
  )
}

type Dialog = 'upgrade' | 'rollback' | 'uninstall'

function ReleaseDetail({ value, expanded, onExpand, onClose }: PanelFrame) {
  const [namespace, name] = value.split('/') as [string, string]
  const release = useHelmRelease(namespace, name)
  const [dialog, setDialog] = useState<Dialog>()
  const data = release.data
  return (
    <>
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-ink-2">
          <ShipWheel className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink-3">
            Helm release · {namespace}
            {data?.updated && <span> · updated {age(data.updated)} ago</span>}
          </p>
          <div className="flex min-w-0 items-start gap-1">
            <h2 className="line-clamp-2 text-[17px] leading-snug font-semibold tracking-[-0.01em] break-all selectable">
              {name}
            </h2>
            <CopyButton text={name} label="Copy name" />
          </div>
          {data && <ReleaseActions release={data} onAction={setDialog} />}
        </div>
        {data && <StatusPill status={releaseStatus(data.status)} className="mt-2.5 shrink-0" />}
        <IconButton
          label={expanded ? 'Restore panel' : 'Expand panel'}
          onClick={onExpand}
          className="mt-0.5"
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton label="Close (Esc)" onClick={onClose} className="mt-0.5">
          <X />
        </IconButton>
      </header>
      {release.isPending ? (
        <Loading label="Reading the release…" />
      ) : !data ? (
        <ErrorState error={release.error as KubeApiError} onRetry={() => void release.refetch()} />
      ) : (
        <ReleaseTabs release={data} />
      )}
      {data && dialog === 'upgrade' && (
        <DeployDialog release={data} onClose={() => setDialog(undefined)} />
      )}
      {data && dialog === 'rollback' && (
        <RollbackReleaseDialog release={data} onClose={() => setDialog(undefined)} />
      )}
      {data && dialog === 'uninstall' && (
        <UninstallReleaseDialog
          release={data}
          onClose={(uninstalled) => {
            setDialog(undefined)
            if (uninstalled) onClose()
          }}
        />
      )}
    </>
  )
}

/** Upgrade, roll back and uninstall, or why they can't be used. */
function ReleaseActions({
  release,
  onAction,
}: {
  release: HelmReleaseDetail
  onAction: (dialog: Dialog) => void
}) {
  const cli = useHelmCli().data
  const { readOnly } = useReadOnly()
  const disabled = readOnly
    ? 'Changes are turned off for this cluster.'
    : cli && !cli.available
      ? `KubeStacks uses helm for this, and couldn’t run ${cli.command}. Install Helm, or set KUBESTACKS_HELM to where it is.`
      : undefined
  // Uninstalling is rarer, and dangerous: an icon, so the others fit on one line.
  const actions: { id: Dialog; label: string; icon: typeof History; danger?: boolean }[] = [
    { id: 'upgrade', label: 'Upgrade…', icon: ArrowUpCircle },
    ...(release.revisions.length > 1
      ? [{ id: 'rollback' as const, label: 'Roll back…', icon: History }]
      : []),
    { id: 'uninstall', label: 'Uninstall…', icon: Trash2, danger: true },
  ]
  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-1.5"
      role="toolbar"
      aria-label="Release actions"
    >
      {readOnly && <ReadOnlyBadge />}
      {actions.map((action) => {
        const button = (
          <Button
            key={action.id}
            aria-label={action.label}
            disabled={disabled !== undefined}
            onClick={() => onAction(action.id)}
            className={cn(
              'h-7 px-2.5 text-xs',
              action.danger && 'w-7 px-0 text-ink-2 hover:text-critical-text',
            )}
          >
            <action.icon className="!size-3.5" />
            {!action.danger && action.label}
          </Button>
        )
        // Disabled buttons get no pointer events, so a wrapper carries the reason.
        return disabled ? (
          <Tooltip key={action.id} content={disabled}>
            <span tabIndex={0}>{button}</span>
          </Tooltip>
        ) : action.danger ? (
          <Tooltip key={action.id} content={action.label}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}

function ReleaseTabs({ release }: { release: HelmReleaseDetail }) {
  const [tab, setTab] = useState('overview')
  const content = 'min-h-0 flex-1 animate-fade-in outline-none'
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <TabList
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'resources', label: 'Resources' },
          { value: 'values', label: 'Values' },
          { value: 'manifest', label: 'Manifest' },
          { value: 'history', label: 'History' },
        ]}
      />
      <TabContent value="overview" className={cn(content, 'overflow-y-auto')}>
        <ReleaseOverview release={release} />
      </TabContent>
      <TabContent value="resources" className={cn(content, 'overflow-y-auto')}>
        <ReleaseResources release={release} />
      </TabContent>
      <TabContent value="values" className={cn(content, 'flex flex-col')}>
        <ReleaseValues release={release} />
      </TabContent>
      <TabContent value="manifest" className={cn(content, 'flex flex-col')}>
        <YamlText text={release.revisions[0]!.manifest} label="Manifest" />
      </TabContent>
      <TabContent value="history" className={cn(content, 'flex flex-col')}>
        <ReleaseHistory release={release} />
      </TabContent>
    </Tabs>
  )
}

const when = (time?: string) => time && `${formatDateTime(time)} (${age(time)} ago)`

function ReleaseOverview({ release }: { release: HelmReleaseDetail }) {
  const go = useGo()
  const { context } = useCluster()
  const latest = release.revisions[0]!
  const facts = [
    { label: 'Chart', value: `${release.chart} ${release.chartVersion}` },
    { label: 'App version', value: release.appVersion },
    { label: 'Revision', value: String(release.revision) },
    { label: 'Last change', value: release.description },
    { label: 'Installed', value: when(release.firstDeployed) },
    { label: 'Updated', value: when(release.updated) },
    { label: 'Chart says', value: release.chartInfo.description },
    {
      label: 'Subcharts',
      value: release.chartInfo.dependencies.length
        ? release.chartInfo.dependencies.join(', ')
        : undefined,
    },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value))
  const managed = release.managedBy
  return (
    <div className="divide-y divide-line pb-6">
      {managed && (
        <div className="flex items-start gap-2.5 bg-accent-soft px-5 py-3 text-[13px] text-ink-2">
          <ShipWheel className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          <span className="flex-1">
            Flux manages this release, and puts back changes made to it any other way.{' '}
            <button
              type="button"
              onClick={() =>
                go(
                  `${kindPath(context, 'HelmRelease.helm.toolkit.fluxcd.io')}?open=${encodeURIComponent(
                    formatRef({
                      kind: 'HelmRelease.helm.toolkit.fluxcd.io',
                      name: managed.name,
                      namespace: managed.namespace,
                    }),
                  )}`,
                )
              }
              className="font-medium text-accent-strong hover:underline"
            >
              Open its HelmRelease
            </button>
          </span>
        </div>
      )}
      <Section title="Details">
        <KeyValueGrid entries={facts} />
      </Section>
      {latest.notes?.trim() && (
        <Section title="Notes">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2 selectable">
            {latest.notes.trim()}
          </pre>
        </Section>
      )}
    </div>
  )
}

/** What the release made, with the status each has now. */
function ReleaseResources({ release }: { release: HelmReleaseDetail }) {
  const { context } = useCluster()
  const go = useGo()
  const objects = manifestObjects(release.revisions[0]!.manifest)
  // One list per kind and namespace finds every object's current state.
  const scopes = [
    ...new Map(
      objects.map((o) => {
        const namespace =
          resourceFor(o.kind)?.namespaced === false ? undefined : (o.namespace ?? release.namespace)
        return [`${o.kind}/${namespace ?? ''}`, { kind: o.kind, namespace }] as const
      }),
    ).values(),
  ]
  const lists = useQueries({
    queries: scopes.map((scope) => ({
      queryKey: ['list', context, scope.kind, scope.namespace, undefined, undefined],
      queryFn: () =>
        unwrap(api.kube.list({ context, kind: scope.kind, namespace: scope.namespace })),
      refetchInterval: listPollInterval(0),
    })),
  })
  const live = new Map<string, KubeObject>()
  for (const list of lists) {
    for (const object of list.data?.items ?? []) {
      live.set(`${object.kind}/${object.metadata.namespace ?? ''}/${object.metadata.name}`, object)
    }
  }
  const loaded = lists.every((list) => !list.isPending)
  const find = (o: ManifestObject, namespace?: string) =>
    live.get(`${o.apiKind}/${namespace ?? ''}/${o.name}`)
  if (objects.length === 0) {
    return <p className="px-5 py-6 text-[13px] text-ink-3">This release makes no objects.</p>
  }
  return (
    <ul aria-label="Release resources" className="divide-y divide-line">
      {objects.map((o) => {
        const namespace =
          resourceFor(o.kind)?.namespaced === false ? undefined : (o.namespace ?? release.namespace)
        const object = find(o, namespace)
        const status = object
          ? statusFor(o.kind, object)
          : loaded
            ? { health: 'warning' as const, label: 'Missing', detail: 'It isn’t in the cluster.' }
            : null
        return (
          <li
            key={`${o.kind}/${namespace}/${o.name}`}
            className="flex items-center gap-3 px-5 py-2.5"
          >
            <KindIcon kind={o.kind} className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!object}
                onClick={() =>
                  go(
                    `${kindPath(context, o.kind)}?open=${encodeURIComponent(
                      formatRef({ kind: o.kind, name: o.name, namespace }),
                    )}`,
                  )
                }
                className="block max-w-full truncate text-left text-[13px] font-medium text-ink-1 hover:text-accent-strong disabled:hover:text-ink-1"
              >
                {o.name}
              </button>
              <span className="block text-xs text-ink-3">{o.apiKind}</span>
            </span>
            {status && <StatusPill status={status} />}
          </li>
        )
      })}
    </ul>
  )
}

function ReleaseValues({ release }: { release: HelmReleaseDetail }) {
  const [all, setAll] = useState(false)
  const set = release.revisions[0]!.values
  const values = all ? coalesce(release.defaults, set) : set
  const text = Object.keys(values).length
    ? toYaml(values)
    : '# No values set: the chart’s defaults apply.\n'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        <div role="group" aria-label="Values shown" className="flex gap-1">
          {[
            { value: false, label: 'Set for this release' },
            { value: true, label: 'With the chart’s defaults' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={all === option.value}
              onClick={() => setAll(option.value)}
              className="h-7 rounded-md px-2.5 text-xs text-ink-2 hover:bg-surface-3 aria-pressed:bg-surface-3 aria-pressed:font-medium aria-pressed:text-ink-1"
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <CopyButton text={text} label="Copy values" />
      </div>
      <YamlText text={text} label="Values" />
    </div>
  )
}

/** Every revision, and how any two differ. */
function ReleaseHistory({ release }: { release: HelmReleaseDetail }) {
  const revisions = release.revisions
  const [to, setTo] = useState(revisions[0]!.revision)
  const [from, setFrom] = useState(revisions[1]?.revision ?? revisions[0]!.revision)
  const [what, setWhat] = useState<'values' | 'manifest'>('values')
  const text = (revision: number) => {
    const r = revisions.find((x) => x.revision === revision)!
    return what === 'values' ? toYaml(r.values) : r.manifest
  }
  const diff = unifiedDiff(text(from), text(to))
  const pick = (label: string, value: number, onChange: (n: number) => void) => (
    <label className="flex items-center gap-1.5 text-xs text-ink-2">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-ink-1"
      >
        {revisions.map((r) => (
          <option key={r.revision} value={r.revision}>
            {r.revision}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ol
        aria-label="Revisions"
        className="max-h-[40%] shrink-0 divide-y divide-line overflow-y-auto border-b border-line"
      >
        {revisions.map((r) => (
          <li key={r.revision} className="flex items-center gap-3 px-5 py-2">
            <span className="w-8 shrink-0 text-right text-[13px] font-semibold tabular-nums">
              {r.revision}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink-1">{r.description}</span>
              <span className="block text-xs text-ink-3">
                Chart {r.chartVersion}
                {r.appVersion && ` · app ${r.appVersion}`}
                {r.updated && ` · ${age(r.updated)} ago`}
              </span>
            </span>
            <StatusPill status={releaseStatus(r.status)} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2">
        {pick('From', from, setFrom)}
        {pick('To', to, setTo)}
        <div role="group" aria-label="Compare" className="flex gap-1">
          {(['values', 'manifest'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={what === option}
              onClick={() => setWhat(option)}
              className="h-7 rounded-md px-2.5 text-xs text-ink-2 capitalize hover:bg-surface-3 aria-pressed:bg-surface-3 aria-pressed:font-medium aria-pressed:text-ink-1"
            >
              {option}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-ink-3 tabular-nums">
          <span className="text-good-text">+{diff.added}</span>{' '}
          <span className="text-critical-text">−{diff.removed}</span>
        </span>
      </div>
      {diff.added + diff.removed === 0 ? (
        <p className="px-5 py-6 text-[13px] text-ink-3">No differences.</p>
      ) : (
        <DiffView diff={diff} label="Differences" />
      )}
    </div>
  )
}
