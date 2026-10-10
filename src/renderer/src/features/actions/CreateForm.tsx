import {
  ArrowRight,
  ChevronsUpDown,
  CircleCheck,
  Eye,
  EyeOff,
  FilePlus2,
  Info,
  Link2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
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
  type TextareaHTMLAttributes,
} from 'react'
import { Button } from '@renderer/components/Button'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { CopyButton } from '@renderer/components/CopyButton'
import { useList, useListResponse } from '@renderer/hooks/queries'
import { useProduction, useReadOnly } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'
import { scheduleWords } from '@renderer/lib/cron-words'
import {
  ACCESS_MODES,
  check,
  claimValues,
  CONCURRENCY_POLICIES,
  dig,
  FORM_KINDS,
  fieldLines,
  HIDDEN,
  masked,
  nameLines,
  pairsAt,
  plainWriter,
  PROTOCOLS,
  read,
  refusals,
  resourcePaths,
  RESTART_POLICIES,
  SERVICE_TYPES,
  serviceValues,
  shown,
  storagePaths,
  unowned,
  UNSAID,
  workloadValues,
  writer,
  type FieldId,
  type FormKind,
  type FormKindName,
  type Pair,
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
  const namespace = shown(dig(object, ['metadata', 'namespace'])) || start
  const { outcomes: answers, setOutcomes, pending, create } = useCreating(namespace, onClose)
  const command = createCommand(context, namespace)

  // A Secret's values are hidden, on both sides, until they're asked for. Hidden, the YAML
  // that's shown is another text, with nothing of a value in it, and isn't edited; and what
  // the cluster says is shown with no value it may quote.
  const [showing, setShowing] = useState(false)
  const cover = useMemo(() => (kind === 'Secret' ? masked(text) : null), [kind, text])
  const hidden = kind === 'Secret' && !showing
  const view = hidden ? (cover ?? '') : text
  const outcomes = useMemo(
    () =>
      hidden
        ? answers.map((answer) =>
            answer.ok
              ? answer
              : {
                  ...answer,
                  error: UNSAID,
                  // (The field it names is still named: only its words are kept back.)
                  ...(answer.causes
                    ? { causes: answer.causes.map((cause) => ({ ...cause, message: UNSAID })) }
                    : {}),
                },
          )
        : answers,
    [answers, hidden],
  )

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

  const { missing: empty, problems: typed } = reading.fits
    ? check(reading.object, form)
    : { missing: [], problems: [] }
  const refused = reading.fits
    ? refusals(
        outcomes.flatMap((outcome) => (outcome.ok ? [] : (outcome.causes ?? []))),
        form,
      )
    : []
  const wrong: Problem[] = [...typed, ...refused]
  const extras = reading.fits ? unowned(reading.object, form) : []
  const ready = !readOnly && (!reading.fits || (empty.length === 0 && typed.length === 0))

  // The lines set apart in the YAML: what the field in focus writes, what's wrong, and what
  // the form has no field for (or, stepped back, what it can't show).
  // (They're the lines of what's shown: a Secret's, hidden, has each value on one.)
  const where = hidden && !reading.fits && !stuck ? read(view, form) : reading
  const linesOf = (paths: Path[]) =>
    paths.flatMap((path) => {
      const span = linesAt(view, path)
      return span ? Array.from({ length: span[1] - span[0] + 1 }, (_, i) => span[0] + i) : []
    })
  const lit =
    focus && reading.fits
      ? fieldLines(
          view,
          reading.object,
          form,
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
              ? nameLines(view, reading.object, form)
              : fieldLines(view, reading.object, form, problem.field),
        )
      : [],
    shaded: reading.fits
      ? linesOf(extras)
      : !where.fits && where.lines
        ? Array.from({ length: where.lines[1] - where.lines[0] + 1 }, (_, i) => where.lines![0] + i)
        : [],
  }

  const status =
    reading.fits && empty.length > 0
      ? `${listed(empty).join('')} ${empty.length === 1 ? 'is' : 'are'} still empty.`
      : reading.fits && typed.length > 0
        ? `${typed.length} ${typed.length === 1 ? 'field' : 'fields'} to fix before it can be created.`
        : outcomes.some((outcome) => !outcome.ok)
          ? 'Nothing was created.'
          : hidden
            ? 'Read-only while its values are hidden.'
            : reading.fits
              ? 'Edit either side: they stay in step.'
              : 'Edited by hand. This is what gets created.'

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
                    setShowing(false)
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
                      {form.family === 'workload' ? (
                        <WorkloadFields
                          // A kind's own: what was being added to one isn't the next one's.
                          key={kind}
                          form={form}
                          wrong={wrong}
                          focus={focus}
                          onFocus={setFocus}
                          allNamespaces={picked === null}
                          start={start}
                          edit={edit}
                          object={object}
                        />
                      ) : (
                        <PlainFields
                          key={kind}
                          form={form}
                          wrong={wrong}
                          focus={focus}
                          onFocus={setFocus}
                          allNamespaces={picked === null}
                          start={start}
                          edit={edit}
                          object={object}
                          hidden={hidden}
                        />
                      )}
                    </fieldset>
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 min-w-0 flex-col border-l border-line">
                <p className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2 pl-5 text-xs text-ink-3">
                  <b className="font-medium text-ink-2">YAML</b>
                  <span role="status" className="min-w-0 flex-1 truncate">
                    {status}
                  </span>
                  {kind === 'Secret' && (
                    <button
                      type="button"
                      aria-pressed={showing}
                      // Where the values can't be told from the rest, they can't be hidden one
                      // by one: it stays shown until they can.
                      disabled={showing && cover === null}
                      title={
                        showing && cover === null
                          ? 'Its values can’t be told from the rest as it’s written: it isn’t YAML as it stands, or a value comes through an alias or a merge key.'
                          : undefined
                      }
                      onClick={() => setShowing(!showing)}
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-ink-2 transition-colors outline-none hover:bg-surface-3 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      {showing ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      {showing ? 'Hide values' : 'Show values'}
                    </button>
                  )}
                </p>
                <div className="min-h-0 flex-1 bg-surface-2/60">
                  <CodeEditor
                    // An editor of its own for each: what one held, and could undo to, isn't
                    // the other's.
                    key={hidden ? 'hidden' : 'open'}
                    value={view}
                    readOnly={hidden}
                    onChange={(next) => !hidden && change(next)}
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
  stack = false,
  error,
  help,
  children,
}: {
  label: string
  optional?: boolean
  path: string
  on: boolean
  /** Its path under its label, not beside it: for one too long to fit there. */
  stack?: boolean
  error?: string
  help?: ReactNode
  children: (ids: { label: string; describedBy: string }) => ReactNode
}) {
  const id = useId()
  return (
    <div className="min-w-0">
      {/* A path too long to sit beside its label is under it, whole. */}
      <div className={cn('mb-1', !stack && 'flex items-baseline justify-between gap-2')}>
        <span className="shrink-0 text-xs font-medium text-ink-2">
          <span id={`${id}-label`}>{label}</span>
          {optional && <small className="ml-1 text-2xs font-normal text-ink-3">optional</small>}
        </span>
        {/* The end of a long path is what tells it from the others: it's cut at its start. */}
        <span
          id={`${id}-path`}
          dir={stack ? undefined : 'rtl'}
          className={cn(
            'min-w-0 font-mono text-[10.5px] leading-4',
            stack ? 'block wrap-anywhere' : 'truncate text-right',
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

type Focus = { field: FieldId; path: Path }
/** A field's edit of the text: made, or (where it comes to `null`) the form steps back. */
type Edit = (how: (text: string) => string | null) => void

/** What every kind is asked first: its name, and the namespace it goes to. */
function Who({
  name,
  namespace,
  example,
  wrong,
  focus,
  onFocus,
  allNamespaces,
  start,
  onName,
  onNamespace,
}: {
  name: string
  namespace: string
  /** A name such a thing might have, shown where none is typed yet. */
  example: string
  wrong: Problem[]
  focus: Focus | undefined
  onFocus: (focus: Focus | undefined) => void
  allNamespaces: boolean
  start: string
  onName: (name: string) => void
  onNamespace: (namespace: string) => void
}) {
  const namespaces = useList('Namespace', { namespace: null })
  const names = [
    ...new Set([
      ...(namespaces.data ?? []).map((ns) => ns.metadata.name),
      ...(namespace ? [namespace] : []),
    ]),
  ].sort()
  const said = (field: FieldId) => wrong.find((problem) => problem.field === field)?.message
  const on = (field: FieldId) => focus?.field === field
  const focused = (field: 'name' | 'namespace') => ({
    onFocus: () => onFocus({ field, path: ['metadata', field] }),
    onBlur: () => onFocus(undefined),
  })
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Labelled label="Name" path="metadata.name" on={on('name')}>
          {(ids) => (
            <Text
              aria-labelledby={ids.label}
              aria-describedby={`${ids.describedBy} create-who-said`}
              aria-invalid={said('name') !== undefined}
              value={name}
              placeholder={example}
              bad={said('name') !== undefined}
              onChange={onName}
              {...focused('name')}
            />
          )}
        </Labelled>
        <Labelled label="Namespace" path="metadata.namespace" on={on('namespace')}>
          {(ids) => (
            <Choice
              aria-labelledby={ids.label}
              aria-describedby={`${ids.describedBy} create-who-said`}
              value={namespace}
              bad={said('namespace') !== undefined}
              onChange={(event) => onNamespace(event.target.value)}
              {...focused('namespace')}
            >
              {namespace === '' && <option value="">Choose…</option>}
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Choice>
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
      {allNamespaces && namespace === start && (
        <p className="-mt-2 text-xs leading-[17px] text-ink-3">
          No namespace is chosen in the header, so it starts at <Code>default</Code>. Choose another
          here.
        </p>
      )}
    </>
  )
}

/** A choice among a few, as the system's own select: its arrow is ours. */
function Choice({
  bad = false,
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'> & { bad?: boolean }) {
  return (
    <span className="relative block">
      <select {...props} className={cn(input(bad), 'appearance-none pr-8')}>
        {children}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute top-2 right-2.5 size-3.5 text-ink-3" />
    </span>
  )
}

/** A whole number, typed or stepped by its buttons and the arrow keys. */
function Count({
  value,
  bad,
  fewer,
  more,
  onChange,
  ...props
}: Omit<TextProps, 'onChange' | 'value'> & {
  value: string
  fewer: string
  more: string
  onChange: (typed: string) => void
}) {
  const count = /^\d+$/.test(value) ? Number(value) : undefined
  return (
    <div className="flex items-center gap-2">
      <StepButton
        label={fewer}
        disabled={count === undefined || count <= 0}
        onClick={() => onChange(String(count! - 1))}
      >
        <Minus className="size-4" />
      </StepButton>
      <Text
        {...props}
        aria-invalid={bad}
        inputMode="numeric"
        value={value}
        bad={bad}
        className="w-16 text-center font-semibold tabular-nums"
        onChange={(typed) => onChange(typed.trim())}
        onKeyDown={(event) => {
          const step = { ArrowUp: 1, ArrowDown: -1 }[event.key]
          if (!step || count === undefined || count + step < 0) return
          event.preventDefault()
          onChange(String(count + step))
        }}
      />
      <StepButton
        label={more}
        disabled={count === undefined}
        onClick={() => onChange(String(count! + 1))}
      >
        <Plus className="size-4" />
      </StepButton>
    </div>
  )
}

/** What a workload asks: its name and where it goes, what's its kind's own, and its one container. */
function WorkloadFields({
  form,
  wrong,
  focus,
  onFocus,
  allNamespaces,
  start,
  edit,
  object,
}: {
  form: FormKind
  wrong: Problem[]
  focus: Focus | undefined
  onFocus: (focus: Focus | undefined) => void
  allNamespaces: boolean
  start: string
  edit: Edit
  object: Record<string, unknown>
}) {
  const write = useMemo(() => writer(form), [form])
  const values = workloadValues(object, form)
  const has = (field: FieldId) => form.fields.includes(field)
  // The Services and the storage classes there are to choose from, where a kind asks.
  const services = useList('Service', {
    namespace: values.namespace || start,
    enabled: has('serviceName'),
  })
  const headless = (services.data ?? [])
    .filter((service) => dig(service, ['spec', 'clusterIP']) === 'None')
    .map((service) => service.metadata.name)
    .sort()
  const others = (services.data ?? [])
    .map((service) => service.metadata.name)
    .filter((name) => !headless.includes(name))
    .sort()
  /** Whether the Service the YAML names is one of them (or it names none). */
  const named = values.serviceName === '' || [...headless, ...others].includes(values.serviceName)
  const classes = useList('StorageClass', { namespace: null, enabled: has('storage') })
  // Rows for variables that aren't in the YAML yet: one is, once it has a name.
  const [drafts, setDrafts] = useState(0)
  // The four amounts show once asked for, or as soon as the YAML sets one.
  const [amounts, setAmounts] = useState(false)
  const anyAmount = Object.values(values.resources).some((amount) => amount !== '')
  const claimed = dig(object, form.paths.storage ?? []) !== undefined && has('storage')

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
  const focused = (field: FieldId, path: Path = form.paths[field]!) => ({
    onFocus: () => onFocus({ field, path }),
    onBlur: () => onFocus(undefined),
  })
  /** A path under the container's, as its fields name theirs: `.image`. */
  const within = (field: FieldId) =>
    pathText(form.paths[field]!).slice(pathText(form.container).length)
  const schedule = values.schedule === '' ? undefined : scheduleWords(values.schedule)
  const resources = resourcePaths(form)
  const storage = storagePaths(form)
  const gibibytes = /^(\d+)Gi$/.exec(values.storage.size)?.[1]
  const defaultClass = (classes.data ?? []).find(
    (item) => item.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
  )?.metadata.name
  const pick = (field: 'restartPolicy' | 'concurrencyPolicy', options: Record<string, string>) => (
    <Labelled
      label={field === 'restartPolicy' ? 'When a pod fails' : 'If the last run is still going'}
      path={pathText(form.paths[field]!)}
      on={on(field)}
      stack={pathText(form.paths[field]!).length > 40}
      error={said(field)}
      help={
        field === 'restartPolicy' ? (
          values.restartPolicy === 'OnFailure' ? (
            <>
              <Code>OnFailure</Code>: the pod stays, and its container is started again.
            </>
          ) : (
            <>
              <Code>Never</Code>: the failed pod is kept, to read its logs.
            </>
          )
        ) : undefined
      }
    >
      {(ids) => (
        <Choice
          aria-labelledby={ids.label}
          aria-describedby={ids.describedBy}
          value={values[field]}
          bad={said(field) !== undefined}
          onChange={(event) => {
            const chosen = event.target.value
            edit((text) => write[field](text, chosen))
          }}
          {...focused(field)}
        >
          {/* What the YAML says, where it's none of these: shown, and said to be wrong. */}
          {!(values[field] in options) && (
            <option value={values[field]}>{values[field] || 'Choose…'}</option>
          )}
          {Object.entries(options).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Choice>
      )}
    </Labelled>
  )

  return (
    <>
      <Who
        name={values.name}
        namespace={values.namespace}
        example="web"
        wrong={wrong}
        focus={focus}
        onFocus={onFocus}
        allNamespaces={allNamespaces}
        start={start}
        onName={(name) => edit((text) => write.name(text, object, name))}
        onNamespace={(chosen) => edit((text) => write.namespace(text, chosen))}
      />

      {(has('replicas') || has('serviceName') || has('backoffLimit')) && (
        <div className="grid grid-cols-2 gap-3">
          {has('replicas') && (
            <Labelled
              label="Replicas"
              path="spec.replicas"
              on={on('replicas')}
              error={said('replicas')}
            >
              {(ids) => (
                <Count
                  aria-labelledby={ids.label}
                  aria-describedby={ids.describedBy}
                  value={values.replicas}
                  bad={said('replicas') !== undefined}
                  fewer="Fewer replicas"
                  more="More replicas"
                  onChange={(typed) => edit((text) => write.replicas(text, typed))}
                  {...focused('replicas')}
                />
              )}
            </Labelled>
          )}
          {has('backoffLimit') && (
            <Labelled
              label="Retries"
              path="spec.backoffLimit"
              on={on('backoffLimit')}
              error={said('backoffLimit')}
            >
              {(ids) => (
                <Count
                  aria-labelledby={ids.label}
                  aria-describedby={ids.describedBy}
                  value={values.backoffLimit}
                  bad={said('backoffLimit') !== undefined}
                  fewer="Fewer retries"
                  more="More retries"
                  onChange={(typed) => edit((text) => write.backoffLimit(text, typed))}
                  {...focused('backoffLimit')}
                />
              )}
            </Labelled>
          )}
          {has('serviceName') && (
            <Labelled
              label="Service"
              path="spec.serviceName"
              on={on('serviceName')}
              error={said('serviceName')}
            >
              {(ids) =>
                // With no Service there to choose, its name is typed: it can be made after.
                services.data?.length === 0 ? (
                  <Text
                    aria-labelledby={ids.label}
                    aria-describedby={`${ids.describedBy} create-service-said`}
                    aria-invalid={said('serviceName') !== undefined}
                    value={values.serviceName}
                    bad={said('serviceName') !== undefined}
                    onChange={(typed) => edit((text) => write.serviceName(text, typed))}
                    {...focused('serviceName')}
                  />
                ) : (
                  <Choice
                    aria-labelledby={ids.label}
                    aria-describedby={`${ids.describedBy} create-service-said`}
                    value={values.serviceName}
                    bad={said('serviceName') !== undefined}
                    onChange={(event) => {
                      const chosen = event.target.value
                      edit((text) => write.serviceName(text, chosen))
                    }}
                    {...focused('serviceName')}
                  >
                    {values.serviceName === '' && <option value="">Choose…</option>}
                    {/* The headless ones first, being what it asks for; with them, a name the
                        YAML has that no Service there does. */}
                    {[...headless, ...(named ? [] : [values.serviceName])].sort().map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    {others.length > 0 && (
                      <optgroup label="Not headless">
                        {others.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Choice>
                )
              }
            </Labelled>
          )}
        </div>
      )}
      {has('serviceName') && (
        <p id="create-service-said" className="-mt-2 text-xs leading-[17px] text-ink-3">
          The headless Service that names its pods. It isn’t created here: make it first, as a
          Service.
        </p>
      )}

      {has('schedule') && (
        <Labelled
          label="Schedule"
          path="spec.schedule"
          on={on('schedule')}
          error={said('schedule')}
          help={
            schedule?.ok
              ? schedule.never
                ? schedule.never
                : schedule.words
                  ? // (Its clock is the cluster's controller manager's, unless the YAML says whose.)
                    `${schedule.words}, in ${shown(dig(object, ['spec', 'timeZone'])) || 'the cluster’s time zone (usually UTC)'}.`
                  : 'A valid schedule, though not one this can put into words. Check it against what you meant.'
              : 'Five fields, as cron has them: minute, hour, day of the month, month, day of the week.'
          }
        >
          {(ids) => (
            <Text
              aria-labelledby={ids.label}
              aria-describedby={ids.describedBy}
              aria-invalid={said('schedule') !== undefined}
              mono
              value={values.schedule}
              placeholder="30 2 * * *"
              bad={said('schedule') !== undefined}
              onChange={(typed) => edit((text) => write.schedule(text, typed))}
              {...focused('schedule')}
            />
          )}
        </Labelled>
      )}
      {has('concurrencyPolicy') && pick('concurrencyPolicy', CONCURRENCY_POLICIES)}
      {has('restartPolicy') && pick('restartPolicy', RESTART_POLICIES)}

      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-line pt-3.5 text-2xs leading-4 font-medium tracking-wider text-ink-3 uppercase">
        <span>Container</span>
        <span
          dir="rtl"
          className="min-w-0 truncate font-mono text-[10.5px] font-normal tracking-normal normal-case"
        >
          <bdi>{pathText(form.container)}</bdi>
        </span>
      </div>

      <Labelled label="Image" path={within('image')} on={on('image')} error={said('image')}>
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

      {has('command') && (
        <Labelled
          label="Command"
          optional
          path={within('command')}
          on={on('command')}
          error={said('command')}
          help={
            <>
              Run as <Code>sh -c</Code>. Empty runs the image’s own command.
            </>
          }
        >
          {(ids) => (
            <Text
              aria-labelledby={ids.label}
              aria-describedby={ids.describedBy}
              mono
              value={values.command}
              placeholder="echo hello"
              onChange={(command) => edit((text) => write.command(text, command))}
              {...focused('command')}
            />
          )}
        </Labelled>
      )}

      {has('port') && (
        <Labelled label="Port" optional path={within('port')} on={on('port')} error={said('port')}>
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
      )}

      {has('storage') && (
        <Labelled
          label="Storage for each pod"
          optional
          path="spec.volumeClaimTemplates[0]"
          on={on('storage')}
          error={said('storage')}
        >
          {(ids) =>
            claimed ? (
              <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-x-3">
                  <Text
                    aria-label="Size"
                    aria-describedby={ids.describedBy}
                    mono
                    // In gibibytes, as a number, where that's how it's written; any other
                    // amount (500Mi) is shown, and typed, whole.
                    unit={gibibytes === undefined && values.storage.size !== '' ? undefined : 'Gi'}
                    value={gibibytes ?? values.storage.size}
                    placeholder="20"
                    bad={said('storage', storage.size) !== undefined}
                    onChange={(typed) => {
                      const size = typed.trim()
                      edit((text) =>
                        write.storage(
                          text,
                          object,
                          'size',
                          /^\d+$/.test(size) ? `${size}Gi` : size,
                        ),
                      )
                    }}
                    {...focused('storage', storage.size)}
                  />
                  <Choice
                    aria-label="Storage class"
                    value={values.storage.storageClass}
                    onChange={(event) => {
                      const chosen = event.target.value
                      edit((text) => write.storage(text, object, 'storageClass', chosen))
                    }}
                    {...focused('storage', storage.storageClass)}
                  >
                    {/* No class said is the cluster's default one, which is named if it has one. */}
                    <option value="">
                      {defaultClass ? `${defaultClass} (default)` : 'The cluster’s default'}
                    </option>
                    {[
                      ...new Set([
                        ...(classes.data ?? []).map((item) => item.metadata.name),
                        ...(values.storage.storageClass ? [values.storage.storageClass] : []),
                      ]),
                    ]
                      // (The default by its name is offered only where the YAML says it so.)
                      .filter(
                        (name) => name !== defaultClass || name === values.storage.storageClass,
                      )
                      .sort()
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </Choice>
                </div>
                <div className="flex items-center gap-1.5">
                  <Text
                    aria-label="Mounted at"
                    mono
                    unit="Mounted at"
                    value={values.storage.mountPath}
                    placeholder="/data"
                    bad={said('storage', storage.mountPath) !== undefined}
                    className="flex-1"
                    onChange={(path) =>
                      edit((text) => write.storage(text, object, 'mountPath', path.trim()))
                    }
                    {...focused('storage', storage.mountPath)}
                  />
                  <RemoveButton
                    label="Remove the storage"
                    onClick={() => edit((text) => write.removeStorage(text))}
                  />
                </div>
              </div>
            ) : (
              <AddButton onClick={() => edit((text) => write.addStorage(text))}>
                Add storage
              </AddButton>
            )
          }
        </Labelled>
      )}

      <Labelled
        label="Environment"
        optional
        path={within('env')}
        on={on('env')}
        error={said('env')}
      >
        {(ids) => (
          <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
            {/* One list, so a new row that's named is the same row, and keeps the focus. */}
            {[
              ...values.env.map((variable, index) => {
                const row: Path = [...form.paths.env!, index]
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
                      edit((text) => write.addVariable(text, object, name))
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

      {has('resources') && (
        <Labelled
          label="Requests and limits"
          optional
          path={within('resources')}
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
                        pathText(resources[which]).startsWith(pathText(problem.path)) &&
                        // The cluster names the pair (the requests): the amounts in it are marked.
                        (pathText(problem.path) !== pathText(form.paths.resources!) ||
                          values.resources[which] !== ''),
                    )}
                    onChange={(amount) =>
                      edit((text) => write.resource(text, which, amount.trim()))
                    }
                    {...focused('resources', resources[which])}
                  />
                ))}
              </div>
            ) : (
              <AddButton onClick={() => setAmounts(true)}>Set them</AddButton>
            )
          }
        </Labelled>
      )}

      {form.kind === 'DaemonSet' && (
        <p className="-mt-1.5 text-xs leading-[17px] text-ink-3">
          One pod on every node, so there’s no replica count.
        </p>
      )}
      {form.follows.length > 1 && (
        <p className="flex items-start gap-1.5 text-xs leading-[17px] text-ink-3">
          <Link2 className="mt-0.5 size-3 shrink-0" />
          <span>
            Labelled <Code>app={values.name || '…'}</Code>: its selector and its pods’ labels follow
            the name.
          </span>
        </p>
      )}
    </>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11px] text-ink-2">{children}</code>
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

/** A name such a thing might have, where none is typed yet. */
const EXAMPLES: Partial<Record<FormKindName, string>> = {
  Service: 'web',
  ConfigMap: 'web-settings',
  Secret: 'web-credentials',
  PersistentVolumeClaim: 'uploads',
}

interface FieldsProps {
  form: FormKind
  wrong: Problem[]
  focus: Focus | undefined
  onFocus: (focus: Focus | undefined) => void
  edit: Edit
  object: Record<string, unknown>
  namespace: string
}

/** What a kind that runs nothing asks: a Service's fields, keys and values, or a claim's. */
function PlainFields({
  allNamespaces,
  start,
  hidden,
  ...fields
}: Omit<FieldsProps, 'namespace'> & {
  allNamespaces: boolean
  start: string
  /** Whether a Secret's values are hidden. */
  hidden: boolean
}) {
  const { form, wrong, focus, onFocus, edit, object } = fields
  const write = useMemo(() => plainWriter(form), [form])
  const namespace = shown(dig(object, ['metadata', 'namespace']))
  return (
    <>
      <Who
        name={shown(dig(object, ['metadata', 'name']))}
        namespace={namespace}
        example={EXAMPLES[form.kind] ?? ''}
        wrong={wrong}
        focus={focus}
        onFocus={onFocus}
        allNamespaces={allNamespaces}
        start={start}
        onName={(name) => edit((text) => write.name(text, name))}
        onNamespace={(chosen) => edit((text) => write.namespace(text, chosen))}
      />
      {form.family === 'service' && <ServiceFields {...fields} namespace={namespace || start} />}
      {form.family === 'data' && (
        <DataFields {...fields} namespace={namespace || start} hidden={hidden} />
      )}
      {form.family === 'claim' && <ClaimFields {...fields} namespace={namespace || start} />}
    </>
  )
}

/** The first thing said of a field, or of one path of it. */
const saidOf = (wrong: Problem[], field: FieldId, path?: Path) =>
  wrong.find(
    (problem) =>
      problem.field === field &&
      (path === undefined ||
        (problem.path !== undefined && pathText(problem.path) === pathText(path))),
  )?.message

function ServiceFields({ form, wrong, focus, onFocus, edit, object, namespace }: FieldsProps) {
  const write = useMemo(() => plainWriter(form), [form])
  const values = serviceValues(object)
  const type = values.type || 'ClusterIP'
  const types = Object.keys(SERVICE_TYPES) as (keyof typeof SERVICE_TYPES)[]
  const focused = (field: FieldId, path: Path = form.paths[field]!) => ({
    onFocus: () => onFocus({ field, path }),
    onBlur: () => onFocus(undefined),
  })
  // The pods its labels match now, asked of the cluster once the labels can be one's.
  const selector = values.selector.map((pair) => `${pair.key}=${pair.value}`).join(',')
  const asked = values.selector.length > 0 && saidOf(wrong, 'selector') === undefined
  const pods = useListResponse('Pod', { namespace, labelSelector: selector, enabled: asked })
  const matching =
    asked && pods.data && !pods.isPlaceholderData
      ? (pods.data.total ?? pods.data.items.length)
      : undefined
  // A port that isn't in the YAML yet: it is, once it has a number.
  const [draft, setDraft] = useState(false)
  const base = form.paths.ports!
  /** Whether a problem is with a port's name. */
  const unnamed = (problem: Problem) => problem.path?.at(-1) === 'name'
  const firstUnnamed = wrong.find((problem) => problem.field === 'ports' && unnamed(problem))
  const rows = [
    ...values.ports.map((port) => ({ ...port, draft: false })),
    ...(draft ? [NEW_PORT] : []),
  ]

  return (
    <>
      <Labelled
        label="Type"
        path="spec.type"
        on={focus?.field === 'type'}
        error={saidOf(wrong, 'type')}
        help={type in SERVICE_TYPES ? SERVICE_TYPES[type as keyof typeof SERVICE_TYPES] : undefined}
      >
        {(ids) => (
          <div
            role="radiogroup"
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            className="inline-flex rounded-lg bg-surface-3 p-0.5"
            onKeyDown={(event) => {
              // As a group of radios goes: the arrows choose, and the focus goes with them.
              const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
              if (!step) return
              event.preventDefault()
              const next =
                types[(types.indexOf(type as never) + step + types.length) % types.length]!
              edit((text) => write.type(text, next))
              event.currentTarget.querySelector<HTMLElement>(`[data-type="${next}"]`)?.focus()
            }}
          >
            {types.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                data-type={name}
                aria-checked={type === name}
                tabIndex={type === name ? 0 : -1}
                onClick={() => edit((text) => write.type(text, name))}
                {...focused('type')}
                className={cn(
                  'h-7 rounded-md px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  type === name ? 'bg-surface text-ink-1 shadow-xs' : 'text-ink-2 hover:text-ink-1',
                )}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </Labelled>

      <Labelled
        label="Sends traffic to pods labelled"
        path="spec.selector"
        on={focus?.field === 'selector'}
        error={saidOf(wrong, 'selector')}
      >
        {(ids) => (
          <Pairs
            ids={ids}
            field="selector"
            base={form.paths.selector!}
            pairs={values.selector}
            noun="label"
            example={['app', 'web']}
            wide="key"
            wrong={wrong}
            onFocus={onFocus}
            edit={edit}
            write={write}
          />
        )}
      </Labelled>
      <p className="-mt-1.5 flex items-start gap-1.5 text-xs leading-[17px] text-ink-3">
        {values.selector.length === 0 ? (
          'With no labels, it sends to no pods until something else says which.'
        ) : matching === undefined ? (
          // (Not asked while a label can't be one, nor said before the answer is in.)
          '\u00a0'
        ) : (
          <>
            {matching > 0 && <CircleCheck className="mt-px size-3.5 shrink-0 text-good-text" />}
            <span>
              {matching === 0
                ? `No pods in ${namespace} match now.`
                : `${matching} ${matching === 1 ? 'pod' : 'pods'} in ${namespace} ${matching === 1 ? 'matches' : 'match'} now.`}
            </span>
          </>
        )}
      </p>

      <Labelled
        label="Ports"
        path="spec.ports"
        on={focus?.field === 'ports'}
        // (What's wrong with a port's name is said under that name.)
        error={wrong.find((problem) => problem.field === 'ports' && !unnamed(problem))?.message}
      >
        {(ids) => (
          <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
            {rows.map((port, index) => {
              const at = (key: string): Path => [...base, index, key]
              const bad = (key: string) => saidOf(wrong, 'ports', at(key)) !== undefined
              const nth = `Port ${index + 1}`
              return (
                // (One list, so a new row that's numbered is the same row, and keeps the focus.)
                <div key={index} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-[104px] shrink-0">
                      <Text
                        aria-label={port.draft ? 'A new port' : nth}
                        aria-describedby={ids.describedBy}
                        aria-invalid={bad('port')}
                        mono
                        inputMode="numeric"
                        unit="Port"
                        className="pr-12"
                        autoFocus={port.draft}
                        value={port.port}
                        placeholder="80"
                        bad={bad('port')}
                        onChange={(typed) => {
                          const number = typed.trim()
                          if (!port.draft) return edit((text) => write.port(text, index, number))
                          if (number === '') return
                          setDraft(false)
                          edit((text) => write.addPort(text, object, number))
                        }}
                        {...(port.draft ? {} : focused('ports', at('port')))}
                      />
                    </span>
                    <ArrowRight aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <Text
                        aria-label={`${nth}, on the pod`}
                        aria-invalid={bad('targetPort')}
                        mono
                        unit="On the pod"
                        className="pr-24"
                        disabled={port.draft}
                        value={port.targetPort}
                        // (Not said, it's the same port on the pod.)
                        placeholder={port.port}
                        bad={bad('targetPort')}
                        onChange={(typed) =>
                          edit((text) => write.targetPort(text, index, typed.trim()))
                        }
                        {...focused('ports', at('targetPort'))}
                      />
                    </span>
                    <span className="w-[84px] shrink-0">
                      <Choice
                        aria-label={`${nth}’s protocol`}
                        disabled={port.draft}
                        value={port.protocol || 'TCP'}
                        bad={bad('protocol')}
                        onChange={(event) => {
                          const chosen = event.target.value
                          edit((text) => write.protocol(text, index, chosen))
                        }}
                        {...focused('ports', at('protocol'))}
                      >
                        {[...new Set([...PROTOCOLS, port.protocol || 'TCP'])].map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Choice>
                    </span>
                    <RemoveButton
                      label={port.draft ? 'Remove the new port' : `Remove port ${index + 1}`}
                      onClick={() =>
                        port.draft ? setDraft(false) : edit((text) => write.removePort(text, index))
                      }
                    />
                  </div>
                  {/* With more than one, the cluster asks a name of each. */}
                  {!port.draft && (values.ports.length > 1 || port.name !== '') && (
                    <span className="mr-[38px] block">
                      <Text
                        aria-label={`${nth}’s name`}
                        aria-invalid={bad('name')}
                        mono
                        unit="Name"
                        className="pr-16"
                        value={port.name}
                        bad={bad('name')}
                        onChange={(typed) =>
                          edit((text) => write.portName(text, index, typed.trim()))
                        }
                        {...focused('ports', at('name'))}
                      />
                      {firstUnnamed?.path &&
                        pathText(firstUnnamed.path) === pathText(at('name')) && (
                          <p
                            role="alert"
                            className="mt-1.5 text-xs leading-[17px] text-critical-text selectable"
                          >
                            {firstUnnamed.message}
                          </p>
                        )}
                    </span>
                  )}
                </div>
              )
            })}
            <AddButton onClick={() => setDraft(true)}>Add a port</AddButton>
          </div>
        )}
      </Labelled>
    </>
  )
}

const NEW_PORT = { name: '', port: '', targetPort: '', protocol: '', draft: true }

function DataFields({
  form,
  wrong,
  focus,
  onFocus,
  edit,
  object,
  hidden,
}: FieldsProps & { hidden: boolean }) {
  const write = useMemo(() => plainWriter(form), [form])
  const base = form.paths.data!
  const secret = form.kind === 'Secret'
  return (
    <>
      {secret && (
        <Labelled label="Type" path="type" on={false}>
          {() => (
            <p className="text-[13px] leading-[21px] text-ink-2">
              <b className="font-medium text-ink-1">Opaque</b>: keys and values of your own. For a
              TLS or registry secret, use the YAML.
            </p>
          )}
        </Labelled>
      )}
      <Labelled
        label="Data"
        path={pathText(base)}
        on={focus?.field === 'data'}
        error={saidOf(wrong, 'data')}
        help={
          !secret
            ? 'A value can have several lines.'
            : `${
                hidden
                  ? 'Values are hidden on both sides until you choose Show values, above the YAML.'
                  : 'Values are showing on both sides; Hide values, above the YAML, hides them again.'
              } The cluster stores them base64-encoded, which isn’t encryption.`
        }
      >
        {(ids) => (
          <Pairs
            ids={ids}
            field="data"
            base={base}
            pairs={pairsAt(object, base)}
            noun="key"
            example={secret ? ['API_KEY', ''] : ['LOG_LEVEL', 'info']}
            wide="value"
            area
            hidden={secret && hidden}
            wrong={wrong}
            onFocus={onFocus}
            edit={edit}
            write={write}
          />
        )}
      </Labelled>
    </>
  )
}

function ClaimFields({ form, wrong, focus, onFocus, edit, object }: FieldsProps) {
  const write = useMemo(() => plainWriter(form), [form])
  const values = claimValues(object)
  const classes = useList('StorageClass', { namespace: null })
  const focused = (field: FieldId) => ({
    onFocus: () => onFocus({ field, path: form.paths[field]! }),
    onBlur: () => onFocus(undefined),
  })
  const gibibytes = /^(\d+)Gi$/.exec(values.size)?.[1]
  const mode = values.accessMode
  return (
    <>
      <Labelled
        label="Size"
        path={pathText(form.paths.size!)}
        on={focus?.field === 'size'}
        error={saidOf(wrong, 'size')}
      >
        {(ids) => (
          <Text
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            aria-invalid={saidOf(wrong, 'size') !== undefined}
            mono
            // In gibibytes, as a number, where that's how it's written; any other amount
            // (500Mi) is shown, and typed, whole.
            unit={gibibytes === undefined && values.size !== '' ? undefined : 'Gi'}
            value={gibibytes ?? values.size}
            placeholder="20"
            bad={saidOf(wrong, 'size') !== undefined}
            onChange={(typed) => {
              const size = typed.trim()
              edit((text) => write.size(text, /^\d+$/.test(size) ? `${size}Gi` : size))
            }}
            {...focused('size')}
          />
        )}
      </Labelled>
      <Labelled
        label="Storage class"
        path={pathText(form.paths.storageClass!)}
        on={focus?.field === 'storageClass'}
        error={saidOf(wrong, 'storageClass')}
      >
        {(ids) => (
          <ClassChoice
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            value={values.storageClass}
            classes={classes.data}
            onChange={(chosen) => edit((text) => write.storageClass(text, chosen))}
            {...focused('storageClass')}
          />
        )}
      </Labelled>
      <Labelled
        label="Who can mount it"
        path="spec.accessModes"
        on={focus?.field === 'accessMode'}
        error={saidOf(wrong, 'accessMode')}
        help={
          <>
            {mode !== '' && <Code>{mode}</Code>}
            {mode !== '' && '. '}The class decides which of these it can give.
          </>
        }
      >
        {(ids) => (
          <Choice
            aria-labelledby={ids.label}
            aria-describedby={ids.describedBy}
            value={mode}
            bad={saidOf(wrong, 'accessMode') !== undefined}
            onChange={(event) => {
              const chosen = event.target.value
              edit((text) => write.accessMode(text, chosen))
            }}
            {...focused('accessMode')}
          >
            {!(mode in ACCESS_MODES) && <option value={mode}>{mode || 'Choose…'}</option>}
            {Object.entries(ACCESS_MODES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Choice>
        )}
      </Labelled>
      <Note>Its size can grow later where the class allows it; it can’t shrink.</Note>
    </>
  )
}

/** A storage class, chosen: none said is the cluster's default one, named if it has one. */
function ClassChoice({
  value,
  classes,
  onChange,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'onChange' | 'value'> & {
  value: string
  classes: { metadata: { name: string; annotations?: Record<string, string> } }[] | undefined
  onChange: (chosen: string) => void
}) {
  const fallback = (classes ?? []).find(
    (item) => item.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
  )?.metadata.name
  return (
    <Choice {...props} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{fallback ? `${fallback} (default)` : 'The cluster’s default'}</option>
      {[
        ...new Set([
          ...(classes ?? []).map((item) => item.metadata.name),
          ...(value ? [value] : []),
        ]),
      ]
        // (The default by its name is offered only where the YAML says it so.)
        .filter((name) => name !== fallback || name === value)
        .sort()
        .map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
    </Choice>
  )
}

const AREA =
  'block min-h-8 w-full min-w-0 resize-none rounded-lg border bg-surface px-2.5 py-[5px] font-mono text-[12.5px] leading-5 text-ink-1 outline-none placeholder:text-ink-3 focus:ring-3 disabled:bg-surface-2'
const area = (bad: boolean) =>
  cn(
    AREA,
    bad
      ? 'border-critical ring-3 ring-critical/15 focus:border-critical focus:ring-critical/15'
      : 'border-line-strong focus:border-accent focus:ring-accent-soft',
  )

type AreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string
  bad?: boolean
  onChange: (value: string) => void
}

/** A field for a value that can have several lines: as tall as what it holds. */
function Area({ value, bad = false, onChange, className, ...props }: AreaProps) {
  return (
    <textarea
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      rows={value.split('\n').length}
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(area(bad), className)}
    />
  )
}

/**
 * A Secret's value while values are hidden. What the YAML holds is never put in it: it shows
 * that there's a value, and takes a new one in its place, drawn as dots while it's typed.
 */
function HiddenValue({
  set,
  onChange,
  onBlur,
  className,
  ...props
}: Omit<AreaProps, 'value'> & {
  /** Whether there's a value now. */
  set: boolean
}) {
  const [typed, setTyped] = useState<string>()
  return (
    <Area
      {...props}
      value={typed ?? ''}
      placeholder={set ? HIDDEN : ''}
      className={cn(
        '[-webkit-text-security:disc] placeholder:[-webkit-text-security:none]',
        className,
      )}
      onChange={(value) => {
        setTyped(value)
        onChange(value)
      }}
      onBlur={(event) => {
        // What was typed is the YAML's now, and hidden with the rest.
        setTyped(undefined)
        onBlur?.(event)
      }}
    />
  )
}

/** Keys and their values, a row each: labels, a ConfigMap's data, a Secret's. */
function Pairs({
  ids,
  field,
  base,
  pairs,
  noun,
  example,
  wide,
  area = false,
  hidden = false,
  wrong,
  onFocus,
  edit,
  write,
}: {
  ids: { label: string; describedBy: string }
  field: FieldId
  /** The map they're in. */
  base: Path
  pairs: Pair[]
  /** What a key is called here: "Add a label". */
  noun: 'label' | 'key'
  example: [string, string]
  /** Which of the two is the long one, and gets the wider share: a label's key, a setting's value. */
  wide: 'key' | 'value'
  /** Whether a value can have several lines. */
  area?: boolean
  /** Whether values are hidden: a Secret's, until they're asked for. */
  hidden?: boolean
  wrong: Problem[]
  onFocus: (focus: Focus | undefined) => void
  edit: Edit
  write: ReturnType<typeof plainWriter>
}) {
  // A row that isn't in the YAML yet: it is, once its key is one the map can take.
  const [draft, setDraft] = useState<string>()
  // A key as it's being typed, while it can't be the key: it's empty, or another's.
  const [renaming, setRenaming] = useState<{ index: number; typed: string }>()
  const taken = (key: string, but?: number) =>
    pairs.some((pair, i) => i !== but && pair.key === key)
  const refused = renaming ?? (draft ? { index: pairs.length, typed: draft } : undefined)
  const rows = [
    ...pairs.map((pair) => ({ ...pair, draft: false })),
    ...(draft === undefined ? [] : [{ key: draft, value: '', draft: true }]),
  ]
  const Value = area ? Area : Text
  const [keyShare, valueShare] =
    wide === 'key' ? ['flex-[1.4]', 'flex-1'] : ['flex-1', 'flex-[1.4]']
  return (
    <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
      {rows.map((pair, index) => {
        const path: Path = [...base, pair.key]
        const bad = !pair.draft && saidOf(wrong, field, path) !== undefined
        const typing = renaming?.index === index ? renaming.typed : pair.key
        const nth = pair.key || `${noun === 'label' ? 'Label' : 'Key'} ${index + 1}`
        const focused = pair.draft
          ? {}
          : { onFocus: () => onFocus({ field, path }), onBlur: () => onFocus(undefined) }
        return (
          // (One list, so a new row that's named is the same row, and keeps the focus.)
          <div key={index} className="flex items-start gap-1.5">
            <Text
              aria-label={
                pair.draft ? `A new ${noun}` : `${noun === 'label' ? 'Label' : 'Key'} ${index + 1}`
              }
              aria-describedby={ids.describedBy}
              mono
              autoFocus={pair.draft}
              value={typing}
              placeholder={pair.draft ? example[0] : undefined}
              bad={bad || refused?.index === index}
              className={keyShare}
              onChange={(typed) => {
                const cannot = typed === '' || taken(typed, pair.draft ? undefined : index)
                if (pair.draft) {
                  if (cannot) return setDraft(typed)
                  setDraft(undefined)
                  return edit((text) => write.addPair(text, base, typed))
                }
                if (cannot) return setRenaming({ index, typed })
                setRenaming(undefined)
                edit((text) => write.renamePair(text, base, pair.key, typed))
              }}
              {...focused}
              onBlur={() => {
                // Left as it can't be, it's the key it was.
                setRenaming(undefined)
                onFocus(undefined)
              }}
            />
            <span aria-hidden className="flex h-8 items-center text-ink-3">
              =
            </span>
            {pair.draft ? (
              <Text
                aria-label={`A new ${noun}’s value`}
                mono
                disabled
                value=""
                placeholder={`after its ${noun === 'label' ? 'key' : 'name'}`}
                className={valueShare}
                onChange={() => undefined}
              />
            ) : hidden ? (
              <HiddenValue
                aria-label={`${nth}’s value`}
                set={pair.value !== ''}
                bad={bad}
                className={valueShare}
                onChange={(value) => edit((text) => write.pairValue(text, base, pair.key, value))}
                {...focused}
              />
            ) : (
              <Value
                aria-label={`${nth}’s value`}
                mono
                value={pair.value}
                placeholder={index === 0 ? example[1] : undefined}
                bad={bad}
                className={valueShare}
                onChange={(value) => edit((text) => write.pairValue(text, base, pair.key, value))}
                {...focused}
              />
            )}
            <RemoveButton
              label={pair.draft ? `Remove the new ${noun}` : `Remove ${nth}`}
              onClick={() => {
                setRenaming(undefined)
                if (pair.draft) setDraft(undefined)
                else edit((text) => write.removePair(text, base, pair.key))
              }}
            />
          </div>
        )
      })}
      {refused && (
        <p role="alert" className="text-xs leading-[17px] text-critical-text">
          {refused.typed === ''
            ? `A ${noun} needs a ${noun === 'label' ? 'key' : 'name'}: remove it with ×, or give it one.`
            : `${refused.typed} is there already, and a ${noun === 'label' ? 'label' : 'key'} is there once.`}
        </p>
      )}
      <AddButton onClick={() => setDraft(draft ?? '')}>Add a {noun}</AddButton>
    </div>
  )
}
