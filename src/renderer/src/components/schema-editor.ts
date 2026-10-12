/**
 * What the YAML editor knows of the cluster's schemas (CodeEditor's `schema`): what's wrong,
 * underlined before the dry run, with a mark in the gutter and a count under the editor that
 * opens the list of them; a field's description under the pointer; and the fields an object can
 * have offered as they're typed.
 *
 * Two kinds of problem, told apart by shape and icon as well as colour: an error is what the
 * cluster would refuse, a warning what it would take and drop without a word. They're checked
 * half a second after typing stops, in a worker, so a long document never holds the typing; and
 * nothing here stops Save or Create: the dry run still decides.
 *
 * A description is the cluster's text (a CRD's author wrote it): drawn as text, never as markup
 * or a link, and in pieces, as TheirText draws a text that isn't Lumovi's; so are a field's names,
 * its values, and what a problem quotes of the document.
 */
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  currentCompletions,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import {
  forceLinting,
  forEachDiagnostic,
  linter,
  lintGutter,
  nextDiagnostic,
  previousDiagnostic,
  type Diagnostic,
} from '@codemirror/lint'
import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  closeHoverTooltips,
  EditorView,
  hoverTooltip,
  keymap,
  showPanel,
  showTooltip,
  ViewPlugin,
  type Panel,
  type Tooltip,
} from '@codemirror/view'
import type { FieldSchema } from '@shared/api'
import { inPieces, spelled, type Piece } from '@shared/kit/characters'
import type { SchemaSource } from '@renderer/hooks/schema-source'
import { createChecker, type Checker, type Known } from '@renderer/lib/yaml-checker'
import {
  isDeprecated,
  placeAt,
  schemaAt,
  typeName,
  type DocumentKind,
  type Problem,
} from '@renderer/lib/yaml-schema'
import { MARK_CLASS } from '@renderer/plugins/TheirText'
import { ALT_KEY } from './Kbd'

/** How long after typing stops the text is checked. */
const PAUSE = 500
/** The app's tooltip wait (App.tsx), for a description under the pointer. */
const HOVER = 500
/** Rows the completion list shows before it scrolls. */
const ROWS = 8

// ——— Drawing ———

type Child = Node | string | null | undefined | false

/** An element, its class, and what's in it: text is always a text node, never markup. */
function h(tag: string, className: string, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  for (const child of children) {
    if (child) element.append(child)
  }
  return element
}

const SVG = 'http://www.w3.org/2000/svg'
/** The two icons, as the app draws them (lucide's circle-x and triangle-alert). */
const ICONS = {
  error: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm15 9-6 6' }],
    ['path', { d: 'm9 9 6 6' }],
  ],
  warning: [
    ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
} as const

function icon(kind: Problem['severity'], size: number): SVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: `cm-schema-icon cm-schema-${kind}`,
  })) {
    svg.setAttribute(name, value)
  }
  for (const [tag, attributes] of ICONS[kind]) {
    const part = document.createElementNS(SVG, tag)
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value)
    svg.append(part)
  }
  return svg
}

const kbd = (keys: string) => h('kbd', '', keys)

/** A piece, drawn as TheirText draws it: a mark is the character's code point in a hairline box. */
function pieceNode(piece: Piece, oneLine: boolean): Node {
  if (typeof piece === 'string') {
    return document.createTextNode(oneLine ? piece.replace(/[\n\t]/g, ' ') : piece)
  }
  const more = 'more' in piece ? piece.more.toLocaleString('en-US') : undefined
  const unseen = 'unseen' in piece ? piece.unseen : ''
  const words = h('span', '', more ? `and ${more} more` : unseen)
  words.setAttribute('aria-hidden', 'true')
  const mark = h('span', MARK_CLASS, words)
  mark.setAttribute('role', 'img')
  mark.setAttribute(
    'aria-label',
    more ? `and ${more} more invisible characters` : `invisible character ${unseen}`,
  )
  mark.dataset.mark = ''
  return mark
}

