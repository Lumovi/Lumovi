/**
 * The lists and objects the page shows, watched while they're shown: a change in the cluster has
 * the page read it again at once, and while its watches hold, a query is read on a timer only now
 * and then. A list is watched in each namespace it reads (as it reads them), an object by its
 * name. A watch that ends (refused, its kind gone, the connection lost) leaves its query polled as
 * before, and is tried again a while later.
 */
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'
import type { ListQuery, LumoviApi, Result } from '@shared/api'
import { AT_ONCE } from './namespaces'

/** While its watches hold, a query is read again this often anyway. */
export const WATCHED_POLL_MS = 60_000
/** A query's reads for what changed are at least this far apart. */
const READ_AGAIN_MS = 1_000
/** A query no longer shown is watched this long still: shown again soon, its watches go on. */
const LET_GO_MS = 2_000
/** A watch that ended is tried again after this long. */
const AGAIN_MS = 60_000

/** The queries whose watches all hold now, by their hash. */
const holding = new Set<string>()

/** Whether a query's watches hold: then it's polled only now and then. */
export function watched(queryHash: string): boolean {
  return holding.has(queryHash)
}

/** What a query's key watches: a list's, in each of its namespaces; an object; or nothing. */
export function watchesOf(key: QueryKey): ListQuery[] {
  if (key[0] === 'list' && key.length === 6) {
    const [, context, kind, namespaces, labelSelector, fieldSelector] = key
    if (typeof context !== 'string' || typeof kind !== 'string') return []
    const selectors = {
      ...(typeof labelSelector === 'string' && labelSelector ? { labelSelector } : {}),
      ...(typeof fieldSelector === 'string' && fieldSelector ? { fieldSelector } : {}),
    }
    // (Several namespaces are named together, as the list's key has them.)
    const each = typeof namespaces === 'string' && namespaces ? namespaces.split(',') : [undefined]
    return each.map((namespace) => ({
      context,
      kind: kind as ListQuery['kind'],
      ...(namespace ? { namespace } : {}),
      ...selectors,
    }))
  }
  if (key[0] === 'object' && key.length === 5) {
    const [, context, kind, namespace, name] = key
    if (typeof context !== 'string' || typeof kind !== 'string' || typeof name !== 'string') {
      return []
    }
    return [
      {
        context,
        kind: kind as ListQuery['kind'],
        ...(typeof namespace === 'string' ? { namespace } : {}),
        fieldSelector: `metadata.name=${name}`,
      },
    ]
  }
  return []
}

/** A query's watches: their ids, and when it was last read for a change. */
interface Held {
  ids: string[]
  readAt: number
  reading?: ReturnType<typeof setTimeout>
  /** To be read once more when the read under way is done: it may have been asked before. */
  again?: boolean
}

