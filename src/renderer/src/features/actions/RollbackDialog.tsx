import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useState } from 'react'
import type { Revision, RolloutKind } from '@shared/api'
import { Loading } from '@renderer/components/States'
import { useChange } from '@renderer/hooks/change'
import { api, unwrap } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

interface Image {
  container: string
  image: string
}

function images(revision: Revision): Image[] {
  const spec = revision.template.spec
  return [...(spec.initContainers ?? []), ...spec.containers].map(
    (c: { name: string; image: string }) => ({ container: c.name, image: c.image }),
  )
}

/** `kubectl rollout undo`: back to the pod template of an earlier revision. */
export function RollbackDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const kind = kindOf(object) as RolloutKind
  const { name, namespace } = object.metadata
  const history = useQuery({
    queryKey: ['history', context, kind, namespace, name],
    queryFn: () => unwrap(api.kube.history({ context, kind, namespace: namespace!, name })),
  })
  const revisions = history.data ?? []
  const current = revisions.find((r) => r.current)
  const earlier = revisions.filter((r) => !r.current)
  const [picked, setPicked] = useState<number>()
  const selected = earlier.find((r) => r.revision === picked) ?? earlier[0]
  const { pending, error, submit } = useSubmit(onClose)
  const command = kubectl(
    context,
    namespace,
    'rollout',
    'undo',
    objectArg(kind, name),
    ...(selected ? [`--to-revision=${selected.revision}`] : []),
  )
  const running = new Map(
    revisions
      .filter((r) => r.current)
      .flatMap(images)
      .map((i) => [i.container, i.image]),
  )

  return (
    <ActionDialog
      icon={History}
      title={`Roll back ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Roll back"
      wide
      ready={selected !== undefined}
      pending={pending}
      error={error ?? history.error?.message}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: {
                action: 'patch',
                patchType: 'json',
                patch: [{ op: 'replace', path: '/spec/template', value: selected!.template }],
              },
            },
            { title: `Rolled back ${name} to revision ${selected!.revision}`, command },
          ),
        )
      }
    >
      {history.isPending ? (
        <Loading label="Loading revisions…" />
      ) : earlier.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-ink-2">
          {name} has no earlier revisions to roll back to.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Revisions" className="space-y-2">
          {earlier.map((revision) => {
            const checked = revision === selected
            return (
              <label
                key={revision.revision}
                className={cn(
                  'flex cursor-default gap-3 rounded-xl border px-3.5 py-3 transition-colors',
                  checked ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-3/50',
                )}
              >
                <input
                  type="radio"
                  name="revision"
                  aria-label={`Revision ${revision.revision}`}
                  checked={checked}
                  onChange={() => setPicked(revision.revision)}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold text-ink-1">
                      Revision {revision.revision}
                    </span>
                    <span className="text-xs text-ink-3">{age(revision.createdAt)} ago</span>
                  </span>
                  {revision.changeCause && (
                    <span className="mt-0.5 block text-xs text-ink-2">{revision.changeCause}</span>
                  )}
                  <span className="mt-1.5 block space-y-0.5">
                    {images(revision).map(({ container, image }) => {
                      const differs = running.get(container) !== image
                      return (
                        <span key={container} className="flex min-w-0 gap-2 font-mono text-2xs">
                          <span className="shrink-0 text-ink-3">{container}</span>
                          <span
                            className={cn(
                              'truncate',
                              differs ? 'font-medium text-accent-strong' : 'text-ink-2',
                            )}
                          >
                            {image}
                          </span>
                        </span>
                      )
                    })}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      )}
      {current && (
        <p className="text-xs text-ink-3">
          Running now: revision {current.revision}
          {current.changeCause ? ` — ${current.changeCause}` : ''}
        </p>
      )}
    </ActionDialog>
  )
}
