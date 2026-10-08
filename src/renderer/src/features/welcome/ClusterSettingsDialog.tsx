/**
 * A cluster's settings, from the clusters page (⌘I, or Settings… in its actions): how it shows
 * in Lumovi (its name, color, group and labels), the namespace it opens in, whether it's
 * production, read-only or hidden, and where it comes from. Kept in Lumovi's settings, never in
 * the kubeconfig; applied on Save.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  FolderOpen,
  Lock,
  Minus,
  Pencil,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { managedReadOnly, type KubeconfigFiles } from '@shared/api'
import { CLUSTER_COLORS, parseLabel, type ClusterSettings } from '@shared/cluster-settings'
import { Button } from '@renderer/components/Button'
import { Switch } from '@renderer/components/Switch'
import { useSettings } from '@renderer/hooks/settings'
import { api, unwrap } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { hostOf } from '@renderer/lib/format'
import { looksLikeProduction } from '@renderer/lib/production'
import { usePrefs } from '@renderer/state/prefs'
import type { Cluster } from './ClusterPicker'
import { initials, REVEAL, tilde } from './clusters'
import { ClusterTile } from './ClusterTile'
import { PageDialog } from './PageDialog'

/** The data colors' names, for those who don't see them. */
export const COLOR_NAMES = ['Blue', 'Orange', 'Teal', 'Amber', 'Pink', 'Green', 'Indigo', 'Red']

const field =
  'h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft'

