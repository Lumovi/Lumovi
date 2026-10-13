import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { settle } from '@shared/plugin-loading'
import { apiGroupOf, type ResourceDefinition, type ResourceKind } from '@shared/resources'
import { api } from '@renderer/lib/api'
import {
  everyKindOf,
  includedPlugins,
  listedPlugins,
  loadShippedPlugins,
  lumovisOwnKinds,
  plain,
  setLocalPlugins,
  type ListedPlugin,
  type Plugin,
} from '@renderer/lib/plugins'
import SHIPPED from 'virtual:lumovi-plugins'
import { useResources } from './resources'

/**
 * The plugin whose page is open, as it was last shown in use: when it stops being in use, its
 * page keeps its name for a title (the header's too) until the person goes elsewhere.
 */
export const useOpenPluginPage = create<{ open?: { context: string; plugin: ListedPlugin } }>()(
  () => ({}),
)

// The plugins Lumovi comes with, from the bundle its build checked (scripts/vite-plugins.ts);
// and its own views for Kubernetes' kinds that have no page, which are written as a plugin's are
// and aren't one.
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

/**
 * The plugins in use: Lumovi's and the user's own, read again on refresh (⌘R) so edits to
 * them show up. Subscribing re-renders when they change.
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const [plugins, { version: lumovi }, { managed }] = await Promise.all([
        api.app.plugins(),
        api.app.info(),
        api.app.settings(),
      ])
      const { directory, files } = plugins
      // Which may be there at all, by the organization's policy: none, or these by name.
      const allowed = (name: string) =>
        !managed?.pluginsOff && (!managed?.pluginsAllowed || managed.pluginsAllowed.includes(name))
      // (A release build has none of this: Lumovi's own are the ones built into it, and
      // nothing that's read while it runs is ever taken for one.)
      const standIns =
        LUMOVI_TEST_BUILD && plugins.included
          ? Object.fromEntries(plugins.included.map((file) => [file.name, file.text] as const))
          : {}
      if (Object.keys(standIns).length > 0 || managed?.pluginsOff || managed?.pluginsAllowed) {
        shippedProblems = loadShippedPlugins({ ...SHIPPED, ...standIns }, OWN, allowed)
      }
      const included = includedPlugins()
      const settled = settle(included, files, api.host === 'desktop' ? 'yours' : 'server', {
        lumovi,
        lumovisOwn: lumovisOwnKinds(),
      })
      // (One the policy doesn't name isn't there: not in use, nor listed.)
      settled.files = settled.files.filter(({ plugin }) => !plugin || allowed(plugin.name))
      const local = settled.files.flatMap(({ state, plugin }) =>
        state === 'not-in-use' ? [] : [plugin!],
      )
      const label = (plugin: Plugin) => plugin.place?.label ?? plugin.name
      // Theirs that are in use in place of one of Lumovi's: said with the count, not as a problem.
      const replacing = settled.files.flatMap(({ file, state, lumovis }) =>
        state === 'in-place-of' ? [{ file, label: label(lumovis!) }] : [],
      )
      // What's wrong with each file, and after it, once, what follows: that it isn't in use
      // (where it's fine by itself and can't be used beside another), and that Lumovi's own is
      // shown instead of it (where it has that plugin's name, and so looks much like it).
      const problems = settled.files.flatMap(({ file, state, problems, lumovis, beside }) => {
        const lines: PluginProblem[] = problems.map((text) => ({ text }))
        if (state === 'not-in-use' && (lumovis || beside)) {
          lines.push({
            text: plain(
              `${file}: isn’t in use${lumovis ? `, so Lumovi’s ${label(lumovis)} is shown instead` : ''}`,
            ),
            consequence: true,
          })
        }
        return lines
      })
      setLocalPlugins(local)
      return {
        directory,
        local,
        replacing,
        included,
        /** What became of each file of the folder, and which of Lumovi's are in use beside them. */
        files: settled.files,
        lumovisInUse: settled.lumovis,
        /** What's wrong with Lumovi's own (in a release, nothing). */
        shipped: shippedProblems,
        lumovi,
        problems: [...shippedProblems.map((text): PluginProblem => ({ text })), ...problems],
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
  return (
    listedPlugins()
      .map((plugin) => ({ plugin, kinds: plugin.kinds.flatMap(kindsOf) }))
      // (One whose kinds this cluster doesn't serve isn't in use here; one of pages alone, with no
      // kinds of its own, is in use wherever it is.)
      .filter(
        ({ plugin, kinds }) =>
          kinds.length > 0 || (plugin.kinds.length === 0 && plugin.added.pages.length > 0),
      )
      .sort((a, b) =>
        a.plugin.label.localeCompare(b.plugin.label, undefined, { sensitivity: 'base' }),
      )
  )
}

/** The plugin a kind's list belongs to, if the cluster has it. */
export function usePluginOf(kind: ResourceKind | undefined): ServedPlugin | undefined {
  const plugins = useServedPlugins()
  return kind ? plugins.find(({ kinds }) => kinds.some((r) => r.kind === kind)) : undefined
}
