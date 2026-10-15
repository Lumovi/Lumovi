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
 *
 * Where it doesn't all fit, its caption, verdict and buttons stay in view, and three boxes share
 * the rest by one rule (proposal-heights.ts): the plugin's options first, then the change, then
 * its command, which folds where the options would have too little. The change's box opens on the
 * change, keeps a floor of its rows whatever the form's length, wraps a long line whole, and says,
 * in Lumovi's words under it, how much of the change it shows where it's cut. Where the boxes
 * can't be measured, nothing is folded or said to be cut: the options scroll, as they did.
 */
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Info, TriangleAlert } from 'lucide-react'
import { Dialog } from 'radix-ui'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { KubeObject } from '@shared/api'
import {
  changedFields,
  fieldAt,
  fieldWrong,
  harmedVerb,
  harmsSent,
  hiddenFields,
  holdsValue,
  filled,
  PROPOSALS_OFF,
  startingValues,
  verbNow,
  type FieldValue,
  type ValueField,
  type PluginChangeAnswer,
} from '@shared/plugin-changes'
import { whose } from '@shared/plugins'
import { apiKindOf } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { DiffView, unifiedDiff } from '@renderer/components/DiffView'
import { CommandWords } from '@renderer/components/CommandWords'
import { Switch } from '@renderer/components/Switch'
import { TYPE_TO_DELETE } from '@renderer/features/actions/DeleteDialog'
import { forDiff } from '@renderer/features/assistants/ApprovalCenter'
import { refreshAfterChange } from '@renderer/hooks/change'
import { useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useMoment } from '@renderer/lib/confirm-moment'
import { share } from './proposal-heights'
import { requestBase, useProposals, type ShownProposal } from './proposals'
import { CopyButton } from '@renderer/components/CopyButton'
import { focusBack, useOpener } from '@renderer/lib/focus-back'
import { TheirText } from './TheirText'

/** Lumovi's word for an action, where the plugin's isn't the button's. */
const LUMOVIS_WORD = {
  patch: 'Change',
  create: 'Create',
  scale: 'Scale',
  delete: 'Delete',
} as const

/**
 * On each box whose height is set and then read at once (the dialog and its three): never eased.
 * (Where motion is reduced, Lumovi gives every element a 1 ms transition, and a height read
 * straight after its most changed would be the old one.)
 */
const MEASURED = 'transition-none!'
/** A box's last lines fade out while there's more of it below. */
const FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]'
/**
 * The change's box fades over less: over a further, part-shown row, never over the rows its floor
 * promises (`LINES_FADE_PX` of it).
 */
const LINES_FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-0.75rem),transparent)]'
const LINES_FADE_PX = 12
/** The change's floor: this many of its rows, whole. */
const CHANGE_ROWS = 3
/** The command's floor, in its lines. */
const COMMAND_LINES = 2
/** The line under a cut box: the gap over it; and, where it isn't there to be measured, both. */
const CUT_GAP_PX = 6
const CUT_LINE_PX = 16 + CUT_GAP_PX
/** What's under the command's heading while it's open, and not while it's folded (`mb-1`). */
const COMMAND_GAP_PX = 4

type DiffOf = ReturnType<typeof unifiedDiff>
const changed = (type: string | undefined) => type === 'added' || type === 'removed'

/**
 * A change's lines as its box opens on them: from the first changed line, with the one line
 * before it for place where there is one. No fold of unchanged lines comes first, and never the
 * object's top where the change is further down.
 */
function fromTheChange(diff: DiffOf): DiffOf {
  const first = diff.lines.findIndex((line) => changed(line.type))
  if (first <= 0) return diff
  const from = diff.lines[first - 1]!.type === 'same' ? first - 1 : first
  return { ...diff, lines: diff.lines.slice(from) }
}

/** How much of the change its box shows: its changed lines whole in view, of all of them. */
interface Counted {
  shown: number
  all: number
  /** With none whole in view: the one in part view is the first. */
  first: boolean
}

