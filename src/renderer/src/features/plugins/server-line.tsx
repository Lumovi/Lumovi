/**
 * What a plugin's file says of its tool's own server, in docs' words: the red line, which
 * Service and where, and every path as listed. The Plugins page and the store's dialog both say
 * it so.
 */
import { ChevronDown } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { PluginServer } from '@shared/plugin-server'
import { apiKindOf } from '@shared/resources'
import { cn } from '@renderer/lib/cn'

/** The red line: that its code reads what the server answers. */
export const serverSays = (server: PluginServer) =>
  'name' in server.service
    ? `Asks the server ${server.service.name} in this cluster, through Lumovi, and its code reads what it answers:`
    : 'Asks a server in this cluster, through Lumovi, and its code reads what it answers:'

/** A Service's labels as the quiet line says them: each `key=value` in mono, commas between. */
const labelsSaid = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([key, value], i) => (
    <Fragment key={key}>
      {i > 0 && ', '}
      <span className="font-mono text-ink-2 selectable">
        {key}={value}
      </span>
    </Fragment>
  ))

/** The quiet line under it: which Service, its port, and in which namespace. */
export function ServerWhere({ server }: { server: PluginServer }) {
  return (
    <>
      {'name' in server.service
        ? `The Service ${server.service.name}`
        : ['The one Service with the labels ', ...labelsSaid(server.service.labels)]}
      , port {server.port}, in the namespace of the {apiKindOf(server.in)} its page shows.
    </>
  )
}

/** How many of a server's paths are listed before the rest are opened. */
const PATHS_SHOWN = 6

/**
 * Its paths, as listed, under a thin red rule (a segment Lumovi fills, quiet): six, and the
 * rest in place on a press. Quiet where `off`.
 */
export function ServerPaths({ paths, off = false }: { paths: readonly string[]; off?: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open ? paths : paths.slice(0, PATHS_SHOWN)
  const more = paths.length - shown.length
  return (
    <>
      <ul
        className={cn('mt-1.5 border-l-2 pl-3', off ? 'border-line-strong' : 'border-critical/35')}
      >
        {shown.map((path) => (
          <li
            key={path}
            className={cn(
              'pl-[2ch] -indent-[2ch] font-mono text-xs leading-5 [overflow-wrap:anywhere] selectable',
              off ? 'text-ink-3' : 'text-ink-1',
            )}
          >
            {path.split(/(\{[A-Za-z0-9]+\})/).map((part, i) =>
              /^\{.*\}$/.test(part) ? (
                <span key={i} className="text-ink-3">
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className="mt-0.5 inline-flex items-center gap-1 rounded text-xs font-medium text-ink-2 hover:text-ink-1"
        >
          <ChevronDown className="size-[13px] text-ink-3" aria-hidden />
          {more} more paths
        </button>
      )}
    </>
  )
}
