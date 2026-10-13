/**
 * A Secret's value on a plugin's page: shown by Lumovi, and never held by the plugin. The card
 * has the plugin's title, Lumovi's caption, the Secret's own name and namespace, and a box for
 * each key, hidden. Nothing is read until the person presses: Reveal, Reveal all and Copy are
 * the presses, each a read of the pressed keys alone, as the person. A box shows what its own
 * press came back with. A value is kept only while its box shows it.
 */
import { Copy, Eye, EyeOff, Info, KeyRound, Lock } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  shownKeys,
  type By,
  type EventsShown as EventsShownSaid,
  type LogsShown as LogsShownSaid,
  type SecretShown as SecretShownSaid,
} from '@shared/kit/shown'
import type { PluginVia } from '@shared/api'
import { DOOR_LIMITS } from '@shared/plugin-door'
import { READ_REFUSED } from '@shared/plugin-reads'
import { whose } from '@shared/plugins'
import type { ObjectRef } from '@shared/kit/table'
import { apiKindOf } from '@shared/resources'
import { Button, IconButton } from '@renderer/components/Button'
import { ErrorState, Loading } from '@renderer/components/States'
import { useObject } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { EventsTab } from '../features/details/EventsTab'
import { LogsView } from '../features/logs/LogsView'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { formatBytes } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { useCluster } from '@renderer/state/cluster'
import { CARD } from './Lead'

/** Eight dots, whatever is behind them. */
const MASK = '••••••••'

/** A card of something shown by reference: the plugin's title, and whose eyes it's for. */
export function ShownCard({
  title,
  by,
  them = false,
  aside,
  children,
}: {
  title: string
  by: By
  /** "…never sees them": logs and events. */
  them?: boolean
  /** At the heading's far end: what the card is of, or what it does to all of it. */
  aside?: ReactNode
  children: ReactNode
}) {
  const phone = useLayout() === 'phone'
  const caption = (
    <span className="text-xs font-normal text-ink-3">
      {them ? (
        <>
          Shown by Lumovi: <bdi>{whose(by.name)}</bdi> code never sees them.
        </>
      ) : (
        <>
          Shown by Lumovi. <bdi>{by.name}</bdi> can’t see it.
        </>
      )}
    </span>
  )
  return (
    <section aria-label={title} className={cn(!phone && CARD, 'min-w-0')}>
      <h3 className="flex min-h-8 flex-wrap items-center gap-x-3 px-4 pt-3 text-[13px] font-semibold text-ink-1 phone:px-0 phone:pt-0">
        {/* (The title is the plugin's text beside Lumovi's own: its own island of direction.) */}
        <bdi className="min-w-0 truncate">{title}</bdi>
        {!phone && caption}
        {aside && <span className="ml-auto shrink-0">{aside}</span>}
      </h3>
      {/* A phone's heading has no room beside it: the caption stands under the title. */}
      {phone && <p className="pb-2">{caption}</p>}
      <div className="px-4 pb-4 phone:px-0">{children}</div>
    </section>
  )
}

/** What a key's box holds: nothing yet, a read on its way, or what its press came back with. */
type Box =
  | { is: 'hidden'; reading?: 'reveal' | 'copy'; press?: number; failed?: string }
  | { is: 'shown'; value: string; failed?: string }
  | { is: 'missing' }
  | { is: 'withheld' }

const HIDDEN: Box = { is: 'hidden' }

function decoded(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
}

