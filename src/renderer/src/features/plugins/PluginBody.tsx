/**
 * Where a plugin's page or tab is drawn: the door's, which draws the strip that says whose it is,
 * then the plugin's frame, or Lumovi's place when it stopped. Until the door is in, a stand-in
 * stands here, for the tests' build alone (nothing of a plugin's pages, tabs or commands reaches
 * a release build before then): it says what's asked of it, so the places round it can be seen
 * and tested. The door's component takes the same props and replaces this file's.
 */
import type { ObjectRef } from '@shared/kit/table'
import type { ListedPlugin } from '@shared/plugins'
import { useLayout } from '@renderer/lib/layout'

export function PluginBody({
  plugin,
  page,
  tab,
  object,
}: {
  plugin: ListedPlugin
} & (
  { page: string; tab?: never; object?: never } | { tab: string; object: ObjectRef; page?: never }
)) {
  const short = useLayout() !== 'wide'
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-plugin-body={plugin.name}>
      <p className="border-b border-line bg-surface-2 px-5 py-2 text-xs text-ink-2">
        {short ? 'From the plugin ' : 'This page is from the plugin '}
        <bdi className="font-semibold text-ink-1">{plugin.label}</bdi> {plugin.version}.
      </p>
      <p className="px-5 py-8 text-center text-xs text-ink-3">
        {page !== undefined
          ? `Stand-in for the door: the page ${page}.`
          : `Stand-in for the door: the tab ${tab}, on ${object.kind} ${object.name}.`}
      </p>
    </div>
  )
}