/**
 * A text that isn't Lumovi's (a description, a field's name, a value) as TheirText draws it: an
 * island of its own direction, what would turn it round or can't be seen a mark. On one line,
 * unless `lines`.
 */
function theirs(text: string, lines = false): HTMLElement {
  const element = h('bdi', 'text-left', ...inPieces(text).map((piece) => pieceNode(piece, !lines)))
  element.dir = 'auto'
  element.dataset.theirText = ''
  return element
}

/** A field's path as a card shows it: any item of a list, not one ("containers[].image"). */
const pathOf = (parts: readonly (string | number)[]) =>
  parts.reduce<string>(
    (text, part) => (typeof part === 'number' ? `${text}[]` : text ? `${text}.${part}` : part),
    '',
  )

/** A sentence after "Error: ", its first word lowered where it's one of Lumovi's own. */
const after = (sentence: string) =>
  /^(A|An|Text|True|This)\b/.test(sentence)
    ? sentence[0]!.toLowerCase() + sentence.slice(1)
    : sentence

/** The card of a problem: what it is, where, and what the cluster would do. */
function problemCard(problem: Problem): HTMLElement {
  const error = problem.severity === 'error'
  return h(
    'div',
    'cm-schema-card',
    h(
      'div',
      `cm-schema-head cm-schema-${problem.severity}`,
      icon(problem.severity, 14),
      h('span', '', h('b', '', error ? 'Error' : 'Warning'), ': ', theirs(after(problem.message))),
    ),
    problem.path &&
      h('div', 'cm-schema-where', theirs([problem.path, problem.type].filter(Boolean).join(' · '))),
    h(
      'div',
      'cm-schema-would',
      error ? 'The cluster would refuse it.' : 'The cluster would drop it without saying so.',
    ),
  )
}

/** The type line of a field's card: its type, then "required", its values, or its default. */
function typeLine(field: FieldSchema, required: boolean): HTMLElement {
  const parts: Child[] = [typeName(field) && h('code', '', typeName(field))]
  if (required) parts.push(h('span', 'cm-schema-tag', 'required'))
  if (field.enum?.length) {
    parts.push(
      h('span', '', 'one of'),
      ...field.enum.map((value) => h('code', '', theirs(String(value)))),
    )
  }
  if (field.default !== undefined && typeof field.default !== 'object') {
    parts.push(h('span', '', 'default'), h('code', '', theirs(String(field.default))))
  }
  return h('div', 'cm-schema-type', ...parts)
}

/**
 * A field's card: its path, its type, and its description as the cluster wrote it; past 216 px
 * it fades and scrolls inside. `closes` says esc closes it (where the keyboard opened it).
 */
function fieldCard(
  path: readonly (string | number)[],
  field: FieldSchema,
  required: boolean,
  from: string,
  closes = false,
): HTMLElement {
  const description = field.description
    ? h('div', 'cm-schema-description', theirs(field.description, true))
    : undefined
  const foot = h('div', 'cm-schema-from', from)
  const card = h(
    'div',
    'cm-schema-card cm-schema-field',
    h('div', 'cm-schema-path', theirs(pathOf(path))),
    typeLine(field, required),
    description,
    foot,
  )
  if (closes) foot.append(' · esc to close')
  // Once it's drawn: a description longer than the card holds fades, and says it scrolls.
  requestAnimationFrame(() => {
    if (description && description.scrollHeight > description.clientHeight + 1) {
      description.classList.add('cm-schema-long')
      description.tabIndex = 0
      foot.prepend('Scroll for the rest · ')
    }
  })
  return card
}

// ——— The check ———

/** Said when a schema the editor waited for has come: the text is checked again. */
const schemasCame = StateEffect.define<null>()

/** Whether the text went unchecked: too long to check on the page, where no worker started. */
const setUnchecked = StateEffect.define<boolean>()
const unchecked = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) =>
    tr.effects.reduce((was, effect) => (effect.is(setUnchecked) ? effect.value : was), value),
})

