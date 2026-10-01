import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useSearchParams } from 'react-router'
import { useUpdateParams } from '@renderer/hooks/update-params'
import { cn } from '@renderer/lib/cn'
import { usePrefs } from '@renderer/state/prefs'
import { CrashView } from '../errors/CrashView'
import { ErrorBoundary } from '../errors/ErrorBoundary'

const DEFAULT_WIDTH = 600
const MIN_WIDTH = 400
/** Arrow keys on the resize handle move it by this much. */
const RESIZE_STEP = 32

export interface PanelFrame {
  /** What the search param names. */
  value: string
  expanded: boolean
  onExpand: () => void
  onClose: () => void
}

/**
 * What a search param names (an object, a Helm release), in a resizable pane
 * next to the list. It animates in and out, can cover the list, and returns
 * focus to where it was when it closes.
 */
export function SidePanel({
  param,
  label,
  crashTitle,
  content: Content,
}: {
  param: string
  /** The pane's name, for screen readers. */
  label: (value: string) => string
  crashTitle: string
  content: ComponentType<PanelFrame>
}) {
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const value = params.get(param)
  // Keep showing the last one while the panel animates out.
  const [shown, setShown] = useState(value)
  if (value && value !== shown) setShown(value)
  const closing = !value && shown !== null
  const returnFocus = useRef<Element | null>(null)
  const [expanded, setExpanded] = useState(false)
  const storedWidth = usePrefs((prefs) => prefs.panelWidth)
  const setStoredWidth = usePrefs((prefs) => prefs.setPanelWidth)
  const [width, setWidth] = useState(storedWidth ?? DEFAULT_WIDTH)

  useEffect(() => {
    if (value) returnFocus.current ??= document.activeElement
  }, [value])

  if (!shown) return null

  const close = () => {
    updateParams((current) => current.delete(param))
    ;(returnFocus.current as HTMLElement | null)?.focus()
    returnFocus.current = null
  }

  const resizeTo = (next: number) => {
    const clamped = Math.round(Math.max(MIN_WIDTH, next))
    setWidth(clamped)
    setStoredWidth(clamped)
  }

  const startResize = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = width
    const onMove = (move: globalThis.PointerEvent) => resizeTo(startWidth + startX - move.clientX)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), {
      once: true,
    })
  }

  const onHandleKey = (event: KeyboardEvent) => {
    const delta = ({ ArrowLeft: RESIZE_STEP, ArrowRight: -RESIZE_STEP } as Record<string, number>)[
      event.key
    ]
    if (delta) resizeTo(width + delta)
  }

  return (
    <aside
      aria-label={label(shown)}
      onAnimationEnd={() => {
        if (closing) setShown(null)
      }}
      style={{ width: expanded ? undefined : width }}
      className={cn(
        'flex min-w-0 shrink-0 flex-col bg-surface',
        // Expanded, it covers the list; otherwise it sits beside it.
        expanded
          ? 'absolute inset-0 z-20'
          : 'relative max-w-[calc(100%-280px)] border-l border-line',
        closing ? 'animate-slide-out' : 'animate-slide-in',
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onHandleKey}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100"
      />
      <ErrorBoundary
        key={shown}
        fallback={(error) => <CrashView error={error} title={crashTitle} />}
      >
        <Content
          value={shown}
          expanded={expanded}
          onExpand={() => setExpanded(!expanded)}
          onClose={close}
        />
      </ErrorBoundary>
    </aside>
  )
}
