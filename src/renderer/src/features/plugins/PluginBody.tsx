/**
 * Where a plugin's page or tab is drawn: its code, as Lumovi hands it over, in its box behind the
 * door, drawn with Lumovi's own parts under the strip that says whose it is; or Lumovi's place
 * when it stopped, or wasn't handed its code. Its code is told first which page it describes, or
 * which tab and the object the tab is on (read for it as its own kind is).
 *
 * The page is the cluster's: another cluster's is another page, opened anew (its code handed
 * again, its reads made again, its tokens new), never this one carried over.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { ObjectRef } from '@shared/kit/table'
import type { ReachDestination } from '@shared/kit/declare'
import { mayStart, type Destination } from '@shared/plugin-presses'
import type { ListedPlugin } from '@shared/plugins'
import { PluginIcon } from '@renderer/components/KindIcon'
import { useOpenObject } from '@renderer/hooks/open-object'
import { usePlugins } from '@renderer/hooks/plugins'
import { api } from '@renderer/lib/api'
import { useLayout } from '@renderer/lib/layout'
import { codeOff, WAITING, type NotHanded } from '@shared/plugin-hand-over'
import { folderOf } from '@shared/plugin-loading'
import { useSettings } from '@renderer/hooks/settings'
import {
  developerModePath,
  formatRef,
  listPath,
  pluginAsksPath,
  pluginSwitchPath,
} from '@renderer/lib/routes'
import { switchesOf } from '@renderer/plugins/code-switches'
import { PluginFrame } from '@renderer/plugins/PluginFrame'
import { KIT_PARTS } from '@renderer/plugins/kit'
import { Opened } from '@renderer/plugins/opened'
import { proposeChange } from '@renderer/plugins/proposals'
import { offered } from '@renderer/plugins/reach'
import { useActionsUi } from '@renderer/state/actions'
import { useCluster } from '@renderer/state/cluster'
import { useAgree, useOwnChanges } from './own-code'
import { useKindNames } from './PluginsPage'

/** Lumovi's parts, but for the Logs part: for a plugin whose file says nothing of logs. */
const WITHOUT_LOGS = Object.fromEntries(
  Object.entries(KIT_PARTS).filter(([name]) => name !== 'Logs'),
) as typeof KIT_PARTS

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
  const { context, namespace } = useCluster()
  const layout = useLayout()
  const openObject = useOpenObject()
  const navigate = useNavigate()
  const { start, showTab } = useActionsUi.getState()
  // Opened again by the person ("Open it again"): made anew, as a change of cluster makes it.
  const [again, setAgain] = useState(0)
  // Its code turned off (by the person, the server or the organization): its place at once, and
  // its code never asked for. Turned on again, the page is opened anew, as "Open it again" does.
  const settings = useSettings().data
  const off = settings === undefined ? undefined : codeOff(plugin.name, switchesOf(settings))
  // One of the person's own (its own folder, Developer mode): whether its code waits for them,
  // asked before anything of it is. Agreed, its page is opened anew.
  const yours = folderOf(plugin.source) !== undefined
  const handOver = useQuery({
    queryKey: ['plugin-hand-over', plugin.name],
    queryFn: () => api.kube.pluginHandOver(plugin.name),
    enabled: yours,
  })
  const plugins = usePlugins().data
  const agree = useAgree({
    names: useKindNames(),
    directory: plugins?.directory ?? '',
    onAgreed: () => setAgain((n) => n + 1),
  })
  const own = plugins?.files.find((file) => file.plugin?.name === plugin.name)?.plugin
  // (Its folder changed, in Developer mode: its page is made anew with what changed.)
  const changes = useOwnChanges()
  const which = page !== undefined ? `page ${page}` : `tab ${tab} ${formatRef(object)}`
  // What a press may open, where the door says: an object's own page in Lumovi, or a list of
  // Lumovi's own as the door made it, and only what this screen may start.
  const open = (to: Destination) => {
    if (mayStart('opens', layout) !== true) return
    // (A list at one object says whose page opened it.)
    if (to.to === 'list') void navigate(listPath(context, { ...to, plugin: plugin.name }))
    else if (to.to === 'reach') reach(to)
    else openObject(to.object.kind, to.object.name, to.object.namespace)
  }
  // One of Lumovi's own places for an object the page was handed, opened as Lumovi opens it:
  // the person does there what they do (a shell waits for their Start), and the audit says
  // which plugin's page brought them. Never a place Lumovi doesn't have here.
  const via = { plugin: plugin.name, version: plugin.version, label: plugin.label }
  const reach = (to: ReachDestination) => {
    if (!offered(to.at, layout)) return
    const { object } = to
    if (to.at === 'port-forward') {
      void api.kube
        .get({ context, kind: object.kind, name: object.name, namespace: object.namespace })
        .then((read) => {
          if (read.ok) start('forward', read.data, { ...(to.port ? { port: to.port } : {}), via })
        })
      return
    }
    openObject(object.kind, object.name, object.namespace)
    showTab(formatRef(object), to.at, to.container, to.at === 'shell' ? via : undefined)
  }
  if (settings === undefined || (yours && handOver.data === undefined)) return null
  // Off with Developer mode (or kept off by the organization's policy): a setting, said so.
  if (
    yours &&
    (handOver.data === 'developer-mode-off' || handOver.data === 'developer-mode-locked')
  ) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-plugin-body={plugin.name}>
        <PluginFrame
          name={plugin.label}
          version={plugin.version}
          end={{ why: 'not-handed', refused: handOver.data }}
          plugins={developerModePath(context)}
          onAgain={() => undefined}
          onFault={() => undefined}
        >
          {null}
        </PluginFrame>
      </div>
    )
  }
  const waiting = yours && handOver.data !== true && WAITING.has(handOver.data!)
  if (waiting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-plugin-body={plugin.name}>
        <PluginFrame
          name={plugin.label}
          version={plugin.version}
          yours
          asks={pluginAsksPath(context, plugin.name)}
          end={{ why: 'not-handed', refused: handOver.data as NotHanded }}
          waiting={{
            icon: <PluginIcon plugin={plugin} className="size-5" />,
            ...(own && agree.ask ? { onAgree: () => void agree.ask!(own) } : {}),
          }}
          onAgain={() => undefined}
          onFault={() => undefined}
        >
          {null}
        </PluginFrame>
        {agree.dialog}
      </div>
    )
  }
  if (off) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-plugin-body={plugin.name}>
        <PluginFrame
          name={plugin.label}
          version={plugin.version}
          end={{ why: 'not-handed', refused: off }}
          plugins={pluginSwitchPath(context, plugin.name)}
          onAgain={() => undefined}
          onFault={() => undefined}
        >
          {null}
        </PluginFrame>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-plugin-body={plugin.name}>
      <Opened
        key={`${context}\u0000${which}\u0000${again}\u0000${yours ? changes : 0}`}
        shown={{
          plugin: plugin.name,
          name: plugin.label,
          version: plugin.version,
          yours,
          context,
          opening: page !== undefined ? { page } : { tab, object },
          // (Its Logs part only where its file says its pages show logs, or its code reads them:
          // elsewhere the door knows no such part, and a page that names it is stopped.)
          parts: plugin.logs ? KIT_PARTS : WITHOUT_LOGS,
          kinds: plugin.named,
          opens: plugin.opens,
          links: plugin.links,
          open,
          // A change its page proposes, in Lumovi's own dialog: on the cluster it's open on, the
          // person's to confirm.
          propose: (proposal, handed) =>
            proposeChange(
              {
                plugin: plugin.name,
                label: plugin.label,
                version: plugin.version,
                ...handed,
                context,
                ...(namespace && { namespace }),
              },
              proposal,
              layout,
            ),
          asks: pluginAsksPath(context, plugin.name),
        }}
        onAgain={() => setAgain((n) => n + 1)}
      />
    </div>
  )
}
