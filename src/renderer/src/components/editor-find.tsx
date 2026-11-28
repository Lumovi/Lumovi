/**
 * An editor's search, in the find bar every YAML view has (LMV-404): drawn by Lumovi in
 * CodeMirror's place for its panel, while what's looked for, what's marked and each step are
 * CodeMirror's own (its query, its highlights, its commands).
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorView, Panel } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MOST_FOUND } from '@renderer/lib/find'
import { whyNot } from '@renderer/lib/log-search'
import { FindBar } from './FindBar'
import { TooltipProvider } from './Tooltip'

/** What the editor's holder hears of its bar, and gives it. */
export interface PanelEvents {
  /** Its bar opened, or closed. */
  shown: (open: boolean) => void
  /** Where the keyboard goes as it's closed (none: the editor's text, as CodeMirror does). */
  back: () => Element | null
  /** Its bar's id, for its toolbar's Find. */
  barId: string
}

/** What CodeMirror makes its search's panel with: the find bar, named for what it searches. */
export const findPanel =
  (label: string, events: PanelEvents) =>
  (view: EditorView): Panel => {
    const dom = document.createElement('div')
    const root = createRoot(dom)
    // (A root of its own, in CodeMirror's panel: with what the bar's tooltips need, as the app's.)
    const draw = () =>
      root.render(
        <TooltipProvider delayDuration={500} skipDelayDuration={200}>
          <EditorFind view={view} label={label} events={events} />
        </TooltipProvider>,
      )
    draw()
    events.shown(true)
    return {
      dom,
      top: true,
      // (Anything that changes what it shows: the text, the selection, the query, read-only.)
      update: (update) => {
        if (update.transactions.length > 0) draw()
      },
      // (After what's under way: it may be closed by its own button.)
      destroy: () => {
        events.shown(false)
        queueMicrotask(() => root.unmount())
      },
    }
  }

function EditorFind({
  view,
  label,
  events,
}: {
  view: EditorView
  label: string
  events: PanelEvents
}) {
  const field = useRef<HTMLInputElement>(null)
  // (Opened: the keyboard in its field, what's there selected. CodeMirror puts it back there
  // when it's asked to open again: the field it marks as its main one.)
  useEffect(() => {
    field.current?.select()
  }, [])

  const spec = getSearchQuery(view.state)
  const set = (change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) =>
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: spec.search,
          caseSensitive: spec.caseSensitive,
          regexp: spec.regexp,
          replace: spec.replace,
          literal: true,
          ...change,
        }),
      ),
    })
  const problem = spec.search && spec.regexp && !spec.valid ? whyNot(spec.search) : undefined
  return (
    <FindBar
      label={label}
      query={{ text: spec.search, matchCase: spec.caseSensitive, regex: spec.regexp }}
      onQuery={({ text, matchCase, regex }) =>
        set({ search: text, caseSensitive: matchCase, regexp: regex })
      }
      found={spec.search && spec.valid ? counted(view, spec) : undefined}
      problem={problem}
      onStep={(by) => void (by === 1 ? findNext : findPrevious)(view)}
      onClose={() => {
        const back = events.back()
        closeSearchPanel(view)
        if (back instanceof HTMLElement && back.isConnected) back.focus()
      }}
      replace={
        view.state.readOnly
          ? undefined
          : {
              text: spec.replace,
              onText: (replace) => set({ replace }),
              onReplace: () => void replaceNext(view),
              onReplaceAll: () => void replaceAll(view),
            }
      }
      framed={false}
      fieldRef={field}
      fieldProps={{ 'main-field': 'true' }}
      id={events.barId}
    />
  )
}

/** How many match (up to `MOST_FOUND`), and which is selected: none until one's stepped to. */
function counted(view: EditorView, spec: SearchQuery): { at: number; total: number } {
  const { from, to } = view.state.selection.main
  const cursor = spec.getCursor(view.state)
  let total = 0
  let at = -1
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (next.value.from === from && next.value.to === to) at = total
    total += 1
    if (total >= MOST_FOUND) break
  }
  return { at, total }
}