/** Each problem's diagnostic, kept to draw its card and its row. */
const problemOf = new WeakMap<Diagnostic, Problem>()

/** The editor's own checker: one worker each, let go of with the editor. */
const checking = ViewPlugin.define(() => {
  const checker = createChecker()
  return { checker, destroy: () => checker.close() }
})

/** What's known of a document's kind, as the check takes it. */
const knownOf =
  (source: SchemaSource) =>
  (kind: DocumentKind): Known | undefined => {
    const known = source.get(kind.apiVersion, kind.kind)
    return known && { schema: known.schema, words: known.words }
  }

function check(source: SchemaSource, onKinds: (kinds: DocumentKind[]) => void) {
  return linter(
    async (view) => {
      const checker: Checker | undefined = view.plugin(checking)?.checker
      if (!checker) return []
      const answer = await checker.check(view.state.doc.toString(), knownOf(source))
      onKinds(answer.kinds)
      if (Boolean(answer.unchecked) !== view.state.field(unchecked)) {
        view.dispatch({ effects: setUnchecked.of(Boolean(answer.unchecked)) })
      }
      const length = view.state.doc.length
      return answer.problems.map((problem) => {
        const from = Math.min(problem.from, length)
        const diagnostic: Diagnostic = {
          from,
          to: Math.min(Math.max(problem.to, from), length),
          severity: problem.severity,
          message: problem.message,
          renderMessage: () => problemCard(problem),
        }
        problemOf.set(diagnostic, problem)
        return diagnostic
      })
    },
    {
      delay: PAUSE,
      needsRefresh: (update) =>
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(schemasCame))),
    },
  )
}

// ——— A card at the caret: a problem's (F8), or a field's (⌥F1) ———

const showCard = StateEffect.define<{ at: number; dom: () => HTMLElement } | null>()

const card = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(showCard)) {
        const shown = effect.value
        return (
          shown && {
            pos: shown.at,
            above: false,
            // (Opened from the keyboard: Escape is its, before anything round the editor's.
            // Held in a frame of its own, as a card under the pointer is.)
            create: () => ({ dom: h('div', 'cm-schema-keyed', shown.dom()) }),
          }
        )
      }
    }
    // It goes as the text or the caret moves on.
    return tr.docChanged || tr.selection ? null : value
  },
  provide: (field) => showTooltip.from(field),
})

/** A card that's open: one opened from the keyboard, or a problem's (F8 opens the lint's own). */
const closeCard = (view: EditorView) => {
  if (view.state.field(card, false)) {
    view.dispatch({ effects: showCard.of(null) })
    return true
  }
  if (view.dom.querySelector('.cm-tooltip-lint')) {
    view.dispatch({ effects: closeHoverTooltips })
    return true
  }
  return false
}

/**
 * Escape closes what the editor has open (a completion, a card opened from the keyboard) before
 * anything round the editor hears it: a dialog it's in closes on Escape too, and takes the key
 * first, as the page's own (capturing) listener. So it's taken here, earlier still, at the
 * window, only while one of those is open, and the key goes no further.
 */
const escapeFirst = ViewPlugin.define((view) => {
  const take = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !view.dom.contains(event.target as Node)) return
    const closed =
      (completionStatus(view.state) === 'active' && closeCompletion(view)) || closeCard(view)
    if (!closed) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  window.addEventListener('keydown', take, true)
  return { destroy: () => window.removeEventListener('keydown', take, true) }
})

// ——— What's at a place: a field and its schema ———

interface FieldAt {
  path: (string | number)[]
  field: FieldSchema
  required: boolean
  from: string
}

function fieldAt(source: SchemaSource, state: EditorState, offset: number): FieldAt | undefined {
  const place = placeAt(state.doc.toString(), offset)
  if (!place?.kind || !place.key.text) return undefined
  const known = source.get(place.kind.apiVersion, place.kind.kind)
  if (!known?.schema) return undefined
  const holder = schemaAt(known.schema, place.parent)
  const field = holder && schemaAt(holder, [place.key.text])
  if (!field) return undefined
  return {
    path: [...place.parent, place.key.text],
    field,
    required: holder.required?.includes(place.key.text) ?? false,
    from: known.from,
  }
}

