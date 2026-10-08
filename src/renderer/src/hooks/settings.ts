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
import { toast } from '@renderer/state/toasts'

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.app.settings(),
    staleTime: Infinity,
  })
}

/** Why someone may not change a server's clusters' settings (as the server says it too). */
export const ADMINS_ONLY = 'Only Lumovi’s admins change what’s set for everyone on this server.'

/**
 * On a server, its clusters' settings are everyone's (`shared`), and only some may change them
 * (`mayChange`: Lumovi's admins, or anyone where it has none). On the desktop, they're the
 * person's own.
 */
export function useSharedSettings() {
  const settings = useSettings().data
  return {
    shared: settings?.shared !== undefined,
    mayChange: settings?.shared?.mayChange !== false,
  }
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
 *
 * On a server it's everyone's (`shared`): `by` says who made it read-only, and when, and only
 * some may change it (`mayChange`: Lumovi's admins, or anyone where there are none). `why` says,
 * where changes are off, why.
 */
export function useReadOnly() {
  const { context } = useCluster()
  const settings = useSettings().data
  const queryClient = useQueryClient()
  const byPolicy = managedReadOnly(settings?.managed, context)
  const locked = settings?.readOnlyAll === true || byPolicy
  const shared = settings?.shared !== undefined
  const by = settings?.readOnlyBy?.[context]
  return {
    readOnly: readOnlyIn(settings, context),
    locked,
    byPolicy,
    policyProblem: settings?.managed?.problem,
    shared,
    by,
    /** Changed outside Lumovi, where the server keeps it: shown to those who may set it. */
    outside: settings?.readOnlyChangedOutside?.[context],
    mayChange: !locked && settings?.shared?.mayChange !== false,
    why: by
      ? `Changes are turned off for this cluster: ${by.by} made it read-only for everyone.`
      : 'Changes are turned off for this cluster.',
    /** Why it's read-only, said of the cluster. */
    said: by
      ? `${by.by} made ${context} read-only for everyone on this server`
      : `${context} is read-only in Lumovi`,
    /** Says so where it can't be changed. */
    async set(readOnly: boolean) {
      try {
        queryClient.setQueryData(['settings'], await api.app.setReadOnly(context, readOnly))
      } catch (error) {
        toast({ tone: 'error', title: 'Couldn’t change it', description: (error as Error).message })
      }
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
