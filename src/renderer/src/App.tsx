import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, createHashRouter, Navigate, type RouteObject } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { RESOURCES } from '@shared/resources'
import { Toaster } from './components/Toaster'
import { StartupProblems } from './components/StartupProblems'
import { UpdateNotice } from './components/UpdateNotice'
import { TooltipProvider } from './components/Tooltip'
import { AccessPage } from './features/access/AccessPage'
import { AccessUpdates } from './features/access/use-access'
import { YourAccessPage } from './features/access/YourAccessPage'
import { AddOnPage } from './features/add-ons/AddOnPage'
import { ApprovalCenter } from './features/assistants/ApprovalCenter'
import { AssistantsPage } from './features/assistants/AssistantsPage'
import { AuditPage } from './features/audit/AuditPage'
import { HelmPage } from './features/helm/HelmPage'
import { ApiResourcesPage } from './features/resources/ApiResourcesPage'
import { NotFound } from './features/errors/NotFound'
import { RouteError } from './features/errors/RouteError'
import { OverviewPage } from './features/overview/OverviewPage'
import { MetricsPage } from './features/metrics/MetricsPage'
import { RightsizingPage } from './features/rightsizing/RightsizingPage'
import { CustomResourcePage, ResourcePage } from './features/resources/ResourcePage'
import { AuthorizePage } from './features/session/AuthorizePage'
import { SessionGate } from './features/session/SessionGate'
import { ClusterLayout } from './features/shell/ClusterLayout'
import { FleetPage } from './features/fleet/FleetPage'
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
  if (session?.fleet) return <FleetPage />
  return session ? <Navigate replace to={clusterPath(session.cluster!)} /> : <WelcomePage />
}

const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Home /> },
      // A server's: where AI assistants send people to allow them.
      { path: '/authorize', element: <AuthorizePage /> },
      // AI assistants: connecting them, what they may do and where, and what they did.
      { path: '/assistants/:tab?', element: <AssistantsPage /> },
      // What was done through Lumovi, by whom, and how it went.
      { path: '/audit', element: <AuditPage /> },
      // A server's: who may do what (its admins'), and what the person may (everyone's).
      { path: '/access/:tab?', element: <AccessPage /> },
      { path: '/your-access', element: <YourAccessPage /> },
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
              { path: 'metrics/right-sizing', element: <RightsizingPage /> },
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

/** The changes AI assistants ask for (the desktop app's, or a server's), wherever the page is. */
const assistants = api.approvals && <ApprovalCenter approvals={api.approvals} />

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        {api.host === 'server' ? (
          <SessionGate>
            <AccessUpdates />
            <RouterProvider router={router} />
            {/* The signed-in person's: over the page's connection, which a session opens. */}
            {assistants}
          </SessionGate>
        ) : (
          <>
            <RouterProvider router={router} />
            {assistants}
          </>
        )}
        <Toaster />
        {api.updates && <UpdateNotice updates={api.updates} />}
        {api.app.problems && <StartupProblems problems={api.app.problems} />}
      </TooltipProvider>
    </QueryClientProvider>
  )
}