function describe(source: SchemaSource) {
  return hoverTooltip(
    (view, offset) => {
      const place = placeAt(view.state.doc.toString(), offset)
      // Only on a key: what's under the pointer is the field's own name.
      if (!place || offset < place.key.from || offset > place.key.to) return null
      const found = fieldAt(source, view.state, place.key.from)
      if (!found) return null
      return {
        pos: place.key.from,
        end: place.key.to,
        above: false,
        create: () => ({
          dom: fieldCard(found.path, found.field, found.required, found.from),
        }),
      }
    },
    { hoverTime: HOVER },
  )
}

/** ⌥F1: the description of the field at the caret, as under the pointer. */
const describeAtCaret =
  (source: SchemaSource) =>
  (view: EditorView): boolean => {
    const at = view.state.selection.main.head
    const place = placeAt(view.state.doc.toString(), at)
    const found = place && fieldAt(source, view.state, place.key.from)
    if (!found || !place) return false
    view.dispatch({
      effects: showCard.of({
        at: place.key.from,
        dom: () => fieldCard(found.path, found.field, found.required, found.from, true),
      }),
    })
    return true
  }

// ——— Completion ———

/**
 * How a schema's name or value is shown in a completion row, which CodeMirror draws as plain
 * text: one with a character that would be a mark has it spelled ("U+202E").
 */
const shownAs = (label: string): { displayLabel?: string } =>
  spelled(label) === label ? {} : { displayLabel: spelled(label) }

interface Offer extends Completion {
  field?: FieldSchema
  required?: boolean
  set?: number
  isDefault?: boolean
}

function complete(source: SchemaSource) {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.toString()
    const place = placeAt(text, context.pos)
    if (!place?.kind) return null
    const known = source.get(place.kind.apiVersion, place.kind.kind)
    if (!known?.schema) return null
    const typed = place.value ? place.value.text : place.key.text
    const lower = typed.toLowerCase()
    const match = (label: string) => label.toLowerCase().indexOf(lower)
    // (Found as written, or as shown: a name with a mark is shown spelled, "U+202E" in it.)
    const found = (label: string) => match(label) !== -1 || match(spelled(label)) !== -1

    if (place.value) {
      // After a key's colon: its values.
      const field = schemaAt(known.schema, [...place.parent, place.key.text])
      const values = field?.enum?.length
        ? field.enum
        : typeName(field ?? {}) === 'boolean'
          ? [true, false]
          : []
      if (!field || values.length === 0) return null
      const options: Offer[] = values
        .map(String)
        .filter(found)
        .map((label) => ({ label, ...shownAs(label), isDefault: String(field.default) === label }))
      return {
        from: place.value.from,
        options,
        filter: false,
        getMatch: (option) => {
          const at = match(option.displayLabel ?? option.label)
          return at === -1 || !lower ? [] : [at, at + lower.length]
        },
      }
    }

    // At a key's start: the fields of the object it's in.
    if (!context.explicit && !place.key.text && !context.matchBefore(/\w/)) return null
    const holder = schemaAt(known.schema, place.parent)
    if (!holder?.properties) return null
    const set = new Map(place.siblings.map((each) => [each.name, each.at]))
    const required = new Set(holder.required ?? [])
    const indent = ' '.repeat(
      Math.max(0, place.key.from - context.state.doc.lineAt(place.key.from).from),
    )
    const rank = (offer: Offer) =>
      offer.set !== undefined ? 3 : isDeprecated(offer.field) ? 2 : offer.required ? 0 : 1
    const options: Offer[] = Object.entries(holder.properties)
      .filter(([name]) => found(name))
      .map(([name, field]) => {
        const type = typeName(field)
        const opens = type === 'object' || type === 'map' || type === 'list'
        return {
          label: name,
          ...shownAs(name),
          field,
          required: required.has(name),
          set: set.get(name),
          apply: (view: EditorView, _offer: Completion, from: number, to: number) => {
            const there = set.get(name)
            // One already set: taking it goes to it.
            if (there !== undefined) {
              view.dispatch({ selection: { anchor: there }, scrollIntoView: true })
              return
            }
            const inner = `${indent}  ${type === 'list' ? '- ' : ''}`
            const insert = opens ? `${name}:\n${inner}` : `${name}: `
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
              scrollIntoView: true,
            })
          },
          info: () => fieldCard([...place.parent, name], field, required.has(name), known.from),
        }
      })
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    return {
      from: place.key.from,
      to: place.key.to,
      options,
      filter: false,
      getMatch: (option) => {
        const at = match(option.displayLabel ?? option.label)
        return at === -1 || !lower ? [] : [at, at + lower.length]
      },
    }
  }
}

