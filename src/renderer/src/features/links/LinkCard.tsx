/**
 * A lumovi:// link handed to the desktop app, asked about in a card at the top of the window it's
 * for: what it opens, in which of the clusters here, and how; or why it can't. Nothing is opened,
 * read or signed in to before a press. Not modal: the page behind still works, and while a
 * terminal or a field is being typed in, the card doesn't take the keyboard (⌘L, Ctrl+⇧L on
 * Windows and Linux, goes to it).
 */
import { Info, KeyRound, LinkIcon, Pencil, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { KubeContext } from '@shared/api'
import { shortInPieces } from '@shared/kit/characters'
import { addressOf, objectRef, type Link, type LinkArrival } from '@shared/links'
import { builtinResource, resourceByPlural } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { currentPath } from '@renderer/lib/routes'
import { TheirText } from '@renderer/plugins/TheirText'
import { useActionsUi } from '@renderer/state/actions'
import { toast } from '@renderer/state/toasts'
import { isEditable } from '../actions/ActionSurfaces'
import { windowRestored } from '../terminal/BelowKept'

/**
 * How long Enter, Space and Esc do nothing once a card is up: a key on its way isn't an answer (one
 * held, or repeated, as the Esc that closed a dialog can be).
 */
const ANSWER_AFTER_MS = 500
const NOT_YET = new Set(['Enter', ' ', 'Escape'])
const MAC = api.platform === 'darwin'
/** The key that goes to a card that waits, from anywhere: ⌘L, or Ctrl+⇧L (Ctrl+L is the shell's). */
const ANSWER_KEY = MAC ? '⌘L' : 'Ctrl+⇧L'
const isAnswerKey = (event: globalThis.KeyboardEvent) =>
  event.key.toLowerCase() === 'l' &&
  !event.altKey &&
  (MAC ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey)

/** What a card up now takes from the page: ⌘N, where it's for adding a cluster and has the keys. */
export const useLinkCard = create<{ create?: () => void }>(() => ({}))

/** The tabs as an object's panel names them. */
const TAB_NAMES: Record<string, string> = {
  overview: 'Overview',
  pods: 'Pods',
  logs: 'Logs',
  metrics: 'Metrics',
  events: 'Events',
  map: 'Map',
  audit: 'Audit',
  yaml: 'YAML',
}

/** A page of a cluster, as Lumovi names it. */
function pageName(page: string): string {
  const [first, second, third] = page.split('/')
  if (!first) return 'Overview'
  if (first === 'r' && second) return second.split('.')[0]!
  if (first === 'plugins') return second ? (third ? `${second} · ${third}` : second) : 'Plugins'
  const named: Record<string, string> = {
    workloads: 'Workloads',
    metrics: 'Metrics',
    alerts: 'Alerts',
    helm: 'Helm releases',
    'api-resources': 'API resources',
  }
  if (page === 'metrics/right-sizing') return 'Right-sizing'
  return named[first] ?? resourceByPlural(first)?.label ?? first
}

/** What a link opens: its object (and where), or its page; and, under it, a line of what. */
function opened(link: Link): { name: string; what?: string } {
  const open = link.view.find(([key]) => key === 'open')?.[1]
  const ref = open ? objectRef(open) : undefined
  if (ref) {
    const kind = builtinResource(ref.kind)?.kind ?? ref.kind.split('.')[0]!
    const where = ref.namespace ? `${kind} in ${ref.namespace}` : kind
    return {
      name: ref.name,
      what: `${where}, on its ${TAB_NAMES[link.tab ?? 'overview'] ?? 'Overview'} tab`,
    }
  }
  const filtered = link.view.some(([key]) =>
    ['q', 'labels', 'namespaces', 'health', 'ns', 'name'].includes(key),
  )
  return { name: pageName(link.page), ...(filtered ? { what: 'With its filters' } : {}) }
}

/** A name from the link or the cluster, as their text: marks shown, a long one cut in its middle. */
const Their = ({ text }: { text: string }) => (
  <bdi>
    <TheirText pieces={shortInPieces(text, 48, 1)} inline />
  </bdi>
)

/** Whether what has the keyboard is being typed in: a field, an editor, a terminal. */
const typing = () => {
  const at = document.activeElement
  return at !== null && at !== document.body && (isEditable(at) || at.closest('.xterm') !== null)
}

/** Whether this window has work that isn't saved: an edit open. (A form is a dialog: see below.) */
const unsaved = () => useActionsUi.getState().editing !== null

/** Whether a dialog is open here: a form, the palette. It keeps the keyboard, so a card waits. */
const dialogOpen = () => document.querySelector('[role="dialog"][data-state="open"]') !== null

/** Once no dialog is open in this window: one's form is finished or left before a card asks. */
const noDialog = () =>
  new Promise<void>((resolve) => {
    if (!dialogOpen()) return resolve()
    const watch = new MutationObserver(() => {
      if (dialogOpen()) return
      watch.disconnect()
      resolve()
    })
    watch.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
  })

/** The keys held down in this window now: a card waits for the one that closed a dialog to be up. */
const held = new Set<string>()
const keysUp = () =>
  new Promise<void>((resolve) => {
    if (held.size === 0) return resolve()
    const check = () => {
      if (held.size > 0) return
      window.removeEventListener('keyup', check)
      window.removeEventListener('blur', check)
      resolve()
    }
    // (After the listeners that keep `held`, which hear it first: they're the capture's.)
    window.addEventListener('keyup', check)
    window.addEventListener('blur', check)
  })

interface Shown {
  arrival: LinkArrival
  /** When it came up: Enter, Space and Esc wait ANSWER_AFTER_MS. */
  at: number
  /** Whether the keyboard was another's then (a field's or a terminal's): the card waits for ⌘L. */
  waiting: boolean
  /**
   * Whether the link raised the window from another app, where the person may be typing: Cancel
   * has the keyboard, and keys are the card's alone, none of them anything until typing stops.
   */
  elsewhere: boolean
  /** This window's work that isn't saved, then. */
  unsaved: boolean
}

export function LinkCard({ navigate }: { navigate: (to: string) => void }) {
  const [shown, setShown] = useState<Shown>()
  // A link told of while a dialog is open: it waits, and a line says so.
  const [behind, setBehind] = useState(false)
  const contexts = useContexts().data?.contexts
  // The link waiting for this window, once the window is back where it was, no dialog is open
  // and the key that closed one is up: and again as told. (Until then a newer link takes its
  // place, as it would anyway.)
  useEffect(() => {
    let gone = false
    const take = async (told: boolean) => {
      await windowRestored
      if (told && dialogOpen()) setBehind(true)
      await noDialog()
      await keysUp()
      if (gone) return
      const arrival = await api.desktop!.takeLink()
      if (gone) return
      setBehind(false)
      if (arrival) {
        const elsewhere = arrival.elsewhere === true
        setShown({
          arrival,
          at: Date.now(),
          // (From another app, what had the keyboard here isn't being typed in: it's the card's.)
          waiting: typing() && !elsewhere,
          elsewhere,
          unsaved: unsaved(),
        })
      }
    }
    const down = (event: globalThis.KeyboardEvent) => held.add(event.code)
    const up = (event: globalThis.KeyboardEvent) => held.delete(event.code)
    // (The window's own blur: an element's is heard here too, in the capture.)
    const left = (event: FocusEvent) => {
      if (event.target === window) held.clear()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', left, true)
    void take(false)
    const offWaiting = api.desktop!.onLinkWaiting(() => void take(true))
    const offSkipped = api.desktop!.onLinkSkipped(() =>
      toast({
        tone: 'info',
        title:
          'Lumovi skipped a link that came right after the last one. Open it again if you meant to.',
      }),
    )
    return () => {
      gone = true
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', left, true)
      offWaiting()
      offSkipped()
    }
  }, [])
  if (!shown) return behind ? <Behind /> : null
  return (
    <Card
      key={shown.at}
      shown={shown}
      contexts={contexts ?? []}
      onDone={() => {
        setShown(undefined)
        useLinkCard.setState({ create: undefined })
        api.desktop!.linkAnswered()
      }}
      navigate={navigate}
    />
  )
}

/**
 * While a link waits for a dialog to close: a line where its card will be, heard once as a status.
 * In a portal of its own, added after the dialog opened, so the dialog doesn't hide it from a screen
 * reader; above the dialog's overlay. Not a button: a press there is outside the dialog, as anywhere.
 */
function Behind() {
  const said = useRef<HTMLSpanElement>(null)
  // (Said once it's there, a frame after: a status is heard as it changes.)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      said.current!.textContent = 'A link is waiting. Lumovi asks about it when this dialog closes.'
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex justify-center">
      <div
        role="status"
        data-link-waiting
        className="flex h-[34px] items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] text-ink-2 shadow-pop"
      >
        <LinkIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span ref={said} />
      </div>
    </div>,
    document.body,
  )
}

function Card({
  shown,
  contexts,
  onDone,
  navigate,
}: {
  shown: Shown
  contexts: KubeContext[]
  onDone: () => void
  navigate: (to: string) => void
}) {
  const titleId = useId()
  const card = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [waiting, setWaiting] = useState(shown.waiting)
  const [picked, setPicked] = useState<string>()
  const [hasKeys, setHasKeys] = useState(false)
  const { arrival } = shown

  // Raised from another app: what the person goes on typing there, as Lumovi comes forward, is
  // nothing here (never what had the keyboard here, a terminal say, nor the card's buttons) until
  // typing stops for ANSWER_AFTER_MS; and the keyboard stays in the card, Tab and all, until it's
  // answered. A click answers at once. (Before anything in the page hears a key.)
  useEffect(() => {
    if (!shown.elsewhere) return
    let quietFrom = Date.now()
    let typing = true
    const swallowed = new Set<string>()
    const onDown = (event: globalThis.KeyboardEvent) => {
      // (Once typing has stopped, keys are the card's as ever.)
      if (typing && Date.now() - quietFrom < ANSWER_AFTER_MS) {
        quietFrom = Date.now()
        swallowed.add(event.code)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      typing = false
      if (event.key !== 'Tab' || !card.current) return
      const stops = [
        ...card.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ),
      ]
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const next = (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length
      event.preventDefault()
      event.stopImmediatePropagation()
      stops[at < 0 ? 0 : next]?.focus()
    }
    // (A key swallowed going down is swallowed coming up: Space presses a button as it's let go.)
    const onUp = (event: globalThis.KeyboardEvent) => {
      if (!swallowed.delete(event.code)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [shown.elsewhere])

  // Cancel has the keyboard, unless it's another's while it's typed in: then ⌘L brings it here.
  // Until the person presses or clicks, it keeps it: a page still opening (the start screen's
  // search, say) focuses its own field by itself.
  useEffect(() => {
    let touched = false
    if (!shown.waiting) cancel.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      touched = true
      if (!isAnswerKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      setWaiting(false)
      cancel.current?.focus()
    }
    const onPress = () => {
      touched = true
    }
    const onFocus = (event: FocusEvent) => {
      if (touched || shown.waiting || card.current?.contains(event.target as Node)) return
      cancel.current?.focus()
    }
    // (Before anything else hears it: a terminal's, or the YAML editor's own ⌘L.)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('focusin', onFocus, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('focusin', onFocus, true)
    }
  }, [shown.waiting])

  /** Goes there in this window: its page, and its object's tab. */
  const openHere = (link: Link, context: string) => {
    navigate(addressOf(link, context))
    const open = link.view.find(([key]) => key === 'open')?.[1]
    if (open && link.tab) {
      // (Logs from a link read what's there, and follow only when asked to.)
      if (link.tab === 'logs') useActionsUi.setState({ linkedLogs: open })
      useActionsUi.getState().showTab(open, link.tab)
    }
    onDone()
  }
  const openNew = (link: Link, context: string) => {
    void api.desktop!.newWindow({
      address: addressOf(link, context),
      ...(link.tab ? { tab: link.tab } : {}),
    })
    onDone()
  }
  const addCluster = () => {
    navigate('/?add=cluster')
    onDone()
  }

  let title: ReactNode
  let what: ReactNode
  const lines: { icon: ReactNode; text: ReactNode; warn?: boolean }[] = []
  let pick: KubeContext[] | undefined
  let buttons: ReactNode
  const cancelButton = (word: 'Cancel' | 'Close') => (
    <Button ref={cancel} onClick={onDone}>
      {word}
    </Button>
  )

  if ('refused' in arrival) {
    title = `This link can’t be opened: ${arrival.refused}`
    buttons = cancelButton('Close')
  } else {
    const { link, match } = arrival
    const target = opened(link)
    const here = currentPath().match(/^\/cluster\/([^/?]+)/)?.[1]
    const shownHere = here !== undefined ? decodeURIComponent(here) : undefined
    const named = (context: string) => contexts.find((c) => c.name === context)
    const calls = (context: string) =>
      context !== link.context ? (
        <span className="text-ink-3">
          {' · '}the link calls it <Their text={link.context} />
        </span>
      ) : null
    const left =
      link.left.length > 0
        ? {
            icon: <Info />,
            text: `Some of the link was left out: ${link.left.join(', ')}.`,
          }
        : undefined
    const signsIn = (context: string) => {
      const found = named(context)
      return found?.signsInWith && !found.signedIn
        ? { icon: <KeyRound />, text: `Opening it signs in with ${found.signsInWith}.` }
        : undefined
    }
    if (match.found === 'one' || (match.found === 'several' && picked)) {
      const context = match.found === 'one' ? match.context : picked!
      const go = shownHere === context
      title = (
        <>
          {go ? 'Go to' : 'Open'} <Their text={target.name} /> in <Their text={context} />?
        </>
      )
      what = (
        <>
          {target.what}
          {calls(context)}
        </>
      )
      for (const line of [go ? undefined : signsIn(context), left]) if (line) lines.push(line)
      if (go) {
        buttons = (
          <>
            {cancelButton('Cancel')}
            <Button variant="primary" onClick={() => openHere(link, context)}>
              Go
            </Button>
          </>
        )
      } else if (shown.unsaved) {
        lines.push({
          icon: <Pencil />,
          text: 'This window has an edit that isn’t saved, so it opens in a new one.',
        })
        buttons = (
          <>
            {cancelButton('Cancel')}
            <Button onClick={() => openHere(link, context)}>Open here</Button>
            <Button variant="primary" onClick={() => openNew(link, context)}>
              New window
            </Button>
          </>
        )
      } else {
        buttons = (
          <>
            {cancelButton('Cancel')}
            <Button onClick={() => openNew(link, context)}>New window</Button>
            <Button variant="primary" onClick={() => openHere(link, context)}>
              Open
            </Button>
          </>
        )
      }
      if (match.found === 'several') pick = match.contexts.flatMap((c) => named(c) ?? [])
    } else if (match.found === 'several') {
      title = (
        <>
          Open <Their text={target.name} /> in which context?
        </>
      )
      what = target.what
      if (left) lines.push(left)
      pick = match.contexts.flatMap((c) => named(c) ?? [])
      buttons = (
        <>
          {cancelButton('Cancel')}
          <Button disabled>New window</Button>
          <Button variant="primary" disabled>
            Open
          </Button>
        </>
      )
    } else if (match.found === 'elsewhere') {
      const context = match.context
      title = (
        <>
          Open <Their text={target.name} /> in your cluster called <Their text={context} />?
        </>
      )
      what = target.what
      lines.push({
        icon: <TriangleAlert />,
        warn: true,
        text: (
          <>
            You have a cluster called <Their text={context} />, but at another address than the
            link’s.
          </>
        ),
      })
      for (const line of [signsIn(context), left]) if (line) lines.push(line)
      buttons = (
        <>
          {cancelButton('Cancel')}
          <Button onClick={() => openHere(link, context)}>
            Open <Their text={context} /> anyway
          </Button>
        </>
      )
    } else {
      title = 'Lumovi doesn’t know this link’s cluster'
      lines.push({
        icon: <Info />,
        text: (
          <>
            This link is to a cluster called <Their text={link.context} /> that isn’t in your
            kubeconfig. Ask whoever sent it which one it is, then add it.
          </>
        ),
      })
      buttons = (
        <>
          {cancelButton('Close')}
          <Button variant="primary" onClick={addCluster}>
            Add a cluster
            {hasKeys && <span className="ml-1 text-xs opacity-80">{MAC ? '⌘N' : 'Ctrl+N'}</span>}
          </Button>
        </>
      )
    }
  }

  // ⌘N, the menu's Create…, is the not-here card's Add a cluster while it has the keyboard.
  const notHere = 'match' in arrival && arrival.match.found === 'none'
  useEffect(() => {
    useLinkCard.setState({ create: notHere && hasKeys ? addCluster : undefined })
  })

  // (A key on its way as the card came up isn't an answer: Space presses a button as it's let go.)
  const early = (event: KeyboardEvent<HTMLDivElement>) =>
    NOT_YET.has(event.key) && Date.now() - shown.at < ANSWER_AFTER_MS
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (early(event)) event.preventDefault()
    else if (event.key === 'Escape') {
      event.preventDefault()
      onDone()
    }
  }
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (early(event)) event.preventDefault()
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
      <div
        ref={card}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-link-card
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={() => setHasKeys(true)}
        onBlur={(event) => {
          if (!card.current?.contains(event.relatedTarget)) setHasKeys(false)
        }}
        // (Its button with the keyboard is ringed however it got it: Cancel's, given it as the
        // card comes up, by no key, would otherwise show none, and Enter or Esc land there.)
        className="pointer-events-auto flex w-[460px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-xl border border-line-strong bg-surface py-3.5 pr-4 pl-[18px] shadow-pop [&_button:focus]:outline-2 [&_button:focus]:outline-offset-1 [&_button:focus]:outline-accent"
      >
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <LinkIcon className="size-3.5" />A link
          {waiting && <span className="ml-auto text-ink-2">{ANSWER_KEY} to answer</span>}
        </div>
        <h3
          id={titleId}
          className="line-clamp-2 text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-1"
        >
          {title}
        </h3>
        {what && <p className="-mt-1.5 text-[12.5px] leading-[18px] text-ink-2">{what}</p>}
        {lines.map((line, at) => (
          <p
            key={at}
            className={cn(
              'flex items-start gap-2 text-[12.5px] leading-[18px] text-ink-2 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-3',
              line.warn && 'text-warn-text [&_svg]:text-warn-text',
            )}
          >
            {line.icon}
            <span>{line.text}</span>
          </p>
        ))}
        {pick && 'match' in arrival && (
          <div
            role="radiogroup"
            aria-label="Context"
            className="flex flex-col overflow-hidden rounded-[9px] border border-line"
          >
            {pick.map((context) => (
              <label
                key={context.name}
                className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] leading-[18px] not-first:border-t not-first:border-line"
              >
                <input
                  type="radio"
                  name="link-context"
                  checked={picked === context.name}
                  onChange={() => setPicked(context.name)}
                />
                <span>
                  <span className="font-medium">
                    <Their text={context.name} />
                  </span>
                  <small className="block font-mono text-[11.5px] leading-4 text-ink-3">
                    {context.user}
                    {context.namespace ? ` · ${context.namespace}` : ''}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="mt-0.5 flex justify-end gap-2">{buttons}</div>
      </div>
    </div>
  )
}
