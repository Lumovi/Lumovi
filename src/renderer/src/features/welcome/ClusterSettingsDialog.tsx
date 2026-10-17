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
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { managedReadOnly, type KubeconfigFiles } from '@shared/api'
import { spelled } from '@shared/kit/characters'
import {
  CLUSTER_COLORS,
  MOST_WATCHED,
  parseLabel,
  type ClusterSettings,
} from '@shared/cluster-settings'
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
import { withTime } from '@renderer/lib/time'

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
  // Who keeps it read-only: LUMOVI_READ_ONLY (set where Lumovi started), or the organization.
  const lockedBy = settings?.readOnlyAll
    ? 'Set by LUMOVI_READ_ONLY.'
    : readOnlyByPolicy
      ? 'Set by your organization.'
      : undefined

  const [name, setName] = useState(stored.name ?? '')
  const [color, setColor] = useState(stored.color)
  const [group, setGroup] = useState(stored.group ?? '')
  const [labels, setLabels] = useState<[string, string][]>(Object.entries(stored.labels ?? {}))
  const [namespace, setNamespace] = useState(stored.namespace ?? '')
  // Set by hand, or else as the name suggests (and kept unset, unless changed).
  const [production, setProduction] = useState(stored.production)
  const [readOnly, setReadOnly] = useState(!!settings?.readOnly?.includes(context.name))
  const [hidden, setHidden] = useState(!!stored.hidden)
  const [notify, setNotify] = useState(!!stored.notify)
  // The namespaces it watches for warnings: all of them, where none are named.
  const [watch, setWatch] = useState(stored.watch)
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

  // How its notifications stand: the credential plugin a look starts, and a pause (signing in
  // failed), as the main process has them.
  const notices = useQuery({
    queryKey: ['warning-notices', context.name],
    queryFn: () => api.app.warningNotices!(context.name),
    enabled: !!api.app.warningNotices,
  })
  const { signsInWith, pausedAt } = notices.data ?? {}

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
      ...(notify ? { notify, ...(watch?.length ? { watch } : {}) } : {}),
    }
    const result = await api.app.setCluster!(context.name, next)
    if (!result.ok) {
      setSaving(false)
      setError(result.error.message)
      return
    }
    let updated = result.data
    if (!readOnlyByPolicy && readOnly !== !!settings?.readOnly?.includes(context.name)) {
      try {
        updated = await api.app.setReadOnly(context.name, readOnly)
      } catch (failed) {
        setSaving(false)
        setError((failed as Error).message)
        return
      }
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
          // Set by hand, it's kept so: back to Lumovi's guess from its name.
          reset={
            production === undefined
              ? undefined
              : { label: 'Let Lumovi guess from its name', run: () => setProduction(undefined) }
          }
        />
        <Toggle
          title="Read-only"
          line="Lumovi changes nothing in it."
          checked={readOnlyByPolicy || readOnly}
          onChange={setReadOnly}
          locked={lockedBy}
        />
        <Toggle
          title="Hidden"
          line="Left out of the list. Show hidden clusters from its footer."
          checked={hidden}
          onChange={setHidden}
        />
      </div>

      <div className="my-4 border-t border-line" />

      <Toggle
        title="Notify me of new warnings"
        line="While Lumovi is open, it checks these namespaces’ warnings every 30 seconds, as you, and tells you of new ones."
        checked={notify}
        onChange={(on) => {
          setNotify(on)
          // Turned on, it starts at the namespace the cluster opens in; all, where that's all.
          const opensIn = namespace.trim() || context.namespace
          if (on && !stored.notify && watch === undefined && opensIn) setWatch([opensIn])
        }}
      />
      {notify && <WatchField names={namespaces.data ?? []} watch={watch} onChange={setWatch} />}
      {notify && (
        <p className="mt-3 ml-12 text-xs text-ink-3">
          Each new Warning event, once per object and reason in 10 minutes. Several at once come as
          one: “5 new warnings in shop”.
          {signsInWith &&
            ` Signing in (${spelled(signsInWith)}) runs as it checks, as when you open the cluster.`}
        </p>
      )}
      {notify && pausedAt !== undefined && (
        <p className="mt-2 ml-12 text-xs font-medium text-ink-2">
          {`Paused at ${new Date(pausedAt).toLocaleTimeString(undefined, withTime({ hour: '2-digit', minute: '2-digit' }))}: signing in failed. Open the cluster to sign in again, and notifications go on.`}
        </p>
      )}

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
          'grid size-[22px] place-items-center rounded-full bg-surface text-ink-3',
          color === undefined
            ? 'ring-2 ring-ink-3 ring-offset-2 ring-offset-surface-2'
            : 'ring-1 ring-line-strong ring-inset',
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
          // Its own chevron only: not the browser's arrow too.
          'pr-8 [&::-webkit-calendar-picker-indicator]:hidden! [&::-webkit-list-button]:hidden!',
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

/**
 * The namespaces a cluster watches for warnings: all of them, or these, as chips; Add opens a
 * list to filter, with a check by each, so several can be picked without closing it.
 */
export function WatchField({
  names,
  watch,
  onChange,
}: {
  names: string[]
  watch?: string[]
  onChange: (watch?: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const these = watch !== undefined
  const shown = names.filter((name) => name.includes(filter.trim().toLowerCase()))
  const radio = 'flex items-center gap-2 text-[13px] text-ink-1'
  return (
    <fieldset className="mt-3 ml-12 space-y-2">
      <legend className="mb-1.5 text-xs font-medium text-ink-2">Namespaces to watch</legend>
      <label className={radio}>
        <input type="radio" name="watch" checked={!these} onChange={() => onChange(undefined)} />
        All namespaces
      </label>
      <label className={radio}>
        <input type="radio" name="watch" checked={these} onChange={() => onChange(watch ?? [])} />
        These namespaces
      </label>
      {these && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {watch.map((name) => (
            <span
              key={name}
              className="flex h-6 items-center gap-1 rounded-full border border-line bg-surface-2 pr-1 pl-2 text-xs text-ink-1"
            >
              {name}
              <button
                type="button"
                aria-label={`Stop watching ${name}`}
                onClick={() => onChange(watch.filter((each) => each !== name))}
                className="grid size-4 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink-1"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
            className="flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-xs text-ink-2 hover:text-ink-1"
          >
            <Plus className="size-3" /> Add
          </button>
        </div>
      )}
      {these && adding && (
        <div
          role="group"
          aria-label="Namespaces"
          className="ml-6 rounded-lg border border-line bg-surface-2 p-1.5"
        >
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter namespaces"
            aria-label="Filter namespaces"
            className="mb-1 h-7 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <ul className="max-h-44 overflow-auto">
            {shown.map((name) => {
              const on = watch.includes(name)
              return (
                <li key={name}>
                  <label className="flex items-center gap-2 rounded px-1.5 py-1 text-[13px] text-ink-1 hover:bg-surface-3">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && watch.length >= MOST_WATCHED}
                      onChange={() =>
                        onChange(on ? watch.filter((each) => each !== name) : [...watch, name])
                      }
                    />
                    {name}
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </fieldset>
  )
}

export function Toggle({
  title,
  line,
  checked,
  onChange,
  locked,
  reset,
}: {
  title: string
  line: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Who keeps it as it is, if anyone does. */
  locked?: string
  /** Back to what Lumovi would make of it, where it's been set by hand. */
  reset?: { label: string; run: () => void }
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-px">
        <Switch label={title} checked={checked} onCheckedChange={onChange} disabled={!!locked} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink-1">{title}</span>
        <span className="block text-xs text-ink-3">
          {locked && (
            <span className="mr-1 text-ink-2">
              {/* On the line's baseline, as its words are. */}
              <Lock className="mr-1 inline-block size-3 align-[-2px]" />
              {locked}
            </span>
          )}
          {line}
          {reset && (
            <button
              type="button"
              onClick={reset.run}
              className="mt-0.5 block text-xs font-medium text-accent-strong hover:underline"
            >
              {reset.label}
            </button>
          )}
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
        {cluster.own ? (
          <span className="ml-auto min-w-0 truncate text-xs text-ink-2">
            Added in Lumovi
            {addedAt
              ? `, ${new Date(addedAt).toLocaleDateString(undefined, withTime({ day: 'numeric', month: 'long' }))}`
              : ''}
          </span>
        ) : (
          context.file &&
          files && (
            // Cut from the start: the file's name shows.
            <span
              className="ml-auto min-w-0 truncate font-mono text-xs text-ink-2 [direction:rtl]"
              title={context.file}
            >
              <bdi>{tilde(context.file, files.home)}</bdi>
            </span>
          )
        )}
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