function counted(lines: HTMLElement): Counted {
  const box = lines.getBoundingClientRect()
  const rows = [
    ...lines.querySelectorAll<HTMLElement>('[data-change="added"], [data-change="removed"]'),
  ].map((row) => row.getBoundingClientRect())
  // (A line counts only when all its rows are in view.)
  const shown = rows.filter((row) => row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5)
  const first = rows[0]
  return {
    shown: shown.length,
    all: rows.length,
    first: first !== undefined && first.bottom > box.top && first.top < box.bottom,
  }
}

/**
 * Where the dialog couldn't be laid out by the rule: whether the change's box shows all it has,
 * read as plainly as it can be (what it holds against its own height), or that even that can't be
 * told. It's never silent about a box that may be cut.
 */
type Unmeasured = 'cut' | 'whole' | 'unknown'
function unmeasuredOf(lines: HTMLElement): Unmeasured {
  const [has, holds] = [lines.scrollHeight, lines.clientHeight]
  if (!Number.isFinite(has) || !Number.isFinite(holds) || holds <= 0) return 'unknown'
  return has > holds + 1 ? 'cut' : 'whole'
}
const UNMEASURED_WORDS = {
  cut: 'Scroll to see the rest of the change.',
  unknown: 'This box may not show all of the change. Scroll it to see the rest.',
} as const

/** What a cut box says under it, in Lumovi's words. */
function cutWords({ shown, all, first }: Counted): string {
  if (shown > 0) return `Shows ${shown} of ${all} changed lines. Scroll to see the rest.`
  if (all === 1) return 'Shows part of the changed line. Scroll to see the rest.'
  return `Shows part of ${first ? 'the first' : 'one'} of ${all} changed lines. Scroll to see the rest.`
}

/**
 * One of the dialog's boxes, held both ways: as a ref, read where the boxes are measured, and as
 * state, so that what watches it starts once it's there (the dialog's content is on the page a
 * drawing after the dialog is).
 */
function useBox<Box extends HTMLElement>(): [
  RefObject<Box | null>,
  Box | null,
  (element: Box | null) => void,
] {
  const ref = useRef<Box | null>(null)
  const [element, setElement] = useState<Box | null>(null)
  const set = useCallback((now: Box | null) => {
    ref.current = now
    setElement(now)
  }, [])
  return [ref, element, set]
}

/** Whether a box has more below what it shows: its last lines fade while it does. */
function useMore(element: HTMLElement | null, of: unknown): boolean {
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (!element) return
    const measure = () =>
      setMore(element.scrollTop + element.clientHeight < element.scrollHeight - 1)
    measure()
    const resized = new ResizeObserver(measure)
    resized.observe(element)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      resized.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [element, of])
  return more
}

/** How the dialog is laid out, where its boxes could be measured. */
interface Laid extends Partial<Counted> {
  /** The height is short: the command folds, and the person can open it. */
  tight: boolean
  folded: boolean
}
const sameLaid = (a: Laid, b: Laid) =>
  a.tight === b.tight &&
  a.folded === b.folded &&
  a.shown === b.shown &&
  a.all === b.all &&
  a.first === b.first

/**
 * What the three boxes would take with all the room there is, and what the dialog can give
 * them; or nothing, where any of it can't be measured.
 */
