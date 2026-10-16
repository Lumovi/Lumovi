import { useQueries, useQuery } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  KeyRound,
  Lock,
  RefreshCw,
  ScrollText,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { comparable, configPairs, type ConfigPair } from '@shared/compare'
import { shownPath, type WithheldField } from '@shared/withheld'
import { Button } from '@renderer/components/Button'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { Switch } from '@renderer/components/Switch'
import { useAccessIn } from '@renderer/features/access/use-access'
import { useClusterName, useProduction } from '@renderer/hooks/settings'
import { api, unwrap, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { maskedManifest } from '@renderer/lib/helm-diff'
import { COMPARED, comparePath, parseRef, type CompareSide } from '@renderer/lib/routes'
import { toYaml } from '@renderer/lib/yaml'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { ComparePicker } from './ComparePicker'

/** What a value is shown as where it isn't compared: the keys alone are. */
const NOT_COMPARED = 'not compared'

/** One side, as the address names it. */
function sideOf(params: URLSearchParams, which: 'left' | 'right'): CompareSide | undefined {
  const context = params.get(which === 'left' ? COMPARED.left : COMPARED.right)
  const ref = params.get(which === 'left' ? COMPARED.leftRef : COMPARED.rightRef)
  return context && ref ? { context, ref } : undefined
}

/** An object as one side's cluster has it, read with that cluster's own access. */
function readOf(side: CompareSide | undefined) {
  const ref = side && parseRef(side.ref)
  return {
    queryKey: ['compare', side?.context, side?.ref],
    queryFn: () =>
      unwrap(
        api.kube.get({
          context: side!.context,
          kind: ref!.kind,
          name: ref!.name,
          namespace: ref!.namespace,
        }),
      ),
    enabled: Boolean(side),
    // (Read when asked, and on Refresh: two clusters are never polled.)
    staleTime: Infinity,
    retry: false,
  }
}

/** A Secret's values, each said "not compared": its keys alone are compared. */
function keysOnly(object: KubeObject): KubeObject {
  const keys = (values: unknown) =>
    Object.fromEntries(Object.keys((values ?? {}) as object).map((key) => [key, NOT_COMPARED]))
  const { data, stringData, ...rest } = object as KubeObject & {
    data?: Record<string, string>
    stringData?: Record<string, string>
  }
  // (kubectl's annotation holds every value: it goes too.)
  const metadata = { ...rest.metadata }
  if (metadata.annotations) {
    const { 'kubectl.kubernetes.io/last-applied-configuration': _all, ...annotations } =
      metadata.annotations
    metadata.annotations = annotations
  }
  return {
    ...rest,
    metadata,
    ...(data ? { data: keys(data) } : {}),
    ...(stringData ? { stringData: keys(stringData) } : {}),
  } as KubeObject
}

/**
 * Two objects' differences, as the page draws them: left out what `noise` says, Secrets masked
 * line for line unless revealed, and only their keys where `keysAlone`.
 */
function differences(
  left: KubeObject,
  right: KubeObject,
  {
    noise,
    revealed,
    keysAlone,
    withheld = [],
  }: {
    noise: boolean
    revealed: boolean
    keysAlone: boolean
    withheld?: readonly WithheldField[]
  },
) {
  const secret = left.kind === 'Secret'
  const [a, b] = [left, right].map((object) =>
    toYaml(comparable(secret && keysAlone ? keysOnly(object) : object, { noise, withheld })),
  ) as [string, string]
  const masked = secret && !keysAlone && !revealed
  return unifiedDiff(
    a,
    b,
    masked ? { before: maskedManifest(a), after: maskedManifest(b) } : undefined,
  )
}

/** How many lines leaving status and what the cluster set out of the two drops. */
function leftOut(left: KubeObject, right: KubeObject, withheld: readonly WithheldField[]): number {
  const lines = (noise: boolean) =>
    [left, right].reduce(
      (sum, object) => sum + toYaml(comparable(object, { noise, withheld })).split('\n').length,
      0,
    )
  return lines(true) - lines(false)
}

/**
 * What either side's cluster withholds of the kind compared, by its plugins' files: taken out of
 * both sides, and marked where it would be.
 */
function useWithheld(sides: (CompareSide | undefined)[]): WithheldField[] {
  const reads = useQueries({
    queries: sides.map((side) => ({
      queryKey: ['resources', side?.context],
      queryFn: () => unwrap(api.kube.resources(side!.context)),
      enabled: Boolean(side),
      staleTime: 60_000,
    })),
  })
  const fields = new Map<string, WithheldField>()
  sides.forEach((side, i) => {
    const kind = side && parseRef(side.ref).kind
    for (const field of reads[i]?.data?.find((r) => r.kind === kind)?.withheld ?? []) {
      fields.set(`${field.plugin}\u0000${field.keys.join('\u0000')}`, field)
    }
  })
  return [...fields.values()]
}

/**
 * Compare: two objects of a kind, from a namespace or a cluster each, read with that cluster's
 * own access; what differs, with what's only status or the cluster's own left out unless asked;
 * and, of a workload, the config it references, paired by where.
 */
export function ComparePage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { context: here } = useCluster()
  const left = sideOf(params, 'left')
  const right = sideOf(params, 'right')
  const [leftRead, rightRead] = useQueries({ queries: [readOf(left), readOf(right)] })
  const noise = usePrefs((prefs) => prefs.compareNoise)
  const setNoise = usePrefs((prefs) => prefs.setCompareNoise)
  const [changing, setChanging] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const leftAccess = useAccessIn(left?.context ?? here)
  const rightAccess = useAccessIn(right?.context ?? here)
  const nameOf = useClusterName()
  const withheld = useWithheld([left, right])

  if (!left || !right) {
    return (
      <div className="p-8 text-sm text-ink-2">
        Nothing to compare: pick an object, and Compare with… in its More actions.
      </div>
    )
  }
  const refresh = () => {
    void leftRead.refetch()
    void rightRead.refetch()
  }
  const swap = () => void navigate(comparePath(here, right, left))
  // (A side whose last read failed is unread: never what it was before.)
  const [a, b] = [leftRead, rightRead].map((read) => (read.isError ? undefined : read.data))
  const secret = a?.kind === 'Secret'
  // Where either side's access shows only Secrets' keys, values aren't compared at all.
  const keysWhy = secret
    ? (leftAccess.whyNot('secrets', 'values', a.metadata.namespace, 'see Secrets’ values') &&
        nameOf(left.context)) ||
      (rightAccess.whyNot('secrets', 'values', b?.metadata.namespace, 'see Secrets’ values') &&
        nameOf(right.context))
    : undefined
  const diff =
    a && b
      ? differences(a, b, { noise, revealed, keysAlone: Boolean(keysWhy), withheld })
      : undefined
  const dropped = a && b && !noise ? leftOut(a, b, withheld) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-3 border-b border-line px-6 pt-4 pb-3">
        <div className="flex items-stretch gap-2">
          <SideCard side={left} sign="−" read={leftRead} />
          <Button
            variant="secondary"
            aria-label="Swap"
            title="Swap"
            onClick={swap}
            className="self-center px-2"
          >
            <ArrowLeftRight />
          </Button>
          <SideCard side={right} sign="+" read={rightRead} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex-1 text-ink-3">
            {diff ? (
              diff.added + diff.removed === 0 ? (
                'No differences'
              ) : (
                <>
                  <span className="font-medium text-critical-text">−{diff.removed}</span>{' '}
                  <span className="font-medium text-good-text">+{diff.added}</span> lines
                </>
              )
            ) : leftRead.isError || rightRead.isError ? (
              `Nothing to compare until ${nameOf(leftRead.isError ? left.context : right.context)} is read`
            ) : null}
            {dropped > 0 && ` · ${dropped} lines of status and cluster-set fields left out`}
          </span>
          <label className="flex items-center gap-2 text-ink-2">
            <Switch
              checked={noise}
              onCheckedChange={setNoise}
              label="Show status and cluster-set fields"
            />
            Show status and cluster-set fields
          </label>
          <Button variant="secondary" onClick={() => setChanging(true)} className="h-7 text-xs">
            Change…
          </Button>
          <Button variant="secondary" onClick={refresh} className="h-7 text-xs">
            <RefreshCw /> Refresh
          </Button>
        </div>
      </div>

      <div className="space-y-6 px-6 py-4">
        {diff && secret && !keysWhy && (
          <RevealRow
            revealed={revealed}
            onReveal={() => setRevealed(!revealed)}
            hidden={
              leftAccess.whyNot('secrets', 'values', a!.metadata.namespace) ??
              rightAccess.whyNot('secrets', 'values', b!.metadata.namespace)
            }
          />
        )}
        {diff && secret && keysWhy && <KeysOnlyLine where={keysWhy} />}
        {diff &&
          (diff.added + diff.removed === 0 ? (
            <NoDifferences
              name={a!.metadata.name}
              dropped={dropped}
              onShow={() => setNoise(true)}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              <DiffView diff={diff} label="Differences" />
            </div>
          ))}
        {diff && withheld.length > 0 && <WithheldLines fields={withheld} object={a!} />}
        {!diff && (a ?? b) && (
          <OneSide
            object={(a ?? b)!}
            name={nameOf(a ? left.context : right.context)}
            other={nameOf(a ? right.context : left.context)}
          />
        )}
        {a && b && (
          <ConfigItReferences
            left={a}
            right={b}
            sides={[left, right]}
            noise={noise}
            names={[nameOf(left.context), nameOf(right.context)]}
          />
        )}
      </div>
      {changing && a && <ComparePicker object={a} onClose={() => setChanging(false)} />}
    </div>
  )
}