/** What a completion row has beside its name: "required", "already set", "default", its type. */
const besideName = {
  position: 80,
  render(completion: Completion) {
    const offer = completion as Offer
    const deprecated = isDeprecated(offer.field)
    return h(
      'span',
      'cm-schema-beside',
      offer.required && offer.set === undefined && h('span', 'cm-schema-tag', 'required'),
      offer.isDefault && h('span', 'cm-schema-quiet', 'default'),
      offer.set !== undefined && h('span', 'cm-schema-quiet', 'already set'),
      offer.field && h('span', 'cm-schema-kind', deprecated ? 'deprecated' : typeName(offer.field)),
    )
  },
}

/** The list's foot: how to take one, or how many more there are. */
const completionFoot = ViewPlugin.define((view) => {
  let foot: HTMLElement | undefined
  const draw = () => {
    const list = view.dom.querySelector('.cm-tooltip-autocomplete')
    if (!list) return
    if (!foot || !list.contains(foot)) {
      foot = h('div', 'cm-schema-foot-list')
      list.append(foot)
    }
    const all = currentCompletions(view.state).length
    foot.textContent =
      all > ROWS ? `${ROWS} of ${all} · ↑↓ for more` : '↵ or tab to take · esc to close'
  }
  return {
    update(update) {
      if (completionStatus(update.state) === 'active') requestAnimationFrame(draw)
    },
  }
})

// ——— Under the editor: the count, and the list ———

const toggleList = StateEffect.define<boolean | null>()

const listOpen = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    for (const effect of tr.effects) {
      if (effect.is(toggleList)) return effect.value ?? !open
    }
    return open
  },
})

interface Row {
  diagnostic: Diagnostic
  from: number
  problem?: Problem
}

function rowsOf(state: EditorState): Row[] {
  const rows: Row[] = []
  forEachDiagnostic(state, (diagnostic, from) =>
    rows.push({ diagnostic, from, problem: problemOf.get(diagnostic) }),
  )
  return rows.sort((a, b) => a.from - b.from)
}

const goTo = (view: EditorView, at: number) => {
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
  view.focus()
}

