/**
 * Lumovi's own dialog for a change a plugin's page proposed: a confirmation of what the person
 * started a moment ago on that page, never an approval anyone waits for. Lumovi's title says the
 * change; "Options, in <plugin>’s words" holds the fields the plugin asked for, whose labels and
 * hints are its own; "What Lumovi will send" is Lumovi's: the change as the cluster says it would
 * be, its command, and the cluster's verdict. After every edit Lumovi asks the cluster again, and
 * only an answer for the options as they stand makes the button live, after a moment: what's sent
 * is what the cluster was asked. Nothing of the plugin's runs between its press and the confirm.
 *
 * Drawn over Lumovi's own header, where no plugin can draw, on a scrim over the page it came from.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Info, TriangleAlert } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import {
  changedFields,
  fieldAt,
  fieldWrong,
  filled,
  PROPOSALS_OFF,
  startingValues,
  type Field,
  type FieldValue,
  type PluginChangeAnswer,
} from '@shared/plugin-changes'
import { whose } from '@shared/plugins'
import { apiKindOf } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { TYPE_TO_DELETE } from '@renderer/features/actions/DeleteDialog'
import { forDiff } from '@renderer/features/assistants/ApprovalCenter'
import { refreshAfterChange } from '@renderer/hooks/change'
import { useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { APPROVE_MOMENT_MS } from '@renderer/lib/confirm-moment'
import { requestBase, useProposals, type ShownProposal } from './proposals'
import { TheirText } from './TheirText'

/** Lumovi's word for an action, where the plugin's isn't the button's. */
const LUMOVIS_WORD = {
  patch: 'Change',
  create: 'Create',
  scale: 'Scale',
  delete: 'Delete',
} as const

export function ProposalDialog(): ReactNode {
  const shown = useProposals((state) => state.shown)
  return shown ? <Proposal shown={shown} /> : null
}

/**
 * Whether the moment has passed since `on` was shown (a new answer starts it again, and so does
 * Lumovi's window getting the focus back): counted from the frame that paints it, only while the
 * window is in front. A press before then is dropped, not kept.
 */