/** One side of the comparison: its cluster, namespace and name, or why it couldn't be read. */
function SideCard({
  side,
  sign,
  read,
}: {
  side: CompareSide
  sign: '−' | '+'
  read: { data?: KubeObject; error: Error | null; isError: boolean }
}) {
  const ref = parseRef(side.ref)
  const name = useClusterName()(side.context)
  const production = useProduction(side.context)
  const failed = read.isError ? (read.error as KubeApiError) : undefined
  return (
    <div
      aria-label={`${sign === '−' ? 'Left' : 'Right'}: ${ref.name} on ${name}`}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3 rounded-xl border bg-surface-2 px-3 py-2.5',
        failed ? 'border-critical/50' : 'border-line',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md font-mono text-sm',
          sign === '−' ? 'bg-critical/10 text-critical-text' : 'bg-good/10 text-good-text',
        )}
      >
        {sign}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          <span className="font-medium text-ink-2">{name}</span>
          {production && (
            <span className="rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
              Production
            </span>
          )}
          {ref.namespace && <span>· {ref.namespace}</span>}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold text-ink-1">{ref.name}</span>
          <span className="text-xs text-ink-3">{read.data?.kind ?? ref.kind}</span>
        </span>
        {failed && (
          <span className="block text-xs text-critical-text">
            {failed.code === 'not-found'
              ? `It’s gone: ${ref.name} no longer exists on ${name}.`
              : failed.code === 'forbidden'
                ? `Your access on ${name} doesn’t let you read ${read.data?.kind ?? ref.kind}s${ref.namespace ? ` in ${ref.namespace}` : ''}.`
                : `Couldn’t read it: ${name} didn’t answer in time.`}
          </span>
        )}
      </span>
    </div>
  )
}

