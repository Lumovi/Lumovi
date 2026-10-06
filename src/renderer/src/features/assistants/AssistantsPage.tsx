/**
 * AI assistants: connecting them, the person's own (on a server), what
 * they may do and where (Permissions), and what they did (Activity). The
 * desktop app's and a server's, each with its tabs.
 */
import { ArrowLeft } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import type { LumoviApi } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { LogoLockup } from '@renderer/components/LogoLockup'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useSession } from '@renderer/state/session'
import { Commands } from '../shell/Commands'
import { ActivityTab } from './ActivityTab'
import { DesktopConnectTab } from './DesktopConnect'
import { PermissionsTab, type Scope } from './PermissionsTab'
import { plural } from './permissions-model'
import { ServerConnectTab, useServerStatus, YourAssistantsTab } from './ServerConnect'

interface Tab {
  path: string
  label: string
  count?: number
  content: ReactNode
}

export function AssistantsPage() {
  useEffect(() => {
    document.title = 'AI assistants — Lumovi'
  }, [])
  return api.serverAssistants ? (
    <ServerAssistants assistants={api.serverAssistants} permissions={api.aiPermissions!} />
  ) : (
    <DesktopAssistants assistants={api.assistants!} permissions={api.aiPermissions!} />
  )
}

function DesktopAssistants({
  assistants,
  permissions,
}: {
  assistants: NonNullable<LumoviApi['assistants']>
  permissions: NonNullable<LumoviApi['aiPermissions']>
}) {
  const contexts = useContexts().data
  return (
    <Page
      scope="Kubeconfig"
      scopeLine={contexts && plural(contexts.contexts.length, 'context', 'contexts')}
      end={
        contexts && (
          <span className="min-w-0 truncate font-mono text-xs text-ink-3 [direction:rtl]">
            <bdi>{contexts.source}</bdi>
          </span>
        )
      }
      tabs={[
        {
          path: 'connect',
          label: 'Connect',
          content: <DesktopConnectTab assistants={assistants} />,
        },
        {
          path: 'permissions',
          label: 'Permissions',
          content: <PermissionsTab permissions={permissions} scope="desktop" />,
        },
        { path: 'activity', label: 'Activity', content: <ActivityTab /> },
      ]}
    />
  )
}

function ServerAssistants({
  assistants,
  permissions,
}: {
  assistants: NonNullable<LumoviApi['serverAssistants']>
  permissions: NonNullable<LumoviApi['aiPermissions']>
}) {
  const session = useSession()!
  const status = useServerStatus(assistants)
  const contexts = useContexts().data
  const scope: Scope = session.fleet ? 'fleet' : 'single'
  if (!status) return null
  return (
    <Page
      scope={session.fleet ? 'Fleet' : session.cluster!}
      scopeLine={
        session.fleet && contexts
          ? plural(contexts.contexts.length, 'cluster', 'clusters')
          : undefined
      }
      end={<span className="truncate text-xs text-ink-2">{session.user.name}</span>}
      tabs={
        status.enabled
          ? [
              { path: 'connect', label: 'Connect', content: <ServerConnectTab url={status.url} /> },
              {
                path: 'assistants',
                label: 'Your assistants',
                count: status.clients.length,
                content: <YourAssistantsTab status={status} assistants={assistants} />,
              },
              {
                path: 'permissions',
                label: 'Permissions',
                content: <PermissionsTab permissions={permissions} scope={scope} />,
              },
              { path: 'activity', label: 'Activity', content: <ActivityTab /> },
            ]
          : []
      }
    />
  )
}

/** The page: where it is (and who), its tabs, and the one chosen. */
function Page({
  scope,
  scopeLine,
  end,
  tabs,
}: {
  scope: string
  scopeLine?: string
  end?: ReactNode
  tabs: Tab[]
}) {
  const { tab } = useParams()
  const navigate = useNavigate()
  const current = tabs.find(({ path }) => path === tab)
  if (tabs.length && !current) return <Navigate replace to={`/assistants/${tabs[0]!.path}`} />
  // Back where the person came from; opened from elsewhere (a link), to the start.
  const back = () =>
    void ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate('/'))
  return (
    <div className="vt-page flex h-full flex-col overflow-hidden bg-app">
      <header className="titlebar-leading titlebar-trailing flex min-h-[52px] shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2 drag">
        <IconButton label="Back" className="no-drag" onClick={back}>
          <ArrowLeft />
        </IconButton>
        <LogoLockup className="h-5" />
        <span aria-hidden className="h-5 w-px bg-line-strong" />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-ink-1">{scope}</span>
          {scopeLine && <span className="text-xs whitespace-nowrap text-ink-3">{scopeLine}</span>}
        </span>
        <span className="flex min-w-0 flex-1 justify-end">{end}</span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1240px] px-5 pt-8 pb-16">
          <div className="flex flex-wrap items-start gap-4">
            <h1 className="flex-[1_1_420px] text-[28px] leading-[1.15] headline text-ink-1">
              <span className="block">AI assistants</span>
              <span className="block text-ink-3">What they may do, wherever they work.</span>
            </h1>
            <p className="max-w-[520px] flex-[1_1_360px] pt-0.5 text-[13px] text-ink-2">
              {api.host === 'desktop'
                ? 'Claude Code, Claude Desktop, Cursor, VS Code and other assistants use your clusters through Lumovi. They never get more than your kubeconfig allows, and your permissions narrow it further.'
                : 'Claude Code, Cursor, VS Code and other assistants act as you through Lumovi. They never get more than your own access, and your permissions narrow it further.'}
            </p>
          </div>
          {tabs.length === 0 ? (
            <p className="mt-8 text-[13px] text-ink-2">
              This server’s administrator has turned AI assistants off.
            </p>
          ) : (
            <>
              <nav
                aria-label="AI assistants"
                className="mt-6 flex flex-wrap gap-5 border-b border-line"
              >
                {tabs.map(({ path, label, count }) => (
                  <Link
                    key={path}
                    to={`/assistants/${path}`}
                    replace
                    aria-current={path === tab ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 py-2.5 text-[13px] transition-colors',
                      path === tab
                        ? 'font-semibold text-ink-1 shadow-[inset_0_-2px_0_var(--color-ink-1)]'
                        : 'text-ink-2 hover:text-ink-1',
                    )}
                  >
                    {label}
                    {count !== undefined && (
                      <span className="rounded-full bg-surface-3 px-1.5 text-2xs text-ink-2">
                        {count}
                      </span>
                    )}
                  </Link>
                ))}
              </nav>
              <div className="mt-6">{current!.content}</div>
            </>
          )}
        </div>
      </main>
      <Commands />
    </div>
  )
}
