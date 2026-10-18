import { PHONE_MEDIA } from '@renderer/lib/layout'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { GO_KEYS, QUICK_NAV, type AppCommand, type NavTarget } from '@shared/navigation'
import { useGo } from '@renderer/hooks/go'
import { api } from '@renderer/lib/api'
import { targetPath } from '@renderer/lib/routes'
import { useUi } from '@renderer/state/ui'
import { useDock } from '../terminal/dock'
import { useLinkCard } from '../links/LinkCard'
import { searchPath } from '../search/saved'
import { TEXT_SIZES } from '@shared/preferences'
import { useSetPreferences } from '@renderer/hooks/settings'
import { claimedMenu, claimedPress, pressed } from '@renderer/lib/shortcuts'
import type { Settings } from '@shared/api'

/** How long `g` waits for the second key of a "go to" shortcut. */
const SEQUENCE_TIMEOUT = 1200

/** The commands with keys of their own (shared/shortcuts.ts) these run, wherever the page is. */
const KEYED: AppCommand[] = [
  'palette',
  'filter',
  'refresh',
  'create',
  'back',
  'forward',
  'shortcuts',
  'settings',
  'clusters',
  'new-window',
  'search',
  'terminal',
  'new-terminal',
]

/** Built in: the Go menu's numbered places. */
const MOD_KEYS: Record<string, AppCommand> = Object.fromEntries(
  QUICK_NAV.map((target, i) => [String(i + 1), `go:${target}`]),
)

const ALT_KEYS: Record<string, AppCommand> = { ArrowLeft: 'back', ArrowRight: 'forward' }

const inTerminal = (target: EventTarget | null) =>
  target instanceof Element && target.closest('.xterm') !== null

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
  const clearGo = () => {
    if (pendingGo.current) clearTimeout(pendingGo.current)
    pendingGo.current = null
  }

  const setPreferences = useSetPreferences()
  const textSize = (step: -1 | 0 | 1) => {
    const now =
      (queryClient.getQueryData(['settings']) as Settings | undefined)?.preferences?.textSize ?? 100
    const at = (TEXT_SIZES as readonly number[]).indexOf(now)
    const next =
      step === 0 ? 100 : TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, at + step))]
    if (next !== undefined && next !== now) return setPreferences({ textSize: next })
  }

  const run = (command: AppCommand) => {
    // (Where a notification was about: the app opens it, whatever screen is shown.)
    if (command.startsWith('open:')) return
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
      // (Not on a phone, where nothing is written: its dialog isn't there to open.)
      // (While a link's card for a cluster that isn't here has the keyboard: its Add a cluster.)
      create: () => {
        const card = useLinkCard.getState().create
        if (card) return card()
        setCreate(Boolean(context) && !matchMedia(PHONE_MEDIA).matches)
      },
      // A terminal on this computer, pointed at the cluster that's open (the desktop app's dock
      // says which, and its namespace; on the start screen, there's none).
      terminal: () => {
        const { here, toggle, ask } = useDock.getState()
        if (here) toggle(here.context, here.namespace)
        else ask?.(false)
      },
      'new-window': () => void api.desktop!.newWindow(),
      'new-terminal': () => {
        const { here, add, ask } = useDock.getState()
        if (here) add(here.context, here.namespace)
        else ask?.(true)
      },
      assistants: () => void navigate('/assistants'),
      // Search, in the cluster that's open: its field focused, its text selected.
      search: () => {
        if (!context) return
        if (location.hash.includes(`/cluster/${encodeURIComponent(context)}/search`)) {
          window.dispatchEvent(new Event('lumovi:search'))
        } else void navigate(searchPath(context, undefined))
      },
      // Settings: in the cluster that's open, as its page; from the start screen, on its own.
      settings: () =>
        void navigate(context ? `/cluster/${encodeURIComponent(context)}/settings` : '/settings'),
      // The text size the View menu's zoom steps through: one setting, kept, in every window.
      'text-actual': () => void textSize(0),
      'text-bigger': () => void textSize(1),
      'text-smaller': () => void textSize(-1),
      // Asked only while a terminal has focus (its ⌘W and ⌘K, on macOS).
      'close-terminal': () => useDock.getState().close(useDock.getState().active!),
      'clear-terminal': () => {
        const { tabs, active } = useDock.getState()
        tabs.find((tab) => tab.session.id === active)!.session.term.clear()
      },
    }
    actions[command]!()
  }

  // The listeners below always call the latest `run`.
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })

  // (Where a live narrower place holds the menu item's key, its command instead.)
  useEffect(
    () =>
      api.desktop?.onCommand((command) => {
        const instead = claimedMenu(command)
        if (instead) instead()
        else runRef.current(command)
      }),
    [],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A command's keys, as Settings has them: with ⌘ or Ctrl, wherever the keyboard is;
      // others not while typing, nor past an open dialog or menu.
      const held = event.metaKey || event.ctrlKey
      const free =
        held ||
        (!isEditable(event.target) && !document.querySelector('[role="dialog"], [role="menu"]'))
      // (G's next key is the go-to's; a live narrower place's key is its own: it runs it.)
      const keyed =
        free && !(pendingGo.current && !held) && !claimedPress(event)
          ? KEYED.find(
              (id) =>
                pressed(event, id) &&
                // (Off a Mac, a terminal keeps Ctrl+Shift+F while it has the keyboard.)
                !(id === 'search' && api.platform !== 'darwin' && inTerminal(event.target)),
            )
          : undefined
      if (keyed) {
        event.preventDefault()
        clearGo()
        runRef.current(keyed)
        return
      }
      // (With Shift, a digit isn't the Go menu's: on some layouts, AZERTY's, Shift and the digit row
      // still type the digit, and Ctrl+Shift+1 is a saved search on Windows.)
      const command =
        event.metaKey || event.ctrlKey
          ? event.shiftKey && /^Digit\d$/.test(event.code)
            ? undefined
            : MOD_KEYS[event.key.toLowerCase()]
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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return null
}