/** What's withheld on both sides, and by whose file: what it is isn't read, so it isn't compared. */
function WithheldLines({ fields, object }: { fields: WithheldField[]; object: KubeObject }) {
  return (
    <ul aria-label="Fields not compared" className="space-y-1 text-xs text-ink-3">
      {fields.map(({ keys, plugin }) => (
        <li key={`${plugin}\u0000${keys.join('\u0000')}`} className="flex items-start gap-2">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Withheld by {plugin}’s file, on both sides: {shownPath(keys, object)} isn’t read from
            either cluster, so it can’t be compared.
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The values of Secrets, hidden until asked for where both sides' access shows them. */
function RevealRow({
  revealed,
  onReveal,
  hidden,
}: {
  revealed: boolean
  onReveal: () => void
  hidden?: string
}) {
  return (
    <p className="flex items-center gap-2 text-xs text-ink-3">
      <KeyRound className="size-3.5" aria-hidden />
      <span className="flex-1">
        {revealed ? 'Secrets’ values shown' : 'Secrets’ values hidden'}
      </span>
      {!hidden && (
        <Button variant="ghost" className="h-7 text-xs" onClick={onReveal}>
          {revealed ? 'Hide values' : 'Reveal values'}
        </Button>
      )}
    </p>
  )
}

/** Why a Secret's values aren't compared: one side's access shows only keys. */
function KeysOnlyLine({ where }: { where: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-ink-3">
      <Lock className="size-3.5" aria-hidden />
      Values not compared: your access on {where} shows only Secrets’ keys. Each side’s Secret opens
      on its own.
    </p>
  )
}

function NoDifferences({
  name,
  dropped,
  onShow,
}: {
  name: string
  dropped: number
  onShow: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span className="grid size-9 place-items-center rounded-xl bg-good/10 text-good-text">
        <Check className="size-5" />
      </span>
      <h2 className="text-[15px] font-semibold text-ink-1">No differences</h2>
      <p className="max-w-md text-[13px] text-ink-2">
        {name} is the same on both sides
        {dropped > 0 ? (
          <>
            . {dropped} lines of status and cluster-set fields were left out, and may differ:{' '}
            <button type="button" onClick={onShow} className="text-accent-strong hover:underline">
              Show them
            </button>
            .
          </>
        ) : (
          ', status included.'
        )}
      </p>
    </div>
  )
}

/** A side alone, where the other couldn't be read: as it is, plain. */
function OneSide({ object, name, other }: { object: KubeObject; name: string; other: string }) {
  const yaml = toYaml(comparable(object))
  return (
    <section className="space-y-2">
      <p className="flex items-center gap-2 text-xs text-ink-3">
        <Info className="size-3.5" aria-hidden />
        Only {name}’s side, as it is. Refresh reads {other} again.
      </p>
      <pre
        aria-label={`${name}’s side`}
        className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-2/60 px-4 py-3 font-mono text-[12px] leading-[1.7] text-ink-2 selectable"
      >
        {object.kind === 'Secret' ? maskedManifest(yaml) : yaml}
      </pre>
    </section>
  )
}

/** The config two workloads reference, a pair each, read from each side's own cluster. */
function ConfigItReferences({
  left,
  right,
  sides,
  noise,
  names,
}: {
  left: KubeObject
  right: KubeObject
  sides: [CompareSide, CompareSide]
  noise: boolean
  names: [string, string]
}) {
  const pairs = configPairs(left, right)
  if (pairs.length === 0) return null
  return (
    <section aria-label="Config it references">
      <h2 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        Config it references{' '}
        <span className="font-normal normal-case">
          {pairs.length} {pairs.length === 1 ? 'pair' : 'pairs'}
        </span>
      </h2>
      <div className="rounded-lg border border-line">
        {pairs.map((pair) => (
          <ConfigPairRow
            key={`${pair.kind}/${pair.left ?? ''}/${pair.right ?? ''}`}
            pair={pair}
            sides={sides}
            namespaces={[left.metadata.namespace, right.metadata.namespace]}
            noise={noise}
            names={names}
          />
        ))}
      </div>
    </section>
  )
}

function ConfigPairRow({
  pair,
  sides,
  namespaces,
  noise,
  names,
}: {
  pair: ConfigPair
  sides: [CompareSide, CompareSide]
  namespaces: [string | undefined, string | undefined]
  noise: boolean
  names: [string, string]
}) {
  const [open, setOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const read = (index: 0 | 1, name: string | undefined) => ({
    queryKey: ['compare', sides[index].context, `${pair.kind}/${namespaces[index] ?? ''}/${name}`],
    queryFn: () =>
      unwrap(
        api.kube.get({
          context: sides[index].context,
          kind: pair.kind,
          name: name!,
          namespace: namespaces[index],
        }),
      ),
    enabled: Boolean(name),
    staleTime: Infinity,
    retry: false,
  })
  const leftRead = useQuery(read(0, pair.left))
  const rightRead = useQuery(read(1, pair.right))
  const leftAccess = useAccessIn(sides[0].context)
  const rightAccess = useAccessIn(sides[1].context)
  const secret = pair.kind === 'Secret'
  const keysWhy = secret
    ? (leftAccess.whyNot('secrets', 'values', namespaces[0]) && names[0]) ||
      (rightAccess.whyNot('secrets', 'values', namespaces[1]) && names[1])
    : undefined
  const [a, b] = [leftRead, rightRead].map((read) => (read.isError ? undefined : read.data))
  const diff =
    a && b ? differences(a, b, { noise, revealed, keysAlone: Boolean(keysWhy) }) : undefined
  const only = !pair.left ? names[1] : !pair.right ? names[0] : undefined
  const keyCount = (object?: KubeObject) =>
    Object.keys(((object as { data?: object } | undefined)?.data ?? {}) as object).length
  let state: ReactNode
  if (only) state = <span className="text-warn-text">Only on {only}</span>
  else if (!diff) state = null
  else if (keysWhy) {
    const more = keyCount(b) - keyCount(a)
    state = (
      <span className="text-ink-3">
        Keys only
        {more !== 0 && (
          <span className="font-medium text-good-text">
            {' '}
            · {more > 0 ? `+${more}` : more} key{Math.abs(more) === 1 ? '' : 's'}
          </span>
        )}
      </span>
    )
  } else if (diff.added + diff.removed === 0) {
    state = (
      <span className="flex items-center gap-1 text-ink-3">
        <Check className="size-3.5" /> The same
      </span>
    )
  } else {
    state = (
      <span className="font-medium">
        <span className="text-critical-text">−{diff.removed}</span>{' '}
        <span className="text-good-text">+{diff.added}</span>
      </span>
    )
  }
  const Icon = secret ? KeyRound : ScrollText
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        disabled={Boolean(only)}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown className="size-4 text-ink-3" />
        ) : (
          <ChevronRight className="size-4 text-ink-3" />
        )}
        <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-1">
            {pair.left ?? pair.right}
            {pair.left && pair.right && pair.left !== pair.right ? ` · ${pair.right}` : ''}
          </span>
          <span className="block truncate text-xs text-ink-3">
            {pair.kind} · {pair.said.join('; ')}
          </span>
        </span>
        <span className="shrink-0 text-xs">{state}</span>
      </button>
      {open && diff && (
        <div className="space-y-2 px-3 pb-3">
          {secret && !keysWhy && (
            <RevealRow
              revealed={revealed}
              onReveal={() => setRevealed(!revealed)}
              hidden={
                leftAccess.whyNot('secrets', 'values', namespaces[0]) ??
                rightAccess.whyNot('secrets', 'values', namespaces[1])
              }
            />
          )}
          {secret && keysWhy && <KeysOnlyLine where={keysWhy} />}
          <div className="overflow-hidden rounded-lg border border-line">
            <DiffView diff={diff} label={`Differences of ${pair.left ?? pair.right}`} />
          </div>
        </div>
      )}
    </div>
  )
}
