import { useQueryClient } from '@tanstack/react-query'
import { Command, useCommandState } from 'cmdk'
import { CornerDownLeft, FileWarning, RotateCw, Search, ServerOff } from 'lucide-react'
import { useEffect } from 'react'
import type { KubeContext } from '@shared/api'
import { REPO_URL } from '@shared/app'
import { Button, IconButton } from '@renderer/components/Button'
import { Kbd } from '@renderer/components/Kbd'
import { GithubMark, Logo } from '@renderer/components/Logo'
import { EmptyState, Loading } from '@renderer/components/States'
import { StatusDot } from '@renderer/components/Status'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api, type KubeApiError } from '@renderer/lib/api'
import { hostOf } from '@renderer/lib/format'
import { matchWords } from '@renderer/lib/match'
import { clusterPath } from '@renderer/lib/routes'
import { usePrefs } from '@renderer/state/prefs'
import { Commands } from '../shell/Commands'
import { ShortcutsDialog } from '../shell/ShortcutsDialog'
import { ThemeMenu } from '../shell/ThemeMenu'

export { REPO_URL } from '@shared/app'

export function WelcomePage() {
  const contexts = useContexts()
  const queryClient = useQueryClient()

  useEffect(() => {
    document.title = 'KubeStacks'
  }, [])

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['contexts'] })
    void queryClient.invalidateQueries({ queryKey: ['version'] })
  }

  return (
    <div className="vt-page relative flex h-full flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(closest-side,var(--accent-soft),transparent)]"
      />
      <div className="titlebar-leading titlebar-trailing h-[52px] shrink-0 drag" />
      <main className="relative flex min-h-0 flex-1 flex-col items-center px-8 pb-6">
        <div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col">
          <header className="mt-6 mb-8 flex shrink-0 animate-rise flex-col items-center text-center [@media(max-height:800px)]:mt-0 [@media(max-height:800px)]:mb-5">
            <div className="mb-5 grid size-16 place-items-center rounded-2xl border border-line-strong bg-surface-2 shadow-panel [@media(max-height:800px)]:mb-3 [@media(max-height:800px)]:size-12">
              <Logo className="size-10 [@media(max-height:800px)]:size-8" />
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink-1">KubeStacks</h1>
            <p className="mt-1.5 text-[14px] text-ink-2">Choose a cluster to explore.</p>
          </header>

          {contexts.isPending ? (
            <Loading label="Reading kubeconfig…" />
          ) : contexts.data!.error ? (
            <EmptyState icon={FileWarning} title="Your kubeconfig could not be read">
              <pre className="mt-2 max-h-60 overflow-auto rounded-lg border border-line bg-surface-3 px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap text-ink-2 selectable">
                {contexts.data!.error}
              </pre>
              <p className="mt-3">Fix the file, then choose Reload.</p>
            </EmptyState>
          ) : contexts.data!.contexts.length === 0 ? (
            <EmptyState icon={ServerOff} title="No clusters found">
              KubeStacks reads clusters from your kubeconfig. Set the{' '}
              <code className="font-mono">KUBECONFIG</code> environment variable, or create{' '}
              <code className="font-mono">~/.kube/config</code>, then reload.
            </EmptyState>
          ) : (
            <ContextPicker
              contexts={contexts.data!.contexts}
              current={contexts.data!.currentContext}
            />
          )}

          <footer className="mt-5 flex shrink-0 items-center gap-2 text-xs text-ink-3">
            {contexts.data && (
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5"
                title={contexts.data.source}
              >
                <span className="shrink-0">Loaded from</span>
                {/* Truncate from the start so the file name stays visible. */}
                <span className="min-w-0 truncate font-mono [direction:rtl] selectable">
                  <bdi>{contexts.data.source}</bdi>
                </span>
              </span>
            )}
            <Button variant="ghost" onClick={reload}>
              <RotateCw /> Reload
            </Button>
            <ThemeMenu />
            <IconButton label="KubeStacks on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
              <GithubMark />
            </IconButton>
          </footer>
        </div>
      </main>
      <Commands />
      <ShortcutsDialog />
    </div>
  )
}

