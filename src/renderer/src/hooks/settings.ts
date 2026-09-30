import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThemePreference } from '@shared/api'
import { api } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.app.settings(),
    staleTime: Infinity,
  })
}

export function useSetTheme() {
  const queryClient = useQueryClient()
  return async (theme: ThemePreference) => {
    queryClient.setQueryData(['settings'], await api.app.setTheme(theme))
  }
}

/**
 * Whether changes to the current cluster are turned off. `locked` means
 * KUBESTACKS_READ_ONLY turned them off everywhere, so they can't be turned on.
 */
export function useReadOnly() {
  const { context } = useCluster()
  const settings = useSettings().data
  const queryClient = useQueryClient()
  const locked = settings?.readOnlyAll === true
  return {
    readOnly: locked || (settings?.readOnly ?? []).includes(context),
    locked,
    async set(readOnly: boolean) {
      queryClient.setQueryData(['settings'], await api.app.setReadOnly(context, readOnly))
    },
  }
}
