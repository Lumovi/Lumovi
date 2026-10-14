/**
 * A server's notifications of new warnings: each person's own, per cluster, kept in this browser
 * (whose permission they need anyway). Turned on in the sidebar's cluster menu, they're told
 * while a Lumovi tab is open here, hidden or not: every 30 seconds the page reads the watched
 * namespaces' Warning events as the person, and what's new is told as the desktop app tells it.
 */
import { useQuery } from '@tanstack/react-query'
import { Bell, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KubeObject } from '@shared/api'
import { WARNINGS_EVERY_MS, WarningWatch } from '@shared/warning-notices'
import { Button } from '@renderer/components/Button'
import { api, unwrap } from '@renderer/lib/api'
import { usePrefs } from '@renderer/state/prefs'
import { useSession } from '@renderer/state/session'
import { ClusterTile } from '../welcome/ClusterTile'
import { initials } from '../welcome/clusters'
import { Toggle, WatchField } from '../welcome/ClusterSettingsDialog'
import { PageDialog } from '../welcome/PageDialog'

/** What a person's watching of a cluster is kept by, in this browser. */
const keyOf = (person: string, context: string) => `${person}|${context}`

/** This person's watching of a cluster: on or off, and the namespaces. */
export function useWarnings(context: string) {
  const person = useSession()?.user.name ?? ''
  const key = keyOf(person, context)
  const watching = usePrefs((prefs) => prefs.warnings[key])
  const setWarnings = usePrefs((prefs) => prefs.setWarnings)
  return { watching, set: (next?: { watch?: string[] }) => setWarnings(key, next) }
}

/** Whether this browser can show notifications at all, and whether it lets Lumovi. */
const permissionNow = () => ('Notification' in window ? Notification.permission : ('none' as const))

/** "Off", "On, in shop and payments", "On, in 3 namespaces", "On, in all namespaces". */
function stateWords(watching?: { watch?: string[] }) {
  if (!watching) return 'Off'
  const watch = watching.watch
  if (!watch?.length) return 'On, in all namespaces'
  // (From three, how many: the row stays one line.)
  return watch.length > 2 ? `On, in ${watch.length} namespaces` : `On, in ${watch.join(' and ')}`
}

/** The sidebar cluster menu's row: what it's set to, and a way into its dialog. */
export function WarningsRow({ context, onOpen }: { context: string; onOpen: () => void }) {
  const { watching } = useWarnings(context)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-t border-line px-3 py-2.5 text-left hover:bg-surface-3/50"
    >
      <Bell className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-ink-1">Notify me of new warnings</span>
        <span className="block truncate text-xs leading-snug text-ink-3">
          {stateWords(watching)}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" />
    </button>
  )
}

/** A person's own notifications of a cluster's new warnings, in this browser. */
export function WarningsDialog({ context, onClose }: { context: string; onClose: () => void }) {
  const { watching, set } = useWarnings(context)
  const [notify, setNotify] = useState(!!watching)
  const [watch, setWatch] = useState(watching?.watch)
  const [permission, setPermission] = useState(permissionNow)
  const namespaces = useQuery({
    queryKey: ['cluster-namespaces', context],
    queryFn: async () =>
      (await unwrap(api.kube.list({ context, kind: 'Namespace' }))).items.map(
        (item) => item.metadata.name,
      ),
    retry: false,
  })
  const save = () => {
    set(notify ? { ...(watch?.length ? { watch } : {}) } : undefined)
    onClose()
  }
  return (
    <PageDialog
      leading={<ClusterTile letters={initials(context)} large />}
      title={context}
      subtitle="Notifications of new warnings"
      onSubmit={save}
      onClose={onClose}
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </>
      }
    >
      <Toggle
        title="Notify me of new warnings"
        line="While a Lumovi tab is open in this browser, it checks these namespaces’ warnings every 30 seconds, as you, and tells you of new ones."
        checked={notify && permission !== 'none'}
        onChange={setNotify}
        {...(permission === 'none' ? { locked: 'This browser can’t show notifications.' } : {})}
      />
      {notify && permission !== 'none' && (
        <>
          <WatchField names={namespaces.data ?? []} watch={watch} onChange={setWatch} />
          <div className="mt-4 ml-12 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-ink-2">
            {permission === 'default' ? (
              <>
                <b className="font-medium text-ink-1">Your browser will ask first.</b> Lumovi shows
                these only while one of its tabs is open in this browser, hidden or not.
                <div className="mt-2">
                  <Button onClick={() => void Notification.requestPermission().then(setPermission)}>
                    Allow notifications
                  </Button>
                </div>
              </>
            ) : permission === 'granted' ? (
              <>
                <b className="font-medium text-ink-1">On in this browser.</b> Only while a Lumovi
                tab is open.{' '}
                <button
                  type="button"
                  onClick={() =>
                    new Notification('A test from Lumovi', {
                      body: `New warnings in ${context} come like this.`,
                    })
                  }
                  className="font-medium text-accent-strong hover:underline"
                >
                  Send a test
                </button>
              </>
            ) : (
              <>
                <b className="font-medium text-ink-1">
                  This browser blocks Lumovi’s notifications.
                </b>{' '}
                Allow them in its settings for this site, then come back. The switch stays on, so
                they start once allowed.
              </>
            )}
          </div>
        </>
      )}
      <p className="mt-3 ml-12 text-xs text-ink-3">
        Each new Warning event, once per object and reason in 10 minutes. Several at once come as
        one: “5 new warnings in shop”.
      </p>
    </PageDialog>
  )
}

