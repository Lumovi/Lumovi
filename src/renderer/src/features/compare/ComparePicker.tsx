import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GitCompareArrows, Info, Lock, Search } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { KubeContext } from '@shared/api'
import { builtinResource } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { StatusDot } from '@renderer/components/Status'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { resourceFor } from '@renderer/hooks/resources'
import { useClusterName, useProduction } from '@renderer/hooks/settings'
import { api, unwrap, type KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { focusBack, useOpener } from '@renderer/lib/focus-back'
import { comparePath, formatRef } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { kindOf, type ActionProps } from '../actions/common'

/** How long a pick stays put before what it names is read: arrowing past reads nothing. */
export const SETTLE_MS = 300

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms = SETTLE_MS): T | undefined {
  const [settled, setSettled] = useState<T | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(() => value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled === value ? value : undefined
}

/** Why a cluster that was asked couldn't be read, on its line. */
function failedLine(error: KubeApiError, name: string): string {
  if (error.code === 'unauthorized' || error.code === 'auth') {
    return `Refused: your credentials for ${name} were rejected.`
  }
  if (error.code === 'forbidden') return `Refused: ${name} doesn’t let you in.`
  return 'Didn’t answer in time. Pick it again to try once more.'
}

const PRODUCTION =
  'shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase'

/** A cluster's own Production mark, where it is one. */
function ProductionMark({ context }: { context: string }) {
  return useProduction(context) ? <span className={PRODUCTION}>Production</span> : null
}

/** What the list of objects says instead, and why. */
function Said({ icon: Icon = Info, children }: { icon?: typeof Info; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-ink-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/**
 * Compare with…: another object of the same kind, in a namespace or a cluster the person has.
 * Read-only throughout. A cluster that signs in through a program is listed unread, and opens on
 * its own button only; any pick is read only once it has stayed put (`SETTLE_MS`), and a cluster
 * that doesn't answer says so on its line without holding the dialog up.
 */
export function ComparePicker({ object, onClose }: ActionProps) {
  const { context: here } = useCluster()
  const navigate = useNavigate()
  const opener = useOpener()
  const client = useQueryClient()
  const kind = kindOf(object)
  const definition = resourceFor(kind)
  const label = definition?.label ?? kind
  const singular = definition?.apiKind ?? object.kind ?? kind
  const own = object.metadata
  const nameOf = useClusterName()
  const contexts = useContexts().data?.contexts
  // This one first, then every other, as the kubeconfig (or the fleet) has them.
  const listed = useMemo(
    () => [
      ...(contexts ?? []).filter((c) => c.name === here),
      ...(contexts ?? []).filter((c) => c.name !== here),
    ],
    [contexts, here],
  )
  const [cluster, setCluster] = useState(here)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [chosenNamespace, setNamespace] = useState<string | undefined>(own.namespace)
  const [chosen, setChosen] = useState<string | undefined>()
  const [filter, setFilter] = useState('')

  const context = listed.find((c) => c.name === cluster)
  /** Whether a cluster may be read: no sign-in to start, or it's started (or opened here). */
  const asked = (c: KubeContext | undefined) =>
    c !== undefined &&
    (c.name === here || !c.signsInWith || c.signedIn === true || opened.has(c.name))
  const settledCluster = useSettled(cluster)
  const reading = settledCluster === cluster && asked(context)
  const version = useVersion(cluster, false, reading)
  const answered = reading && version.isSuccess
  // A read of a cluster no longer picked is let go.
  useEffect(
    () => () => void client.cancelQueries({ queryKey: ['version', cluster], exact: true }),
    [client, cluster],
  )

  const served = useQuery({
    queryKey: ['resources', cluster],
    queryFn: () => unwrap(api.kube.resources(cluster)),
    enabled: answered && !builtinResource(kind),
    staleTime: 60_000,
  })
  const there = builtinResource(kind) ?? served.data?.find((r) => r.kind === kind)
  const namespaced = there?.namespaced ?? Boolean(own.namespace)
  const namespaces = useQuery({
    queryKey: ['compare-namespaces', cluster],
    queryFn: async () =>
      (await unwrap(api.kube.list({ context: cluster, kind: 'Namespace' }))).items
        .map((ns) => ns.metadata.name)
        .sort(),
    enabled: answered && Boolean(there) && namespaced,
  })
  // Its own namespace where the cluster has it, else the first.
  const namespace = !namespaced
    ? undefined
    : namespaces.data?.includes(chosenNamespace ?? '')
      ? chosenNamespace
      : namespaces.data?.[0]
  const settledNamespace = useSettled(namespace)
  const objects = useQuery({
    queryKey: ['compare-objects', cluster, kind, namespace ?? null],
    queryFn: async () =>
      (await unwrap(api.kube.list({ context: cluster, kind, namespace }))).items
        .map((item) => item.metadata.name)
        .filter((name) => !(cluster === here && namespace === own.namespace && name === own.name))
        .sort(),
    enabled:
      answered &&
      Boolean(there) &&
      (!namespaced || (namespace !== undefined && settledNamespace === namespace)),
  })
  // The same-named one, where there is one, until another is picked.
  const sameName = objects.data?.includes(own.name) ? own.name : undefined
  const picked = chosen !== undefined && objects.data?.includes(chosen) ? chosen : sameName
  const shown = (objects.data ?? []).filter((name) =>
    name.toLowerCase().includes(filter.trim().toLowerCase()),
  )

  const pick = (name: string) => {
    // Picked again where it failed: tried once more.
    if (name === cluster && version.isError) void version.refetch()
    setCluster(name)
    setChosen(undefined)
  }
  const compare = () => {
    if (!picked) return
    onClose()
    void navigate(
      comparePath(
        here,
        { context: here, ref: formatRef({ kind, name: own.name, namespace: own.namespace }) },
        { context: cluster, ref: formatRef({ kind, name: picked, namespace }) },
      ),
    )
  }

  const where = nameOf(cluster)
  const failed = reading && version.isError ? (version.error as KubeApiError) : undefined
  let list: ReactNode
  if (!asked(context)) {
    list = (
      <Said>
        {where} isn’t open. Open it, with the button on its row, to see its namespaces and {label}.
      </Said>
    )
  } else if (failed) {
    list = (
      <Said>
        {failed.code === 'unauthorized' || failed.code === 'auth' || failed.code === 'forbidden'
          ? `${where} refused`
          : `${where} didn’t answer in time`}
        , so there’s nothing to pick there yet. Pick another cluster, or {where} again.
      </Said>
    )
  } else if (answered && !builtinResource(kind) && served.isSuccess && !there) {
    const group = definition
      ? `${definition.group ? `${definition.group}/` : ''}${definition.version}`
      : ''
    list = (
      <Said>
        {where} doesn’t serve {label}
        {group ? ` (${group})` : ''}, so there’s nothing to compare with there.
      </Said>
    )
  } else if (objects.isError || namespaces.isError) {
    const error = (objects.error ?? namespaces.error) as KubeApiError
    list =
      error.code === 'forbidden' ? (
        <Said icon={Lock}>
          Your access on {where} doesn’t list {label}
          {namespace ? ` in ${namespace}` : ''}.
        </Said>
      ) : (
        <Said>{error.message}</Said>
      )
  } else if (objects.isSuccess && objects.data.length === 0) {
    list = (
      <Said>
        {namespace
          ? `No ${label} in ${namespace} on ${where}. Pick another namespace, or another cluster.`
          : `No ${label} on ${where}. Pick another cluster.`}
      </Said>
    )
  } else if (objects.isSuccess) {
    list = (
      <>
        <label className="relative block">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${label.toLowerCase()}`}
            aria-label={`Filter ${label.toLowerCase()}`}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-lg border border-line-strong bg-surface pr-3 pl-8 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
          />
        </label>
        <div
          role="radiogroup"
          aria-label={singular}
          className="max-h-56 overflow-y-auto rounded-lg border border-line"
        >
          {shown.map((name) => (
            <label
              key={name}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0',
                name === picked && 'bg-accent-soft',
              )}
            >
              <input
                type="radio"
                name="compare-object"
                checked={name === picked}
                onChange={() => setChosen(name)}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-1">
                {name}
              </span>
              {name === sameName && <span className="shrink-0 text-xs text-ink-3">Same name</span>}
            </label>
          ))}
        </div>
      </>
    )
  } else {
    list = <div className="h-24 animate-shimmer rounded-lg bg-surface-3" aria-label="Reading" />
  }

  return finish(list)

  /** The dialog round what the list says. */
  function finish(said: ReactNode) {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
          <Dialog.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              focusBack(opener)
            }}
            className="fixed top-[10vh] left-1/2 z-50 flex max-h-[80vh] w-[480px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
          >
            <header className="flex items-start gap-3 px-5 pt-5 pb-1">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2">
                <GitCompareArrows className="size-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-[15px] leading-snug font-semibold text-ink-1">
                  Compare {own.name} with…
                </Dialog.Title>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                  <span className="truncate">
                    {singular}
                    {own.namespace ? ` · ${own.namespace}` : ''} ·{' '}
                    <span className="font-medium text-ink-2">{nameOf(here)}</span>
                  </span>
                  <ProductionMark context={here} />
                </p>
              </div>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-4 pb-5">
              <section>
                <h3 className="mb-1.5 text-xs font-medium text-ink-2">Cluster</h3>
                <div
                  role="radiogroup"
                  aria-label="Cluster"
                  className="rounded-lg border border-line"
                >
                  {listed.map((c) => (
                    <ClusterRow
                      key={c.name}
                      context={c}
                      here={c.name === here}
                      picked={c.name === cluster}
                      asked={asked(c)}
                      failed={c.name === cluster ? failed : undefined}
                      name={nameOf(c.name)}
                      onPick={() => pick(c.name)}
                      onOpen={() => {
                        setOpened(new Set([...opened, c.name]))
                        pick(c.name)
                      }}
                    />
                  ))}
                </div>
              </section>
              {namespaced && (
                <section>
                  <h3 className="mb-1.5 text-xs font-medium text-ink-2">Namespace</h3>
                  <select
                    aria-label="Namespace"
                    value={namespace ?? ''}
                    disabled={!namespaces.data}
                    onChange={(event) => {
                      setNamespace(event.target.value)
                      setChosen(undefined)
                    }}
                    className="h-8 w-48 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink-1 disabled:text-ink-3"
                  >
                    {namespaces.data ? (
                      namespaces.data.map((ns) => (
                        <option key={ns} value={ns}>
                          {ns}
                        </option>
                      ))
                    ) : (
                      <option value="">—</option>
                    )}
                  </select>
                </section>
              )}
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-ink-2">{singular}</h3>
                {said}
              </section>
            </div>
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <Dialog.Close asChild>
                <Button variant="ghost" data-cancel>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button variant="primary" disabled={!picked} onClick={compare}>
                Compare
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
}

/** A cluster to pick: read only where it may be, its Open button where it signs in. */
function ClusterRow({
  context,
  here,
  picked,
  asked,
  failed,
  name,
  onPick,
  onOpen,
}: {
  context: KubeContext
  here: boolean
  picked: boolean
  asked: boolean
  failed?: KubeApiError
  name: string
  onPick: () => void
  onOpen: () => void
}) {
  // (Its dot from what's known of it: never read for the dot alone, where it signs in.)
  const version = useVersion(context.name, false, false)
  const health = failed ? 'critical' : version.isSuccess && asked ? 'healthy' : 'neutral'
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0',
        picked && 'bg-accent-soft',
      )}
    >
      <input type="radio" name="compare-cluster" checked={picked} onChange={onPick} />
      <StatusDot health={health} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink-1">{name}</span>
          <ProductionMark context={context.name} />
        </span>
        {!asked && <span className="block text-xs text-ink-3">Signs in when opened</span>}
        {failed && (
          <span className="block text-xs text-critical-text">{failedLine(failed, name)}</span>
        )}
      </span>
      {here && <span className="shrink-0 text-xs text-ink-3">This one</span>}
      {!asked && (
        <Button
          variant="secondary"
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={(event) => {
            event.preventDefault()
            onOpen()
          }}
        >
          Open {name}
        </Button>
      )}
    </label>
  )
}
