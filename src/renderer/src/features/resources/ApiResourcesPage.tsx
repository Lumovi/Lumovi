import { BookOpen, Pin, PinOff, SearchX, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { REPO_URL } from '@shared/app'
import { isCustomGroup, type ResourceDefinition } from '@shared/resources'
import { Button, IconButton } from '@renderer/components/Button'
import { kindIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { useGo } from '@renderer/hooks/go'
import { useResources } from '@renderer/hooks/resources'
import { useViews } from '@renderer/hooks/views'
import { api, type KubeApiError } from '@renderer/lib/api'
import { kindPath } from '@renderer/lib/routes'
import { viewFor } from '@renderer/lib/views'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'

const VIEWS_GUIDE = `${REPO_URL}/blob/main/docs/views.md`

/** Every kind the cluster serves, like `kubectl api-resources`, and the views that show them. */
export function ApiResourcesPage() {
  const resources = useResources()
  const views = useViews().data
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const matching = (resources.data ?? []).filter((r) =>
    [r.label, r.apiKind, r.group, r.plural, ...(r.shortNames ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
  const custom = matching.filter((r) => isCustomGroup(r.group))
  const kubernetes = matching.filter((r) => !isCustomGroup(r.group))

  let body
  if (resources.isPending) {
    body = <Loading label="Looking at what the cluster serves…" />
  } else if (!resources.data) {
    body = (
      <ErrorState
        error={resources.error as KubeApiError}
        onRetry={() => void resources.refetch()}
      />
    )
  } else if (matching.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No kinds match “{filter.trim()}”.
      </EmptyState>
    )
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {custom.length > 0 && <KindTable title="Custom resources" resources={custom} />}
        {kubernetes.length > 0 && <KindTable title="Kubernetes" resources={kubernetes} />}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <span className="text-[13px] text-ink-2 tabular-nums">
          {resources.data ? `${resources.data.length} kinds` : ' '}
        </span>
        <div className="flex-1" />
        <SearchInput
          value={filter}
          onChange={setFilter}
          // Down goes from the filter to the first kind.
          onArrowDown={() => document.querySelector<HTMLElement>('[data-kind-link]')?.focus()}
          placeholder="Filter kinds"
          className="w-60"
        />
      </div>
      {views && views.problems.length > 0 && (
        <div
          role="alert"
          className="shrink-0 border-b border-line bg-warn/8 px-5 py-3 text-[13px] text-ink-2"
        >
          <p className="flex items-center gap-2 font-medium text-warn-text">
            <TriangleAlert className="size-4" />
            {views.problems.length === 1
              ? 'A view couldn’t be used'
              : `${views.problems.length} problems with views`}
          </p>
          <ul aria-label="View problems" className="mt-1.5 space-y-0.5 pl-6 font-mono text-xs">
            {views.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {body}
      {views && (
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-2.5 text-xs text-ink-3">
          <span>
            {views.shipped.length} views from KubeStacks
            {views.local.length > 0 && `, ${views.local.length} of yours`}. Yours go in{' '}
            <span className="font-mono text-ink-2 selectable">{views.directory}</span>
          </span>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => void api.app.openExternal(VIEWS_GUIDE)}
          >
            <BookOpen /> How to write a view
          </Button>
        </footer>
      )}
    </div>
  )
}

function KindTable({ title, resources }: { title: string; resources: ResourceDefinition[] }) {
  const { context } = useCluster()
  const go = useGo()
  const pinned = usePrefs((prefs) => prefs.pinned)
  const setPinned = usePrefs((prefs) => prefs.setPinned)
  return (
    <section aria-label={title} className="mt-5">
      <h2 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">{title}</h2>
      <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
        <thead className="text-left text-2xs font-medium tracking-wider text-ink-3 uppercase">
          <tr>
            <th className="w-[34%] border-b border-line py-2 pl-3 font-medium">Kind</th>
            <th className="w-[30%] border-b border-line py-2 font-medium">API version</th>
            <th className="w-[12%] border-b border-line py-2 font-medium">Scope</th>
            <th className="w-[16%] border-b border-line py-2 font-medium">View</th>
            <th className="w-[8%] border-b border-line py-2">
              <span className="sr-only">Pin</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => {
            const Icon = kindIcon(resource.kind)
            const view = viewFor(resource.kind)
            const isPinned = pinned.includes(resource.kind)
            return (
              <tr key={resource.kind} className="group hover:bg-surface-2">
                <td className="border-b border-line py-1.5 pl-3">
                  <button
                    type="button"
                    data-kind-link
                    onClick={() => go(kindPath(context, resource.kind))}
                    className="flex min-w-0 items-center gap-2.5 text-left font-medium text-ink-1 hover:text-accent-strong"
                  >
                    <Icon className="size-4 shrink-0 text-ink-3" />
                    <span className="truncate">{resource.label}</span>
                    {resource.shortNames && (
                      <span className="truncate font-mono text-xs font-normal text-ink-3">
                        {resource.shortNames.join(', ')}
                      </span>
                    )}
                  </button>
                </td>
                <td className="truncate border-b border-line py-1.5 font-mono text-xs text-ink-2">
                  {resource.group ? `${resource.group}/${resource.version}` : resource.version}
                </td>
                <td className="border-b border-line py-1.5 text-ink-2">
                  {resource.namespaced ? 'Namespaced' : 'Cluster'}
                </td>
                <td className="truncate border-b border-line py-1.5 text-xs text-ink-2">
                  {view?.source ?? '—'}
                </td>
                <td className="border-b border-line py-1 pr-2 text-right">
                  <IconButton
                    label={isPinned ? `Unpin ${resource.label}` : `Pin ${resource.label}`}
                    aria-pressed={isPinned}
                    onClick={() => setPinned(resource.kind, !isPinned)}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100"
                  >
                    {isPinned ? <PinOff /> : <Pin />}
                  </IconButton>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
