/**
 * A fleet's cluster's settings, an admin's, from its card's ⋯: the name it's shown by, its labels,
 * and its groups (who sees it, besides admins). Each says where its value comes from: what the
 * cluster's source sets is locked, with where to change it; what the source leaves unset is set
 * here, and kept by Lumovi (never in the source).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil, Settings2, Trash2, TriangleAlert } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import type { AgentTrust } from '@shared/api'
import {
  groupError,
  titleError,
  type ClusterOrigin,
  type FleetClusterSettings,
  type Managed,
} from '@shared/fleet'
import { Button } from '@renderer/components/Button'
import { ErrorState, Loading } from '@renderer/components/States'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { DialogIcon, PageDialog } from '../welcome/PageDialog'
import { ChipsField, labelError, labelMap, lastOfEachKey } from './ChipsField'
import { AuditNote, Box } from './ConnectDialog'

const field =
  'h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

/** Where a cluster comes from, in words. */
export function originText(origin: ClusterOrigin): string {
  switch (origin.kind) {
    case 'secret':
      return origin.tool === 'argocd'
        ? `Argo CD’s Secret ${origin.secret}`
        : origin.tool === 'cluster-api'
          ? `Cluster API’s Secret ${origin.secret}`
          : `the Secret ${origin.secret}`
    case 'kubeconfig':
      return origin.where === 'LUMOVI_FLEET_KUBECONFIG'
        ? `the fleet’s kubeconfig, context ${origin.context}`
        : `the kubeconfig ${origin.where}, context ${origin.context}`
    case 'this':
      return 'this cluster, where Lumovi runs'
    case 'agent':
      return origin.joined ? 'its agent, connected from this page' : 'its agent'
  }
}

/** A cluster's settings, read, then the form. */
export function ClusterSettingsDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const settings = useQuery({
    queryKey: ['fleet-settings', name],
    queryFn: () => api.fleet!.settings(name),
  })
  if (settings.data) return <SettingsForm settings={settings.data} onClose={onClose} />
  return (
    <PageDialog
      leading={
        <DialogIcon>
          <Settings2 />
        </DialogIcon>
      }
      title={name}
      top="top-[7vh]"
      onClose={onClose}
      footer={
        <Button variant="ghost" className="ml-auto" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {settings.isPending ? (
        <Loading label="Reading its settings…" className="py-10" />
      ) : (
        <ErrorState
          error={settings.error!}
          onRetry={() => void settings.refetch()}
          className="py-10"
        />
      )}
    </PageDialog>
  )
}

