/**
 * What the Plugins page says of Lumovi-plugins' latest release (the desktop app's alone): the
 * toolbar's line, what's newer for a plugin, and the plugins this Lumovi doesn't carry. Checked
 * in the main process (src/main/plugin-store.ts) on opening the page and on Check now; nothing
 * here installs anything.
 */
import { LoaderCircle, Lock, Package, TriangleAlert } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { failedLine, type StoreCheck, type StoreRelease } from '@shared/plugin-store'
import { older, parsePlugin, type Plugin } from '@shared/plugins'
import { Button } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { lumovisOwnKinds } from '@renderer/lib/plugins'
import { withTime } from '@renderer/lib/time'

/**
 * The store's check, as last asked: asked again each time the page opens (the main process
 * answers from its last check within ten minutes), and on Check now.
 */
export function usePluginStore() {
  const store = api.pluginStore
  const queryClient = useQueryClient()
  const [pressed, setPressed] = useState(false)
  const query = useQuery({
    queryKey: ['plugin-store'],
    queryFn: () => store!.check(),
    enabled: store !== undefined,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  })
  const checkNow = async () => {
    setPressed(true)
    try {
      queryClient.setQueryData(['plugin-store'], await store!.check(true))
    } catch (error) {
      const last = releaseOf(query.data)
      const failed: StoreCheck = {
        state: 'failed',
        failure: { check: 'network', words: (error as Error).message },
        at: Date.now(),
        ...(last ? { last } : {}),
      }
      queryClient.setQueryData(['plugin-store'], failed)
    } finally {
      setPressed(false)
    }
  }
  // (Where the main process couldn't be asked at all, said as the network's words are.)
  const check: StoreCheck | undefined =
    query.data ??
    (query.error
      ? {
          state: 'failed',
          failure: { check: 'network', words: query.error.message },
          at: query.errorUpdatedAt,
        }
      : undefined)
  return {
    /** Nothing where there's no store: on a server. */
    there: store !== undefined,
    check,
    checking: store !== undefined && (pressed || (query.isPending && !query.error)),
    checkNow,
  }
}

/** The release whose plugins the page goes on with: the last that passed every check. */
export const releaseOf = (check: StoreCheck | undefined): StoreRelease | undefined =>
  check?.state === 'checked' ? check.release : check?.state === 'failed' ? check.last : undefined

/** What's offered for one of Lumovi's plugins: a newer version, or one this Lumovi is too old for. */
export type Offer = { update: string } | { needs: { version: string; lumovi: string } }

/** What `release` offers for `plugin`, in use at its version, in this Lumovi (`lumovi`). */
export function offerFor(
  plugin: Plugin,
  release: StoreRelease | undefined,
  lumovi: string,
): Offer | undefined {
  const there = release?.plugins.find(({ name }) => name === plugin.name)
  if (!there || !older(plugin.version, there.version)) return undefined
  return there.lumovi && older(lumovi, there.lumovi)
    ? { needs: { version: there.version, lumovi: there.lumovi } }
    : { update: there.version }
}

/** A plugin of the release that this Lumovi doesn't carry, read as Lumovi's own are. */
export interface NotHere {
  plugin: Plugin
  /** The Lumovi it needs, where this one is older. */
  needs?: string
}

/** A plugin of the release, read as Lumovi reads its own. */
export interface Offered {
  plugin: Plugin
  code: boolean
  /** The oldest Lumovi it works with, as the release's index says. */
  needs?: string
}

/** The release's plugins, each read as Lumovi reads its own, by name: one it can't read isn't offered. */
export function useOffered(release: StoreRelease | undefined): ReadonlyMap<string, Offered> {
  return useMemo(
    () =>
      new Map(
        (release?.plugins ?? []).flatMap((entry) => {
          const { plugin } = parsePlugin(entry.file, `${entry.name}.yaml`, {
            lumovisOwn: lumovisOwnKinds(),
            carriesCode: true,
          })
          return plugin
            ? [
                [
                  plugin.name,
                  { plugin, code: entry.code, ...(entry.lumovi ? { needs: entry.lumovi } : {}) },
                ] as const,
              ]
            : []
        }),
      ),
    [release],
  )
}

/** The release's plugins whose names none here has (`have`). */
export function notHere(
  offered: ReadonlyMap<string, Offered>,
  have: ReadonlySet<string>,
  lumovi: string,
): NotHere[] {
  return [...offered.values()]
    .filter(({ plugin }) => !have.has(plugin.name))
    .map(({ plugin, needs }) => ({
      plugin,
      ...(needs && older(lumovi, needs) ? { needs } : {}),
    }))
}

/** "just now", "2m ago", "3h ago", "2d ago". */
export function checkedAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** The time of a check, for the filters that keep what it found: "14:02". */
export const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, withTime({ hour: '2-digit', minute: '2-digit' }))

/** Now, again every half minute: for "checked 2m ago". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The toolbar's line: which release was checked and when, what's happening, why it couldn't
 * check, or that the policy turns it off; with Check now, but where it's off.
 */
export function StoreLine({ store }: { store: ReturnType<typeof usePluginStore> }) {
  const now = useNow()
  const { check, checking } = store
  if (!store.there) return null
  if (check?.state === 'off') {
    return (
      <p data-plugin-store="off" className="flex items-center gap-2 text-xs text-ink-3">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        Your organization’s policy turns off checking for newer plugins.
      </p>
    )
  }
  const button = (
    <Button
      variant="ghost"
      disabled={checking}
      onClick={() => void store.checkNow()}
      className="h-7 shrink-0 px-2 text-xs"
    >
      Check now
    </Button>
  )
  if (checking || !check) {
    return (
      <div data-plugin-store="checking" className="flex items-center gap-2 text-xs text-ink-3">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
        <span role="status">Checking for newer plugins…</span>
        {button}
      </div>
    )
  }
  if (check.state === 'failed') {
    return (
      <div data-plugin-store="failed" className="flex items-center gap-2 text-xs text-ink-2">
        <TriangleAlert className="size-3.5 shrink-0 text-warn-text" aria-hidden />
        <span className="min-w-0">{failedLine(check.failure)}</span>
        {button}
      </div>
    )
  }
  return (
    <div
      data-plugin-store="checked"
      className="flex items-center gap-2 text-xs whitespace-nowrap text-ink-3"
    >
      <Package className="size-3.5 shrink-0" aria-hidden />
      <span>
        Lumovi-plugins release{' '}
        <span className="font-mono font-medium text-ink-2">{check.release.version}</span> · checked{' '}
        {checkedAgo(check.release.checked, now)}
      </span>
      {button}
    </div>
  )
}
