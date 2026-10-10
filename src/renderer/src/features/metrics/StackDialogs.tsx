import { ArrowLeft, PackagePlus, Trash2, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HelmDeployed, MetricsStack } from '@shared/api'
import { metricsStackChartArgs } from '@shared/metrics-stack'
import { Button } from '@renderer/components/Button'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { useHelmChange } from '@renderer/hooks/helm'
import { useResetSource } from '@renderer/hooks/history'
import { api } from '@renderer/lib/api'
import { manifestObjects } from '@renderer/lib/helm'
import { helm, kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { ActionDialog, useSubmit } from '../actions/ActionDialog'

/** "namespaces, cluster roles and secrets". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** Why it can't be installed (or removed) here, if it can't: said before anyone tries. */
function whyNot(stack: MetricsStack, doing: 'create' | 'delete'): string | undefined {
  if (stack.off) return stack.off.message
  if (stack.state === 'taken' && doing === 'create') {
    return `This cluster has a namespace named ${stack.namespace} that Lumovi didn’t make, so it installs nothing there.`
  }
  const missing = doing === 'create' ? stack.missing.install : stack.missing.remove
  if (missing.length) {
    return `The cluster doesn’t let you ${doing} ${listed(missing)}, which ${doing === 'create' ? 'installing' : 'removing'} it takes. Ask someone who administers the cluster.`
  }
  return undefined
}

/** After it's installed or removed: its status, and where history comes from, are read again. */
function useStackChanged() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  const reset = useResetSource()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['metrics-stack', context] })
    await reset()
  }
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-2">{title}</h3>
      <div className="mt-1 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </div>
  )
}

const code = 'font-mono text-xs break-all text-ink-1 selectable'

/**
 * Installs Lumovi's metrics stack: what it is and what it will run, then a dry run on the API
 * server that shows every object it makes before anything is made.
 */
