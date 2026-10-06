import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  managedReadOnly,
  NODE_SHELL_DEFAULTS,
  type NodeShellSetting,
  type Settings,
  type ThemePreference,
} from '@shared/api'
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

/** Whether a cluster is read-only: as set, by LUMOVI_READ_ONLY, or by the organization's policy. */
export function readOnlyIn(settings: Settings | undefined, context: string): boolean {
  return Boolean(
    settings?.readOnlyAll ||
    managedReadOnly(settings?.managed, context) ||
    settings?.readOnly?.includes(context),
  )
}

/**
 * Whether changes to the current cluster are turned off. `locked` means they can't be turned
 * on here: LUMOVI_READ_ONLY turned them off everywhere, or the organization's policy did
 * (`byPolicy`, and `policyProblem` where it can't be used, so it locks every cluster).
 */
export function useReadOnly() {
  const { context } = useCluster()
  const settings = useSettings().data
  const queryClient = useQueryClient()
  const byPolicy = managedReadOnly(settings?.managed, context)
  const locked = settings?.readOnlyAll === true || byPolicy
  return {
    readOnly: readOnlyIn(settings, context),
    locked,
    byPolicy,
    policyProblem: settings?.managed?.problem,
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