function natural(
  dialog: HTMLElement,
  options: HTMLElement | null,
  lines: HTMLElement | null,
  command: HTMLElement | null,
  cut: HTMLElement | null,
):
  | {
      room: number
      options: number
      change: number
      changeFloor: number
      row: number
      command: number
      commandFloor: number
      cutLine: number
    }
  | undefined {
  const most = parseFloat(getComputedStyle(dialog).maxHeight)
  // (As it would be with all the room there is: nothing shrunk, nothing cut.)
  dialog.style.maxHeight = 'none'
  try {
    for (const box of [options, lines, command]) if (box) box.style.maxHeight = ''
    const cutLine = cut ? cut.offsetHeight + CUT_GAP_PX : 0
    const folded = dialog.querySelector('[data-proposal-command-fold][aria-expanded="false"]')
    // Everything that never scrolls: the dialog, less its three boxes and the line under a cut one.
    const still =
      dialog.offsetHeight -
      (options?.offsetHeight ?? 0) -
      (lines?.offsetHeight ?? 0) -
      (command?.offsetHeight ?? 0) -
      cutLine +
      (folded ? COMMAND_GAP_PX : 0)
    let changeFloor = 0
    let row = 0
    if (lines) {
      const rows = [...lines.querySelectorAll<HTMLElement>('[data-change]')]
      const first = rows.findIndex((each) => changed(each.dataset.change))
      if (rows.length === 0 || lines.scrollHeight <= 0) return undefined
      if (first >= 0) {
        row = parseFloat(getComputedStyle(rows[first]!).lineHeight)
        if (!(row > 0)) return undefined
        // Three rows of the change, from the top of the box: the line before the change, where
        // there's one, comes over them, and what's between two changes is passed, never counted.
        const top = lines.getBoundingClientRect().top
        let need = CHANGE_ROWS * row
        let end = top
        for (const each of rows.slice(first)) {
          if (!changed(each.dataset.change)) continue
          const rect = each.getBoundingClientRect()
          if (!(rect.height > 0)) return undefined
          const taken = Math.min(rect.height, need)
          end = rect.top + taken
          need -= taken
          if (need <= 0.5) break
        }
        changeFloor = end - top
        // (More below them: the fade lies over a further row, never over these.)
        if (changeFloor < lines.scrollHeight - 0.5) changeFloor += LINES_FADE_PX
        changeFloor = Math.min(Math.ceil(changeFloor), lines.scrollHeight)
      }
    }
    let commandFloor = 0
    if (command) {
      const line = parseFloat(getComputedStyle(command).lineHeight)
      if (!(line > 0)) return undefined
      commandFloor = Math.ceil(COMMAND_LINES * line)
    }
    return {
      room: most - still,
      options: options?.scrollHeight ?? 0,
      change: lines?.scrollHeight ?? 0,
      changeFloor,
      row,
      command: command?.scrollHeight ?? 0,
      commandFloor,
      cutLine,
    }
  } finally {
    dialog.style.maxHeight = ''
  }
}

