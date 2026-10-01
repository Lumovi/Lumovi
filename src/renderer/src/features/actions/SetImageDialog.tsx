import { ArrowRight, Box } from 'lucide-react'
import { useId, useRef, useState, type FocusEvent } from 'react'
import type { KubeObject } from '@shared/api'
import { useChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { cn } from '@renderer/lib/cn'
import { kubectl, objectArg } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from './ActionDialog'
import { kindOf, subjectOf, target, type ActionProps } from './common'

interface Container {
  name: string
  image: string
  init: boolean
}

/** The pod template: CronJobs keep theirs one level deeper, in the job template. */
function podSpec(object: KubeObject) {
  return object.kind === 'CronJob'
    ? object.spec.jobTemplate.spec.template.spec
    : object.spec.template.spec
}

/** Wraps a pod spec patch in the path to the object's pod template. */
function templatePatch(object: KubeObject, spec: object) {
  const template = { template: { spec } }
  return object.kind === 'CronJob'
    ? { spec: { jobTemplate: { spec: template } } }
    : { spec: template }
}

/** Images this workload ran before, from its ReplicaSets, as suggestions. */
function usePastImages(object: KubeObject): string[] {
  const replicaSets = useList('ReplicaSet', {
    namespace: object.metadata.namespace,
    enabled: object.kind === 'Deployment',
  }).data
  const images = new Set<string>()
  for (const rs of replicaSets ?? []) {
    if (!rs.metadata.ownerReferences?.some((ref) => ref.uid === object.metadata.uid)) continue
    for (const c of rs.spec.template.spec.containers) images.add(c.image)
  }
  return [...images]
}

/** `kubectl set image`: new images for some of the containers, rolled out as usual. */
export function SetImageDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const change = useChange()
  const listId = useId()
  const { name, namespace } = object.metadata
  const spec = podSpec(object)
  // The app's own containers first: they're what usually changes.
  const containers: Container[] = [
    ...spec.containers.map((c: Container) => ({ ...c, init: false })),
    ...(spec.initContainers ?? []).map((c: Container) => ({ ...c, init: true })),
  ]
  // When the dialog first focuses the first image, its tag is selected, ready to be
  // replaced. (Done as it gets focus, so nothing typed can come before it.)
  const tagSelected = useRef(false)
  const selectTag = (event: FocusEvent<HTMLInputElement>) => {
    if (tagSelected.current) return
    tagSelected.current = true
    const input = event.currentTarget
    const colon = input.value.lastIndexOf(':')
    if (colon > input.value.lastIndexOf('/')) {
      input.setSelectionRange(colon + 1, input.value.length)
    }
  }
  const [images, setImages] = useState<Record<string, string>>(() =>
    Object.fromEntries(containers.map((c) => [c.name, c.image])),
  )
  const suggestions = usePastImages(object)
  const { pending, error, submit } = useSubmit(onClose)

  const changed = containers.filter((c) => images[c.name]!.trim() !== c.image)
  const valid = containers.every((c) => images[c.name]!.trim() !== '')
  const patchFor = (list: Container[], image: (c: Container) => string) => {
    const pick = (init: boolean) =>
      list.filter((c) => c.init === init).map((c) => ({ name: c.name, image: image(c) }))
    const main = pick(false)
    const init = pick(true)
    return templatePatch(object, {
      ...(main.length ? { containers: main } : {}),
      ...(init.length ? { initContainers: init } : {}),
    })
  }
  const command = (list: Container[], image: (c: Container) => string) =>
    kubectl(
      context,
      namespace,
      'set',
      'image',
      objectArg(kindOf(object), name),
      ...(list.length ? list : containers).map((c) => `${c.name}=${image(c)}`),
    )
  const next = (c: Container) => images[c.name]!.trim()
  const previous = (c: Container) => c.image

  return (
    <ActionDialog
      icon={Box}
      title={`Change images of ${name}`}
      subject={subjectOf(object)}
      command={command(changed, next)}
      confirmLabel="Update"
      ready={valid && changed.length > 0}
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void submit(() =>
          change(
            {
              ...target(object),
              change: { action: 'patch', patchType: 'strategic', patch: patchFor(changed, next) },
            },
            {
              title:
                changed.length === 1
                  ? `Set ${changed[0]!.name} of ${name} to ${next(changed[0]!)}`
                  : `Updated ${changed.length} images of ${name}`,
              command: command(changed, next),
              undo: {
                change: {
                  ...target(object),
                  change: {
                    action: 'patch',
                    patchType: 'strategic',
                    patch: patchFor(changed, previous),
                  },
                },
                meta: {
                  title: `Restored the images of ${name}`,
                  command: command(changed, previous),
                },
              },
            },
          ),
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        {object.kind === 'CronJob'
          ? 'Jobs it starts from now on use the new images.'
          : 'Pods are replaced with the new images, following the rollout strategy.'}
      </p>
      <div className="space-y-3">
        {containers.map((c, index) => {
          const edited = next(c) !== c.image
          return (
            <label key={c.name} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                {c.name}
                {c.init && (
                  <span className="rounded bg-surface-3 px-1 py-px text-2xs text-ink-3">init</span>
                )}
              </span>
              <input
                onFocus={index === 0 ? selectTag : undefined}
                aria-label={`Image for ${c.name}`}
                value={images[c.name]}
                list={listId}
                spellCheck={false}
                onChange={(event) => setImages({ ...images, [c.name]: event.target.value })}

                className={cn(
                  'h-9 w-full rounded-lg border bg-surface px-3 font-mono text-[12.5px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft',
                  edited ? 'border-accent/60' : 'border-line-strong',
                )}
              />
              {edited && (
                <span className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-2xs text-ink-3">
                  <span className="truncate line-through decoration-ink-3/60">{c.image}</span>
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="truncate text-accent-strong">{next(c) || '—'}</span>
                </span>
              )}
            </label>
          )
        })}
      </div>
      <datalist id={listId}>
        {suggestions.map((image) => (
          <option key={image} value={image} />
        ))}
      </datalist>
    </ActionDialog>
  )
}
