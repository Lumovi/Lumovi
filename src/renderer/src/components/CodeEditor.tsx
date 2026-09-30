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
import { EditorState } from '@codemirror/state'
import {
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
  { tag: [tags.number, tags.bool, tags.null, tags.keyword], color: 'var(--serious-text)' },
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

/**
 * A YAML editor: line numbers, undo, search (⌘F), and Tab to indent. ⌘S (or
 * Ctrl+S) calls `onSave`.
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  label,
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  label: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is created once; these always call the latest props.
  const latest = useRef({ onChange, onSave })
  useEffect(() => {
    latest.current = { onChange, onSave }
  })

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
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current.focus()
    return () => view.current!.destroy()
    // The document is only set when the editor is created; see the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Replace the document when it is reset from outside (e.g. "Start over from the latest").
  useEffect(() => {
    const current = view.current!.state.doc.toString()
    if (current !== value) {
      view.current!.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
