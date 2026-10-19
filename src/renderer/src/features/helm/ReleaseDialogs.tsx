import { History, Lock, ShipWheel, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { HelmReleaseDetail } from '@shared/api'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { useHelmChange } from '@renderer/hooks/helm'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { manifestObjects } from '@renderer/lib/helm'
import { maskedManifest, valueKeys } from '@renderer/lib/helm-diff'
import { helm } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'
import { SecretsHidden } from './SecretsHidden'

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
  // The values by key alone; the manifest's diff worked out on its text, shown with each
  // Secret's values masked until asked (where the person's access shows them at all).
  const keys = valueKeys(current!.values, chosen.values)
  const keyCount = keys.changed.length + keys.added.length + keys.removed.length
  const [revealed, setRevealed] = useState(false)
  const masked = {
    before: maskedManifest(current!.manifest),
    after: maskedManifest(chosen.manifest),
  }
  const hidesSome = masked.before !== current!.manifest || masked.after !== chosen.manifest
  const manifest = unifiedDiff(current!.manifest, chosen.manifest, revealed ? undefined : masked)
  return (
    <ActionDialog
      icon={History}
      title={`Roll back ${name}`}
      name={name}
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
        Running now: revision {current!.revision}.
        {!release.withheld && (
          <>
            {' '}
            Going back to {revision} changes <span className="tabular-nums">{keyCount}</span> of its
            values and <span className="tabular-nums">{manifest.added + manifest.removed}</span>{' '}
            {manifest.added + manifest.removed === 1 ? 'line' : 'lines'} of its manifest.
          </>
        )}
      </p>
      <section aria-label="What changes" className="space-y-3">
        <h3 className="text-xs font-medium text-ink-2">What changes</h3>
        {release.withheld ? (
          <div className="flex gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-ink-3" />
            <p>
              <span className="block font-medium text-ink-1">What it changes is hidden</span>
              {release.withheld} Roll back still goes back to all that revision {revision} had.
            </p>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-1 text-xs text-ink-3">Values</p>
              {keyCount === 0 ? (
                <p className="text-[13px] text-ink-2">No values change.</p>
              ) : (
                <dl className="divide-y divide-line rounded-lg border border-line">
                  {(
                    [
                      ['Changed', keys.changed],
                      ['Added', keys.added],
                      ['Removed', keys.removed],
                    ] as const
                  )
                    .filter(([, list]) => list.length > 0)
                    .map(([what, list]) => (
                      <div key={what} className="flex gap-3 px-3 py-2">
                        <dt className="w-16 shrink-0 text-xs text-ink-3">{what}</dt>
                        <dd className="flex min-w-0 flex-wrap gap-1.5">
                          {list.map((key) => (
                            <code
                              key={key}
                              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] break-all text-ink-1"
                            >
                              {key}
                            </code>
                          ))}
                        </dd>
                      </div>
                    ))}
                </dl>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-ink-3">Manifest</p>
              {manifest.added + manifest.removed === 0 ? (
                <p className="text-[13px] text-ink-2">The manifest doesn’t change.</p>
              ) : (
                <div className="flex max-h-[40vh] min-h-0 flex-col overflow-hidden rounded-lg border border-line">
                  <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
                    <span className="flex-1 tabular-nums">
                      <span className="font-medium text-good-text">+{manifest.added}</span>{' '}
                      <span className="font-medium text-critical-text">−{manifest.removed}</span>{' '}
                      <span className="text-ink-3">lines</span>
                    </span>
                    {hidesSome && <SecretsHidden revealed={revealed} onReveal={setRevealed} />}
                  </div>
                  <DiffView diff={manifest} label="Manifest changes" />
                </div>
              )}
            </div>
          </>
        )}
      </section>
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
      name={name}
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