/** One calm line in the card: what can't be shown, and that the plugin's page asked. */
function Said({
  refused = false,
  again,
  children,
}: {
  refused?: boolean
  /** A way back: what was refused or missing may be there a minute later. */
  again?: () => void
  children: ReactNode
}) {
  const Icon = refused ? Lock : Info
  return (
    <div className="flex items-start gap-2.5 pt-1 text-[13px] leading-5 text-ink-2">
      <Icon className={cn('mt-0.5 size-4 shrink-0', refused ? 'text-warn' : 'text-ink-3')} />
      {/* (On a phone the way back stands under the sentence, at its left, a finger's size.) */}
      <div className="flex min-w-0 flex-1 items-start gap-2.5 phone:flex-col">
        <p className="min-w-0 flex-1">{children}</p>
        {again && (
          <Button className="-my-1.5 shrink-0 phone:my-0 phone:h-11" onClick={again}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Everything a press brought (a shown value, "no key named", "hidden by your access", a
 * refusal) belongs to one Secret, one set of keys and one title. When any of those changes, the
 * card is as it opens: a value never stays under a name or a title that isn't the one it was
 * revealed under.
 */
export function SecretShown(props: Parameters<typeof SecretCard>[0]) {
  const { shown } = props
  const { context } = useCluster()
  const of = JSON.stringify([
    context,
    shown.title,
    shown.secret?.namespace,
    shown.secret?.name,
    shownKeys(shown),
  ])
  return <SecretCard key={of} {...props} />
}

function SecretCard({
  shown,
  by,
  from,
  off = false,
}: {
  shown: SecretShownSaid
  by: By
  /** The kind whose object named the Secret, as it's said where it names none ("Certificate"). */
  from?: string
  /** This server doesn't show Secrets' values on a plugin's page. */
  off?: boolean
}) {
  const { context } = useCluster()
  const keys = shownKeys(shown)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map())
  /** What a press came back with for the whole Secret: the boxes give way to it. */
  const [card, setCard] = useState<'not-allowed' | 'not-found'>()
  const { secret } = shown
  const box = (key: string) => boxes.get(key) ?? HIDDEN
  const set = (changed: Iterable<[string, Box]>) =>
    setBoxes((was) => {
      const next = new Map(was)
      for (const [key, value] of changed) next.set(key, value)
      return next
    })
  // An answer belongs to its press: each press has a number, kept in the boxes waiting for it,
  // and what comes back is put only in a box that's still that press's. Hide, or a later press,
  // wins over an answer that arrives after it.
  const presses = useRef(0)
  const here = useRef(true)
  useEffect(() => {
    // (Set here and not only where it's made: in development React runs a mount's effects, their
    // cleanups and the effects again, keeping refs, and it would stay false for good.)
    here.current = true
    return () => {
      here.current = false
    }
  }, [])
  const answer = (number: number, changed: [string, Box][]) =>
    setBoxes((was) => {
      const next = new Map(was)
      for (const [key, value] of changed) {
        const held = was.get(key)
        if (held?.is === 'hidden' && held.press === number) next.set(key, value)
      }
      return next
    })

  /** A press: one read, of the pressed keys alone. */
  const press = async (pressed: string[], to: 'reveal' | 'copy') => {
    if (!secret || pressed.length === 0) return
    const number = ++presses.current
    set(pressed.map((key) => [key, { is: 'hidden', reading: to, press: number }]))
    // Whatever goes wrong on the way, the pressed boxes come back to be pressed again.
    let said: string | undefined
    try {
      const result = await api.kube.secretValues({
        context,
        namespace: secret.namespace,
        name: secret.name,
        keys: pressed,
      })
      // (The card has gone, or been pointed at another Secret, since: nothing of it is used.)
      if (!here.current) return
      if (!result.ok) {
        const { code } = result.error
        if (code === 'not-allowed' || code === 'forbidden' || code === 'not-found') {
          answer(
            number,
            pressed.map((key) => [key, HIDDEN]),
          )
          return setCard(code === 'not-found' ? 'not-found' : 'not-allowed')
        }
        // Anything else is said in the pressed boxes, with their buttons kept.
        said = result.error.message
        return
      }
      const values = new Map(result.data.values)
      if (to === 'copy' && values.size > 0) {
        said = 'The browser didn’t let Lumovi copy it.'
        await navigator.clipboard.writeText(
          pressed.map((key) => decoded(values.get(key) ?? '')).join(''),
        )
        said = undefined
      }
      answer(
        number,
        pressed.map((key): [string, Box] => {
          // (A key the Secret doesn't have is said so whatever the person's access shows: where
          // it shows a Secret's keys, which ones there are is theirs to know.)
          if (result.data.missing.includes(key)) return [key, { is: 'missing' }]
          if (result.data.withheld) return [key, { is: 'withheld' }]
          const value = values.get(key)
          if (value === undefined) return [key, { is: 'missing' }]
          // A copy leaves its box as it was; a reveal keeps the value, for as long as it's shown.
          return [key, to === 'copy' ? HIDDEN : { is: 'shown', value: decoded(value) }]
        }),
      )
    } catch {
      said ??= 'Lumovi couldn’t read this Secret.'
    } finally {
      // (Only the boxes still waiting for this press: the others have moved on.)
      answer(
        number,
        pressed.map((key) => [key, said ? { is: 'hidden', failed: said } : HIDDEN]),
      )
    }
  }
  /** Copies what a box shows; where the page may not, the box says so. */
  const copyShown = (key: string, value: string) =>
    navigator.clipboard.writeText(value).catch(() =>
      setBoxes((was) => {
        const held = was.get(key)
        // (Only if it's still the value that's shown.)
        if (held?.is !== 'shown' || held.value !== value) return was
        return new Map(was).set(key, { ...held, failed: 'The browser didn’t let Lumovi copy it.' })
      }),
    )

  const named = secret && (
    <p className="flex items-start gap-2 pb-2.5 text-[13px] leading-5 text-ink-1">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 wrap-anywhere">
        Secret <bdi className="font-mono text-xs font-medium">{secret.name}</bdi> in{' '}
        <bdi className="font-mono text-xs font-medium">{secret.namespace}</bdi>
      </span>
    </p>
  )
  if (!secret) {
    return (
      <ShownCard title={shown.title} by={by}>
        <Said>This {from ?? 'object'} names no Secret.</Said>
      </ShownCard>
    )
  }
  if (off || card) {
    return (
      <ShownCard title={shown.title} by={by}>
        {named}
        {off ? (
          <Said>This server doesn’t show Secrets’ values on a plugin’s page.</Said>
        ) : card === 'not-allowed' ? (
          <Said refused again={() => setCard(undefined)}>
            Your account isn’t allowed to read this Secret. <bdi>{by.name}</bdi>’s page asks Lumovi
            to show it here.
          </Said>
        ) : (
          <Said again={() => setCard(undefined)}>
            There’s no Secret named <bdi>{secret.name}</bdi> in <bdi>{secret.namespace}</bdi>.{' '}
            <bdi>{by.name}</bdi>’s page points at it.
          </Said>
        )}
      </ShownCard>
    )
  }

  const pressable = keys.filter((key) => box(key).is === 'hidden' || box(key).is === 'shown')
  const allShown = pressable.length > 0 && pressable.every((key) => box(key).is === 'shown')
  const waiting = (key: string) => {
    const held = box(key)
    return held.is === 'hidden' && held.reading !== undefined
  }
  const busy = pressable.some(waiting)
  return (
    <ShownCard
      title={shown.title}
      by={by}
      aside={
        pressable.length > 0 && (
          <Button
            variant="ghost"
            aria-busy={busy}
            disabled={busy}
            onClick={() =>
              allShown
                ? set(pressable.map((key) => [key, HIDDEN]))
                : void press(
                    pressable.filter((key) => box(key).is === 'hidden' && !waiting(key)),
                    'reveal',
                  )
            }
          >
            {allShown ? <EyeOff /> : <Eye />}
            {allShown ? 'Hide all' : 'Reveal all'}
          </Button>
        )
      }
    >
      {named}
      {keys.length === 0 && (
        <Said>
          <bdi>{by.name}</bdi>’s page asks for none of this Secret’s keys.
        </Said>
      )}
      <div className="space-y-2">
        {keys.map((key) => {
          const held = box(key)
          const reading = held.is === 'hidden' ? held.reading : undefined
          return (
            <div
              key={key}
              role="group"
              aria-label={key}
              className="overflow-hidden rounded-xl border border-line"
            >
              <div className="flex min-h-10 items-center gap-2 bg-surface-2 py-1 pr-1 pl-3">
                <bdi className="min-w-0 truncate font-mono text-xs font-medium text-ink-1">
                  {key}
                </bdi>
                {/* Its size is known only while its value is shown. */}
                {held.is === 'shown' && (
                  <span className="shrink-0 text-2xs text-ink-3 tabular-nums">
                    {formatBytes(new TextEncoder().encode(held.value).length)}
                  </span>
                )}
                <span className="flex-1" />
                {(held.is === 'hidden' || held.is === 'shown') && (
                  <>
                    <IconButton
                      label={held.is === 'shown' ? `Hide ${key}` : `Reveal ${key}`}
                      aria-busy={reading === 'reveal'}
                      disabled={reading !== undefined}
                      onClick={() =>
                        held.is === 'shown' ? set([[key, HIDDEN]]) : void press([key], 'reveal')
                      }
                    >
                      {reading === 'reveal' ? (
                        <Turning />
                      ) : held.is === 'shown' ? (
                        <EyeOff />
                      ) : (
                        <Eye />
                      )}
                    </IconButton>
                    <IconButton
                      label={`Copy ${key}`}
                      aria-busy={reading === 'copy'}
                      disabled={reading !== undefined}
                      onClick={() =>
                        held.is === 'shown'
                          ? void copyShown(key, held.value)
                          : void press([key], 'copy')
                      }
                    >
                      {reading === 'copy' ? <Turning /> : <Copy />}
                    </IconButton>
                  </>
                )}
              </div>
              {held.is === 'missing' ? (
                <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
                  Secret <bdi>{secret.name}</bdi> in <bdi>{secret.namespace}</bdi> has no key named{' '}
                  <bdi>{key}</bdi>.
                </p>
              ) : held.is === 'withheld' ? (
                <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
                  Value hidden by your access
                </p>
              ) : (
                <>
                  <pre className="max-h-72 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-1 selectable">
                    {held.is === 'shown' ? held.value : MASK}
                  </pre>
                  {held.failed && (
                    <p role="alert" className="border-t border-line px-3 py-2 text-xs text-ink-2">
                      {held.failed}
                    </p>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </ShownCard>
  )
}

/** The app's loader, in a button's place while its read is on its way. */
function Turning() {
  return (
    <span className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-ink-2" />
  )
}

/**
 * What's in it once the card has come into view, and not before: a page that opens doesn't
 * start reading logs or events for cards nobody has scrolled to.
 */
function OnceInView({ children }: { children: ReactNode }) {
  const place = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return
    const watching = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    })
    watching.observe(place.current!)
    return () => watching.disconnect()
  }, [seen])
  return (
    // (Something to come into view until it has; then only as tall as what's in it.)
    <div ref={place} className={seen ? undefined : 'min-h-16'}>
      {seen && children}
    </div>
  )
}

/** A pod's logs, in Lumovi's own log view. The plugin never holds a line of them. */
export function LogsShown({
  shown,
  by,
  container,
  via,
  off = false,
  waiting,
}: {
  shown: LogsShownSaid
  by: By
  /** The container to show first, where the pod has one of that name. */
  container?: string
  /** Which plugin's page asked Lumovi to show them, for the history. */
  via?: PluginVia
  /** The organization's policy lets no plugin show logs: none are read. */
  off?: boolean
  /** Not streaming yet: a page shows so many at once, and a plugin so many. */
  waiting?: 'page' | 'plugin'
}) {
  const { pod } = shown
  if (off) {
    return (
      <ShownCard title={shown.title} by={by} them>
        <Said refused>{READ_REFUSED['logs-off']}</Said>
      </ShownCard>
    )
  }
  if (waiting) {
    // (Its quiet place, until a place for its stream frees: it then turns into the log view.)
    return (
      <ShownCard
        title={shown.title}
        by={by}
        them
        {...(pod
          ? { aside: <bdi className="font-mono text-xs font-normal text-ink-3">{pod.name}</bdi> }
          : {})}
      >
        <p
          data-logs-waiting
          className="flex min-h-24 items-center justify-center px-4 py-3 text-center text-[13px] text-ink-3"
        >
          {waiting === 'page' ? (
            `Not shown: a plugin’s page shows ${DOOR_LIMITS.logStreamsPage} logs at once. This one starts when another closes.`
          ) : (
            <span>
              Not shown: <bdi>{by.name}</bdi> shows {DOOR_LIMITS.logStreamsPlugin} logs at once,
              across its pages and tabs. This one starts when another closes.
            </span>
          )}
        </p>
      </ShownCard>
    )
  }
  // (What a plugin points at may be gone by the time the page is drawn: said, never thrown on.)
  if (!pod) {
    return (
      <ShownCard title={shown.title} by={by} them>
        <Said>The pod these logs were of isn’t there any more.</Said>
      </ShownCard>
    )
  }
  return (
    <ShownCard
      title={shown.title}
      by={by}
      them
      aside={<bdi className="font-mono text-xs font-normal text-ink-3">{pod.name}</bdi>}
    >
      <OnceInView>
        <PodLogs
          pod={pod}
          by={by}
          {...(container !== undefined ? { container } : {})}
          {...(via ? { via } : {})}
        />
      </OnceInView>
    </ShownCard>
  )
}

function PodLogs({
  pod,
  by,
  container,
  via,
}: {
  pod: ObjectRef
  by: By
  container?: string
  via?: PluginVia
}) {
  const read = useObject('Pod', pod.name, pod.namespace)
  if (read.isPending) return <Loading label="Loading logs…" />
  if (read.data === undefined) {
    const error = read.error as KubeApiError
    if (error.code === 'not-found') {
      return (
        <Said>
          There’s no pod named <bdi>{pod.name}</bdi> in <bdi>{pod.namespace}</bdi>: it may have been
          deleted.
        </Said>
      )
    }
    if (error.code === 'forbidden' || error.code === 'not-allowed') {
      return (
        <Said refused>
          Your account isn’t allowed to read this pod’s logs. <bdi>{by.name}</bdi>’s page asks
          Lumovi to show them here.
        </Said>
      )
    }
    return <ErrorState error={error} onRetry={() => void read.refetch()} />
  }
  // The app's own log view, in a box of its own height: it scrolls inside it.
  return (
    <div className="flex h-96 flex-col overflow-hidden rounded-xl border border-line phone:h-[28rem]">
      <LogsView
        pods={[read.data]}
        name={pod.name}
        {...(container !== undefined ? { container } : {})}
        {...(via ? { via } : {})}
      />
    </div>
  )
}

/** An object's events, as its detail lists them. The plugin never holds one. */
export function EventsShown({ shown, by }: { shown: EventsShownSaid; by: By }) {
  const phone = useLayout() === 'phone'
  const { of } = shown
  if (!of) {
    return (
      <ShownCard title={shown.title} by={by} them>
        <Said>What these events were about isn’t there any more.</Said>
      </ShownCard>
    )
  }
  const kind = apiKindOf(of.kind)
  return (
    <ShownCard
      title={shown.title}
      by={by}
      them
      aside={
        <span className="text-xs font-normal text-ink-3">
          {kind} <bdi>{of.name}</bdi>
        </span>
      }
    >
      <OnceInView>
        {/* As tall as its rows, to 384 px, then scrolling inside; its rows start at the card's
            own edge, and nothing is left empty under the last. */}
        <div
          style={
            {
              '--events-inset': '-0.75rem',
              '--events-field-inset': '0px',
              '--events-gap': '0.25rem',
              '--events-ground': phone ? 'var(--surface)' : 'var(--surface-2)',
            } as CSSProperties
          }
          className="events-in-a-card -mx-3 max-h-96 overflow-x-clip overflow-y-auto px-3 phone:px-3"
        >
          <EventsTab
            object={{
              apiVersion: 'v1',
              kind,
              metadata: { name: of.name, namespace: of.namespace },
            }}
            refused={
              <Said refused>
                Your account isn’t allowed to read these events. <bdi>{by.name}</bdi>’s page asks
                Lumovi to show them here.
              </Said>
            }
          />
        </div>
      </OnceInView>
    </ShownCard>
  )
}
