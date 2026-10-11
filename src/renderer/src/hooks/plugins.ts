import { useQuery } from '@tanstack/react-query'
import { apiGroupOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { api } from '@renderer/lib/api'
import {
  everyKindOf,
  includedPlugins,
  listedPlugins,
  loadShippedPlugins,
  parsePlugin,
  setLocalPlugins,
  type ListedPlugin,
  type Plugin,
} from '@renderer/lib/plugins'
import { useResources } from './resources'

// The plugins Lumovi comes with, bundled with the app; and its own views for Kubernetes'
// kinds that have no page, which are written as a plugin's are and aren't one.
const SHIPPED_PROBLEMS = loadShippedPlugins(
  import.meta.glob<string>('../../../../plugins/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  import.meta.glob<string>('../views/*.yaml', { query: '?raw', import: 'default', eager: true }),
)

/** A line of what's wrong with the plugins: a problem, or what follows from a file's problems. */
export interface PluginProblem {
  text: string
  /** Nothing to fix by itself, so it isn't counted among the problems. */
  consequence?: true
}

/**
 * The plugins in use: Lumovi's and the user's own, read again on refresh (⌘R) so edits to
 * them show up. Subscribing re-renders when they change.
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const { directory, files } = await api.app.plugins()
      const included = includedPlugins()
      const parsed = files.map((file) => {
        if (file.error)
          return { plugin: undefined, problems: [{ text: `${file.name}: ${file.error}` }] }
        // Whatever a file holds, it's that file's problem and never the others'.
        let read: ReturnType<typeof parsePlugin>
        try {
          read = parsePlugin(file.text, file.name)
        } catch (error) {
          const text = `${file.name}: It couldn’t be read: ${(error as Error).message}`
          return { plugin: undefined, problems: [{ text }] }
        }
        const problems: PluginProblem[] = read.problems.map((text) => ({ text }))
        // A plugin of theirs that would have replaced one of Lumovi's leaves it in use while
        // it has a problem: said after the file's problems, since Lumovi's looks much like theirs.
        const stead = read.plugin ? undefined : included.find(({ name }) => name === read.name)
        if (stead) {
          problems.push({
            text: `${file.name}: isn’t in use, so Lumovi’s ${stead.place?.label ?? stead.name} is shown instead`,
            consequence: true,
          })
        }
        return { plugin: read.plugin, problems }
      })
      const local = parsed.flatMap((p): Plugin[] => (p.plugin ? [p.plugin] : []))
      setLocalPlugins(local)
      return {
        directory,
        local,
        included,
        problems: [
          ...SHIPPED_PROBLEMS.map((text): PluginProblem => ({ text })),
          ...parsed.flatMap((p) => p.problems),
        ],
      }
    },
    staleTime: Infinity,
  })
}

/** A plugin with a place in the sidebar, with those of its kinds the cluster serves, in its order. */
export interface ServedPlugin {
  plugin: ListedPlugin
  kinds: ResourceDefinition[]
}

/**
 * The plugins of the tools this cluster has (it serves at least one of their
 * kinds), by name.
 */
export function useServedPlugins(): ServedPlugin[] {
  // Subscribes to the user's plugins, and to what the cluster serves.
  usePlugins()
  const resources = useResources().data ?? []
  const served = new Map(resources.map((r) => [r.kind, r]))
  // Every kind of a group: the ones the cluster serves, by name.
  const kindsOf = (kind: ResourceKind) =>
    kind === everyKindOf(kind)
      ? resources
          .filter((r) => r.group === apiGroupOf(kind))
          .sort((a, b) => a.label.localeCompare(b.label))
      : (served.get(kind) ?? [])
  return listedPlugins()
    .map((plugin) => ({ plugin, kinds: plugin.kinds.flatMap(kindsOf) }))
    .filter(({ kinds }) => kinds.length > 0)
    .sort((a, b) =>
      a.plugin.label.localeCompare(b.plugin.label, undefined, { sensitivity: 'base' }),
    )
}

/** The plugin a kind's list belongs to, if the cluster has it. */
export function usePluginOf(kind: ResourceKind | undefined): ServedPlugin | undefined {
  const plugins = useServedPlugins()
  return kind ? plugins.find(({ kinds }) => kinds.some((r) => r.kind === kind)) : undefined
}
