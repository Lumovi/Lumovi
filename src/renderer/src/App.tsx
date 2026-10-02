import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, createHashRouter, Navigate, type RouteObject } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { RESOURCES } from '@shared/resources'
import { Toaster } from './components/Toaster'
import { UpdateNotice } from './components/UpdateNotice'
import { TooltipProvider } from './components/Tooltip'
import { AddOnPage } from './features/add-ons/AddOnPage'
import { HelmPage } from './features/helm/HelmPage'
import { ApiResourcesPage } from './features/resources/ApiResourcesPage'
import { NotFound } from './features/errors/NotFound'
import { RouteError } from './features/errors/RouteError'
import { OverviewPage } from './features/overview/OverviewPage'
import { MetricsPage } from './features/metrics/MetricsPage'
import { CustomResourcePage, ResourcePage } from './features/resources/ResourcePage'
import { SessionGate } from './features/session/SessionGate'
import { ClusterLayout } from './features/shell/ClusterLayout'
import { WelcomePage } from './features/welcome/WelcomePage'
import { WorkloadsPage } from './features/workloads/WorkloadsPage'
import { api } from './lib/api'
import { clusterPath } from './lib/routes'
import { useSession } from './state/session'
import { SETTINGS_CHANGED } from './web/api'
import { basename } from './web/session'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling recovers from transient failures, so errors surface immediately instead of after retries.
      retry: false,
      staleTime: 2_000,
      refetchIntervalInBackground: false,
    },
  },
})

/** The start: the desktop app's clusters to choose from, or the one a server shows. */
function Home() {
  const session = useSession()
  return session ? <Navigate replace to={clusterPath(session.cluster)} /> : <WelcomePage />
}

const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Home /> },
      {
        path: '/cluster/:context',
        element: <ClusterLayout />,
        children: [
          {
            // Page errors render inside the layout, so the sidebar stays usable.
            errorElement: <RouteError />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: 'workloads', element: <WorkloadsPage /> },
              { path: 'metrics', element: <MetricsPage /> },
              ...RESOURCES.map((resource) => ({
                path: resource.plural,
                element: <ResourcePage key={resource.kind} resource={resource} />,
              })),
              { path: 'r/:kind', element: <CustomResourcePage /> },
              { path: 'add-ons/:name', element: <AddOnPage /> },
              { path: 'api-resources', element: <ApiResourcesPage /> },
              { path: 'helm', element: <HelmPage /> },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// Another tab changed which clusters are read-only, or where metrics come from.
addEventListener(
  SETTINGS_CHANGED,
  () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
)

// The desktop app's page is a file, so it keeps its place in the hash; a served page has real
// addresses, below the server's base path, that can be shared.
const router =
  api.host === 'desktop'
    ? createHashRouter(routes)
    : createBrowserRouter(routes, { basename: basename() || '/' })

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        {api.host === 'server' ? (
          <SessionGate>
            <RouterProvider router={router} />
          </SessionGate>
        ) : (
          <RouterProvider router={router} />
        )}
        <Toaster />
        {api.updates && <UpdateNotice updates={api.updates} />}
      </TooltipProvider>
    </QueryClientProvider>
  )
}
