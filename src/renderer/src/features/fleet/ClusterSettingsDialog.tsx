/**
 * A fleet's cluster's settings, an admin's, from its card's ⋯: the name it's shown by, its labels,
 * and its groups (who sees it, besides admins). Each says where its value comes from: what the
 * cluster's source sets is locked, with where to change it; what the source leaves unset is set
 * here, and kept by Lumovi (never in the source).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil, ScrollText, Settings2, X } from 'lucide-react'
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  groupError,
  labelKeyError,
  labelValueError,
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
              labels: Object.fromEntries(
                labels.map((label) => [label.slice(0, label.indexOf('=')), labelValue(label)]),
              ),
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
          <span className="mr-auto flex items-center gap-1.5 text-xs text-ink-3">
            <ScrollText className="size-3.5" aria-hidden />
            Recorded in the audit log
          </span>
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
            check={(text) => {
              const at = text.indexOf('=')
              const key = at < 0 ? text : text.slice(0, at)
              return (
                labelKeyError(key) ??
                (at < 0 ? 'A label is key=value' : labelValueError(text.slice(at + 1)))
              )
            }}
            // A key once: the last value given for it.
            onChange={(values) =>
              setLabels(
                values.filter(
                  (value, i) => !values.slice(i + 1).some((later) => keyOf(later) === keyOf(value)),
                ),
              )
            }
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
              : groups.length
                ? 'Who sees it, besides admins. A change applies at once.'
                : 'Who sees it, besides admins: with none, everyone signed in. A change applies at once.'}
          </p>
        </div>
      </div>
      <ComesFrom origin={settings.origin} />
    </PageDialog>
  )
}

const keyOf = (label: string) => label.slice(0, label.indexOf('='))
const labelValue = (label: string) => label.slice(label.indexOf('=') + 1)

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

/**
 * Values as chips, each added as it's typed (Enter or a comma), checked first; removed with its
 * X, or Backspace in an empty field. Locked, they're only shown.
 */
function ChipsField({
  id,
  label,
  values,
  locked,
  placeholder,
  check,
  onChange,
  mono = false,
}: {
  id: string
  /** What each is, in words: "label". */
  label: string
  values: string[]
  locked: boolean
  placeholder: string
  check: (text: string) => string | undefined
  onChange: (values: string[]) => void
  mono?: boolean
}) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string>()
  const add = () => {
    const value = text.trim()
    if (!value) return
    const error = check(value)
    if (error) {
      setProblem(error)
      return
    }
    onChange([...values, value])
    setText('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',') && text.trim()) {
      // Enter adds it, not saves (with nothing typed, it saves).
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }
  return (
    <>
      <div
        className={cn(
          'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border px-1.5 py-1',
          locked
            ? 'border-line bg-surface-2'
            : problem
              ? 'border-critical bg-surface focus-within:ring-3 focus-within:ring-critical/15'
              : 'border-line-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        )}
      >
        {values.map((value) => (
          <span
            key={value}
            className={cn(
              'flex h-5 items-center gap-0.5 rounded-md text-2xs',
              mono && 'font-mono',
              locked
                ? 'border border-line bg-transparent px-1.5 text-ink-2'
                : 'bg-surface-3 pr-1 pl-1.5 text-ink-1',
            )}
          >
            {value}
            {!locked && (
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="grid place-items-center rounded text-ink-3 hover:text-ink-1"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {locked ? (
          values.length === 0 && <span className="px-1 text-xs text-ink-3">None</span>
        ) : (
          <input
            id={id}
            value={text}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Add a ${label}`}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(event) => {
              setText(event.target.value)
              setProblem(undefined)
            }}
            onKeyDown={onKeyDown}
            onBlur={add}
            className={cn(
              'h-5 min-w-28 flex-1 bg-transparent px-1 text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-xs placeholder:text-ink-3',
              mono && 'font-mono text-2xs',
            )}
          />
        )}
      </div>
      {problem && (
        <p role="alert" className="mt-1.5 text-xs text-critical-text">
          {problem}.
        </p>
      )}
    </>
  )
}

/** Where a cluster comes from, and what that means here. */
function ComesFrom({ origin }: { origin: ClusterOrigin }) {
  const tag = {
    secret:
      origin.kind === 'secret'
        ? { argocd: 'Argo CD', 'cluster-api': 'Cluster API', lumovi: 'Secret' }[origin.tool]
        : '',
    kubeconfig: 'Kubeconfig',
    this: 'This cluster',
    agent: 'Its agent',
  }[origin.kind]
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
