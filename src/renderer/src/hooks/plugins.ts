import { useQuery } from '@tanstack/react-query'
import { apiGroupOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { api } from '@renderer/lib/api'
import {
  everyKindOf,
  includedPlugins,
  listedPlugins,
  clashes,
  loadShippedPlugins,
  parsePlugin,
  plain,
  setLocalPlugins,
  type ListedPlugin,
  type Plugin,
} from '@renderer/lib/plugins'
import { useResources } from './resources'

// The plugins Lumovi comes with, bundled with the app; and its own views for Kubernetes'
// kinds that have no page, which are written as a plugin's are and aren't one.
const SHIPPED = import.meta.glob<string>('../../../../plugins/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const OWN = import.meta.glob<string>('../views/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})
let shippedProblems = loadShippedPlugins(SHIPPED, OWN)

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

/** A line of what's wrong with the plugins: a problem, or what follows from a file's problems. */
export interface PluginProblem {
  text: string
  /** Nothing to fix by itself, so it isn't counted among the problems. */
  consequence?: true
}

/** What follows for a file that's fine by itself and can't be used beside another: said once, after why. */
const unused = (file: string): PluginProblem => ({
  text: `${file}: isn’t in use`,
  consequence: true,
})

/**
 * The plugins in use: Lumovi's and the user's own, read again on refresh (⌘R) so edits to
 * them show up. Subscribing re-renders when they change.
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const [plugins, { version: lumovi }] = await Promise.all([api.app.plugins(), api.app.info()])
      const { directory, files } = plugins
      // (A release build has none of this: Lumovi's own are the ones built into it, and
      // nothing that's read while it runs is ever taken for one.)
      if (LUMOVI_TEST_BUILD && plugins.included) {
        const standIns = plugins.included.map((file) => [file.name, file.text] as const)
        shippedProblems = loadShippedPlugins({ ...SHIPPED, ...Object.fromEntries(standIns) }, OWN)
      }
      const included = includedPlugins()
      const parsed = files.map((file) => {
        if (file.error)
          return { plugin: undefined, problems: [{ text: `${file.name}: ${file.error}` }] }
        // Whatever a file holds, it's that file's problem and never the others'.
        let read: ReturnType<typeof parsePlugin>
        try {
          read = parsePlugin(file.text, file.name, { lumovi })
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
      // A name is one plugin's: of two files with one name the first is used, and the second
      // says whose name it is.
      const named = new Map<string, string>()
      const unique: Plugin[] = []
      for (const { plugin, problems } of parsed) {
        if (!plugin) continue
        const first = named.get(plugin.name)
        if (first === undefined) {
          named.set(plugin.name, plugin.source)
          unique.push(plugin)
        } else {
          problems.push(
            { text: `${plugin.source}: ${plugin.name} is ${first}’s name too` },
            unused(plugin.source),
          )
        }
      }
      // And a kind is one plugin's: of two of theirs that show one kind, the first is used.
      // (How a file of theirs meets one of Lumovi's is as it was: theirs is used for its kinds.)
      const lost = clashes(unique)
      const local = unique.filter((plugin) => !lost.has(plugin))
      for (const { plugin, problems } of parsed) {
        if (plugin && lost.has(plugin)) {
          problems.push({ text: `${plugin.source}: ${lost.get(plugin)}` }, unused(plugin.source))
        }
      }
      setLocalPlugins(local)
      return {
        directory,
        local,
        included,
        problems: [
          ...shippedProblems.map((text): PluginProblem => ({ text })),
          // (A file's name is the file's to choose, like what's in it: shown plainly too.)
          ...parsed
            .flatMap((p) => p.problems)
            .map((problem) => ({ ...problem, text: plain(problem.text) })),
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