/** "1 error · 1 warning", pressable: it opens the list. None, and it isn't there. */
function footPanel(view: EditorView): Panel {
  const dom = h('div', 'cm-schema-foot')
  // What it says, drawn again only when that changes. (A node taken away while the focus moves
  // from one field to the next, which a form's own change can do, makes a dialog's focus trap
  // take the focus instead: Tab would land nowhere.)
  let said = ''
  const draw = (state: EditorState) => {
    const rows = rowsOf(state)
    const errors = rows.filter((row) => row.diagnostic.severity === 'error').length
    const warnings = rows.length - errors
    const now = [state.field(unchecked), errors, warnings, state.field(listOpen)].join(' ')
    if (now === said) return
    said = now
    if (state.field(unchecked)) {
      dom.hidden = false
      dom.replaceChildren(
        h(
          'span',
          'cm-schema-hint cm-schema-unchecked',
          'This YAML is too long to check as you type here. The cluster still checks it before anything changes.',
        ),
      )
      return
    }
    dom.hidden = rows.length === 0
    const count = h(
      'button',
      'cm-schema-count',
      errors > 0 &&
        h(
          'span',
          'cm-schema-error',
          icon('error', 13),
          `${errors} ${errors === 1 ? 'error' : 'errors'}`,
        ),
      // (Spaces between, which the layout drops and a reader reads.)
      errors > 0 && warnings > 0 && ' ',
      errors > 0 && warnings > 0 && h('span', 'cm-schema-dot', '·'),
      errors > 0 && warnings > 0 && ' ',
      warnings > 0 &&
        h(
          'span',
          'cm-schema-warning',
          icon('warning', 13),
          `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
        ),
    )
    count.setAttribute('type', 'button')
    count.setAttribute('aria-expanded', String(state.field(listOpen)))
    count.addEventListener('click', () => view.dispatch({ effects: toggleList.of(null) }))
    dom.replaceChildren(
      count,
      h('span', 'cm-schema-hint', kbd('F8'), ' next · ', kbd(`${ALT_KEY}F8`), ' all'),
    )
  }
  draw(view.state)
  return {
    dom,
    update(update) {
      if (update.docChanged || update.transactions.length > 0) draw(update.state)
    },
  }
}

/** The list of problems: the editor's own panel. ↑↓ move, Enter goes there. */
function listPanel(view: EditorView): Panel {
  const list = h('ul', 'cm-schema-rows')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Problems')
  list.tabIndex = 0
  const count = h('span', 'cm-schema-hint')
  const dom = h('div', 'cm-schema-list', h('div', 'cm-schema-list-head', 'Problems', count), list)
  let rows: Row[] = []
  let selected = 0
  const draw = (state: EditorState) => {
    rows = rowsOf(state)
    selected = Math.min(selected, Math.max(0, rows.length - 1))
    count.textContent = `${rows.length} · ${ALT_KEY}F8 closes`
    list.replaceChildren(
      ...rows.map((row, index) => {
        const line = state.doc.lineAt(row.from)
        const item = h(
          'li',
          `cm-schema-row${index === selected ? ' cm-schema-selected' : ''}`,
          icon(row.diagnostic.severity === 'error' ? 'error' : 'warning', 13),
          h('span', 'cm-schema-at', `${line.number}:${row.from - line.from + 1}`),
          ' ',
          h(
            'span',
            'cm-schema-message',
            theirs(row.diagnostic.message),
            row.problem?.path && ' ',
            row.problem?.path && h('code', '', theirs(row.problem.path)),
          ),
        )
        item.id = `cm-schema-row-${index}`
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(index === selected))
        item.addEventListener('click', () => goTo(view, row.from))
        return item
      }),
      ...(rows.length === 0 ? [h('li', 'cm-schema-none', 'No problems')] : []),
    )
    if (rows.length) list.setAttribute('aria-activedescendant', `cm-schema-row-${selected}`)
  }
  list.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selected = Math.max(
        0,
        Math.min(rows.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)),
      )
      draw(view.state)
      list.querySelector('.cm-schema-selected')?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && rows[selected]) {
      event.preventDefault()
      goTo(view, rows[selected]!.from)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      view.dispatch({ effects: toggleList.of(false) })
      view.focus()
    }
  })
  draw(view.state)
  return {
    dom,
    mount: () => list.focus(),
    update(update) {
      if (update.docChanged || update.transactions.length > 0) draw(update.state)
    },
  }
}

const panels = showPanel.computeN([listOpen], (state) => [
  state.field(listOpen) ? listPanel : null,
  footPanel,
])

// ——— Its look ———

/** An icon for the gutter: the same two, as masks in the problem's colour. */
const mask = (kind: Problem['severity']) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='${SVG}' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${ICONS[
      kind
    ]
      .map(
        ([tag, attributes]) =>
          `<${tag} ${Object.entries(attributes)
            .map(([name, value]) => `${name}='${value}'`)
            .join(' ')}/>`,
      )
      .join('')}</svg>`,
  )}")`

const look = EditorView.theme({
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--critical)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline dashed var(--warn)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-gutter-lint': { width: '20px', paddingLeft: '8px' },
  '.cm-gutter-lint .cm-gutterElement': { display: 'grid', placeItems: 'center', padding: '0' },
  '.cm-lint-marker': { width: '12px', height: '12px', content: 'none' },
  '.cm-lint-marker-error': { backgroundColor: 'var(--critical)', maskImage: mask('error') },
  '.cm-lint-marker-warning': { backgroundColor: 'var(--warn-text)', maskImage: mask('warning') },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    borderRadius: '10px',
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-1)',
    boxShadow: 'var(--shadow-panel)',
    overflow: 'hidden',
  },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': { padding: '0', border: 'none', marginLeft: '0' },
  '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid var(--line)' },
  '.cm-schema-card': {
    maxWidth: '420px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12.5px',
    lineHeight: '18px',
    paddingBottom: '10px',
  },
  '.cm-schema-head': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '8px 12px 0',
  },
  '.cm-schema-head .cm-schema-icon': { flex: 'none', marginTop: '2px' },
  '.cm-schema-head b': { fontWeight: '600' },
  '.cm-schema-error': { color: 'var(--critical)' },
  '.cm-schema-warning': { color: 'var(--warn-text)' },
  '.cm-schema-where': {
    padding: '2px 12px 0 34px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11.5px',
    color: 'var(--text-3)',
    overflowWrap: 'anywhere',
  },
  '.cm-schema-would': { padding: '2px 12px 0 34px', fontSize: '11.5px', color: 'var(--text-3)' },
  '.cm-schema-field': { width: 'max-content' },
  '.cm-schema-path': {
    padding: '8px 12px 0',
    fontFamily: 'var(--font-mono)',
    fontSize: '11.5px',
    color: 'var(--text-3)',
    overflowWrap: 'anywhere',
  },
  '.cm-schema-type': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px 0',
    fontSize: '12px',
    color: 'var(--text-2)',
  },
  '.cm-schema-type code, .cm-schema-message code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '11.5px',
    color: 'var(--text-1)',
  },
  '.cm-schema-tag': {
    padding: '0 6px',
    borderRadius: '999px',
    backgroundColor: 'var(--surface-3)',
    fontSize: '11px',
    lineHeight: '18px',
    color: 'var(--text-1)',
  },
  '.cm-schema-description': {
    maxHeight: '216px',
    overflowY: 'auto',
    padding: '6px 12px 0',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    outline: 'none',
  },
  '.cm-schema-description.cm-schema-long': {
    maskImage: 'linear-gradient(#000 80%, transparent)',
  },
  '.cm-schema-from': { padding: '6px 12px 0', fontSize: '11.5px', color: 'var(--text-3)' },
  '.cm-tooltip-autocomplete': {
    width: '340px',
    padding: '4px',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-tooltip-autocomplete > ul': { maxHeight: `${ROWS * 28}px` },
  '.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '28px',
    padding: '0 8px !important',
    borderRadius: '6px',
    fontSize: '12.5px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text-1)',
  },
  '.cm-completionLabel': {
    minWidth: '0',
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    fontWeight: '700',
    color: 'var(--accent-strong)',
  },
  '.cm-schema-beside': { display: 'flex', flex: 'none', alignItems: 'center', gap: '8px' },
  '.cm-schema-quiet': { fontSize: '11px', color: 'var(--text-3)' },
  '.cm-schema-kind': { fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-3)' },
  '.cm-schema-foot-list': {
    display: 'flex',
    gap: '12px',
    marginTop: '4px',
    padding: '6px 8px 2px',
    borderTop: '1px solid var(--line)',
    fontSize: '11px',
    color: 'var(--text-3)',
  },
  '.cm-completionInfo': { padding: '0', width: '300px' },
  '.cm-completionInfo .cm-schema-card': { maxWidth: '300px' },
  '.cm-schema-foot': {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    padding: '6px 12px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    color: 'var(--text-2)',
  },
  '.cm-schema-foot[hidden]': { display: 'none' },
  '.cm-schema-count': { display: 'flex', alignItems: 'center', gap: '8px', borderRadius: '6px' },
  '.cm-schema-count > span': { display: 'flex', alignItems: 'center', gap: '5px' },
  '.cm-schema-count .cm-schema-error, .cm-schema-count .cm-schema-warning': {
    color: 'var(--text-2)',
  },
  '.cm-schema-count .cm-schema-error svg': { color: 'var(--critical)' },
  '.cm-schema-count .cm-schema-warning svg': { color: 'var(--warn-text)' },
  '.cm-schema-hint': { marginLeft: 'auto', color: 'var(--text-3)', fontWeight: '400' },
  '.cm-schema-unchecked': { marginLeft: '0' },
  '.cm-schema-foot kbd, .cm-schema-card kbd': {
    display: 'inline-grid',
    minWidth: '18px',
    height: '18px',
    padding: '0 4px',
    placeItems: 'center',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    backgroundColor: 'var(--surface)',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--text-2)',
  },
  '.cm-schema-list': { fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
  '.cm-schema-list-head': {
    display: 'flex',
    alignItems: 'center',
    height: '30px',
    padding: '0 12px',
    borderBottom: '1px solid var(--line)',
    fontSize: '12px',
    fontWeight: '600',
  },
  '.cm-schema-rows': {
    maxHeight: '160px',
    margin: '0',
    padding: '0',
    overflowY: 'auto',
    outline: 'none',
  },
  '.cm-schema-row': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '5px 12px',
    listStyle: 'none',
    cursor: 'default',
  },
  '.cm-schema-row .cm-schema-icon': { flex: 'none', marginTop: '2px' },
  '.cm-schema-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-schema-at': {
    flex: 'none',
    width: '52px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11.5px',
    color: 'var(--text-3)',
  },
  '.cm-schema-message': { minWidth: '0', flex: '1' },
  '.cm-schema-none': { padding: '5px 12px', listStyle: 'none', color: 'var(--text-3)' },
})