export function InstallStackDialog({
  stack,
  onClose,
}: {
  stack: MetricsStack
  onClose: () => void
}) {
  const { context } = useCluster()
  const change = useHelmChange()
  const changed = useStackChanged()
  const [reviewed, setReviewed] = useState<HelmDeployed>()
  const [problem, setProblem] = useState<string>()
  const [checking, setChecking] = useState(false)
  const { pending, error, submit } = useSubmit(onClose)
  const { namespace, release, chart } = stack
  const command = helm(context, namespace, 'install', release, ...metricsStackChartArgs)
  const notAllowed = whyNot(stack, 'create')

  const review = async () => {
    setChecking(true)
    setProblem(undefined)
    const result = await api.metricsStack.install({ context, dryRun: true })
    setChecking(false)
    if (result.ok) setReviewed(result.data)
    else setProblem(result.error.message)
  }
  const apply = () =>
    submit(async () => {
      const result = await change(() => api.metricsStack.install({ context }), {
        title: 'Installed the metrics stack',
        command,
      })
      if (result.ok) await changed()
      return result
    })

  const diff = reviewed && unifiedDiff('', reviewed.manifest)
  const objects = reviewed ? manifestObjects(reviewed.manifest) : []
  return (
    <ActionDialog
      icon={PackagePlus}
      title="Install a metrics stack"
      subject={`Helm · ${namespace}`}
      command={command}
      confirmLabel={reviewed ? 'Install' : 'Review'}
      wide
      ready={!notAllowed && !checking}
      pending={pending || checking}
      error={error ?? problem ?? notAllowed}
      onClose={onClose}
      onSubmit={() => void (reviewed ? apply() : review())}
    >
      {reviewed ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setReviewed(undefined)}
            >
              <ArrowLeft /> Back
            </Button>
            <span className="text-xs text-ink-2">
              The cluster accepts it · {objects.length} objects ·{' '}
              <span className="font-medium text-good-text tabular-nums">+{diff!.added}</span> lines
              of manifest
            </span>
          </div>
          <div className="flex max-h-[45vh] min-h-0 flex-col overflow-hidden rounded-lg border border-line">
            <DiffView diff={diff!} label="What it makes" />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-2">
            {context} has no Prometheus, so Lumovi has no usage history to chart. This installs a
            small one that collects only what Lumovi reads: CPU, memory and network use, and
            restarts. Nothing is made until you’ve reviewed it.
          </p>
          {stack.large && (
            <p className="flex gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-text" />
              <span>
                This is sized for small clusters, and {context} has{' '}
                {stack.large.nodes.toLocaleString('en')} nodes and{' '}
                {stack.large.pods.toLocaleString('en')} pods. Its Prometheus may run out of the 1
                GiB of memory it’s limited to and restart, and its 4 GiB of storage may hold less
                than a week. A cluster this size is better served by a Prometheus set up for it.
              </span>
            </p>
          )}
          <Part title="What runs in the cluster">
            <ul className="list-disc space-y-1 pl-4">
              <li>
                Two Deployments in a new namespace, {namespace}: Prometheus {chart.appVersion} and
                kube-state-metrics, one pod each, running as an unprivileged user.
              </li>
              <li>
                Two read-only cluster roles: Prometheus reads the nodes and their kubelets’ metrics;
                kube-state-metrics lists pods. Neither can read Secrets or ConfigMaps, or change
                anything.
              </li>
              <li>
                Two services inside the cluster. Nothing is exposed outside it: Lumovi asks
                Prometheus through the API server, as you. Inside it, Prometheus asks nobody who
                they are, as usual: any pod can read the usage it keeps, with every namespace’s pod,
                container and node names.
              </li>
              <li>
                Prometheus asks for 0.1 CPU and 256 MiB of memory, and is limited to 1 CPU and 1
                GiB.
              </li>
            </ul>
          </Part>
          <Part title="History">
            Kept for 7 days, in up to 4 GiB on the disk of the node Prometheus runs on. There’s no
            volume, so history starts over if its pod is replaced or moves to another node. Charts
            fill in a minute or two after it starts.
          </Part>
          <Part title="Removing it">
            From the metrics source’s settings, any time: Lumovi uninstalls the release and deletes{' '}
            {namespace}, and nothing of it stays in the cluster.
          </Part>
          <Part title="The chart">
            <p>
              {chart.name} {chart.version}, from <span className={code}>{chart.repository}</span>.
              Lumovi ships it and checks it before using it (SHA-256{' '}
              <span className={code}>{chart.sha256}</span>), so it downloads nothing. The cluster
              pulls the images, each by its digest:
            </p>
            <ul aria-label="Images" className="mt-1 space-y-0.5">
              {stack.images.map((image) => (
                <li key={image} className={code}>
                  {image}
                </li>
              ))}
            </ul>
          </Part>
          <details className="group rounded-lg border border-line">
            <summary className="cursor-default px-3 py-2 text-xs font-medium text-ink-2 select-none hover:text-ink-1">
              The values it’s installed with
            </summary>
            <pre
              aria-label="Values"
              className="max-h-64 overflow-auto border-t border-line bg-surface-3/40 px-3 py-2 font-mono text-xs text-ink-2 selectable"
            >
              {stack.values}
            </pre>
          </details>
        </div>
      )}
    </ActionDialog>
  )
}

/** Removes Lumovi's metrics stack: its release, and the namespace made for it. */
export function RemoveStackDialog({
  stack,
  onClose,
}: {
  stack: MetricsStack
  onClose: (removed: boolean) => void
}) {
  const { context } = useCluster()
  const change = useHelmChange()
  const changed = useStackChanged()
  const { pending, error, submit } = useSubmit(() => onClose(true))
  const { namespace, release } = stack
  const command = `${helm(context, namespace, 'uninstall', release)} && ${kubectl(context, undefined, 'delete', 'namespace', namespace)}`
  const notAllowed = whyNot(stack, 'delete')
  return (
    <ActionDialog
      icon={Trash2}
      tone="danger"
      title="Remove the metrics stack?"
      subject={`Helm release · ${namespace}`}
      command={command}
      confirmLabel="Remove"
      typeToConfirm={namespace}
      ready={!notAllowed}
      pending={pending}
      error={error ?? notAllowed}
      onClose={() => onClose(false)}
      onSubmit={() =>
        void submit(async () => {
          const result = await change(() => api.metricsStack.uninstall({ context }), {
            title: 'Removed the metrics stack',
            command,
          })
          if (result.ok) await changed()
          return result
        })
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        Uninstalls {release}, which Lumovi installed, and deletes the namespace {namespace} with
        everything in it: Prometheus, kube-state-metrics, their cluster roles, the usage history
        collected so far, and anything else put in {namespace} since. Nothing of it stays in{' '}
        {context}.
      </p>
      <p className="text-[13px] leading-relaxed text-ink-2">
        The Metrics page, each object’s charts and right-sizing go back to having no history.
      </p>
    </ActionDialog>
  )
}