export function ClusterSettingsDialog({
  cluster,
  groups,
  files,
  onEditConnection,
  onCopyForKubectl,
  onRemove,
  onClose,
}: {
  cluster: Cluster
  /** The groups clusters are in, to choose from. */
  groups: string[]
  files?: KubeconfigFiles
  onEditConnection: () => void
  onCopyForKubectl: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { context } = cluster
  const settings = useSettings().data
  const queryClient = useQueryClient()
  const forgetNamespace = usePrefs((prefs) => prefs.forgetNamespace)
  const stored: ClusterSettings = settings?.clusters?.[context.name] ?? {}
  const readOnlyByPolicy =
    !!settings?.readOnlyAll || managedReadOnly(settings?.managed, context.name)

  const [name, setName] = useState(stored.name ?? '')
  const [color, setColor] = useState(stored.color)
  const [group, setGroup] = useState(stored.group ?? '')
  const [labels, setLabels] = useState<[string, string][]>(Object.entries(stored.labels ?? {}))
  const [namespace, setNamespace] = useState(stored.namespace ?? '')
  // Set by hand, or else as the name suggests (and kept unset, unless changed).
  const [production, setProduction] = useState(stored.production)
  const [readOnly, setReadOnly] = useState(!!settings?.readOnly?.includes(context.name))
  const [hidden, setHidden] = useState(!!stored.hidden)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const namespaces = useQuery({
    queryKey: ['cluster-namespaces', context.name],
    queryFn: async () =>
      (await unwrap(api.kube.list({ context: context.name, kind: 'Namespace' }))).items.map(
        (item) => item.metadata.name,
      ),
    retry: false,
  })

  const save = async () => {
    setSaving(true)
    setError(undefined)
    const next: ClusterSettings = {
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(color ? { color } : {}),
      ...(group.trim() ? { group: group.trim() } : {}),
      ...(labels.length > 0 ? { labels: Object.fromEntries(labels) } : {}),
      ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
      ...(production !== undefined ? { production } : {}),
      ...(hidden ? { hidden } : {}),
    }
    const result = await api.app.setCluster!(context.name, next)
    if (!result.ok) {
      setSaving(false)
      setError(result.error.message)
      return
    }
    let updated = result.data
    if (!readOnlyByPolicy && readOnly !== !!settings?.readOnly?.includes(context.name)) {
      updated = await api.app.setReadOnly(context.name, readOnly)
    }
    queryClient.setQueryData(['settings'], updated)
    // Opened in the namespace set, from now on: not the one it was last left in.
    if ((stored.namespace ?? '') !== namespace.trim()) forgetNamespace(context.name)
    onClose()
  }

  const file = files?.files.find((entry) => entry.path === context.file)
  return (
    <PageDialog
      top="top-[7vh]"
      leading={
        <ClusterTile
          letters={initials(context.name, name.trim() || undefined)}
          color={color}
          large
        />
      }
      title={name.trim() || context.name}
      subtitle={<span className="font-mono">{context.name}</span>}
      error={error}
      onSubmit={() => void save()}
      onClose={onClose}
      footer={
        <>
          {cluster.own && (
            <Button
              variant="ghost"
              className="-ml-2 text-critical-text hover:bg-critical/8 hover:text-critical-text"
              onClick={onRemove}
            >
              <Trash2 /> Remove from Lumovi
            </Button>
          )}
          <span className="ml-auto" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            aria-disabled={saving || undefined}
            className="min-w-20 aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[128px_1fr] items-center gap-x-4 gap-y-3">
        <Label htmlFor="cluster-name">Name</Label>
        <input
          id="cluster-name"
          data-autofocus
          value={name}
          placeholder={context.name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className={field}
        />

        <Label>Color</Label>
        <Swatches color={color} onChange={setColor} />

        <Label htmlFor="cluster-group">Group</Label>
        <Combo
          id="cluster-group"
          value={group}
          onChange={setGroup}
          options={groups}
          placeholder="None"
          maxLength={60}
        />

        <Label htmlFor="cluster-labels">Labels</Label>
        <LabelsField labels={labels} onChange={setLabels} />

        <Label htmlFor="cluster-namespace">Namespace</Label>
        <Combo
          id="cluster-namespace"
          value={namespace}
          onChange={setNamespace}
          options={namespaces.data ?? []}
          placeholder={context.namespace ?? 'All namespaces'}
          mono={false}
          maxLength={63}
        />
      </div>

      <div className="my-4 border-t border-line" />

      <div className="space-y-3.5">
        <Toggle
          title="Production"
          line="Deleting and draining ask you to type its name, and its rows say Production."
          checked={production ?? looksLikeProduction(context.name)}
          onChange={setProduction}
        />
        <Toggle
          title="Read-only"
          line="Lumovi changes nothing in it."
          checked={readOnlyByPolicy || readOnly}
          onChange={setReadOnly}
          locked={readOnlyByPolicy}
        />
        <Toggle
          title="Hidden"
          line="Left out of the list. Show hidden clusters from its footer."
          checked={hidden}
          onChange={setHidden}
        />
      </div>

      <Connection
        cluster={cluster}
        files={files}
        addedAt={file?.addedAt}
        onEditConnection={onEditConnection}
        onCopyForKubectl={onCopyForKubectl}
      />
    </PageDialog>
  )
}

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
      {children}
    </label>
  )
}

/** One of the eight data colors, or none. */
export function Swatches({
  color,
  onChange,
}: {
  color?: number
  onChange: (color: number | undefined) => void
}) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex items-center gap-2">
      <button
        type="button"
        role="radio"
        aria-checked={color === undefined}
        aria-label="No color"
        onClick={() => onChange(undefined)}
        className={cn(
          'grid size-[22px] place-items-center rounded-full bg-surface text-ink-3 ring-1 ring-line-strong ring-inset',
          color === undefined && 'ring-2 ring-ink-3 ring-offset-2 ring-offset-surface-2',
        )}
      >
        <Minus className="size-3" />
      </button>
      {Array.from({ length: CLUSTER_COLORS }, (_, index) => index + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={color === n}
          aria-label={COLOR_NAMES[n - 1]}
          onClick={() => onChange(n)}
          className={cn(
            'grid size-[22px] place-items-center rounded-full text-white',
            color === n && 'ring-2 ring-offset-2 ring-offset-surface-2',
          )}
          style={{
            background: `var(--series-${n})`,
            ['--tw-ring-color' as string]: `var(--series-${n})`,
          }}
        >
          {color === n && <Check className="size-3" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}

/** A text field with choices to pick from (groups, namespaces), any text allowed. */
export function Combo({
  id,
  value,
  onChange,
  options,
  placeholder,
  maxLength,
  mono = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder: string
  maxLength: number
  mono?: boolean
}) {
  return (
    <span className="relative">
      <input
        id={id}
        list={`${id}-options`}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        // Its own chevron, not the browser's arrow for the choices.
        className={cn(
          field,
          'pr-8 [&::-webkit-calendar-picker-indicator]:hidden',
          mono && 'font-mono',
        )}
      />
      <datalist id={`${id}-options`}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
    </span>
  )
}

/** Labels as `key=value` chips; a new one typed, then Enter (or a comma). */
function LabelsField({
  labels,
  onChange,
}: {
  labels: [string, string][]
  onChange: (labels: [string, string][]) => void
}) {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = () => {
    const label = parseLabel(text)
    if (!label) {
      setInvalid(text.trim() !== '')
      return false
    }
    onChange([...labels.filter(([key]) => key !== label[0]), label])
    setText('')
    setInvalid(false)
    return true
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter adds the label, not saves (with nothing typed, it saves).
      if (text.trim()) {
        event.preventDefault()
        add()
      }
    } else if (event.key === 'Backspace' && text === '' && labels.length > 0) {
      onChange(labels.slice(0, -1))
    }
  }
  return (
    <div
      className={cn(
        'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border bg-surface px-1.5 py-1 focus-within:ring-3',
        invalid
          ? 'border-critical focus-within:ring-critical/15'
          : 'border-line-strong focus-within:border-accent focus-within:ring-accent-soft',
      )}
    >
      {labels.map(([key, value]) => (
        <span
          key={key}
          className="flex h-5 items-center gap-0.5 rounded-md bg-surface-3 pr-1 pl-1.5 font-mono text-2xs text-ink-1"
        >
          {key}={value}
          <button
            type="button"
            aria-label={`Remove ${key}=${value}`}
            onClick={() => onChange(labels.filter(([k]) => k !== key))}
            className="grid place-items-center rounded text-ink-3 hover:text-ink-1"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id="cluster-labels"
        value={text}
        placeholder={labels.length === 0 ? 'Add a label, as env=production…' : 'Add a label…'}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setText(event.target.value)
          setInvalid(false)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => text.trim() && add()}
        className="h-5 min-w-28 flex-1 bg-transparent px-1 font-mono text-2xs text-ink-1 outline-none placeholder:font-sans placeholder:text-xs placeholder:text-ink-3"
      />
    </div>
  )
}

function Toggle({
  title,
  line,
  checked,
  onChange,
  locked = false,
}: {
  title: string
  line: string
  checked: boolean
  onChange: (checked: boolean) => void
  locked?: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-px">
        <Switch label={title} checked={checked} onCheckedChange={onChange} disabled={locked} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink-1">{title}</span>
        <span className="block text-xs text-ink-3">
          {locked && (
            <span className="mr-1 inline-flex items-center gap-1 text-ink-2">
              <Lock className="size-3" /> Set by your organization.
            </span>
          )}
          {line}
        </span>
      </span>
    </div>
  )
}

/** Where a cluster comes from: a kubeconfig's (changed there), or one added in Lumovi. */
function Connection({
  cluster,
  files,
  addedAt,
  onEditConnection,
  onCopyForKubectl,
}: {
  cluster: Cluster
  files?: KubeconfigFiles
  addedAt?: string
  onEditConnection: () => void
  onCopyForKubectl: () => void
}) {
  const { context } = cluster
  const signsIn = useSignsIn(cluster)
  return (
    <section className="mt-5 rounded-xl bg-surface-3/70 px-3.5 py-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-2xs font-medium tracking-wider text-ink-3 uppercase">Connection</h3>
        <span className="ml-auto truncate font-mono text-xs text-ink-2">
          {cluster.own
            ? `Added in Lumovi${addedAt ? `, ${new Date(addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` : ''}`
            : context.file && files
              ? tilde(context.file, files.home)
              : ''}
        </span>
      </div>
      {cluster.own ? (
        <>
          <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">Server</dt>
            <dd className="truncate font-mono text-ink-1 selectable">
              {context.server ?? hostOf(context.server)}
            </dd>
            <dt className="text-ink-3">Signs in with</dt>
            <dd className="truncate font-mono text-ink-1">{signsIn}</dd>
          </dl>
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              className="h-7 text-xs [&_svg]:size-3.5"
              onClick={onEditConnection}
            >
              <Pencil /> Edit connection…
            </Button>
            <Button
              variant="ghost"
              className="h-7 text-xs [&_svg]:size-3.5"
              onClick={onCopyForKubectl}
            >
              <SquareTerminal /> Copy for kubectl
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-ink-2">
            {files?.locked
              ? 'From the kubeconfig your organization keeps Lumovi to'
              : 'From your kubeconfig'}
            , as user <span className="font-mono text-ink-1">{context.user}</span>. Lumovi never
            changes it: to change how it connects, edit the file.
          </p>
          {context.file && (
            <Button
              variant="secondary"
              className="mt-3 h-7 text-xs [&_svg]:size-3.5"
              onClick={() => void api.kubeconfigFiles?.show(context.file!)}
            >
              <FolderOpen /> {REVEAL}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

/** How a cluster added in Lumovi signs in, from its kubeconfig (its secrets kept out of it). */
function useSignsIn(cluster: Cluster): string {
  const file = cluster.context.file
  const inspected = useQuery({
    queryKey: ['added-cluster', file],
    queryFn: async () => {
      const text = await unwrap(api.addedClusters!.read(file!))
      return unwrap(api.addedClusters!.inspect(text, file))
    },
    enabled: cluster.own && !!api.addedClusters && !!file,
  })
  const found = inspected.data?.contexts.find((entry) => entry.name === cluster.context.name)
  if (!found) return '…'
  const command = inspected.data!.commands[0]
  switch (found.auth) {
    case 'command':
      return `${command?.line ?? 'a program'} · allowed by you`
    case 'token':
      return 'a token'
    case 'certificate':
      return 'a client certificate'
    case 'basic':
      return 'a user name and password'
    default:
      return 'nothing'
  }
}