/**
 * Everything the editor knows of the schemas, from `source`; `onKinds` hears which kinds the
 * text's documents say they are, each time it's checked. Put before the line numbers, so the
 * marks' gutter is left of them.
 */
export function schemaEditor(
  source: SchemaSource,
  onKinds: (kinds: DocumentKind[]) => void,
): Extension {
  return [
    checking,
    unchecked,
    check(source, onKinds),
    lintGutter(),
    ViewPlugin.define((view) => ({
      destroy: source.listen(() => {
        view.dispatch({ effects: schemasCame.of(null) })
        forceLinting(view)
      }),
    })),
    card,
    escapeFirst,
    describe(source),
    listOpen,
    panels,
    autocompletion({
      override: [complete(source)],
      defaultKeymap: false,
      icons: false,
      addToOptions: [besideName],
      optionClass: (option) => {
        const offer = option as Offer
        return offer.set !== undefined || isDeprecated(offer.field) ? 'cm-schema-dim' : ''
      },
    }),
    completionFoot,
    look,
    Prec.highest(
      keymap.of([
        { key: 'Ctrl-Space', run: startCompletion },
        { key: 'Alt-Escape', run: startCompletion },
        // Tab takes a completion only while the list is open; otherwise it indents, as it did.
        {
          key: 'Tab',
          run: (view) => completionStatus(view.state) === 'active' && acceptCompletion(view),
        },
        ...completionKeymap.filter((binding) => binding.run !== startCompletion),
        // (The caret to the next or previous problem, and its card shown there: the lint's.)
        { key: 'F8', run: nextDiagnostic },
        { key: 'Shift-F8', run: previousDiagnostic },
        { key: 'Alt-F8', run: (view) => (view.dispatch({ effects: toggleList.of(null) }), true) },
        { key: 'Alt-F1', run: describeAtCaret(source) },
        { key: 'Escape', run: closeCard },
      ]),
    ),
  ]
}
