import { ChevronsUpDown, FilePlus2, Info, Link2, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { CopyButton } from '@renderer/components/CopyButton'
import { useList } from '@renderer/hooks/queries'
import { useProduction, useReadOnly } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import {
  CONTAINER_PATH,
  FIELD_PATHS,
  FORM_KINDS,
  fieldLines,
  missing,
  nameLines,
  problems,
  read,
  refusals,
  RESOURCE_PATHS,
  unowned,
  workloadValues,
  write,
  type FieldId,
  type FormKindName,
  type Problem,
  type Resources,
} from '@renderer/lib/create-form'
import { linesAt, pathText, type Path } from '@renderer/lib/yaml-edit'
import { useCluster } from '@renderer/state/cluster'
import { Results } from './CreateDialog'
import { createCommand, useCreating } from './create-run'

const KINDS = Object.keys(FORM_KINDS) as FormKindName[]

/** "one, two and three". */
const listed = (items: ReactNode[]) =>
  items.flatMap((item, i) => (i === 0 ? [item] : [i === items.length - 1 ? ' and ' : ', ', item]))

/**
 * Create, with a form: the common kinds' essential fields on the left, and the YAML they
 * write on the right. Either side is edited, and they stay in step: the YAML is what's
 * created, and the form shows what of it it has fields for. Each field names the path it
 * writes, and lights its lines in the YAML while it has the focus.
 */
export function CreateForm({ sides, onClose }: { sides: ReactNode; onClose: () => void }) {
  const { context, namespace: picked } = useCluster()
  const production = useProduction(context)
  const { readOnly, why: readOnlyWhy } = useReadOnly()
  const start = picked ?? 'default'
  const [kind, setKind] = useState<FormKindName>('Deployment')
  const form = FORM_KINDS[kind]
  const [text, setText] = useState(() => form.blank(start))
  // The last text the form could show, which it goes back to when asked.
  const [fitting, setFitting] = useState(text)
  const [focus, setFocus] = useState<{ field: FieldId; path: Path }>()
  // An edit the form couldn't make without rewriting more of the YAML than its own lines.
  const [stuck, setStuck] = useState(false)
  const reading = useMemo(
    () =>
      stuck
        ? {
            fits: false as const,
            why: 'A field’s edit would have rewritten more of this YAML than its own lines, the way it’s written, so it wasn’t made.',
            lines: undefined,
          }
        : read(text, form),
    [text, form, stuck],
  )
  if (reading.fits && fitting !== text) setFitting(text)
  const last = useMemo(() => read(fitting, form), [fitting, form])
  const object = reading.fits ? reading.object : last.fits ? last.object : {}
  const values = workloadValues(object)
  const namespace = values.namespace || start
  const { outcomes, setOutcomes, pending, create } = useCreating(namespace, onClose)
  const command = createCommand(context, namespace)

  const change = (next: string) => {
    setText(next)
    setOutcomes([])
    setStuck(false)
  }
  /** A field's edit, of the text as it is now: made, or the form steps back and says why. */
  const edit = (how: (text: string) => string | null) => {
    if (!reading.fits) return
    const next = how(text)
    if (next === null) setStuck(true)
    else change(next)
  }

  const typed = reading.fits ? problems(values) : []
  const empty = reading.fits ? missing(values) : []
  const refused = reading.fits
    ? refusals(outcomes.flatMap((outcome) => (outcome.ok ? [] : (outcome.causes ?? []))))
    : []
  const wrong: Problem[] = [...typed, ...refused]
  const extras = reading.fits ? unowned(reading.object, form) : []
  const ready = !readOnly && (!reading.fits || (empty.length === 0 && typed.length === 0))

  // The lines set apart in the YAML: what the field in focus writes, what's wrong, and what
  // the form has no field for (or, stepped back, what it can't show).
  const linesOf = (paths: Path[]) =>
    paths.flatMap((path) => {
      const span = linesAt(text, path)
      return span ? Array.from({ length: span[1] - span[0] + 1 }, (_, i) => span[0] + i) : []
    })
  const lit =
    focus && reading.fits
      ? fieldLines(
          text,
          reading.object,
          focus.field,
          focus.field === 'name' ? undefined : focus.path,
        )
      : []
  const marks = {
    lit,
    wrong: reading.fits
      ? wrong.flatMap((problem) =>
          problem.path
            ? linesOf([problem.path])
            : problem.field === 'name'
              ? nameLines(text, reading.object)
              : fieldLines(text, reading.object, problem.field),
        )
      : [],
    shaded: reading.fits
      ? linesOf(extras)
      : reading.lines
        ? Array.from(
            { length: reading.lines[1] - reading.lines[0] + 1 },
            (_, i) => reading.lines![0] + i,
          )
        : [],
  }

  const status = !reading.fits
    ? 'Edited by hand. This is what gets created.'
    : empty.length > 0
      ? `${listed(empty).join('')} ${empty.length === 1 ? 'is' : 'are'} still empty.`
      : typed.length > 0
        ? `${typed.length} ${typed.length === 1 ? 'field' : 'fields'} to fix before it can be created.`
        : outcomes.some((outcome) => !outcome.ok)
          ? 'Nothing was created.'
          : 'Edit either side: they stay in step.'

  // What the cluster said of a field is brought into view in the form too, whole.
  const formPane = useRef<HTMLDivElement>(null)
  const refusedCount = refused.length
  useEffect(() => {
    if (refusedCount === 0) return
    const said = formPane.current?.querySelector('[role="alert"]')
    // Its field is above it: both, where the pane has room.
    ;(said?.parentElement?.parentElement ?? said)?.scrollIntoView({ block: 'nearest' })
  }, [refusedCount])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready && !pending) void create(text)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            // On its first field: a form is filled from the top.
            ;(event.currentTarget as HTMLElement)
              .querySelector<HTMLElement>('[data-form] input')
              ?.focus()
          }}
          className="fixed top-[7vh] left-1/2 z-50 flex h-[86vh] w-[960px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start gap-3 px-5 pt-5 pb-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2">
                <FilePlus2 className="size-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-[15px] leading-snug font-semibold text-ink-1">
                  Create
                </Dialog.Title>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                  <span className="truncate">
                    On <span className="font-medium text-ink-2">{context}</span>
                  </span>
                  {production && (
                    <span className="shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
                      Production
                    </span>
                  )}
                </p>
              </div>
            </header>
            <div className="shrink-0 px-5 pt-1 pb-2">{sides}</div>
            <div
              role="radiogroup"
              aria-label="Kind"
              className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 pt-1 pb-4"
            >
              {KINDS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={kind === name}
                  onClick={() => {
                    const blank = FORM_KINDS[name].blank(start)
                    if (name === kind) return
                    setKind(name)
                    change(blank)
                    setFitting(blank)
                  }}
                  className={cn(
                    'h-6 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    kind === name
                      ? 'border-accent bg-accent-soft text-accent-strong'
                      : 'border-line text-ink-2 hover:bg-surface-3 hover:text-ink-1',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,440px)_minmax(0,1fr)] border-t border-line">
              {/* It scrolls without a bar of its own, which would take the fields' width: that
                  there's more below is said by its last lines fading out. */}
              <div className="relative min-h-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-7 after:bg-linear-to-b after:from-transparent after:to-surface-2">
                <div
                  ref={formPane}
                  data-form
                  role="group"
                  aria-label="Form"
                  className="h-full [scroll-padding-block:1rem_2.5rem] [scrollbar-width:none] overflow-y-auto px-5 pt-4 pb-7"
                >
                  <div className="flex flex-col gap-3.5">
                    {!reading.fits && (
                      <Note>
                        <b className="block font-semibold text-ink-1">
                          The form can’t show this YAML
                        </b>
                        {reading.why} The YAML is what gets created; go on editing it there. Below
                        is the form as it last was.
                        <br />
                        <Button className="mt-2 h-7 px-2 text-xs" onClick={() => change(fitting)}>
                          <RotateCcw />
                          Go back to the form’s version
                        </Button>
                      </Note>
                    )}
                    {extras.length > 0 && (
                      <Note>
                        The YAML also sets{' '}
                        {listed(
                          extras.map((path) => (
                            <code key={pathText(path)} className="font-mono text-[11px] text-ink-2">
                              {pathText(path)}
                            </code>
                          )),
                        )}
                        . The form has no field for {extras.length === 1 ? 'it' : 'them'}, and keeps{' '}
                        {extras.length === 1 ? 'it as it is' : 'them as they are'}.
                      </Note>
                    )}
                    <fieldset
                      disabled={!reading.fits}
                      className={cn('flex min-w-0 flex-col gap-3.5', !reading.fits && 'opacity-45')}
                    >
                      <WorkloadFields
                        values={values}
                        wrong={wrong}
                        focus={focus}
                        onFocus={setFocus}
                        allNamespaces={picked === null}
                        start={start}
                        edit={edit}
                        object={object}
                      />
                    </fieldset>
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 min-w-0 flex-col border-l border-line">
                <p className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2 pl-5 text-xs text-ink-3">
                  <b className="font-medium text-ink-2">YAML</b>
                  <span role="status">{status}</span>
                </p>
                <div className="min-h-0 flex-1 bg-surface-2/60">
                  <CodeEditor
                    value={text}
                    onChange={change}
                    onSave={() => ready && !pending && void create(text)}
                    label="YAML to create"
                    lines={marks}
                    reveal={
                      // What the cluster refused is brought well into view; a field's own lines,
                      // just into it.
                      refused.length > 0 && marks.wrong[0] !== undefined
                        ? { line: marks.wrong[0], high: true }
                        : lit[0]
                    }
                    autoFocus={false}
                  />
                </div>
                <div className="flex max-h-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-t border-line px-5 pt-3 pb-4">
                  {readOnly && (
                    <p role="alert" className="text-xs text-critical-text">
                      {readOnlyWhy}
                    </p>
                  )}
                  <Results outcomes={outcomes} />
                  <div className="group relative rounded-lg bg-surface-3/70 px-3 py-2.5">
                    <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                      Equivalent command
                    </p>
                    <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
                      {command}
                    </code>
                    <span className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CopyButton text={command} label="Copy command" />
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3">
              <Button variant="ghost" data-cancel onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                data-confirm
                variant="primary"
                disabled={!ready && !pending}
                aria-disabled={pending || undefined}
                className="min-w-20 aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Create
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-surface-3 px-3 py-2.5 text-[13px] leading-[21px] text-ink-2">
      <Info className="mt-[3px] size-4 shrink-0 text-ink-3" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

const INPUT =
  'h-8 w-full min-w-0 rounded-lg border bg-surface px-2.5 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 focus:ring-3 disabled:bg-surface-2'
const input = (bad: boolean, mono = false) =>
  cn(
    INPUT,
    mono && 'font-mono text-[12.5px]',
    bad
      ? 'border-critical ring-3 ring-critical/15 focus:border-critical focus:ring-critical/15'
      : 'border-line-strong focus:border-accent focus:ring-accent-soft',
  )

/** A field's label, with the YAML path it writes: lit while the field has the focus. */
function Labelled({
  label,
  optional,
  path,
  on,
  error,
  help,
  children,
}: {
  label: string
  optional?: boolean
  path: string
  on: boolean
  error?: string
  help?: ReactNode
  children: (ids: { label: string; describedBy: string }) => ReactNode
}) {
  const id = useId()
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-ink-2">
          <span id={`${id}-label`}>{label}</span>
          {optional && <small className="ml-1 text-2xs font-normal text-ink-3">optional</small>}
        </span>
        {/* The end of a long path is what tells it from the others: it's cut at its start. */}
        <span
          id={`${id}-path`}
          dir="rtl"
          className={cn(
            'min-w-0 truncate text-right font-mono text-[10.5px] leading-4',
            on ? 'text-accent-strong' : 'text-ink-3',
          )}
        >
          <bdi>{path}</bdi>
        </span>
      </div>
      {children({ label: `${id}-label`, describedBy: `${id}-path ${id}-said` })}
      <div id={`${id}-said`}>
        {error && (
          <p role="alert" className="mt-1.5 text-xs leading-[17px] text-critical-text selectable">
            {error}
          </p>
        )}
        {help && !error && <p className="mt-1.5 text-xs leading-[17px] text-ink-3">{help}</p>}
      </div>
    </div>
  )
}

type TextProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  bad?: boolean
  mono?: boolean
  unit?: string
  onChange: (value: string) => void
}

/** A one-line field, with what it holds said at its end where that helps (a unit). */
function Text({ bad = false, mono = false, unit, onChange, className, ...props }: TextProps) {
  const field = (
    <input
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      {...props}
      onChange={(event) => onChange(event.target.value)}
      className={cn(input(bad, mono), unit && 'pr-28', className)}
    />
  )
  if (!unit) return field
  return (
    <span className="relative block min-w-0">
      {field}
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 right-2.5 flex h-8 items-center text-xs text-ink-3"
      >
        {unit}
      </span>
    </span>
  )
}

const RESOURCE_FIELDS: [keyof Resources, string, string][] = [
  ['cpuRequest', 'CPU request', '250m'],
  ['memoryRequest', 'Memory request', '128Mi'],
  ['cpuLimit', 'CPU limit', ''],
  ['memoryLimit', 'Memory limit', '256Mi'],
]

/** What a workload asks: its name and where it goes, how many, and its one container. */
function WorkloadFields({
  values,
  wrong,
  focus,
  onFocus,
  allNamespaces,
  start,
  edit,
  object,
}: {
  values: ReturnType<typeof workloadValues>
  wrong: Problem[]
  focus: { field: FieldId; path: Path } | undefined
  onFocus: (focus: { field: FieldId; path: Path } | undefined) => void
  allNamespaces: boolean
  start: string
  edit: (how: (text: string) => string | null) => void
  object: Record<string, unknown>
}) {
  const namespaces = useList('Namespace', { namespace: null })
  const names = [
    ...new Set([
      ...(namespaces.data ?? []).map((ns) => ns.metadata.name),
      ...(values.namespace ? [values.namespace] : []),
    ]),
  ].sort()
  // Rows for variables that aren't in the YAML yet: one is, once it has a name.
  const [drafts, setDrafts] = useState(0)
  // The four amounts show once asked for, or as soon as the YAML sets one.
  const [amounts, setAmounts] = useState(false)
  const anyAmount = Object.values(values.resources).some((amount) => amount !== '')

  const said = (field: FieldId, path?: Path) =>
    wrong.find(
      (problem) =>
        problem.field === field &&
        (path === undefined ||
          problem.path === undefined ||
          pathText(problem.path) === pathText(path) ||
          pathText(path).startsWith(pathText(problem.path))),
    )?.message
  const on = (field: FieldId) => focus?.field === field
  /** Says which field has the focus, and where it writes, for the YAML to light its lines. */
  const focused = (field: FieldId, path: Path = FIELD_PATHS[field]) => ({
    onFocus: () => onFocus({ field, path }),
    onBlur: () => onFocus(undefined),
  })
  const replicas = /^\d+$/.test(values.replicas) ? Number(values.replicas) : undefined
  const containerPath = pathText(CONTAINER_PATH)

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Name" path="metadata.name" on={on('name')}>
          {(ids) => (
            <Text
              aria-labelledby={ids.label}
              aria-describedby={`${ids.describedBy} create-who-said`}
              aria-invalid={said('name') !== undefined}
              value={values.name}
              placeholder="web"
              bad={said('name') !== undefined}
              onChange={(name) => edit((text) => write.name(text, object, name))}
              {...focused('name')}
            />
          )}
        </Labelled>
        <Labelled label="Namespace" path="metadata.namespace" on={on('namespace')}>
          {(ids) => (
            <span className="relative block">
              <select
                aria-labelledby={ids.label}
                aria-describedby={`${ids.describedBy} create-who-said`}
                value={values.namespace}
                onChange={(event) => {
                  const chosen = event.target.value
                  edit((text) => write.namespace(text, chosen))
                }}
                className={cn(input(said('namespace') !== undefined), 'appearance-none pr-8')}
                {...focused('namespace')}
              >
                {values.namespace === '' && <option value="">Choose…</option>}
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <ChevronsUpDown className="pointer-events-none absolute top-2 right-2.5 size-3.5 text-ink-3" />
            </span>
          )}
        </Labelled>
      </div>
      {/* What's wrong with either is said under the two, across the form's width. */}
      <div id="create-who-said" className="-mt-2 empty:hidden">
        {(said('name') ?? said('namespace')) !== undefined && (
          <p role="alert" className="text-xs leading-[17px] text-critical-text selectable">
            {said('name') ?? said('namespace')}
          </p>
        )}
      </div>
      {allNamespaces && values.namespace === start && (
        <p className="-mt-2 text-xs leading-[17px] text-ink-3">
          No namespace is chosen in the header, so it starts at{' '}
          <code className="font-mono text-[11px] text-ink-2">default</code>. Choose another here.
        </p>
      )}

      <Labelled label="Replicas" path="spec.replicas" on={on('replicas')} error={said('replicas')}>
        {(ids) => (
          <div className="flex items-center gap-2">
            <StepButton
              label="Fewer replicas"
              disabled={replicas === undefined || replicas <= 0}
              onClick={() => edit((text) => write.replicas(text, String(replicas! - 1)))}
            >
              <Minus className="size-4" />
            </StepButton>
            <Text
              aria-labelledby={ids.label}
              aria-describedby={ids.describedBy}
              aria-invalid={said('replicas') !== undefined}
              inputMode="numeric"
              value={values.replicas}
              bad={said('replicas') !== undefined}
              className="w-16 text-center font-semibold tabular-nums"
              onChange={(typed) => edit((text) => write.replicas(text, typed.trim()))}
              onKeyDown={(event) => {
                const step = { ArrowUp: 1, ArrowDown: -1 }[event.key]
                if (!step || replicas === undefined || replicas + step < 0) return
                event.preventDefault()
                edit((text) => write.replicas(text, String(replicas + step)))
              }}
              {...focused('replicas')}
            />
            <StepButton
              label="More replicas"
              disabled={replicas === undefined}
              onClick={() => edit((text) => write.replicas(text, String(replicas! + 1)))}
            >
              <Plus className="size-4" />
            </StepButton>
          </div>
        )}
      </Labelled>

      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-line pt-3.5 text-2xs leading-4 font-medium tracking-wider text-ink-3 uppercase">
        <span id="create-container">Container</span>
        <span
          dir="rtl"
          className="min-w-0 truncate font-mono text-[10.5px] font-normal tracking-normal normal-case"
        >
          <bdi>{containerPath}</bdi>
        </span>
      </div>

      <Labelled label="Image" path=".image" on={on('image')} error={said('image')}>
        {(ids) => (
          <Text
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            aria-invalid={said('image') !== undefined}
            mono
            value={values.image}
            placeholder="nginx:1.27"
            bad={said('image') !== undefined}
            onChange={(image) => edit((text) => write.image(text, image))}
            {...focused('image')}
          />
        )}
      </Labelled>

      <Labelled
        label="Port"
        optional
        path=".ports[0].containerPort"
        on={on('port')}
        error={said('port')}
      >
        {(ids) => (
          <Text
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            aria-invalid={said('port') !== undefined}
            mono
            inputMode="numeric"
            value={values.port}
            placeholder="80"
            bad={said('port') !== undefined}
            onChange={(port) => edit((text) => write.port(text, port.trim()))}
            {...focused('port')}
          />
        )}
      </Labelled>

      <Labelled label="Environment" optional path=".env" on={on('env')} error={said('env')}>
        {(ids) => (
          <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
            {/* One list, so a new row that's named is the same row, and keeps the focus. */}
            {[
              ...values.env.map((variable, index) => {
                const row: Path = [...FIELD_PATHS.env, index]
                const bad = wrong.some(
                  (problem) => problem.path && pathText(problem.path) === pathText(row),
                )
                return (
                  <div key={index} className="flex items-start gap-1.5">
                    <Text
                      aria-label={`Variable ${index + 1}’s name`}
                      aria-describedby={ids.describedBy}
                      mono
                      value={variable.name}
                      bad={bad}
                      className="flex-1"
                      onChange={(name) => edit((text) => write.variableName(text, index, name))}
                      {...focused('env', row)}
                    />
                    <span aria-hidden className="flex h-8 items-center text-ink-3">
                      =
                    </span>
                    {variable.from === undefined ? (
                      <Text
                        aria-label={`${variable.name || `Variable ${index + 1}`}’s value`}
                        mono
                        value={variable.value}
                        className="flex-[1.4]"
                        onChange={(value) =>
                          edit((text) => write.variableValue(text, index, value))
                        }
                        {...focused('env', row)}
                      />
                    ) : (
                      // Said elsewhere: where from is shown, and it isn't typed over here.
                      <span
                        aria-label={`${variable.name || `Variable ${index + 1}`}’s value`}
                        className="flex min-h-8 min-w-0 flex-[1.4] items-center rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs leading-[17px] wrap-anywhere text-ink-2"
                      >
                        from {variable.from}
                      </span>
                    )}
                    <RemoveButton
                      label={`Remove ${variable.name || `variable ${index + 1}`}`}
                      onClick={() => edit((text) => write.removeVariable(text, index))}
                    />
                  </div>
                )
              }),
              ...Array.from({ length: drafts }, (_, draft) => (
                // Keyed as the row it becomes once it's named, so the field being typed in is
                // the same one then, and keeps the focus.
                <div key={values.env.length + draft} className="flex items-center gap-1.5">
                  <Text
                    aria-label="A new variable’s name"
                    mono
                    autoFocus
                    value=""
                    placeholder="LOG_LEVEL"
                    className="flex-1"
                    onChange={(name) => {
                      // Named, it's in the YAML, and a row like the others.
                      setDrafts(drafts - 1)
                      edit((text) => write.addVariable(text, object, name, ''))
                    }}
                  />
                  <span aria-hidden className="text-ink-3">
                    =
                  </span>
                  <Text
                    aria-label="A new variable’s value"
                    mono
                    disabled
                    value=""
                    placeholder="after its name"
                    className="flex-[1.4]"
                    onChange={() => undefined}
                  />
                  <RemoveButton
                    label="Remove the new variable"
                    onClick={() => setDrafts(drafts - 1)}
                  />
                </div>
              )),
            ]}
            <AddButton onClick={() => setDrafts(drafts + 1)}>Add a variable</AddButton>
          </div>
        )}
      </Labelled>

      <Labelled
        label="Requests and limits"
        optional
        path=".resources"
        on={on('resources')}
        error={said('resources')}
      >
        {(ids) =>
          amounts || anyAmount ? (
            <div
              role="group"
              aria-labelledby={ids.label}
              className="grid grid-cols-2 gap-x-3 gap-y-2"
            >
              {RESOURCE_FIELDS.map(([which, label, example]) => (
                <Text
                  key={which}
                  aria-label={label}
                  aria-describedby={ids.describedBy}
                  mono
                  unit={label}
                  value={values.resources[which]}
                  placeholder={example}
                  bad={wrong.some(
                    (problem) =>
                      problem.field === 'resources' &&
                      problem.path !== undefined &&
                      pathText(RESOURCE_PATHS[which]).startsWith(pathText(problem.path)) &&
                      // The cluster names the pair (the requests): the amounts in it are marked.
                      (pathText(problem.path) !== pathText(FIELD_PATHS.resources) ||
                        values.resources[which] !== ''),
                  )}
                  onChange={(amount) => edit((text) => write.resource(text, which, amount.trim()))}
                  {...focused('resources', RESOURCE_PATHS[which])}
                />
              ))}
            </div>
          ) : (
            <AddButton onClick={() => setAmounts(true)}>Set them</AddButton>
          )
        }
      </Labelled>

      <p className="flex items-start gap-1.5 text-xs leading-[17px] text-ink-3">
        <Link2 className="mt-0.5 size-3 shrink-0" />
        <span>
          Labelled{' '}
          <code className="font-mono text-[11px] text-ink-2">app={values.name || '…'}</code>: its
          selector and its pods’ labels follow the name.
        </span>
      </p>
    </>
  )
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-ink-2 shadow-xs transition-colors outline-none hover:bg-surface-3 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-surface"
    >
      {children}
    </button>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors outline-none hover:bg-surface-3 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <X className="size-4" />
    </button>
  )
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 inline-flex h-8 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] font-medium text-accent-strong transition-colors outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Plus className="size-4" />
      {children}
    </button>
  )
}
