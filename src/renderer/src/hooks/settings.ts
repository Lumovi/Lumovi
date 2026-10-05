import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NODE_SHELL_DEFAULTS, type NodeShellSetting, type ThemePreference } from '@shared/api'
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
 * LUMOVI_READ_ONLY turned them off everywhere, so they can't be turned on.
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

/**
 * Where the current cluster's node shells run: as set for it, or by default
 * (the server's, where it has its own), and whether they're turned off.
 */
export function useNodeShellSetting() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  // Until the settings are read: the defaults.
  const settings = Object.assign(
    { nodeShell: {}, nodeShellDefault: NODE_SHELL_DEFAULTS },
    useSettings().data,
  )
  const own: NodeShellSetting | undefined = settings.nodeShell![context]
  return {
    setting: own ?? settings.nodeShellDefault!,
    defaults: settings.nodeShellDefault!,
    custom: own !== undefined,
    off: settings.nodeShellsOff === true,
    async set(setting: NodeShellSetting | null) {
      queryClient.setQueryData(['settings'], await api.app.setNodeShell(context, setting))
    },
  }
}
