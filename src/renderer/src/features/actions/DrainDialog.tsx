import {
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  Minus,
  PackageMinus,
  RotateCw,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { useChange } from '@renderer/hooks/change'
import { useList } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { selects, type LabelSelector } from '@renderer/lib/map'
import { useProduction } from '@renderer/hooks/settings'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { Segmented } from '../assistants/PageParts'
import { ActionDialog } from './ActionDialog'
import { count, subjectOf, target, type ActionProps } from './common'

/** How many evictions run at once. */
const CONCURRENCY = 4
/** How often a pod a PodDisruptionBudget holds is looked at again, as kubectl drain does. */
const AGAIN_MS = 5_000
const MIRROR = 'kubernetes.io/config.mirror'
const PDB = 'PodDisruptionBudget.policy'
/** The most a grace period or a timeout is, in seconds (a day). */
const MOST = 86_400

type Option = 'localData' | 'unmanaged' | 'daemonSets'

type Plan =
  | { kind: 'evict' }
  | { kind: 'skip'; reason: string }
  | { kind: 'needs'; option: Option; reason: string }

/** A budget holding a pod: its name and numbers, as it said them when last read. */
interface Hold {
  name: string
  allowed: number
  healthy: number
  needed: number
}

type Progress =
  | { state: 'evicting' }
  | { state: 'evicted' }
  /** Held: by the budgets found (`said`: what the cluster said, where none is found). */
  | { state: 'held'; holds: Hold[]; said: string; next: number }
  | { state: 'left'; holds: Hold[]; said?: string }
  | { state: 'failed'; error: string }

/** What `kubectl drain` would do with a pod. */
function planFor(pod: KubeObject, leaveDaemonSets: boolean): Plan {
  const owner = pod.metadata.ownerReferences?.find((ref) => ref.controller)
  if (owner?.kind === 'DaemonSet') {
    return leaveDaemonSets
      ? { kind: 'skip', reason: 'DaemonSet pod, stays on the node' }
      : {
          kind: 'needs',
          option: 'daemonSets',
          reason: 'DaemonSet pod: the drain can’t go on with it here',
        }
  }
  if (pod.metadata.annotations?.[MIRROR])
    return { kind: 'skip', reason: 'Static pod, managed by the kubelet' }
  if (!owner)
    return { kind: 'needs', option: 'unmanaged', reason: 'No controller: it won’t come back' }
  if (pod.spec?.volumes?.some((v: { emptyDir?: unknown }) => v.emptyDir)) {
    return { kind: 'needs', option: 'localData', reason: 'Its emptyDir data is lost' }
  }
  return { kind: 'evict' }
}

/** A number of seconds typed, if it's a whole one from 1 to a day. */
function seconds(text: string): number | undefined {
  const value = Number(text)
  return /^\d+$/.test(text.trim()) && value >= 1 && value <= MOST ? value : undefined
}

/** A span as a clock says it: 2:10, 1:02:03. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A list as it's said: "a", "a and b", "a, b and c". */
const listed = (texts: string[]) =>
  texts.length <= 1 ? texts.join('') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}`

/** The budgets of a pod's namespace that hold it now: those whose selector picks it. */
async function holdsOf(context: string, pod: KubeObject): Promise<Hold[] | undefined> {
  const read = await api.kube.list({ context, kind: PDB, namespace: pod.metadata.namespace })
  if (!read.ok) return undefined
  return read.data.items
    .filter((pdb) => selects((pdb.spec?.selector ?? {}) as LabelSelector, pod.metadata.labels))
    .map((pdb) => ({
      name: pdb.metadata.name,
      allowed: Number(pdb.status?.disruptionsAllowed ?? 0),
      healthy: Number(pdb.status?.currentHealthy ?? 0),
      needed: Number(pdb.status?.desiredHealthy ?? 0),
    }))
}

/** A budget's line: why it holds pods now. */
const holdSays = (hold: Hold) =>
  `no disruptions allowed now (${hold.healthy} healthy, ${hold.needed} needed)`

export function DrainDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const production = useProduction(context)
  const change = useChange()
  const node = object.metadata.name
  const pods = useList('Pod', { namespace: null, fieldSelector: `spec.nodeName=${node}` }).data
  const [options, setOptions] = useState({ localData: false, unmanaged: false, daemonSets: true })
  const [grace, setGrace] = useState<'own' | 'seconds'>('own')
  const [graceText, setGraceText] = useState('30')
  const [giveUp, setGiveUp] = useState<'never' | 'seconds'>('never')
  const [giveUpText, setGiveUpText] = useState('300')
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  // The same, as it is this moment (for what the drain does once every pod is done).
  const now$ = useRef<Record<string, Progress>>({})
  const [phase, setPhase] = useState<'review' | 'running' | 'stopped' | 'done'>('review')
  // Cordoning, before any pod: Drain stays, busy, with the focus (Stop comes with the evictions).
  const [cordoning, setCordoning] = useState(false)
  const [error, setError] = useState<string>()
  const [started, setStarted] = useState<{ pod: KubeObject; plan: Plan }[]>()
  const [startedAt, setStartedAt] = useState(0)
  const [timedOut, setTimedOut] = useState<number>()
  const [now, setNow] = useState(Date.now())
  // Stop asked: what's waiting stops waiting, and nothing more is sent.
  const stop = useRef(false)
  // While a drain runs: how many it set out to evict (to say, should the dialog go).
  const running = useRef<number | undefined>(undefined)

  // Closed (Escape, a click away, the page left): whatever runs stops as Stop does, nothing more
  // is sent (the cordon too, if it's still on its way: nothing follows it), and a drain that was
  // running is said, since nothing on screen says it any more. (A drain sets the stop off as it
  // starts, so React's rehearsal of this as the dialog opens changes nothing.)
  useEffect(
    () => () => {
      stop.current = true
      const total = running.current
      if (total === undefined) return
      const evicted = Object.values(now$.current).filter((p) => p.state === 'evicted').length
      toast({
        tone: 'info',
        title: evicted
          ? `Stopped draining ${node}: ${evicted} of ${count(total, 'pod')} evicted. It stays cordoned.`
          : `Stopped draining ${node}: no pods evicted. It stays cordoned.`,
        action: {
          label: 'Uncordon',
          run: () =>
            void change(
              {
                ...target(object),
                change: {
                  action: 'patch',
                  patchType: 'merge',
                  patch: { spec: { unschedulable: null } },
                },
              },
              {
                title: `Uncordoned ${node}`,
                command: kubectl(context, undefined, 'uncordon', node),
              },
            ),
        },
      })
    },
    // (Once, as it goes: what it says is read from the refs then.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // A clock while it runs: how long, and when each held pod is looked at again.
  useEffect(() => {
    if (phase !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const graceSeconds = grace === 'seconds' ? seconds(graceText) : undefined
  const timeout = giveUp === 'seconds' ? seconds(giveUpText) : undefined
  const graceWrong = grace === 'seconds' && graceSeconds === undefined
  const timeoutWrong = giveUp === 'seconds' && timeout === undefined

  // Once the drain starts, the list stays as it was, while evicted pods leave the node.
  const planned =
    started ??
    (pods ?? [])
      .map((pod) => ({ pod, plan: planFor(pod, options.daemonSets) }))
      .sort((a, b) => a.pod.metadata.name.localeCompare(b.pod.metadata.name))
  const allowed = (plan: Plan) =>
    plan.kind === 'evict' ||
    (plan.kind === 'needs' && plan.option !== 'daemonSets' && options[plan.option])
  const blocked = planned.filter(({ plan }) => plan.kind === 'needs' && !allowed(plan))
  const toEvict = planned.filter(({ plan }) => allowed(plan))
  const command = kubectl(
    context,
    undefined,
    'drain',
    node,
    ...(options.daemonSets ? ['--ignore-daemonsets'] : []),
    ...(options.localData ? ['--delete-emptydir-data'] : []),
    ...(options.unmanaged ? ['--force'] : []),
    ...(graceSeconds !== undefined ? [`--grace-period=${graceSeconds}`] : []),
    ...(timeout !== undefined ? [`--timeout=${timeout}s`] : []),
  )

  const keyOf = (pod: KubeObject) => `${pod.metadata.namespace}/${pod.metadata.name}`
  const set = (pod: KubeObject, state: Progress) => {
    now$.current = { ...now$.current, [keyOf(pod)]: state }
    setProgress(now$.current)
  }

  /** One eviction, as kubectl drain's: with the grace period asked for. */
  const evictOnce = (pod: KubeObject) =>
    change(
      {
        ...target(pod),
        change: {
          action: 'evict',
          ...(graceSeconds !== undefined ? { gracePeriodSeconds: graceSeconds } : {}),
        },
      },
      { title: `Evicted ${pod.metadata.name}`, command, silent: true },
    )

  /**
   * A pod evicted; one a budget holds looked at again every 5 s (its budgets read, not the
   * eviction sent: the audit log has the eviction once, and again only when they allow it)
   * until it's evicted, the timeout ends, or Stop.
   */
  const evict = async (pod: KubeObject, deadline?: number) => {
    set(pod, { state: 'evicting' })
    for (;;) {
      const result = await evictOnce(pod)
      if (result.ok) return set(pod, { state: 'evicted' })
      if (result.error.status !== 429) {
        return set(pod, { state: 'failed', error: result.error.message })
      }
      const said = result.error.message
      let holds = (await holdsOf(context, pod)) ?? []
      for (;;) {
        const next = Date.now() + AGAIN_MS
        if (stop.current || (deadline !== undefined && next > deadline)) {
          if (!stop.current) setTimedOut(Date.now())
          return set(pod, { state: 'left', holds, said })
        }
        set(pod, { state: 'held', holds, said, next })
        await new Promise((done) => setTimeout(done, AGAIN_MS))
        if (stop.current) return set(pod, { state: 'left', holds, said })
        const fresh = await holdsOf(context, pod)
        // Unreadable budgets: tried again as kubectl does, every 5 s.
        if (!fresh) break
        holds = fresh
        if (holds.every((hold) => hold.allowed > 0)) break
      }
      set(pod, { state: 'evicting' })
    }
  }

  const drain = async () => {
    stop.current = false
    // Running from here, the cordon included: a dialog closed from now on says where it stopped.
    running.current = toEvict.length
    setStarted(planned)
    now$.current = {}
    setProgress({})
    setTimedOut(undefined)
    setPhase('running')
    setStartedAt(Date.now())
    setNow(Date.now())
    setError(undefined)
    if (!object.spec?.unschedulable) {
      setCordoning(true)
      const cordoned = await change(
        {
          ...target(object),
          change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: true } } },
        },
        {
          title: `Cordoned ${node}`,
          command: kubectl(context, undefined, 'cordon', node),
          silent: true,
        },
      )
      setCordoning(false)
      if (!cordoned.ok) {
        running.current = undefined
        setError(cordoned.error.message)
        setStarted(undefined)
        setPhase('review')
        return
      }
    }
    // Closed while it cordoned: nothing is evicted (it was said as it closed).
    if (stop.current) return
    const deadline = timeout !== undefined ? Date.now() + timeout * 1000 : undefined
    const queue = toEvict.map(({ pod }) => pod)
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let pod = queue.shift(); pod; pod = queue.shift()) {
          if (stop.current) set(pod, { state: 'left', holds: [] })
          else await evict(pod, deadline)
        }
      }),
    )
    // Done: a Retry from here is one try (nothing waits once the drain is over).
    stop.current = true
    running.current = undefined
    setPhase(Object.values(now$.current).every((s) => s.state === 'evicted') ? 'done' : 'stopped')
  }

  const uncordon = async () => {
    const result = await change(
      {
        ...target(object),
        change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: null } } },
      },
      { title: `Uncordoned ${node}`, command: kubectl(context, undefined, 'uncordon', node) },
    )
    if (result.ok) onClose()
    else setError(result.error.message)
  }

  const states = Object.values(progress)
  const evicted = states.filter((p) => p.state === 'evicted').length
  const failed = states.filter((p) => p.state === 'failed' || p.state === 'left').length
  const held = planned.filter(({ pod }) => progress[keyOf(pod)]?.state === 'held')
  // Which budgets hold which pods: while it runs, and where it stopped.
  const holding = new Map<string, { hold: Hold; pods: string[] }>()
  for (const { pod } of planned) {
    const p = progress[keyOf(pod)]
    if (p?.state !== 'held' && p?.state !== 'left') continue
    for (const hold of p.holds) {
      const name = `${pod.metadata.namespace}/${hold.name}`
      const entry = holding.get(name) ?? { hold, pods: [] }
      entry.pods.push(pod.metadata.name)
      holding.set(name, entry)
    }
  }
  const left = planned.filter(({ pod }) => {
    const p = progress[keyOf(pod)]?.state
    return p === 'left' || p === 'failed'
  }).length

  const footer =
    phase === 'running' && !cordoning ? (
      <Button
        onClick={() => {
          stop.current = true
        }}
      >
        Stop
      </Button>
    ) : phase === 'stopped' ? (
      <>
        <Button onClick={() => void uncordon()}>Uncordon</Button>
        <Button
          onClick={() => {
            setStarted(undefined)
            now$.current = {}
            setProgress({})
            setPhase('review')
          }}
        >
          Drain again
        </Button>
        <Button variant="primary" data-confirm onClick={onClose}>
          Done
        </Button>
      </>
    ) : phase === 'done' ? (
      <Button variant="primary" data-confirm onClick={onClose}>
        Done
      </Button>
    ) : undefined

  const optionRow = (label: string, control: ReactNode, field: ReactNode, hint: string) => (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-28 shrink-0 text-[13px] font-medium text-ink-1">{label}</span>
        {control}
        {field}
      </div>
      <p className="pl-[124px] text-xs text-ink-3">{hint}</p>
    </div>
  )
  const secondsField = (
    label: string,
    text: string,
    onText: (text: string) => void,
    wrong: boolean,
    why: string,
  ) => (
    <span className="flex items-center gap-2">
      <input
        aria-label={label}
        value={text}
        inputMode="numeric"
        onChange={(event) => onText(event.target.value)}
        aria-invalid={wrong || undefined}
        className="h-8 w-20 rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft aria-invalid:border-critical"
      />
      {wrong && <span className="text-xs text-critical-text">{why}</span>}
    </span>
  )

  return (
    <ActionDialog
      icon={PackageMinus}
      tone="danger"
      title={
        phase === 'running'
          ? `Draining ${node}`
          : phase === 'stopped'
            ? `Drain of ${node} stopped`
            : `Drain ${node}?`
      }
      name={node}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Drain"
      wide
      typeToConfirm={production && phase === 'review' ? node : undefined}
      ready={pods !== undefined && blocked.length === 0 && !graceWrong && !timeoutWrong}
      pending={phase === 'running'}
      error={error}
      onClose={onClose}
      onSubmit={() => void drain()}
      footer={footer}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        {node} is cordoned so nothing new is scheduled on it, then its pods are evicted — their
        controllers start them on other nodes. Pods a PodDisruptionBudget holds are tried again
        until it allows them, or the timeout ends.
      </p>

      {phase === 'review' && (
        <>
          <div className="space-y-2.5">
            {optionRow(
              'Grace period',
              <Segmented
                label="Grace period"
                value={grace}
                choices={[
                  { value: 'own', label: 'Each pod’s own' },
                  { value: 'seconds', label: 'Seconds' },
                ]}
                onChange={setGrace}
              />,
              grace === 'seconds' &&
                secondsField(
                  'Grace period in seconds',
                  graceText,
                  setGraceText,
                  graceWrong,
                  graceText.trim() === '0'
                    ? 'At least 1 second: 0 would kill each pod without letting it stop.'
                    : 'A whole number of seconds.',
                ),
              'How long each pod has to stop before it’s killed. Its own is its terminationGracePeriodSeconds.',
            )}
            {optionRow(
              'Give up after',
              <Segmented
                label="Give up after"
                value={giveUp}
                choices={[
                  { value: 'never', label: 'Never' },
                  { value: 'seconds', label: 'Seconds' },
                ]}
                onChange={setGiveUp}
              />,
              giveUp === 'seconds' ? (
                secondsField(
                  'Give up after, in seconds',
                  giveUpText,
                  setGiveUpText,
                  timeoutWrong,
                  'At least 1 second.',
                )
              ) : (
                <span className="text-xs text-ink-3">Stop it yourself</span>
              ),
              'How long to keep trying pods a PodDisruptionBudget holds. Then those pods stay, and so does the cordon.',
            )}
          </div>
          <fieldset className="space-y-1.5">
            {(
              [
                [
                  'daemonSets',
                  'Leave DaemonSet pods',
                  'Their DaemonSet would start them here again anyway. Off, a DaemonSet pod stops the drain.',
                  false,
                ],
                [
                  'localData',
                  'Delete emptyDir data',
                  'Evict pods that keep data in emptyDir volumes; the data is lost.',
                  true,
                ],
                [
                  'unmanaged',
                  'Evict pods without a controller',
                  'Nothing restarts them elsewhere.',
                  true,
                ],
              ] as const
            ).map(([option, label, hint, critical]) => (
              <label
                key={option}
                className={cn(
                  'flex cursor-default gap-3 rounded-lg border border-line px-3 py-2',
                  critical && 'has-checked:border-critical/40 has-checked:bg-critical/5',
                )}
              >
                <input
                  type="checkbox"
                  checked={options[option]}
                  onChange={(event) => setOptions({ ...options, [option]: event.target.checked })}
                  className={cn(
                    'mt-0.5',
                    critical ? 'accent-[var(--critical)]' : 'accent-[var(--accent)]',
                  )}
                />
                <span>
                  <span className="block text-[13px] font-medium text-ink-1">{label}</span>
                  <span className="block text-xs text-ink-3">{hint}</span>
                </span>
              </label>
            ))}
            {blocked.length > 0 && (
              <p className="text-xs text-warn-text">
                {count(blocked.length, 'pod')} {blocked.length === 1 ? 'needs' : 'need'} one of
                these options before the node can be drained.
              </p>
            )}
          </fieldset>
        </>
      )}

      {phase === 'running' && holding.size > 0 && (
        <div role="status" className="rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-warn-text">
          <p className="flex flex-wrap justify-between gap-x-3 font-semibold">
            <span>Waiting on {count(holding.size, 'PodDisruptionBudget')}</span>
            <span className="font-normal tabular-nums">
              trying every 5 s · {clock(now - startedAt)}
              {timeout !== undefined && ` of ${clock(timeout * 1000)}`}
            </span>
          </p>
          {[...holding].map(([name, { hold, pods: held }]) => (
            <p key={name} className="mt-0.5">
              <span className="font-mono text-xs">{name}</span> holds {count(held.length, 'pod')}:{' '}
              {holdSays(hold)}
            </p>
          ))}
        </div>
      )}

      {phase === 'stopped' && (
        <div role="status" className="rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-warn-text">
          <p className="font-semibold">
            {timedOut !== undefined && timeout !== undefined
              ? `Stopped after ${clock(timeout * 1000)}: ${count(left, 'pod')} ${left === 1 ? 'is' : 'are'} still on ${node}${holding.size ? ', held by PodDisruptionBudgets' : ''}. It stays cordoned.`
              : `Stopped: ${count(left, 'pod')} ${left === 1 ? 'is' : 'are'} still on ${node}. It stays cordoned.`}
          </p>
          {[...holding].map(([name, { pods: held }]) => (
            <p key={name} className="mt-0.5">
              <span className="font-mono text-xs">{name}</span>: {listed(held)}
            </p>
          ))}
          <p className="mt-0.5">Retry below once the cause is fixed.</p>
        </div>
      )}

      {pods === undefined ? (
        <Loading label="Finding pods on the node…" />
      ) : (
        <>
          {phase === 'done' ? (
            <p
              role="status"
              className={cn(
                'rounded-lg px-3 py-2 text-[13px]',
                failed ? 'bg-warn/10 text-warn-text' : 'bg-good/10 text-good-text',
              )}
            >
              {failed
                ? `${count(failed, 'pod')} couldn’t be evicted. Retry below once the cause is fixed.`
                : `Drained ${node}: ${count(evicted, 'pod')} evicted.`}
            </p>
          ) : (
            <p className="text-xs text-ink-3 tabular-nums" aria-live="polite">
              {phase === 'review'
                ? `${count(toEvict.length, 'pod')} to evict, ${planned.length - toEvict.length} staying`
                : `${evicted} of ${toEvict.length} evicted${held.length ? ` · ${held.length} held by PodDisruptionBudgets` : ''}${failed ? ` · ${failed} stopped` : ''}`}
            </p>
          )}
          <ul
            aria-label="Pods on the node"
            className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line"
          >
            {planned.length === 0 && (
              <li className="px-3 py-3 text-[13px] text-ink-3">No pods run on {node}.</li>
            )}
            {planned.map(({ pod, plan }) => {
              const status = progress[keyOf(pod)]
              const may = allowed(plan)
              const stopped = status?.state === 'failed' || status?.state === 'left'
              const hold = status?.state === 'held' || status?.state === 'left' ? status.holds : []
              return (
                <li key={keyOf(pod)} className="flex items-center gap-3 px-3 py-2">
                  <span className="grid size-4 shrink-0 place-items-center">
                    {status?.state === 'evicting' ? (
                      <LoaderCircle
                        aria-label="Evicting"
                        className="size-4 animate-spin text-ink-3"
                      />
                    ) : status?.state === 'evicted' ? (
                      <CircleCheck aria-label="Evicted" className="size-4 text-good-text" />
                    ) : status?.state === 'held' ? (
                      <Clock aria-label="Held" className="size-4 text-warn-text" />
                    ) : stopped ? (
                      <CircleX aria-label="Not evicted" className="size-4 text-critical-text" />
                    ) : (
                      <Minus aria-hidden className="size-3.5 text-ink-3" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-ink-1">
                      {pod.metadata.name}
                    </span>
                    <span
                      className={cn(
                        'block truncate text-xs',
                        stopped
                          ? 'text-critical-text'
                          : status?.state === 'held' || (plan.kind === 'needs' && !may)
                            ? 'text-warn-text'
                            : 'text-ink-3',
                      )}
                    >
                      {status?.state === 'failed'
                        ? status.error
                        : status?.state === 'held' || status?.state === 'left'
                          ? `${pod.metadata.namespace} · ${
                              hold.length > 0
                                ? `Held by PodDisruptionBudget ${hold.map((h) => `${h.name}: ${holdSays(h)}`).join('; ')}`
                                : (status.said ?? 'Not evicted')
                            }${status.state === 'held' ? ` · again in ${Math.max(0, Math.ceil((status.next - now) / 1000))} s` : ''}`
                          : status?.state === 'evicted'
                            ? `${pod.metadata.namespace} · Evicted`
                            : plan.kind === 'evict'
                              ? pod.metadata.namespace
                              : `${pod.metadata.namespace} · ${plan.reason}`}
                    </span>
                  </span>
                  {stopped && phase !== 'running' && (
                    <Button variant="ghost" className="h-7 px-2" onClick={() => void evict(pod)}>
                      <RotateCw /> Retry
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </ActionDialog>
  )
}
