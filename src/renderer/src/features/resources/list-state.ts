import { useSearchParams } from 'react-router'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { Health } from '@renderer/lib/health'

export const PAGE_SIZES = [50, 100, 250, 500]
const DEFAULT_PAGE_SIZE = 100

export interface ListState {
  /** Free-text filter over names, namespaces and labels. */
  q: string
  /** Health levels to show; empty shows everything. */
  health: Health[]
  sort: string
  desc: boolean
  /** 1-based page number. */
  page: number
  size: number
  /** Server-side label selector. */
  labels: string
}

/**
 * List state lives in the URL so Back/Forward restore it and other views can
 * link straight to a filtered list (e.g. `?health=critical,warning`).
 */
export function useListState(
  defaultSort: string,
): [ListState, (patch: Partial<ListState>) => void] {
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const state: ListState = {
    q: params.get('q') ?? '',
    health: (params.get('health')?.split(',') ?? []) as Health[],
    sort: params.get('sort') ?? defaultSort,
    desc: params.get('desc') === '1',
    page: Math.max(1, Number(params.get('page')) || 1),
    size: PAGE_SIZES.includes(Number(params.get('size')))
      ? Number(params.get('size'))
      : DEFAULT_PAGE_SIZE,
    labels: params.get('labels') ?? '',
  }

  const serialize: { [K in keyof ListState]: (value: ListState[K]) => string } = {
    q: (q) => q,
    health: (health) => health.join(','),
    sort: (sort) => (sort === defaultSort ? '' : sort),
    desc: (desc) => (desc ? '1' : ''),
    page: (page) => (page === 1 ? '' : String(page)),
    size: (size) => (size === DEFAULT_PAGE_SIZE ? '' : String(size)),
    labels: (labels) => labels,
  }

  /** Writes only the keys in `patch`. */
  const update = (patch: Partial<ListState>) =>
    updateParams(
      (next) => {
        // Any change other than paging starts again from the first page.
        if (!('page' in patch)) next.delete('page')
        for (const [key, value] of Object.entries(patch) as [keyof ListState, never][]) {
          const text = serialize[key](value)
          if (text) next.set(key, text)
          else next.delete(key)
        }
      },
      { replace: true },
    )

  return [state, update]
}