export function ProposalDialog(): ReactNode {
  const shown = useProposals((state) => state.shown)
  return shown ? <Proposal shown={shown} /> : null
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
  // Fields a switch that's off shows: hidden, and left out of the change.
  const hidden = hiddenFields(proposed.fields, values)
  // (A number's field as typed: what isn't a whole number yet is said so, never lost.)
  const [typing, setTyping] = useState<Record<string, string>>({})
  const change = useMemo(() => filled(proposed, values), [proposed, values])
  const key = typeof change === 'string' ? undefined : JSON.stringify(change)
  const [tried, setTried] = useState<{ key: string; round: number; answer: PluginChangeAnswer }>()
  const [round, setRound] = useState(0)
  const [moved, setMoved] = useState(false)
  const opener = useOpener()
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

  // What the change's box shows: a create's whole object, which is all change; any other, from
  // its first changed line.
  const diff = useMemo(() => {
    if (!answer?.ok || proposed.action === 'delete' || typeof change === 'string') return undefined
    return proposed.action === 'create'
      ? unifiedDiff('', forDiff((answer.sent ?? answer.after) as KubeObject))
      : fromTheChange(
          unifiedDiff(forDiff(answer.before as KubeObject), forDiff(answer.after as KubeObject)),
        )
  }, [answer, proposed.action, change])

  // Who gets the height (proposal-heights.ts): each box's most, set here from what the boxes
  // would take with all the room there is; and how much of the change its box then shows.
  const sendsId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [optionsRef, optionsBox, setOptionsBox] = useBox<HTMLDivElement>()
  const [linesRef, linesBox, setLinesBox] = useBox<HTMLDivElement>()
  const [commandRef, commandBox, setCommandBox] = useBox<HTMLElement>()
  const cutRef = useRef<HTMLParagraphElement>(null)
  const optionsMost = useRef<number>(undefined)
  const [opened, setOpened] = useState(false)
  const [laid, setLaid] = useState<Laid>()
  const [unmeasured, setUnmeasured] = useState<Unmeasured>()
  const fit = useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const boxes = [optionsRef.current, linesRef.current, commandRef.current] as const
    const [options, lines, command] = boxes
    // (Measured with nothing cut, which takes each box to its top: put back where it was.)
    const scrolled = boxes.map((box) => box?.scrollTop ?? 0)
    const sizes = natural(dialog, options, lines, command, cutRef.current)
    let shared = sizes && share({ ...sizes, opened })
    // A cut box says so under it: that line's row comes out of what's shared.
    if (sizes && shared && shared.change < sizes.change) {
      shared = share({ ...sizes, opened, room: sizes.room - (sizes.cutLine || CUT_LINE_PX) })
    }
    if (!sizes || !shared) {
      // Not measured, or not to be laid out by the rule: the heights it has by itself, with
      // nothing folded. The options give way first, and the change's box keeps its floor by its
      // own style; whether it then shows all it has is said under it, as plainly as it's known.
      boxes.forEach((box, i) => {
        if (box) box.scrollTop = scrolled[i]!
      })
      setLaid(undefined)
      setUnmeasured(lines ? unmeasuredOf(lines) : undefined)
      return
    }
    setUnmeasured(undefined)
    let changeHeight = shared.change
    if (changeHeight < sizes.change && sizes.row > 0) {
      // Cut at a row's edge and the fade's depth past it: the fade lies over a part-shown row.
      const over = (changeHeight - LINES_FADE_PX) % sizes.row
      changeHeight = Math.max(sizes.changeFloor, changeHeight - over)
    }
    const most = (box: HTMLElement | null, height: number, whole: number) => {
      if (box) box.style.maxHeight = height < whole ? `${Math.round(height)}px` : ''
    }
    most(options, shared.options, sizes.options)
    most(lines, changeHeight, sizes.change)
    if (shared.folded && command) command.style.maxHeight = '0px'
    else most(command, shared.command, sizes.command)
    boxes.forEach((box, i) => {
      if (box) box.scrollTop = scrolled[i]!
    })
    // The focused field stays in view where the options' height changed under it.
    const optionsHeight = options ? Math.round(Math.min(shared.options, sizes.options)) : undefined
    const focused = document.activeElement
    if (
      options &&
      optionsMost.current !== optionsHeight &&
      focused instanceof HTMLElement &&
      options.contains(focused)
    ) {
      focused.closest('[data-field]')?.scrollIntoView({ block: 'nearest' })
    }
    optionsMost.current = optionsHeight
    const now: Laid = {
      tight: shared.tight,
      folded: shared.folded,
      ...(lines ? counted(lines) : {}),
    }
    setLaid((was) => (was && sameLaid(was, now) ? was : now))
  }, [opened, optionsRef, linesRef, commandRef])
  // After every drawing of it: what it holds may have changed (the cluster's answer, a field's
  // words). Applied twice it's the same, so it settles at once.
  useLayoutEffect(() => {
    fit()
  })
  useEffect(() => {
    window.addEventListener('resize', fit)
    // (And once the page's own fonts are in: a row's height is its font's.)
    void document.fonts.ready.then(fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])
  // The count follows the box as the person scrolls it.
  useEffect(() => {
    const lines = linesBox
    if (!lines) return
    const recount = () =>
      setLaid((was) => {
        if (!was) return was
        const now = { ...was, ...counted(lines) }
        return sameLaid(was, now) ? was : now
      })
    lines.addEventListener('scroll', recount, { passive: true })
    return () => lines.removeEventListener('scroll', recount)
  }, [linesBox])
  const optionsMore = useMore(optionsBox, proposed.fields)
  const linesMore = useMore(linesBox, diff)
  const cut = laid?.all !== undefined && laid.all > 0 && laid.shown! < laid.all
  // What's said under the change's box, where anything is: how much of it shows, counted; or,
  // where it couldn't be measured, that there's more of it, or that there may be.
  const under = cut
    ? cutWords(laid as Counted)
    : unmeasured === 'cut' || unmeasured === 'unknown'
      ? UNMEASURED_WORDS[unmeasured]
      : undefined
  // Lumovi's own words, on a line of their own and never a row of the box: under it where the
  // rule laid the dialog out and counted that line's room (6 px under: CUT_GAP_PX, less than the
  // gap the others keep); over it where nothing was measured.
  const said = under && (
    <p
      ref={cutRef}
      id={`${sendsId}-cut`}
      data-proposal-cut
      className={cn('shrink-0 text-xs text-ink-2', unmeasured === undefined && '-mt-1')}
    >
      {under}
    </p>
  )

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
  // What does harm: the file's, where what this sends holds it, and what the page adds. Drawn in
  // red, and named on the button, whatever the page's code says.
  const fileKind =
    proposed.kind ?? `${kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : ''}/${apiKind}`
  const fileHarm = by.changes?.find((each) => each.kind === fileKind)?.harm ?? []
  const fired =
    typeof change === 'object' && change.body !== undefined
      ? harmsSent(proposed, change.body, fileHarm)
      : []
  const ownHarm = (proposed.harm ?? []).filter((each) => each.path === undefined)
  const harmDetail = (path: string) =>
    (proposed.harm ?? []).filter((each) => each.path === path && each.detail)
  const harmed = !danger && fired.length + ownHarm.length > 0
  // (The page's word, or a switch's that's on: Dry run.)
  const verb = verbNow(proposed, values) ?? LUMOVIS_WORD[proposed.action]
  const word = danger
    ? LUMOVIS_WORD.delete
    : harmed
      ? harmedVerb(verb, [...fired, ...ownHarm])
      : verb
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
      // (Before the dialog goes: the button pressed for it is busy in the same moment.)
      proposal.applied?.()
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
          ref={dialogRef}
          aria-describedby={undefined}
          data-plugin-proposal={by.plugin}
          // (Closed: back to the button it was opened from, or the busy one in its place.)
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusBack(opener)
          }}
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
          className={cn(
            'fixed top-12 left-1/2 z-50 flex max-h-[calc(100vh-96px)] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none',
            MEASURED,
          )}
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

          {/* When it doesn't all fit, the three boxes share the height (`fit`): the options under
              their heading, the object in its box, the command in its own. What Lumovi will send's
              caption, the verdict, the cautions and the buttons stay in view, however tall the
              object. (Unmeasured, the options give way first and scroll, then the object.) */}
          {proposed.fields.length > 0 && (
            <section
              aria-label={`Options, in ${whose(by.label)} words`}
              data-proposal-options
              className="flex min-h-0 shrink-[1000] flex-col overflow-hidden border-t border-line px-5 py-3"
            >
              <p className="mb-2 shrink-0 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                Options, in {whose(by.label)} words
              </p>
              {/* (A little wider and taller than its fields: a focused field's ring isn't cut.) */}
              <div
                ref={setOptionsBox}
                data-proposal-fields
                className={cn(
                  '-mx-1 -my-1 min-h-0 space-y-3 overflow-y-auto px-1 py-1',
                  MEASURED,
                  optionsMore && FADE,
                )}
              >
                {proposed.fields.map((field, at) =>
                  // A section's heading: the fields after it stand under it, until the next.
                  !holdsValue(field) ? (
                    <h4
                      key={`section-${at}`}
                      className="pt-1 text-xs font-semibold [overflow-wrap:anywhere] text-ink-2"
                    >
                      <TheirText text={field.label} inline />
                    </h4>
                  ) : hidden.has(field.key) ? null : (
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
                  ),
                )}
              </div>
            </section>
          )}

          {/* What it harms, in red: its file's words for what this sends, the page's detail under
              them as its own words, and any harm the page adds. Never fewer than its file says. */}
          {harmed && (
            <section aria-label="What it harms" className="shrink-0 border-t border-line px-5 py-3">
              <p className="mb-1.5 text-2xs font-medium tracking-wider text-critical-text uppercase">
                What it harms
              </p>
              <ul className="space-y-1.5 text-xs [overflow-wrap:anywhere]">
                {fired.map((harm) => (
                  <li key={harm.path} className="text-critical-text">
                    <TheirText text={{ their: harm.says }} inline />
                    {harmDetail(harm.path).map((each, i) => (
                      <span key={i} className="mt-0.5 block text-ink-2">
                        In {whose(by.label)} words:{' '}
                        <TheirText text={{ their: each.detail! }} inline />
                      </span>
                    ))}
                  </li>
                ))}
                {ownHarm.map((each, i) => (
                  <li key={`own-${i}`} className="text-critical-text">
                    In {whose(by.label)} words: <TheirText text={{ their: each.says! }} inline />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* (Where nothing sets the heights, the options give way before this does, and then only
              the change's box, down to its floor. In a window too short even for that, what's
              over is cut here, never laid over the buttons.) */}
          <section className="flex min-h-0 shrink flex-col gap-2.5 overflow-hidden border-t border-line px-5 py-3">
            <p
              id={sendsId}
              className="shrink-0 text-2xs font-medium tracking-wider text-ink-3 uppercase"
            >
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
              diff && (
                <>
                  {/* (Where nothing was measured, the line is over the box: a part cut from its
                      bottom, in a window too short, keeps its top.) */}
                  {unmeasured !== undefined && said}
                  {/* Its box, on the dialog's own ground as Lumovi's other changes are: its lines
                      scroll inside it, up and down only, and a long line wraps whole. (Its first
                      row 8 px under the caption: nothing stands between them.) */}
                  <div
                    ref={setLinesBox}
                    data-proposal-object
                    role="region"
                    aria-labelledby={sendsId}
                    aria-describedby={under ? `${sendsId}-cut` : undefined}
                    tabIndex={0}
                    className={cn(
                      '-mt-0.5 shrink overflow-x-hidden overflow-y-auto rounded-lg text-[12px] leading-[1.7] outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      // Its floor wherever nothing sets its height: three rows (CHANGE_ROWS) of its
                      // lines' own height, where the change has that many.
                      diff.lines.length >= CHANGE_ROWS ? 'min-h-[3lh]' : 'min-h-0',
                      MEASURED,
                      linesMore && LINES_FADE,
                    )}
                  >
                    <DiffView
                      diff={diff}
                      label={
                        proposed.action === 'create'
                          ? 'The whole object Lumovi will create'
                          : 'Changes'
                      }
                      wraps
                      flush
                    />
                  </div>
                  {unmeasured === undefined && said}
                </>
              )
            )}
            {answer?.ok && answer.command && (
              <Command
                command={answer.command}
                create={proposed.action === 'create'}
                box={setCommandBox}
                element={commandBox}
                tight={laid?.tight === true}
                folded={laid?.folded === true}
                onToggle={() => setOpened(laid?.folded === true)}
              />
            )}
            <div className="shrink-0">
              <Verdict
                asking={key !== undefined && !answer}
                answer={answer}
                refused={refused}
                under={refusedField !== undefined}
                options={proposed.fields.length > 0}
              />
            </div>
          </section>

          {/* What's at stake, by the buttons: never scrolled away from the press. */}
          <div data-proposal-cautions className="shrink-0 space-y-2.5 px-5 pb-3 empty:hidden">
            {moved && (
              <p className="bg-warning/10 text-warning-text flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {apiKind} {target?.name} changed since this was shown. Here is the change again, as
                it stands now.
              </p>
            )}
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
                  : what {answer.finalizers.length === 1 ? 'that does' : 'they do'} runs first, and
                  the cluster deletes it once that’s done.
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
          </div>

          <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            <Button data-cancel onClick={cancel}>
              Cancel
            </Button>
            <Button
              data-confirm
              variant={danger || harmed ? 'danger' : 'primary'}
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
 * The command a person could run instead, as Lumovi would. A create's reads its object from what
 * follows it (a heredoc): that's the object shown above, so it's said in a line, not printed again.
 * Copy copies the whole of it.
 */
function Command({
  command,
  create,
  box,
  element,
  tight,
  folded,
  onToggle,
}: {
  command: string
  create: boolean
  /** Its box, for the dialog to measure; and the box itself, once it's there. */
  box: (element: HTMLElement | null) => void
  element: HTMLElement | null
  /** The height is short: its heading's row is a button that folds it and opens it in place. */
  tight: boolean
  /** Folded to its heading's row: not seen, and still read by a screen reader and copied. */
  folded: boolean
  onToggle: () => void
}) {
  const lines = command.split('\n')
  // (Its end, as the first line names it: LUMOVI_EOF, or LUMOVI_EOF_2 where the object has that line.)
  const end = /<<'(LUMOVI_EOF(?:_\d+)?)'$/.exec(lines[0] ?? '')?.[1]
  const heredoc = create && end !== undefined && lines.length > 2 && lines.at(-1) === end
  const objectLines = lines
    .slice(1, -1)
    .filter((line, i, all) => i < all.length - 1 || line !== '').length
  // A long change's command scrolls in its own box: while there's more of it below, its last
  // lines fade out.
  const more = useMore(element, command)
  return (
    <div className="shrink-0 rounded-lg bg-surface-3/70 px-3 py-2.5">
      {/* (Its gap under it is counted in the dialog's heights: COMMAND_GAP_PX.) */}
      <div className={cn('flex items-center justify-between gap-2', !folded && 'mb-1')}>
        {tight ? (
          <button
            type="button"
            data-proposal-command-fold
            aria-expanded={!folded}
            aria-label={folded ? 'Show the command' : 'Hide the command'}
            onClick={onToggle}
            className="-my-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3 shrink-0 text-ink-3', !folded && 'rotate-90')}
            />
            <span className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
              Equivalent command
            </span>
          </button>
        ) : (
          <p className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Equivalent command
          </p>
        )}
        <CopyButton text={command} label="Copy the command" />
      </div>
      {/* (It never pushes the buttons off. A region the keyboard can scroll.) */}
      <code
        ref={box}
        data-proposal-command
        role="region"
        aria-label="Equivalent command"
        tabIndex={folded ? -1 : 0}
        className={cn(
          'block max-h-24 overflow-y-auto rounded-sm font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2 outline-none selectable focus-visible:ring-2 focus-visible:ring-accent',
          MEASURED,
          more && !folded && FADE,
        )}
      >
        {heredoc ? (
          <>
            <CommandWords text={lines[0] ?? ''} />
            {'\n'}
            <span className="font-sans text-ink-3 select-none">
              the object above, {objectLines} {objectLines === 1 ? 'line' : 'lines'}
            </span>
            {'\n'}
            {end}
          </>
        ) : (
          <CommandWords text={command} />
        )}
      </code>
    </div>
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
  field: ValueField
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
    case 'check':
      // (Its label is beside the box, and the box is the field: drawn whole below.)
      return (
        <div data-field={field.key}>
          <label className="flex items-start gap-2.5 text-xs text-ink-1">
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium">
                <TheirText text={field.label} inline />
              </span>
              {field.hint && (
                <span className="mt-0.5 block text-ink-3">
                  <TheirText text={field.hint} inline />
                </span>
              )}
            </span>
          </label>
          {wrong && <p className="mt-1 text-xs text-critical-text">{wrong}</p>}
        </div>
      )
    case 'picks': {
      // Several of a list: a box each, in a box of its own that scrolls past a few.
      const picked = new Set(Array.isArray(value) ? value : [])
      control = (
        <div
          id={id}
          role="group"
          aria-labelledby={`${id}-label`}
          className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-surface px-2.5 py-1.5"
        >
          {field.options.map((option, i) => (
            <label key={i} className="flex items-center gap-2 text-xs text-ink-1">
              <input
                type="checkbox"
                checked={picked.has(i)}
                onChange={(event) => {
                  const next = new Set(picked)
                  if (event.target.checked) next.add(i)
                  else next.delete(i)
                  onChange(field.options.flatMap((_, at) => (next.has(at) ? [at] : [])))
                }}
                className="size-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0 truncate">
                <TheirText text={option.label} inline />
              </span>
            </label>
          ))}
        </div>
      )
      break
    }
    case 'switch':
      // (Lumovi's own, named by the plugin's label above it.)
      control = (
        <Switch
          id={id}
          labelledBy={`${id}-label`}
          checked={value === true}
          onCheckedChange={(on) => onChange(on)}
        />
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
