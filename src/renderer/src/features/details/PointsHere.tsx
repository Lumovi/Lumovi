import { ChevronRight, Plug } from 'lucide-react'
import type { KubeObject } from '@shared/api'
import { apiKindOf } from '@shared/resources'
import { KindIcon } from '@renderer/components/KindIcon'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { StatusPill } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useServedPlugins } from '@renderer/hooks/plugins'
import { usePointing, type Pointing } from '@renderer/hooks/pointing'
import { pluginNamed, renderWhole, viewStatus } from '@renderer/lib/plugins'
import { worstFirst } from '@renderer/lib/pointing'
import { formatRef } from '@renderer/lib/routes'
import { useActionsUi } from '@renderer/state/actions'
import { Section } from './sections'

/** A plugin as its group's line says it: "Trivy 1.1.0", its place's name where it has one. */
function pluginWords(name: string): { label: string; version?: string } {
  const plugin = pluginNamed(name)
  return { label: plugin?.place?.label ?? name, ...(plugin ? { version: plugin.version } : {}) }
}

/** How many are drawn: past it, how many more there are. */
const SHOWN_MOST = 50

/**
 * The objects that point at this one, as plugins' links say they do (`listedThere`), worst first
 * and grouped by plugin: each with its kind and what it's of, its view's status, and opening it (on its plugin's
 * tab, where it has one). Drawn from the file alone: no plugin's code runs here. Nothing, where
 * nothing points here.
 */
export function PointsHere({ object }: { object: KubeObject }) {
  const pointing = usePointing(object)
  const open = useOpenObject()
  const showTab = useActionsUi((state) => state.showTab)
  const served = useServedPlugins()
  if (pointing.length === 0) return null
  // Worst first, so what isn't drawn is the least wrong; each plugin where its worst is.
  const shown = pointing
    .map((each) => ({ ...each, status: viewStatus(each.view, each.object) }))
    .sort((a, b) =>
      worstFirst(
        { status: a.status, name: a.object.metadata.name },
        { status: b.status, name: b.object.metadata.name },
      ),
    )
    .slice(0, SHOWN_MOST)
  const byPlugin = new Map<string, typeof shown>()
  for (const each of shown) {
    byPlugin.set(each.view.plugin, [...(byPlugin.get(each.view.plugin) ?? []), each])
  }
  const openOne = ({ kind, view, object: one }: Pointing) => {
    const { name, namespace } = one.metadata
    open(kind, name, namespace)
    const tab = served
      .find(({ plugin }) => plugin.name === view.plugin)
      ?.plugin.added.tabs.find((each) => each.kinds.includes(kind))
    if (tab) showTab(formatRef({ kind, name, namespace }), `plugin:${view.plugin}/${tab.id}`)
  }
  return (
    <Section title="Objects that point here" aside={pointing.length}>
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {[...byPlugin].map(([plugin, rows]) => {
          const { label, version } = pluginWords(plugin)
          return (
            <section key={plugin} aria-label={`From the plugin ${label}`}>
              <h4 className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2 text-xs text-ink-3">
                <Plug className="size-3.5 shrink-0" aria-hidden />
                <span>
                  From the plugin <span className="font-medium text-ink-2">{label}</span>
                  {version && ` ${version}`}
                </span>
              </h4>
              <ul className="divide-y divide-line">
                {rows.map(({ status, ...row }) => {
                  const about = row.link.about && renderWhole(row.link.about, row.object)
                  const kind = apiKindOf(row.kind)
                  return (
                    <li
                      key={`${row.kind}/${row.object.metadata.namespace}/${row.object.metadata.name}`}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 phone:min-h-[52px]"
                        onClick={() => openOne(row)}
                      >
                        <KindIcon kind={row.kind} className="size-4 shrink-0 text-ink-3" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <MiddleTruncate
                            text={row.object.metadata.name}
                            className="min-w-0 text-[13px] font-medium text-ink-1"
                          />
                          <span className="truncate text-xs text-ink-3">
                            {about ? `${kind} · ${about}` : kind}
                          </span>
                        </span>
                        {status && <StatusPill status={status} className="shrink-0" />}
                        <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      {pointing.length > shown.length && (
        <p className="mt-2 text-xs text-ink-3">
          {pointing.length - shown.length} more aren’t shown here.
        </p>
      )}
    </Section>
  )
}
