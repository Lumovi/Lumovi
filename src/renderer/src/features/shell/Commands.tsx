import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { GO_KEYS, QUICK_NAV, type AppCommand, type NavTarget } from '@shared/navigation'
import { useGo } from '@renderer/hooks/go'
import { api } from '@renderer/lib/api'
import { targetPath } from '@renderer/lib/routes'
import { useUi } from '@renderer/state/ui'

/** How long `g` waits for the second key of a "go to" shortcut. */
const SEQUENCE_TIMEOUT = 1200

const MOD_KEYS: Record<string, AppCommand> = {
  k: 'palette',
  r: 'refresh',
  n: 'create',
  '[': 'back',
  ']': 'forward',
  ...Object.fromEntries(QUICK_NAV.map((target, i) => [String(i + 1), `go:${target}`])),
}

const ALT_KEYS: Record<string, AppCommand> = { ArrowLeft: 'back', ArrowRight: 'forward' }

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/** How long a focus request waits for its target, e.g. while the next page renders. */
const FOCUS_WAIT = 1000

/** Focuses the current view's filter, waiting for it if the view is still changing. */
function focusFilter(): void {
  const start = performance.now()
  const attempt = () => {
    const filter = document.querySelector<HTMLElement>('[data-hotkey-target="filter"]')
    if (filter) filter.focus()
    else if (performance.now() - start < FOCUS_WAIT) requestAnimationFrame(attempt)
  }
  attempt()
}

/**
 * Runs app commands from the keyboard and from the native menu. Each screen
 * (start screen, cluster view) mounts its own, so listeners come and go with it.
 */
export function Commands() {
  const navigate = useNavigate()
  const goTo = useGo()
  const queryClient = useQueryClient()
  const context = useMatch('/cluster/:context/*')?.params.context
  const { setPalette, setShortcuts, setCreate } = useUi()
  const pendingGo = useRef<ReturnType<typeof setTimeout> | null>(null)

  const run = (command: AppCommand) => {
    if (command.startsWith('go:')) {
      if (context) goTo(targetPath(context, command.slice(3) as NavTarget))
      return
    }
    const actions: Record<string, () => void> = {
      palette: () => (context ? setPalette(!useUi.getState().palette) : focusFilter()),
      filter: focusFilter,
      shortcuts: () => setShortcuts(true),
      refresh: () => void queryClient.invalidateQueries(),
      back: () => navigate(-1),
      forward: () => navigate(1),
      clusters: () => goTo('/'),
      // Objects are created in a cluster, so not from the start screen.
      create: () => setCreate(Boolean(context)),
    }
    actions[command]!()
  }

  // The listeners below always call the latest `run`.
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })

  useEffect(() => api.desktop?.onCommand((command) => runRef.current(command)), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command =
        event.metaKey || event.ctrlKey
          ? MOD_KEYS[event.key.toLowerCase()]
          : event.altKey && !isEditable(event.target)
            ? ALT_KEYS[event.key]
            : undefined
      if (command) {
        event.preventDefault()
        runRef.current(command)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return
      // Single-key shortcuts don't reach past open dialogs and menus.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return

      if (pendingGo.current) {
        clearTimeout(pendingGo.current)
        pendingGo.current = null
        const go = GO_KEYS.find((entry) => entry.key === event.key)
        if (go) runRef.current(`go:${go.target}`)
        return
      }
      if (event.key === 'g') {
        pendingGo.current = setTimeout(() => {
          pendingGo.current = null
        }, SEQUENCE_TIMEOUT)
      } else if (event.key === '/') {
        event.preventDefault()
        runRef.current('filter')
      } else if (event.key === '?') {
        runRef.current('shortcuts')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return null
}
