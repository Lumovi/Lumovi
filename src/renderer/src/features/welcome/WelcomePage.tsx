import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FileWarning, RotateCw, ServerOff } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { KubeContext } from '@shared/api'
import { Button, IconButton } from '@renderer/components/Button'
import { GithubMark, Logo } from '@renderer/components/Logo'
import { EmptyState, Loading } from '@renderer/components/States'
import { SearchInput } from '@renderer/components/SearchInput'
import { StatusDot } from '@renderer/components/Status'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api, type KubeApiError } from '@renderer/lib/api'
import { clusterPath } from '@renderer/lib/routes'
import { ThemeMenu } from '../shell/ThemeMenu'

export const REPO_URL = 'https://github.com/kotapeter/kubestacks'

export function WelcomePage() {
  const contexts = useContexts()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['contexts'] })
    void queryClient.invalidateQueries({ queryKey: ['version'] })
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(closest-side,var(--accent-soft),transparent)]"
      />
      <div className="titlebar-leading titlebar-trailing h-[52px] shrink-0 drag" />
      <main className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pb-10">
        <div className="flex w-full max-w-2xl flex-col">
          <header className="mt-6 mb-8 flex flex-col items-center text-center">
            <div className="mb-5 grid size-16 place-items-center rounded-2xl border border-line-strong bg-surface-2 shadow-panel">
              <Logo className="size-10" />
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink-1">KubeStacks</h1>
            <p className="mt-1.5 text-[14px] text-ink-2">Choose a cluster to explore.</p>
          </header>

          {contexts.isPending ? (
            <Loading label="Reading kubeconfig…" />
          ) : contexts.data!.error ? (
            <EmptyState icon={FileWarning} title="Your kubeconfig could not be read">
              <p className="font-mono text-xs break-words selectable">{contexts.data!.error}</p>
            </EmptyState>
          ) : contexts.data!.contexts.length === 0 ? (
            <EmptyState icon={ServerOff} title="No clusters found">
              KubeStacks reads clusters from your kubeconfig. Set the{' '}
              <code className="font-mono">KUBECONFIG</code> environment variable, or create{' '}
              <code className="font-mono">~/.kube/config</code>, then reload.
            </EmptyState>
          ) : (
            <ContextList
              contexts={contexts.data!.contexts}
              current={contexts.data!.currentContext}
              filter={filter}
              onFilter={setFilter}
            />
          )}

          <footer className="mt-6 flex items-center gap-2 text-xs text-ink-3">
            <span className="min-w-0 flex-1 truncate" title={contexts.data?.source}>
              {contexts.data && (
                <>
                  Loaded from <span className="font-mono selectable">{contexts.data.source}</span>
                </>
              )}
            </span>
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
    </div>
  )
}

function ContextList({
  contexts,
  current,
  filter,
  onFilter,
}: {
  contexts: KubeContext[]
  current?: string
  filter: string
  onFilter: (value: string) => void
}) {
  const needle = filter.trim().toLowerCase()
  const visible = contexts.filter((context) =>
    [context.name, context.cluster, context.server ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  )
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-panel">
      <div className="flex items-center gap-3 border-b border-line p-3">
        <SearchInput
          value={filter}
          onChange={onFilter}
          placeholder="Filter clusters"
          className="flex-1"
        />
        <span className="pr-1 text-xs text-ink-3 tabular-nums">
          {visible.length} of {contexts.length}
        </span>
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-ink-3">No clusters match “{filter}”.</p>
      ) : (
        <ul aria-label="Clusters" className="max-h-[52vh] divide-y divide-line overflow-y-auto">
          {visible.map((context) => (
            <ContextRow key={context.name} context={context} isCurrent={context.name === current} />
          ))}
        </ul>
      )}
    </section>
  )
}

function serverHost(server: string | undefined): string {
  return server ? new URL(server).host : 'No cluster defined'
}

function ContextRow({ context, isCurrent }: { context: KubeContext; isCurrent: boolean }) {
  const navigate = useNavigate()
  const version = useVersion(context.name)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate(clusterPath(context.name))}
        className="group flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-surface-3/70 focus-visible:bg-surface-3/70 focus-visible:outline-none"
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
            {serverHost(context.server)} · {context.user}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs">
          {version.isPending ? (
            <span className="text-ink-3">Checking…</span>
          ) : version.isError ? (
            <span className="text-critical-text" title={version.error.message}>
              {errorLabel(version.error as KubeApiError)}
            </span>
          ) : (
            <span className="font-mono text-ink-2">{version.data.gitVersion}</span>
          )}
        </span>
        <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
      </button>
    </li>
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
}

function errorLabel(error: KubeApiError): string {
  return ERROR_LABELS[error.code]
}
