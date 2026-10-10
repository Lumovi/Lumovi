import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

/** The app's YAML colours (see YamlTab), so editing looks like reading. */
const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--accent-strong)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--good-text)' },
  { tag: [tags.number, tags.bool, tags.null, tags.keyword], color: 'var(--ansi-5)' },
  { tag: [tags.comment, tags.meta], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.operator], color: 'var(--text-3)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent', color: 'var(--text-1)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'color-mix(in srgb, var(--text-3) 60%, transparent)',
    border: 'none',
    paddingLeft: '12px',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  // The caret's line is set apart while the editor is being typed in, and not otherwise:
  // beside a form, a line that's lit is the form's to light.
  '&:not(.cm-focused) .cm-activeLine': { backgroundColor: 'transparent' },
  '&:not(.cm-focused) .cm-activeLineGutter': { color: 'inherit' },
  // Lines set apart by whoever is beside the editor (a form): see `LineMarks`.
  '.cm-line-lit': {
    backgroundColor: 'color-mix(in srgb, var(--accent) var(--tint-lit), transparent)',
  },
  '.cm-line-wrong': {
    backgroundColor: 'color-mix(in srgb, var(--critical) var(--tint-wrong), transparent)',
  },
  '.cm-line-shaded': {
    backgroundColor: 'color-mix(in srgb, var(--text-3) var(--tint-shaded), transparent)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 22%, transparent)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-1)',
    borderTop: '1px solid var(--line)',
  },
  '.cm-panel.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '12px', padding: '6px 12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
})

/** Lines (from 1) set apart from the rest, each kind in its own way. */
export interface LineMarks {
  /** What a field in focus writes. */
  lit?: readonly number[]
  /** What's wrong, and must be put right. */
  wrong?: readonly number[]
  /** What's there that nothing beside the editor shows. */
  shaded?: readonly number[]
}

const MARK_CLASS: Record<keyof LineMarks, string> = {
  lit: 'cm-line-lit',
  wrong: 'cm-line-wrong',
  shaded: 'cm-line-shaded',
}

const setMarks = StateEffect.define<LineMarks>()

/** The marked lines, as decorations of whole lines: kept in step with the document's own. */
const marks = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setMarks)) continue
      const { doc } = transaction.state
      // One class per line, the gravest: what's wrong, before what's lit, before what's shaded.
      const classes = new Map<number, string>()
      for (const kind of ['shaded', 'lit', 'wrong'] as const) {
        for (const line of effect.value[kind] ?? []) {
          if (line >= 1 && line <= doc.lines) classes.set(line, MARK_CLASS[kind])
        }
      }
      return Decoration.set(
        [...classes]
          .sort(([a], [b]) => a - b)
          .map(([line, name]) => Decoration.line({ class: name }).range(doc.line(line).from)),
      )
    }
    return transaction.docChanged ? value.map(transaction.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * A YAML editor: line numbers, undo, search (⌘F), and Tab to indent. ⌘S (or
 * Ctrl+S) calls `onSave`.
 *
 * `value` is the editor's whole document: what's selected, copied and searched is that text
 * and no other. Whoever shows something in place of the real text (a Secret's values, hidden)
 * gives that as `value` and makes it `readOnly`; nothing is hidden by drawing over it.
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  label,
  lines,
  reveal,
  readOnly = false,
  autoFocus = true,
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  label: string
  /** Lines set apart: lit, wrong, shaded. */
  lines?: LineMarks
  /**
   * A line to bring into view, when it changes: just into view, or (`high`) about a third of
   * the way down, with what follows it below.
   */
  reveal?: number | { line: number; high: true }
  /** Shown, and not edited. */
  readOnly?: boolean
  /** Whether it takes the focus as it opens (it does, where it's all there is to fill in). */
  autoFocus?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is created once; these always call the latest props.
  const latest = useRef({ onChange, onSave })
  useEffect(() => {
    latest.current = { onChange, onSave }
  })
  const editable = useRef(new Compartment())
  // What the document was last set to from outside: such a change isn't the user's typing.
  const setting = useRef(false)

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          yaml(),
          syntaxHighlighting(highlight),
          theme,
          marks,
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
          ]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !setting.current) {
              latest.current.onChange(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    if (autoFocus) view.current.focus()
    // Measured while a dialog was still animating in, line heights come out scaled.
    const remeasure = () => view.current!.requestMeasure()
    document.addEventListener('animationend', remeasure)
    return () => {
      document.removeEventListener('animationend', remeasure)
      view.current!.destroy()
    }
    // The document is only set when the editor is created; see the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Replace the document when it is reset from outside (e.g. "Start over from the latest").
  useEffect(() => {
    const current = view.current!.state.doc.toString()
    if (current !== value) {
      // Only what differs is replaced, so the caret and the scroll stay where they were when a
      // form beside it writes one value.
      let start = 0
      const shortest = Math.min(current.length, value.length)
      while (start < shortest && current[start] === value[start]) start += 1
      let end = 0
      while (
        end < shortest - start &&
        current[current.length - 1 - end] === value[value.length - 1 - end]
      ) {
        end += 1
      }
      setting.current = true
      view.current!.dispatch({
        changes: {
          from: start,
          to: current.length - end,
          insert: value.slice(start, value.length - end),
        },
      })
      setting.current = false
    }
  }, [value])

  useEffect(() => {
    view.current!.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
      ]),
    })
  }, [readOnly])

  // After the document, so the lines are the new text's.
  const { lit, wrong, shaded } = lines ?? {}
  const marked = JSON.stringify([lit ?? [], wrong ?? [], shaded ?? []])
  useEffect(() => {
    const [lit, wrong, shaded] = JSON.parse(marked) as number[][]
    view.current!.dispatch({ effects: setMarks.of({ lit, wrong, shaded }) })
  }, [marked, value])

  const line = typeof reveal === 'object' ? reveal.line : reveal
  const high = typeof reveal === 'object'
  useEffect(() => {
    if (line === undefined) return
    // Once what's around the editor has settled (a list of results under it takes some of
    // its height), so "a third of the way down" is of the pane as it then is.
    const frame = requestAnimationFrame(() => {
      const { state, dom } = view.current!
      if (line < 1 || line > state.doc.lines) return
      view.current!.dispatch({
        effects: EditorView.scrollIntoView(
          state.doc.line(line).from,
          high
            ? { y: 'start', yMargin: Math.round(dom.clientHeight / 3) }
            : { y: 'nearest', yMargin: 40 },
        ),
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [line, high])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
