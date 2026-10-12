/**
 * A node's taints, changed as `kubectl taint` changes them: taints struck out and new ones added
 * are staged, and Apply sends them as one patch that touches only those (src/shared/taints.ts), so
 * a taint that changed meanwhile has the change refused and the list shown as it is now, the
 * person's changes still staged; one added meanwhile is kept. A NoExecute taint staged says first
 * which pods it evicts at once.
 */
import { Plus, Tag, X } from 'lucide-react'
import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import {
  changeTaints,
  refusedAsChanged,
  EFFECTS,
  sameSlot,
  sameTaint,
  taintsArgs,
  taintsSaid,
  taintText,
  type Effect,
  type Taint,
} from '@shared/taints'
import { Button } from '@renderer/components/Button'
import { Tooltip } from '@renderer/components/Tooltip'
import { useChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { Segmented } from '../assistants/PageParts'
import { ActionDialog } from './ActionDialog'
import { subjectOf, target, type ActionProps } from './common'

/** A taint's key: an optional DNS-subdomain prefix and a name, as the API takes it. */
const KEY =
  /^(?:[a-z0-9]([-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
/** A taint's value: empty, or a label value. */
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/
/** Kubernetes' own: the node's conditions and role, set by it (and set again while they hold). */
const KUBERNETES = /^(node\.kubernetes\.io|node-role\.kubernetes\.io)\//
const CONTROL_PLANE = 'node-role.kubernetes.io/control-plane'

/** Whether a pod tolerates a taint (as the scheduler and the taint manager read tolerations). */
function tolerates(pod: KubeObject, taint: Taint): boolean {
  const tolerations = (pod.spec?.tolerations ?? []) as {
    key?: string
    operator?: string
    value?: string
    effect?: string
  }[]
  return tolerations.some(
    (toleration) =>
      (!toleration.effect || toleration.effect === taint.effect) &&
      (toleration.operator === 'Exists'
        ? !toleration.key || toleration.key === taint.key
        : toleration.key === taint.key && (toleration.value ?? '') === (taint.value ?? '')),
  )
}

/** A list as it's said: "a", "a and b", "a, b and c". */
const listed = (texts: string[]) =>
  texts.length <= 1 ? texts.join('') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}`

export function TaintsDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const production = useProduction(context)
  const change = useChange()
  const node = object.metadata.name
  // As last read: the node as opened, then as a change (or a fresh read) left it.
  const [read, setRead] = useState(object)
  const taints = read.spec?.taints as Taint[] | undefined
  // Staged: those of the read list struck out (as themselves, so a fresh read keeps them), and new.
  const [struck, setStruck] = useState<Taint[]>([])
  const [added, setAdded] = useState<Taint[]>([])
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [effect, setEffect] = useState<Effect>('NoSchedule')
  const [pending, setPending] = useState(false)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState<string>()
  const pods = useList('Pod', { namespace: null, fieldSelector: `spec.nodeName=${node}` }).data

  const asked: Taint = { key: key.trim(), ...(value.trim() ? { value: value.trim() } : {}), effect }
  const keyWrong = key.trim() !== '' && !KEY.test(asked.key)
  const valueWrong = !VALUE.test(value.trim())
  const kept = (taints ?? []).filter((taint) => !struck.some((each) => sameTaint(each, taint)))
  const replaces = [...kept, ...added].find((taint) => sameSlot(taint, asked))
  const already = [...kept, ...added].some((taint) => sameTaint(taint, asked))
  const removed = (taints ?? []).filter((taint) => struck.some((each) => sameTaint(each, taint)))
  const diff = { added, removed }
  const staged = added.length + removed.length > 0

  // A NoExecute taint staged evicts, at once, the pods that don't tolerate it.
  const executing = added.filter((taint) => taint.effect === 'NoExecute')
  const evicted = executing.length
    ? (pods ?? []).filter((pod) => executing.some((taint) => !tolerates(pod, taint)))
    : []
  const danger = evicted.length > 0

  const command = staged
    ? taintsArgs(node, diff)
        .map((args) => kubectl(context, undefined, ...args))
        .join('\n')
    : kubectl(context, undefined, 'taint', 'nodes', node, '…')

  const stage = () => {
    if (!KEY.test(asked.key) || valueWrong || already) return
    // The same key and effect: the new value replaces it (a node has one taint per key and effect).
    const old = kept.find((taint) => sameSlot(taint, asked))
    if (old) setStruck([...struck, old])
    setAdded([...added.filter((taint) => !sameSlot(taint, asked)), asked])
    setKey('')
    setValue('')
  }

  const apply = async () => {
    setPending(true)
    setError(undefined)
    const places = removed.map((taint) => taints!.findIndex((each) => sameTaint(each, taint)))
    const patch = changeTaints(taints, places, added, read.metadata.resourceVersion ?? '')
    const title = taintsSaid(node, diff, true)!
    const result = await change(
      { ...target(read), change: { action: 'patch', patchType: 'json', patch } },
      { title, command, silent: true },
    )
    setPending(false)
    if (!result.ok) {
      // A test failed (the taints changed while this was open): nothing was written. The API
      // server says only that its patch didn't apply; a stand-in, which test.
      if (refusedAsChanged(result.error)) {
        const fresh = await api.kube.get({ context, kind: 'Node', name: node })
        if (fresh.ok) {
          setRead(fresh.data)
          // What's struck that's gone isn't anyone's to strike any more.
          const now = (fresh.data.spec?.taints ?? []) as Taint[]
          setStruck(struck.filter((taint) => now.some((each) => sameTaint(each, taint))))
        }
        setChanged(true)
        return
      }
      setError(result.error.message)
      return
    }
    const node2 = result.data!
    const now = (node2.spec?.taints ?? []) as Taint[]
    // Undo: what was added taken out (where it is now), and what was removed put back.
    const back = changeTaints(
      node2.spec?.taints ? now : undefined,
      added.map((taint) => now.findIndex((each) => sameTaint(each, taint))).filter((at) => at >= 0),
      removed,
      node2.metadata.resourceVersion ?? '',
    )
    const undone = { added: removed, removed: added }
    toast({
      tone: 'success',
      title,
      description: danger
        ? 'Undo puts the taints back. Pods it evicted don’t come back.'
        : undefined,
      action: {
        label: 'Undo',
        run: () =>
          void change(
            { ...target(node2), change: { action: 'patch', patchType: 'json', patch: back } },
            {
              title: taintsSaid(node, undone, true)!,
              command: taintsArgs(node, undone)
                .map((args) => kubectl(context, undefined, ...args))
                .join('\n'),
              silent: true,
            },
          ).then((reverted) =>
            toast(
              reverted.ok
                ? { tone: 'success', title: taintsSaid(node, undone, true)! }
                : { tone: 'error', title: 'Couldn’t undo', description: reverted.error.message },
            ),
          ),
      },
    })
    onClose()
  }

  const rowText = (taint: Taint) => (
    <span
      className="min-w-0 flex-1 truncate font-mono text-xs text-ink-1 selectable"
      title={taintText(taint)}
    >
      {taint.key}
      {taint.value ? `=${taint.value}` : ''}
    </span>
  )
  const pill = (taint: Taint) => (
    <span
      className={cn(
        'shrink-0 rounded-md px-1.5 py-px text-2xs font-medium',
        taint.effect === 'NoExecute' ? 'bg-warn/12 text-warn-text' : 'bg-surface-3 text-ink-2',
      )}
    >
      {taint.effect}
    </span>
  )
  const iconButton = (label: string, aria: string, onClick: () => void) => (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={aria}
        onClick={onClick}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-4" />
      </button>
    </Tooltip>
  )

  return (
    <ActionDialog
      icon={Tag}
      tone={danger ? 'danger' : 'default'}
      title={`Taints on ${node}`}
      name={node}
      subject={subjectOf(object)}
      command={command}
      confirmLabel={
        danger
          ? `Apply and evict ${evicted.length} ${evicted.length === 1 ? 'pod' : 'pods'}`
          : 'Apply'
      }
      typeToConfirm={production ? node : undefined}
      ready={staged && (executing.length === 0 || pods !== undefined)}
      pending={pending}
      error={error}
      wide
      onClose={onClose}
      onSubmit={() => void apply()}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        A taint keeps pods off {node} unless they tolerate it.{' '}
        {staged
          ? 'Nothing changes until Apply.'
          : 'Pods already running stay, except with NoExecute.'}
      </p>
      {changed && (
        <p role="status" className="rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-warn-text">
          {node}’s taints changed while this was open, so nothing was changed. Here they are now,
          with your changes still staged.
        </p>
      )}
      <ul aria-label="Taints" className="divide-y divide-line rounded-xl border border-line">
        {!taints?.length && added.length === 0 && (
          <li className="px-3 py-2.5 text-[13px] text-ink-3">
            No taints: nothing keeps pods off {node}.
          </li>
        )}
        {taints?.map((taint, index) => {
          const out = struck.some((each) => sameTaint(each, taint))
          return (
            <li key={`${taintText(taint)}-${index}`} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-3',
                    out && 'line-through opacity-60',
                  )}
                >
                  {rowText(taint)}
                  {pill(taint)}
                </span>
                {KUBERNETES.test(taint.key) && !out && (
                  <span className="shrink-0 text-xs text-ink-3">Set by Kubernetes</span>
                )}
                {out ? (
                  <>
                    <span className="shrink-0 text-xs text-ink-3">Removed</span>
                    <button
                      type="button"
                      aria-label={`Keep ${taintText(taint)}`}
                      onClick={() => setStruck(struck.filter((each) => !sameTaint(each, taint)))}
                      className="shrink-0 text-xs font-medium text-accent-strong hover:underline"
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  iconButton('Remove', `Remove ${taintText(taint)}`, () =>
                    setStruck([...struck, taint]),
                  )
                )}
              </div>
              {out && taint.key === CONTROL_PLANE && (
                <p className="mt-1 text-xs text-warn-text">
                  Pods will be scheduled on this control-plane node.
                </p>
              )}
            </li>
          )
        })}
        {added.map((taint) => (
          <li
            key={`new-${taintText(taint)}`}
            className="bg-accent-soft/30 px-3 py-2 shadow-[inset_3px_0_0_var(--accent)]"
          >
            <div className="flex items-center gap-3">
              {rowText(taint)}
              {pill(taint)}
              <span className="shrink-0 text-xs font-medium text-accent-strong">New</span>
              {iconButton('Remove', `Remove ${taintText(taint)}`, () =>
                setAdded(added.filter((each) => !sameTaint(each, taint))),
              )}
            </div>
            {taint.effect === 'NoExecute' &&
              pods !== undefined &&
              !pods.some((pod) => !tolerates(pod, taint)) && (
                <p className="mt-1 text-xs text-ink-3">
                  Every pod on {node} tolerates it: none is evicted.
                </p>
              )}
          </li>
        ))}
      </ul>
      {danger && (
        <p role="note" className="rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-warn-text">
          <span className="font-semibold">
            {evicted.length === 1
              ? `Applying this evicts ${evicted[0]!.metadata.name} from ${node} at once.`
              : `Applying this evicts ${evicted.length} pods from ${node} at once.`}
          </span>{' '}
          {evicted.length === 1
            ? `It doesn’t tolerate ${listed(executing.map(taintText))}.`
            : `${listed([
                ...evicted.slice(0, 2).map((pod) => pod.metadata.name),
                ...(evicted.length > 2 ? [`${evicted.length - 2} more`] : []),
              ])} don’t tolerate ${listed(executing.map(taintText))}.`}{' '}
          PodDisruptionBudgets aren’t asked, and pods without a controller don’t come back.
        </p>
      )}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block w-44">
            <span className="mb-1 block text-xs font-medium text-ink-2">Key</span>
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stage()
                }
              }}
              placeholder="dedicated"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={keyWrong || undefined}
              className="h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft aria-invalid:border-critical"
            />
          </label>
          <label className="block w-28">
            <span className="mb-1 block text-xs font-medium text-ink-2">Value</span>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="optional"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={valueWrong || undefined}
              className="h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft aria-invalid:border-critical"
            />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-2">Effect</span>
            <Segmented
              label="Effect"
              value={effect}
              choices={EFFECTS.map((each) => ({ value: each, label: each }))}
              onChange={setEffect}
            />
          </div>
          <Button disabled={!KEY.test(asked.key) || valueWrong || already} onClick={stage}>
            <Plus /> Add
          </Button>
        </div>
        {keyWrong && (
          <p className="text-xs text-critical-text">
            A key is letters, digits, “-”, “_” and “.”, with an optional prefix and “/”: no spaces.
          </p>
        )}
        {!keyWrong && replaces && !already && (
          <p className="text-xs text-ink-3">
            Replaces {taintText(replaces)}: a node has one taint per key and effect.
          </p>
        )}
      </div>
    </ActionDialog>
  )
}