function useMoment(on: string | undefined): boolean {
  // (Live for what was shown when its moment ran out: anything shown since, or a focus got back
  // since, is a new moment.)
  const [liveFor, setLiveFor] = useState<string>()
  const [back, setBack] = useState(0)
  useEffect(() => {
    const focused = () => setBack((n) => n + 1)
    window.addEventListener('focus', focused)
    return () => window.removeEventListener('focus', focused)
  }, [])
  const now = on === undefined ? undefined : `${on}\u0000${back}`
  useEffect(() => {
    if (now === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => document.hasFocus() && setLiveFor(now), APPROVE_MOMENT_MS)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [now])
  return now !== undefined && liveFor === now
}

/** The cluster's or Lumovi's verdict on a refused try, in Lumovi's words. */
function refusedWords(answer: PluginChangeAnswer & { ok: false }): string {
  switch (answer.refused) {
    case 'invalid':
    case 'not-found':
      return answer.said ? `The cluster refused it: ${answer.said}` : 'The cluster refused it.'
    case 'read-only':
      return 'This cluster is read-only in Lumovi: nothing is changed here.'
    case 'not-allowed':
      return 'You may not make this change here.'
    case 'off-by-policy':
      return PROPOSALS_OFF
    case 'no-scale':
      return 'This kind has no scale to set.'
    case 'no-namespace':
      return 'Pick one namespace to make it in.'
    case 'not-granted':
    case 'not-in-use':
    case 'changed':
    case 'not-held':
      return 'Lumovi doesn’t make this change for this plugin.'
    case 'conflict':
    case 'failed':
      return answer.said ? `It couldn’t be tried: ${answer.said}` : 'It couldn’t be tried.'
  }
}

function Proposal({ shown }: { shown: ShownProposal }): ReactNode {
  const { by, proposal, settle } = shown
  const { proposed, target } = proposal
  const base = useMemo(() => requestBase(by, proposal), [by, proposal])
  const production = useProduction(by.context)
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    startingValues(proposed.fields),
  )
  // (A number's field as typed: what isn't a whole number yet is said so, never lost.)
  const [typing, setTyping] = useState<Record<string, string>>({})
  const change = useMemo(() => filled(proposed, values), [proposed, values])
  const key = typeof change === 'string' ? undefined : JSON.stringify(change)
  const [tried, setTried] = useState<{ key: string; round: number; answer: PluginChangeAnswer }>()
  const [round, setRound] = useState(0)
  const [moved, setMoved] = useState(false)
  const [making, setMaking] = useState(false)
  const [refused, setRefused] = useState<PluginChangeAnswer & { ok: false }>()
  const [typed, setTyped] = useState('')

  // Asked again after every edit (and once the object moved): only the latest answer counts.
  useEffect(() => {
    if (key === undefined || typeof change === 'string') return
    let here = true
    const timer = setTimeout(() => {
      void api.kube.pluginChange({ step: 'try', ...base, ...change }).then((answer) => {
        if (here) setTried({ key, round, answer })
      })
    }, 250)
    return () => {
      here = false
      clearTimeout(timer)
    }
  }, [key, round, base, change])
  const answer = tried && tried.key === key && tried.round === round ? tried.answer : undefined
  const live = useMoment(answer?.ok ? `${key}\u0000${round}` : undefined)

  const kind = target?.kind ?? proposed.kind ?? ''
  const apiKind = target ? apiKindOf(target.kind) : (proposed.kind ?? '').split('/')[1]!
  const where = target?.namespace ? `${target.namespace}/${target.name}` : target?.name
  const madeIn = base.namespace
  const title =
    proposed.action === 'create'
      ? `${by.label} asks to create a new ${apiKind}${madeIn ? ` in ${madeIn}` : ''}`
      : `${by.label} asks to ${proposed.action === 'patch' ? 'change' : proposed.action} the ${apiKind} ${where}`
  const danger = proposed.action === 'delete'
  // (Today's rule, as Lumovi's own Delete has it: the kinds it always asks it for, or production.)
  const typeToConfirm =
    danger && (TYPE_TO_DELETE.includes(kind) || production) ? target?.name : undefined
  const word = danger ? LUMOVIS_WORD.delete : (proposed.verb ?? LUMOVIS_WORD[proposed.action])
  const confirmable =
    answer?.ok === true &&
    live &&
    !making &&
    !refused &&
    (typeToConfirm === undefined || typed === typeToConfirm)
  const refusedField =
    answer && !answer.ok && answer.field ? fieldAt(proposed, answer.field) : undefined

  const cancel = () => {
    if (!refused) {
      void api.kube.pluginChange({
        step: 'cancelled',
        ...base,
        fields: changedFields(proposed.fields, values),
      })
    }
    settle(refused ? 'refused' : 'cancelled')
  }
  const confirm = async () => {
    if (!confirmable || typeof change === 'string' || !answer.ok || !document.hasFocus()) return
    setMaking(true)
    const made = await api.kube.pluginChange({
      step: 'make',
      ...base,
      ...change,
      ...(answer.seen && { seen: answer.seen }),
      fields: changedFields(proposed.fields, values),
    })
    setMaking(false)
    if (made.ok) {
      refreshAfterChange(queryClient, by.context, kind)
      settle('applied')
    } else if (made.refused === 'conflict') {
      // Moved since it was shown: said, and asked again; never made onto what's there now.
      setMoved(true)
      setRound((n) => n + 1)
    } else {
      setRefused(made)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-plugin-proposal={by.plugin}
          onOpenAutoFocus={(event) => {
            // Never on the button: on the first field, or on Cancel where there's none.
            event.preventDefault()
            const dialog = event.currentTarget as HTMLElement
            const first =
              dialog.querySelector<HTMLElement>(
                '[data-field] input, [data-field] select, [data-field] button',
              ) ??
              dialog.querySelector<HTMLElement>('[data-type-to-confirm]') ??
              dialog.querySelector<HTMLElement>('[data-cancel]')
            first?.focus()
          }}
          className="fixed top-6 left-1/2 z-50 flex max-h-[min(640px,calc(100vh-48px))] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <header className="shrink-0 px-5 pt-4 pb-3">
            <p className="flex items-center gap-1.5 text-xs text-ink-3">
              <Info className="size-3.5" />
              From {by.label} {by.version}
            </p>
            <Dialog.Title className="mt-1 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere] text-ink-1">
              {title}
            </Dialog.Title>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <span>
                {apiKind}
                {(target?.namespace ?? madeIn) && ` · ${target?.namespace ?? madeIn}`} ·{' '}
                <span className="font-medium text-ink-2">{by.context}</span>
              </span>
              {production && (
                <span className="rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
                  Production
                </span>
              )}
            </p>
          </header>

          {/* What's asked and what's sent scroll together: the buttons stay in reach, however tall
              the object sent or the command that reads it. */}
          <div className="min-h-0 flex-1 overflow-y-auto" data-proposal-body>
            {proposed.fields.length > 0 && (
              <section
                aria-label={`Options, in ${whose(by.label)} words`}
                className="border-t border-line px-5 py-3"
              >
                <p className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                  Options, in {whose(by.label)} words
                </p>
                <div className="space-y-3">
                  {proposed.fields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      typed={typing[field.key]}
                      wrong={
                        fieldWrong(field, values[field.key]) ??
                        (refusedField === field.key && answer && !answer.ok
                          ? refusedWords(answer)
                          : undefined)
                      }
                      onChange={(value, raw) => {
                        setValues((all) => ({ ...all, [field.key]: value }))
                        if (raw !== undefined) setTyping((all) => ({ ...all, [field.key]: raw }))
                        setRefused(undefined)
                      }}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-2.5 border-t border-line px-5 py-3">
              {moved && (
                <p className="bg-warning/10 text-warning-text flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {apiKind} {target?.name} changed since this was shown. Here is the change again,
                  as it stands now.
                </p>
              )}
              <p className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
                {danger ? 'What Lumovi will do' : 'What Lumovi will send'}
              </p>
              {change === 'fields' ? (
                <p className="rounded-lg bg-surface-3/70 px-3 py-2.5 text-xs text-ink-3">
                  The change shows here once the options above are filled in.
                </p>
              ) : change === 'too-big' ? (
                <p className="rounded-lg bg-surface-3/70 px-3 py-2.5 text-xs text-ink-3">
                  The change comes to more than a plugin may send.
                </p>
              ) : change === 'not-allowed' ? (
                <p className="rounded-lg bg-surface-3/70 px-3 py-2.5 text-xs text-ink-3">
                  With these options, the change would write what no plugin may.
                </p>
              ) : (
                !danger &&
                answer?.ok && (
                  <div className="max-h-56 overflow-auto rounded-lg">
                    {proposed.action === 'create' ? (
                      <DiffView
                        diff={unifiedDiff('', forDiff((answer.sent ?? answer.after) as KubeObject))}
                        label="The whole object Lumovi will create"
                      />
                    ) : (
                      <DiffView
                        diff={unifiedDiff(
                          forDiff(answer.before as KubeObject),
                          forDiff(answer.after as KubeObject),
                        )}
                        label="Changes"
                      />
                    )}
                  </div>
                )
              )}
              {answer?.ok && answer.command && (
                <div className="rounded-lg bg-surface-3/70 px-3 py-2.5">
                  <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                    Equivalent command
                  </p>
                  <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
                    {answer.command}
                  </code>
                </div>
              )}
              <Verdict
                asking={key !== undefined && !answer}
                answer={answer}
                refused={refused}
                under={refusedField !== undefined}
                options={proposed.fields.length > 0}
              />
              {answer?.ok &&
                answer.takesOver?.map(({ manager }, i, all) =>
                  all.findIndex((other) => other.manager === manager) === i ? (
                    <p key={manager} className="flex items-start gap-1.5 text-xs text-ink-2">
                      <Info className="mt-px size-3.5 shrink-0 text-ink-3" />
                      <span>
                        It takes over{' '}
                        {all
                          .filter((other) => other.manager === manager)
                          .map((other) => other.field)
                          .join(', ')}{' '}
                        from <span className="font-medium">{manager}</span>.
                      </span>
                    </p>
                  ) : null,
                )}
              {danger && answer?.ok && answer.finalizers && (
                <p className="flex items-start gap-1.5 text-xs text-ink-2">
                  <Info className="mt-px size-3.5 shrink-0 text-ink-3" />
                  {/* Each named, as the cluster's text: what's true of any finalizer, never more. */}
                  <span>
                    It has the {answer.finalizers.length === 1 ? 'finalizer' : 'finalizers'}{' '}
                    {/* (The first five, then how many more: a long list can't push the button off.) */}
                    {answer.finalizers.slice(0, 5).map((name, i, shown) => {
                      const more = answer.finalizers!.length - shown.length
                      const last = i === shown.length - 1 && more === 0
                      return (
                        <span key={i}>
                          {i > 0 && (last ? ' and ' : ', ')}
                          <TheirText text={name} inline className="font-mono" />
                          {i === shown.length - 1 && more > 0 && ` and ${more} more`}
                        </span>
                      )
                    })}
                    : what {answer.finalizers.length === 1 ? 'that does' : 'they do'} runs first,
                    and the cluster deletes it once that’s done.
                  </span>
                </p>
              )}
              {typeToConfirm !== undefined && (
                <label className="block">
                  <span className="mb-1.5 block text-xs text-ink-2">
                    {production && (
                      <TriangleAlert className="mr-1.5 inline size-3.5 align-[-2px] text-critical-text" />
                    )}
                    Type{' '}
                    <span className="font-mono font-medium wrap-anywhere text-ink-1 select-all">
                      {typeToConfirm}
                    </span>{' '}
                    to confirm
                  </span>
                  <input
                    data-type-to-confirm
                    aria-label={`Type ${typeToConfirm} to confirm`}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[13px] text-ink-1 outline-none focus:border-critical focus:ring-3 focus:ring-critical/15"
                  />
                </label>
              )}
            </section>
          </div>

          <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            <Button data-cancel onClick={cancel}>
              Cancel
            </Button>
            <Button
              data-confirm
              variant={danger ? 'danger' : 'primary'}
              disabled={!confirmable}
              aria-disabled={!confirmable}
              onClick={() => void confirm()}
            >
              {danger ? word : <TheirText text={word} inline />}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The cluster's verdict on the change, with the options as they stand where it has any: asked,
 * accepted, or refused, and why.
 */
function Verdict({
  asking,
  answer,
  refused,
  under,
  options,
}: {
  asking: boolean
  answer: PluginChangeAnswer | undefined
  refused: (PluginChangeAnswer & { ok: false }) | undefined
  under: boolean
  /** It has options: what the cluster accepts is the change with them as they stand. */
  options: boolean
}): ReactNode {
  if (refused) {
    return <p className="text-xs text-critical-text">{refusedWords(refused)}</p>
  }
  if (asking) return <p className="text-xs text-ink-3">Asking the cluster…</p>
  if (!answer) return null
  if (answer.ok)
    return (
      <p className="text-success-text text-xs">
        {options ? 'The cluster accepts it, as the options stand.' : 'The cluster accepts it.'}
      </p>
    )
  // (Said under the field it names, where it names one; here, otherwise.)
  return under ? null : <p className="text-xs text-critical-text">{refusedWords(answer)}</p>
}

/** One of the plugin's fields: its label and hint in its words, what's wrong in Lumovi's. */
function FieldInput({
  field,
  value,
  typed,
  wrong,
  onChange,
}: {
  field: Field
  value: FieldValue
  typed: string | undefined
  wrong: string | undefined
  onChange: (value: FieldValue, typed?: string) => void
}): ReactNode {
  const id = `proposal-field-${field.key}`
  const noEnter = (event: KeyboardEvent) => event.key === 'Enter' && event.preventDefault()
  let control: ReactNode
  switch (field.kind) {
    case 'text':
      control = (
        <input
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={noEnter}
          maxLength={field.most}
          spellCheck={false}
          autoComplete="off"
          className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
        />
      )
      break
    case 'number':
      control = (
        <input
          id={id}
          inputMode="numeric"
          value={typed ?? (typeof value === 'number' ? String(value) : '')}
          onChange={(event) => {
            const raw = event.target.value
            onChange(/^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined, raw)
          }}
          onKeyDown={noEnter}
          autoComplete="off"
          className="h-9 w-32 rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink-1 tabular-nums outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
        />
      )
      break
    case 'choice':
      control =
        field.options.length <= 4 ? (
          <div
            role="radiogroup"
            aria-labelledby={`${id}-label`}
            className="inline-flex rounded-lg bg-surface-3 p-0.5"
          >
            {field.options.map((option, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={value === i}
                onClick={() => onChange(i)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs',
                  value === i ? 'bg-surface-2 font-medium text-ink-1 shadow-sm' : 'text-ink-2',
                )}
              >
                <TheirText text={option.label} inline />
              </button>
            ))}
          </div>
        ) : (
          <select
            id={id}
            value={typeof value === 'number' ? value : ''}
            onChange={(event) =>
              onChange(event.target.value === '' ? undefined : Number(event.target.value))
            }
            className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink-1"
          >
            <option value="">Choose one</option>
            {field.options.map((option, i) => (
              <option key={i} value={i}>
                {option.label}
              </option>
            ))}
          </select>
        )
      break
    case 'switch':
      control = (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={value === true}
          aria-labelledby={`${id}-label`}
          onClick={() => onChange(value !== true)}
          className={cn(
            'relative h-5 w-9 rounded-full transition-colors',
            value === true ? 'bg-accent' : 'bg-surface-3',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
              value === true ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
      )
      break
  }
  return (
    <div data-field={field.key}>
      <label
        id={`${id}-label`}
        htmlFor={id}
        className="mb-1 block text-xs font-medium [overflow-wrap:anywhere] text-ink-1"
      >
        <TheirText text={field.label} inline />
      </label>
      {control}
      {wrong ? (
        <p className="mt-1 text-xs text-critical-text">{wrong}</p>
      ) : field.hint ? (
        <p className="mt-1 text-xs [overflow-wrap:anywhere] text-ink-3">
          <TheirText text={field.hint} inline />
        </p>
      ) : null}
    </div>
  )
}