/**
 * Type to filter, ↑/↓ to move, Enter to open. Recently opened clusters come
 * first, then the rest in kubeconfig order.
 */
function ContextPicker({ contexts, current }: { contexts: KubeContext[]; current?: string }) {
  const recentNames = usePrefs((prefs) => prefs.recent)
  const recent = recentNames
    .map((name) => contexts.find((c) => c.name === name))
    .filter((c): c is KubeContext => c !== undefined)
  const others = contexts.filter((c) => !recentNames.includes(c.name))

  return (
    <Command
      label="Clusters"
      loop
      filter={matchWords}
      className="flex min-h-0 animate-rise flex-col overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-panel [animation-delay:60ms]"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-ink-3" />
        <Command.Input
          autoFocus
          data-hotkey-target="filter"
          placeholder="Search clusters…"
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-ink-1 outline-none placeholder:text-ink-3"
        />
        <MatchCount total={contexts.length} />
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase">
        <Command.Empty className="px-4 py-10 text-center text-ink-3">
          No clusters match.
        </Command.Empty>
        {recent.length > 0 && (
          <Command.Group heading="Recent">
            {recent.map((context) => (
              <ContextItem
                key={context.name}
                context={context}
                isCurrent={context.name === current}
              />
            ))}
          </Command.Group>
        )}
        <Command.Group heading={recent.length > 0 ? 'All clusters' : 'Clusters'}>
          {others.map((context) => (
            <ContextItem
              key={context.name}
              context={context}
              isCurrent={context.name === current}
            />
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft className="size-3" />
          </Kbd>
          to open
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>?</Kbd> for all shortcuts
        </span>
      </div>
    </Command>
  )
}

function MatchCount({ total }: { total: number }) {
  const count = useCommandState((state) => state.filtered.count)
  return (
    <span className="shrink-0 text-xs text-ink-3 tabular-nums">
      {count} of {total}
    </span>
  )
}

function ContextItem({ context, isCurrent }: { context: KubeContext; isCurrent: boolean }) {
  const go = useGo()
  const version = useVersion(context.name)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  return (
    <Command.Item
      value={`${context.name} ${context.cluster} ${context.server ?? ''}`}
      onSelect={() => go(clusterPath(context.name))}
      className="group flex cursor-default items-center gap-3.5 rounded-xl px-3 py-2.5 text-left transition-colors data-[selected=true]:bg-surface-3 data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]"
    >
      <StatusDot health={health} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-1">{context.name}</span>
          {isCurrent && (
            <span className="rounded-full bg-accent-soft px-1.5 py-px text-2xs font-medium text-accent-strong">
              current
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-ink-3">
          {hostOf(context.server) ?? 'No cluster defined'} · {context.user}
        </span>
      </span>
      <span className="shrink-0 text-right text-xs">
        {version.isPending ? (
          <span className="text-ink-3">Checking…</span>
        ) : version.isError ? (
          <span className="text-critical-text" title={version.error.message}>
            {ERROR_LABELS[(version.error as KubeApiError).code]}
          </span>
        ) : (
          <span className="text-ink-3">
            <span className="font-mono text-ink-2">{version.data.gitVersion}</span> ·{' '}
            {version.data.latencyMs} ms
          </span>
        )}
      </span>
      <span className="grid size-5 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-data-[selected=true]:opacity-100">
        <CornerDownLeft className="size-3.5" />
      </span>
    </Command.Item>
  )
}

const ERROR_LABELS: Record<KubeApiError['code'], string> = {
  unreachable: 'Unreachable',
  timeout: 'Timed out',
  tls: 'Certificate error',
  insecure: 'Plain HTTP blocked',
  auth: 'Credentials failed',
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  'not-found': 'Not found',
  server: 'Server error',
  invalid: 'Misconfigured',
  conflict: 'Conflict',
  'read-only': 'Read-only',
  helm: 'Helm failed',
}