/** Watches what `client`'s shown queries read, through `watches`; stops it all when called. */
export function watchQueries(client: QueryClient, watches: LumoviApi['watches']): () => void {
  const cache = client.getQueryCache()
  const held = new Map<string, Held>()
  /** Which query each watch is for. */
  const queryOf = new Map<string, string>()
  const lettingGo = new Map<string, ReturnType<typeof setTimeout>>()
  const tryingAgain = new Map<string, ReturnType<typeof setTimeout>>()
  // Watches begin as lists are read: at most AT_ONCE at a time, the rest waiting their turn.
  let beginning = 0
  const waiting: (() => void)[] = []
  const begin = (id: string, query: ListQuery): Promise<Result<null>> =>
    new Promise((resolve) => {
      const go = () => {
        beginning++
        void watches
          .start(id, query)
          .catch((error: unknown) => ({
            ok: false as const,
            error: { code: 'server' as const, message: String(error) },
          }))
          .then((result) => {
            beginning--
            waiting.shift()?.()
            resolve(result)
          })
      }
      if (beginning < AT_ONCE) go()
      else waiting.push(go)
    })

  /**
   * Reads a query again (in a window that's hidden, once it's shown: as its timer does). One being
   * read now is read once more when that's done: what changed may have come after it was asked.
   */
  const read = (hash: string) => {
    const query = cache.get(hash)
    if (!query) return
    const watching = held.get(hash)
    if (watching && query.state.fetchStatus === 'fetching') {
      watching.again = true
      return
    }
    void client.invalidateQueries(
      {
        queryKey: query.queryKey,
        exact: true,
        refetchType: document.visibilityState === 'hidden' ? 'none' : 'active',
      },
      { cancelRefetch: false },
    )
  }

  /** Reads a query for what changed: at once, or once it's been a while since the last. */
  const changed = (hash: string, watching: Held) => {
    if (watching.reading) return
    const wait = watching.readAt + READ_AGAIN_MS - Date.now()
    const now = () => {
      watching.reading = undefined
      watching.readAt = Date.now()
      read(hash)
    }
    if (wait <= 0) now()
    else watching.reading = setTimeout(now, wait)
  }

  const start = (query: Query) => {
    const hash = query.queryHash
    const asked = watchesOf(query.queryKey)
    if (asked.length === 0) return
    const watching: Held = { ids: [], readAt: 0 }
    held.set(hash, watching)
    let begun = 0
    for (const each of asked) {
      const id = `watch-${crypto.randomUUID()}`
      watching.ids.push(id)
      queryOf.set(id, hash)
      void begin(id, each).then((result) => {
        if (held.get(hash) !== watching) return
        if (!result.ok) {
          ended(id)
          return
        }
        // All of them holding: read once for what changed before they began, and from then on
        // only now and then by the timer.
        if (++begun === asked.length) {
          holding.add(hash)
          read(hash)
        }
      })
    }
  }

  const stop = (hash: string) => {
    const watching = held.get(hash)
    if (!watching) return
    held.delete(hash)
    holding.delete(hash)
    clearTimeout(watching.reading)
    for (const id of watching.ids) {
      queryOf.delete(id)
      watches.stop(id)
    }
  }

  /** A watch ended: its query is polled again, and watched again later if it's still shown. */
  const ended = (id: string) => {
    const hash = queryOf.get(id)
    if (!hash || !held.has(hash)) return
    // (Its try again set first: reading it says it's shown, which would begin it again now.)
    tryingAgain.set(
      hash,
      setTimeout(() => {
        tryingAgain.delete(hash)
        const query = cache.get(hash)
        if (query) consider(query)
      }, AGAIN_MS),
    )
    stop(hash)
    read(hash)
  }

  /** Watches a query while it's shown (an observer of it enabled), and lets go a while after. */
  const consider = (query: Query) => {
    const hash = query.queryHash
    if (query.isActive()) {
      clearTimeout(lettingGo.get(hash))
      lettingGo.delete(hash)
      if (!held.has(hash) && !tryingAgain.has(hash)) start(query)
    } else if (held.has(hash) && !lettingGo.has(hash)) {
      lettingGo.set(
        hash,
        setTimeout(() => {
          lettingGo.delete(hash)
          if (!cache.get(hash)?.isActive()) stop(hash)
        }, LET_GO_MS),
      )
    }
  }

  const unlistenChanged = watches.onChanged((id) => {
    const hash = queryOf.get(id)
    const watching = hash ? held.get(hash) : undefined
    if (hash && watching) changed(hash, watching)
  })
  const unlistenEnded = watches.onEnded((id) => ended(id))
  const unsubscribe = cache.subscribe((event) => {
    // A read done that was under way when it changed: once more.
    if (
      event.type === 'updated' &&
      (event.action.type === 'success' || event.action.type === 'error')
    ) {
      const watching = held.get(event.query.queryHash)
      if (watching?.again) {
        watching.again = false
        read(event.query.queryHash)
      }
    }
    if (event.type === 'removed') {
      stop(event.query.queryHash)
      clearTimeout(tryingAgain.get(event.query.queryHash))
      tryingAgain.delete(event.query.queryHash)
      return
    }
    if (watchesOf(event.query.queryKey).length > 0) consider(event.query)
  })
  for (const query of cache.getAll()) {
    if (watchesOf(query.queryKey).length > 0) consider(query)
  }

  return () => {
    unsubscribe()
    unlistenChanged()
    unlistenEnded()
    for (const hash of [...held.keys()]) stop(hash)
    for (const timer of [...lettingGo.values(), ...tryingAgain.values()]) clearTimeout(timer)
  }
}