/**
 * The page's own look, every 30 seconds while it's open (hidden or not), at each cluster this
 * person watches in this browser: what's new told by the browser, where it lets Lumovi. A click
 * comes back to the tab, at where it happened.
 */
export function ServerWarningNotices({ navigate }: { navigate: (path: string) => void }) {
  const person = useSession()?.user.name ?? ''
  const warnings = usePrefs((prefs) => prefs.warnings)
  const watch = useRef(new WarningWatch())
  const mine = Object.entries(warnings)
    .filter(([key]) => key.startsWith(`${person}|`))
    .map(([key, watching]) => ({ context: key.slice(person.length + 1), watch: watching.watch }))
  const asked = JSON.stringify(mine)
  useEffect(() => {
    const clusters = JSON.parse(asked) as { context: string; watch?: string[] }[]
    // (Turned off: forgotten, so turned on again it starts from what's there then.)
    for (const context of watch.current.watched) {
      if (!clusters.some((cluster) => cluster.context === context)) watch.current.forget(context)
    }
    if (clusters.length === 0) return
    let looking = false
    const look = async () => {
      if (looking) return
      looking = true
      try {
        for (const { context, watch: namespaces } of clusters) {
          const events: KubeObject[] = []
          let whole = true
          for (const namespace of namespaces ?? [undefined]) {
            const listed = await api.kube.list({
              context,
              kind: 'Event',
              ...(namespace ? { namespace } : {}),
              fieldSelector: 'type=Warning',
            })
            if (listed.ok) events.push(...listed.data.items)
            else whole = false
          }
          // (A look with a read that failed is left for the next: nothing told of it now, and
          // what was seen kept.)
          if (!whole) continue
          for (const notice of watch.current.look(context, context, events, Date.now())) {
            if (permissionNow() !== 'granted') continue
            const shown = new Notification(notice.title, {
              body: `${notice.body}\n${notice.cluster}`,
              // (The same one from another of the person's tabs, shown once.)
              tag: `${notice.opens} ${notice.title}`,
            })
            shown.onclick = () => {
              window.focus()
              navigate(notice.opens)
            }
          }
        }
      } finally {
        looking = false
      }
    }
    const stopped = new AbortController()
    const looks = () => {
      // (From what's there now: what this tab saw before another took over is old.)
      for (const context of watch.current.watched) watch.current.forget(context)
      void look()
      const timer = setInterval(() => void look(), WARNINGS_EVERY_MS)
      stopped.signal.addEventListener('abort', () => clearInterval(timer))
    }
    // One of the person's tabs looks, the one that asked first: the next, once it's closed. (A
    // page without the browser's locks, not served over HTTPS, looks in each tab.)
    if (navigator.locks) {
      navigator.locks
        .request(`lumovi-warnings ${person}`, { signal: stopped.signal }, () => {
          looks()
          return new Promise((done) => stopped.signal.addEventListener('abort', done))
        })
        .catch(() => {})
    } else {
      looks()
    }
    return () => stopped.abort()
  }, [asked, navigate, person])
  return null
}