function SettingsForm({
  settings,
  onClose,
}: {
  settings: FleetClusterSettings
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(settings.title.value ?? '')
  const [labels, setLabels] = useState(
    Object.entries(settings.labels.value).map(([key, value]) => `${key}=${value}`),
  )
  // (A source's empty group, lumovi.dev/groups: "", is none.)
  const [groups, setGroups] = useState(settings.groups.value.filter(Boolean))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState(false)
  // A cluster joined from the page: what its certificate authority is trusted with.
  const agents = useQuery({
    queryKey: ['fleet-agents'],
    queryFn: () => api.fleet!.agents(),
    enabled: settings.origin.kind === 'agent',
  })
  const titleProblem = titleError(title.trim())
  const shown = settings.title.value ?? settings.name
  const save = async () => {
    if (pending || titleProblem) return
    setPending(true)
    setError(undefined)
    try {
      await api.fleet!.saveSettings(settings.name, {
        title: title.trim(),
        // What its source sets isn't the page's to send.
        ...(settings.labels.managed
          ? {}
          : {
              labels: labelMap(labels),
            }),
        ...(settings.groups.managed ? {} : { groups }),
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contexts'] }),
        queryClient.invalidateQueries({ queryKey: ['fleet-settings', settings.name] }),
      ])
      toast({ tone: 'success', title: `Saved ${title.trim() || settings.name}’s settings` })
      onClose()
    } catch (failed) {
      setError((failed as Error).message)
      setPending(false)
    }
  }
  // Removing takes its place, one dialog at a time; Cancel brings it back as it was left.
  if (removing) {
    return (
      <RemoveDialog
        name={settings.name}
        added={Boolean(settings.added)}
        onDone={(removed) => (removed ? onClose() : setRemoving(false))}
      />
    )
  }
  return (
    <PageDialog
      leading={
        <DialogIcon>
          <Settings2 />
        </DialogIcon>
      }
      title={shown}
      subtitle={`Comes from ${originText(settings.origin)}`}
      top="top-[7vh]"
      error={error}
      onSubmit={() => void save()}
      onClose={onClose}
      footer={
        <>
          {settings.removable ? (
            <Button
              variant="ghost"
              className="mr-auto text-critical-text hover:bg-critical/10 hover:text-critical-text"
              onClick={() => setRemoving(true)}
            >
              <Trash2 /> Remove from the fleet…
            </Button>
          ) : (
            <AuditNote />
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={pending || Boolean(titleProblem)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-3.5">
        <FieldLabel htmlFor="fleet-cluster-title">Name</FieldLabel>
        <div className="min-w-0">
          <input
            id="fleet-cluster-title"
            value={title}
            placeholder={settings.name}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(titleProblem) || undefined}
            aria-describedby="fleet-cluster-title-from"
            onChange={(event) => setTitle(event.target.value)}
            className={cn(field, titleProblem && 'border-critical focus:ring-critical/15')}
          />
          <From id="fleet-cluster-title-from" set={title.trim() !== ''} problem={titleProblem} />
        </div>
        <FieldLabel htmlFor="fleet-cluster-labels">Labels</FieldLabel>
        <div className="min-w-0">
          <ChipsField
            id="fleet-cluster-labels"
            label="label"
            values={labels}
            locked={Boolean(settings.labels.managed)}
            placeholder={labels.length ? 'Add a label…' : 'Add a label, as env=production…'}
            check={labelError}
            onChange={(values) => setLabels(lastOfEachKey(values))}
            mono
          />
          <From set={labels.length > 0} managed={settings.labels.managed} />
        </div>
        <FieldLabel htmlFor="fleet-cluster-groups">Groups</FieldLabel>
        <div className="min-w-0">
          <ChipsField
            id="fleet-cluster-groups"
            label="group"
            values={groups}
            locked={Boolean(settings.groups.managed)}
            placeholder="Add a group…"
            check={groupError}
            onChange={(values) => setGroups([...new Set(values)])}
          />
          <From set={groups.length > 0} managed={settings.groups.managed} />
          <p className="mt-1 text-xs text-ink-3">
            {settings.groups.managed && groups.length === 0
              ? 'Only admins see it: its source gives it no groups.'
              : settings.adminsOnly && groups.length === 0
                ? 'Only admins see it: what this page set was for another cluster by its name. Save to say who sees it.'
                : groups.length
                  ? 'Who sees it, besides admins. A change applies at once.'
                  : 'Who sees it, besides admins: with none, everyone signed in. A change applies at once.'}
          </p>
        </div>
      </div>
      <ComesFrom
        origin={settings.origin}
        added={settings.added}
        trust={agents.data?.find((agent) => agent.name === settings.name)}
      />
    </PageDialog>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="self-start pt-2 text-xs font-medium text-ink-2">
      {children}
    </label>
  )
}

/**
 * Where a field's value comes from: its cluster's source, which manages it; or this page, once
 * it's set (an empty one says nothing: its placeholder and help do).
 */
function From({
  id,
  set,
  managed,
  problem,
}: {
  id?: string
  set: boolean
  managed?: Managed
  problem?: string
}) {
  if (problem) {
    return (
      <p id={id} className="mt-1.5 text-xs text-critical-text">
        {problem}.
      </p>
    )
  }
  if (managed) {
    return (
      <p id={id} className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-2">
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          Set by {managed.by}, in{' '}
          {managed.in.map(({ key, context }, i) => (
            <Fragment key={key + (context ?? '')}>
              {i > 0 && ' and '}
              {context === undefined ? (
                <span className="font-mono">{key}</span>
              ) : (
                <>
                  the <span className="font-mono">{key}</span> extension of context {context}
                </>
              )}
            </Fragment>
          ))}
          . Change it there.
        </span>
      </p>
    )
  }
  return set ? (
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-3">
      <Pencil className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>Set on this page.</span>
    </p>
  ) : null
}

/** Where a cluster comes from, and what that means here. */
function ComesFrom({
  origin,
  added,
  trust,
}: {
  origin: ClusterOrigin
  /** Added from the page by kubeconfig or token: when, and by whom. */
  added?: { at: string; by: string }
  trust?: AgentTrust
}) {
  const tag = {
    secret:
      origin.kind === 'secret'
        ? { argocd: 'Argo CD', 'cluster-api': 'Cluster API', lumovi: 'Secret' }[origin.tool]
        : '',
    kubeconfig: 'Kubeconfig',
    this: 'This cluster',
    agent: 'Its agent',
  }[origin.kind]
  if (origin.kind === 'secret' && added) {
    return (
      <section className="mt-5 rounded-xl bg-surface-3/70 px-3.5 py-3">
        <div className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-2xs font-medium tracking-wider text-ink-3 uppercase">Comes from</h3>
          <span className="ml-auto truncate text-xs font-medium text-ink-2">This page</span>
        </div>
        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">Added</dt>
          <dd className="text-ink-1">
            {new Date(added.at).toLocaleString(undefined, {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
            , by {added.by}
          </dd>
          <dt className="text-ink-3">Kept as</dt>
          <dd className="truncate text-ink-1">
            the Secret{' '}
            <span className="font-mono">
              {origin.namespace}/{origin.secret}
            </span>
          </dd>
        </dl>
      </section>
    )
  }
  if (origin.kind === 'agent' && origin.joined) {
    return (
      <section className="mt-5 rounded-xl bg-surface-3/70 px-3.5 py-3">
        <div className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-2xs font-medium tracking-wider text-ink-3 uppercase">Comes from</h3>
          <span className="ml-auto truncate text-xs font-medium text-ink-2">{tag}</span>
        </div>
        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">Connected</dt>
          <dd className="text-ink-1">
            from this page,{' '}
            {new Date(origin.joined.at).toLocaleString(undefined, {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </dd>
          <dt className="text-ink-3">Certificate</dt>
          <dd className="truncate text-ink-1">
            {!trust?.trusted.length
              ? 'Not yet sent'
              : `SHA-256 ${trust.unconfirmed ? 'not checked yet' : 'checked'} · `}
            {trust?.trusted.length ? (
              <span className="font-mono">{trust.trusted.join(', ')}</span>
            ) : null}
          </dd>
        </dl>
      </section>
    )
  }
  const where =
    origin.kind === 'secret' ? (
      <>
        {originText(origin).replace(/^t/, 'T')}, in the{' '}
        <span className="font-mono">{origin.namespace}</span> namespace.
      </>
    ) : origin.kind === 'kubeconfig' ? (
      <>{originText(origin).replace(/^t/, 'T')}.</>
    ) : origin.kind === 'this' ? (
      <>The cluster Lumovi runs in, reached with its own service account.</>
    ) : (
      <>An agent the server’s settings name (LUMOVI_FLEET_AGENTS), which dials this server.</>
    )
  return (
    <section className="mt-5 rounded-xl bg-surface-3/70 px-3.5 py-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-2xs font-medium tracking-wider text-ink-3 uppercase">Comes from</h3>
        <span className="ml-auto truncate text-xs font-medium text-ink-2">{tag}</span>
      </div>
      <p className="text-xs leading-relaxed text-ink-2">
        {where} What it sets is shown, not changed, here; it can’t be removed from this page.
      </p>
    </section>
  )
}

/** Where a cluster's agent was installed, from the Fleet page's command: to uninstall it. */
const UNINSTALL_COMMAND = 'helm uninstall lumovi --namespace lumovi'

/**
 * Removing a cluster connected from the page, typed to confirm: what stops, and how to uninstall
 * its agent, which keeps running in the cluster until then.
 */
export function RemoveDialog({
  name,
  added = false,
  onDone,
}: {
  name: string
  /** Added by kubeconfig or token: its Secret goes (connected, its agent's token stops). */
  added?: boolean
  onDone: (removed: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const remove = async () => {
    if (typed !== name || pending) return
    setPending(true)
    setError(undefined)
    try {
      await api.fleet!.remove(name)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['contexts'] }),
        queryClient.invalidateQueries({ queryKey: ['fleet-joins'] }),
      ])
      toast({ tone: 'success', title: `Removed ${name} from the fleet` })
      onDone(true)
    } catch (failed) {
      setError((failed as Error).message)
      setPending(false)
    }
  }
  return (
    <PageDialog
      leading={
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-critical/10 text-critical-text [&_svg]:size-[18px]">
          <Trash2 />
        </div>
      }
      title={`Remove ${name}?`}
      subtitle={
        <>
          From the fleet · <span className="font-medium text-ink-2">{name}</span>
        </>
      }
      error={error}
      onSubmit={() => void remove()}
      onClose={() => onDone(false)}
      footer={
        <>
          <AuditNote />
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={typed !== name || pending}>
            Remove
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {added ? (
          <p className="text-[13px] leading-relaxed text-ink-2">
            People stop seeing it, and Lumovi deletes the Secret it kept it as, with its
            credentials. The cluster itself isn’t changed.
          </p>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-ink-2">
              People stop seeing it, and its agent’s token stops working at once. The agent keeps
              running in the cluster until you uninstall it there:
            </p>
            <Box label={`In ${name}`} copy={UNINSTALL_COMMAND} copyLabel="Copy the command">
              <code className="block font-mono text-xs text-ink-2 selectable">
                {UNINSTALL_COMMAND}
              </code>
            </Box>
          </>
        )}
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-2">
            <TriangleAlert className="size-3.5 text-critical-text" aria-hidden />
            Type <span className="font-mono font-medium text-ink-1 select-all">{name}</span> to
            confirm
          </span>
          <input
            data-autofocus
            aria-label={`Type ${name} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[13px] text-ink-1 outline-none focus:border-critical focus:ring-3 focus:ring-critical/15"
          />
        </label>
      </div>
    </PageDialog>
  )
}
