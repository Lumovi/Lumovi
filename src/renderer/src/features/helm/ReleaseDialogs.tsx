import { History, ShipWheel, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { HelmReleaseDetail } from '@shared/api'
import { unifiedDiff } from '@renderer/components/DiffView'
import { useHelmChange } from '@renderer/hooks/helm'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { manifestObjects } from '@renderer/lib/helm'
import { helm } from '@renderer/lib/kubectl'
import { toYaml } from '@renderer/lib/yaml'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'

/** Changes to a release Flux manages don't last: Flux puts its own back. */
export function FluxWarning({ release }: { release: HelmReleaseDetail }) {
  if (!release.managedBy) return null
  return (
    <p className="flex gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
      <ShipWheel className="mt-0.5 size-4 shrink-0 text-warn-text" />
      <span>
        Flux manages {release.name} (HelmRelease {release.managedBy.namespace}/
        {release.managedBy.name}), and puts back changes made here at its next reconcile. Suspend it
        first, or change it in Git.
      </span>
    </p>
  )
}

/** `helm rollback`: back to an earlier revision's chart and values, as a new revision. */
export function RollbackReleaseDialog({
  release,
  onClose,
}: {
  release: HelmReleaseDetail
  onClose: () => void
}) {
  const { context } = useCluster()
  const change = useHelmChange()
  const [current, ...earlier] = release.revisions
  const [revision, setRevision] = useState(earlier[0]!.revision)
  const { pending, error, submit } = useSubmit(onClose)
  const { name, namespace } = release
  const command = helm(context, namespace, 'rollback', name, String(revision))
  const chosen = earlier.find((r) => r.revision === revision)!
  const values = unifiedDiff(toYaml(current!.values), toYaml(chosen.values))
  const manifest = unifiedDiff(current!.manifest, chosen.manifest)
  return (
    <ActionDialog
      icon={History}
      title={`Roll back ${name}`}
      subject={`Helm release · ${namespace}`}
      command={command}
      confirmLabel="Roll back"
      wide
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(() => api.helm.rollback({ context, namespace, name, revision }), {
            title: `Rolled back ${name} to revision ${revision}`,
            command,
          }),
        )
      }
    >
      <FluxWarning release={release} />
      <div role="radiogroup" aria-label="Revisions" className="space-y-2">
        {earlier.map((r) => {
          const checked = r.revision === revision
          return (
            <label
              key={r.revision}
              className={cn(
                'flex cursor-default gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                checked ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-3/50',
              )}
            >
              <input
                type="radio"
                name="revision"
                aria-label={`Revision ${r.revision}`}
                checked={checked}
                onChange={() => setRevision(r.revision)}
                className="mt-1 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-ink-1">
                    Revision {r.revision}
                  </span>
                  <span className="text-xs text-ink-3">
                    {r.status}
                    {r.updated && ` · ${age(r.updated)} ago`}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-ink-2">
                  Chart {r.chartVersion}
                  {r.appVersion && `, app ${r.appVersion}`}
                  {r.description && ` · ${r.description}`}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="text-xs text-ink-3" aria-live="polite">
        Running now: revision {current!.revision}. Going back to {revision} changes{' '}
        <span className="tabular-nums">
          {values.added + values.removed} {values.added + values.removed === 1 ? 'line' : 'lines'}
        </span>{' '}
        of its values and <span className="tabular-nums">{manifest.added + manifest.removed}</span>{' '}
        of its manifest.
      </p>
    </ActionDialog>
  )
}

/** `helm uninstall`: deletes everything the release made, and its history unless kept. */
export function UninstallReleaseDialog({
  release,
  onClose,
}: {
  release: HelmReleaseDetail
  onClose: (uninstalled: boolean) => void
}) {
  const { context } = useCluster()
  const change = useHelmChange()
  const [keepHistory, setKeepHistory] = useState(false)
  const { pending, error, submit } = useSubmit(() => onClose(true))
  const { name, namespace } = release
  const command = helm(
    context,
    namespace,
    'uninstall',
    name,
    ...(keepHistory ? ['--keep-history'] : []),
  )
  const objects = manifestObjects(release.revisions[0]!.manifest)
  return (
    <ActionDialog
      icon={Trash2}
      tone="danger"
      title={`Uninstall ${name}?`}
      subject={`Helm release · ${namespace}`}
      command={command}
      confirmLabel="Uninstall"
      typeToConfirm={name}
      pending={pending}
      error={error}
      onClose={() => onClose(false)}
      onSubmit={() =>
        void submit(() =>
          change(() => api.helm.uninstall({ context, namespace, name, keepHistory }), {
            title: `Uninstalled ${name}`,
            command,
          }),
        )
      }
    >
      <FluxWarning release={release} />
      {objects.length ? (
        <p className="text-[13px] leading-relaxed text-ink-2">
          Deletes {objects.length === 1 ? 'the object' : `the ${objects.length} objects`} {name}{' '}
          made, apart from any its chart keeps on purpose (like CRDs, and objects annotated with{' '}
          <code className="font-mono text-xs">helm.sh/resource-policy: keep</code>).
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-2">
          {name} makes no objects: this deletes its record.
        </p>
      )}
      <label className="flex cursor-default gap-3 rounded-lg border border-line px-3 py-2">
        <input
          type="checkbox"
          checked={keepHistory}
          onChange={(event) => setKeepHistory(event.target.checked)}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span>
          <span className="block text-[13px] font-medium text-ink-1">Keep its history</span>
          <span className="block text-xs text-ink-3">
            Its revisions stay, so it can be rolled back into being.
          </span>
        </span>
      </label>
    </ActionDialog>
  )
}
