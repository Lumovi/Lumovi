/**
 * The Audit page's data: what the log is, the events its filters find (a
 * page at a time, the newest first), and those recorded since, as they are.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { matches, wordsOf, type AuditEvent, type AuditQuery } from '@shared/audit'
import { api } from '@renderer/lib/api'
import { useConnection } from '@renderer/web/connection'
import { fromOf, type Range } from './audit-model'

/** How many events a page of the list asks for. */
const PAGE = 200

export const useAuditInfo = () =>
  useQuery({
    queryKey: ['audit-info'],
    queryFn: () => api.audit.info(),
    // What couldn't be sent shows soon after.
    refetchInterval: 30_000,
  })

export interface AuditEvents {
  events: AuditEvent[]
  /** Recorded while the page was open, newest first: shown on top as they come. */
  fresh: Set<string>
  loading: boolean
  error?: Error
  /** Whether there are older ones, and getting them. */
  more: boolean
  loadingMore: boolean
  loadMore: () => void
  /** It stopped looking before it found a page's worth: how many it looked through. */
  stopped?: number
}

export function useAuditEvents(query: AuditQuery, range: Range, key: string): AuditEvents {
  const pages = useInfiniteQuery({
    queryKey: ['audit', key],
    // How far back is as of the first page: the next ones keep to it.
    queryFn: async ({ pageParam }) => {
      const from = pageParam ? pageParam.from : fromOf(range, Date.now())
      const page = await api.audit.query({
        ...query,
        ...(from ? { from } : {}),
        limit: PAGE,
        ...(pageParam ? { after: pageParam.after } : {}),
      })
      return { ...page, from }
    },
    initialPageParam: undefined as { after: string; from?: string } | undefined,
    getNextPageParam: (last) => (last.next ? { after: last.next, from: last.from } : undefined),
    // Events come as they're recorded while it's shown: it needn't ask again then. Shown again
    // (back on the page, or a search made again), it asks afresh: what came meanwhile wasn't heard.
    staleTime: Infinity,
    gcTime: 0,
  })
  const { refetch } = pages
  const [live, setLive] = useState<{ key: string; events: AuditEvent[] }>({ key, events: [] })
  // Those recorded from now on: how far back doesn't matter to them.
  useEffect(() => {
    const words = wordsOf(query.text)
    return api.audit.onEvent((event) => {
      if (!matches(query, event, words)) return
      setLive((now) => ({
        key,
        events: [event, ...(now.key === key ? now.events : [])],
      }))
    })
  }, [query, key])
  // Back from a dropped connection (a server that restarted): what happened meanwhile, asked for.
  useEffect(
    () =>
      useConnection.subscribe((now, before) => {
        if (now.state === 'open' && before.state === 'reconnecting') {
          setLive({ key, events: [] })
          void refetch()
        }
      }),
    [key, refetch],
  )
  return useMemo(() => {
    // A new search starts with nothing new.
    const recorded = live.key === key ? live.events : []
    const loaded = pages.data?.pages.flatMap((page) => page.events) ?? []
    const seen = new Set(loaded.map((event) => event.id))
    const fresh = recorded.filter((event) => !seen.has(event.id))
    const last = pages.data?.pages.at(-1)
    return {
      events: [...fresh, ...loaded],
      fresh: new Set(fresh.map((event) => event.id)),
      loading: pages.isPending,
      error: pages.error ?? undefined,
      more: pages.hasNextPage,
      loadingMore: pages.isFetchingNextPage,
      loadMore: () => void pages.fetchNextPage(),
      stopped: last?.stopped
        ? pages.data!.pages.reduce((sum, page) => sum + page.scanned, 0)
        : undefined,
    }
  }, [pages, live, key])
}
