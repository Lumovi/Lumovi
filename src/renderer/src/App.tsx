import { OnALargerScreen } from './components/LargerScreen'
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
import { PluginPage } from './features/plugins/PluginPage'
import { PluginsPage } from './features/plugins/PluginsPage'
import { ApprovalCenter } from './features/assistants/ApprovalCenter'
import { ProposalDialog } from './plugins/ProposalDialog'
import { AssistantsPage } from './features/assistants/AssistantsPage'
import { AuditPage } from './features/audit/AuditPage'
import { HelmPage } from './features/helm/HelmPage'
import { ApiResourcesPage } from './features/resources/ApiResourcesPage'
import { NotFound } from './features/errors/NotFound'
import { RouteError } from './features/errors/RouteError'
import { OverviewPage } from './features/overview/OverviewPage'
import { AlertsPage } from './features/alerts/AlertsPage'
import { MetricsPage } from './features/metrics/MetricsPage'
import { RightsizingPage } from './features/rightsizing/RightsizingPage'
import { ComparePage } from './features/compare/ComparePage'
import { SeveralLayout } from './features/several/SeveralLayout'
import { SeveralList } from './features/several/SeveralList'
import { CustomResourcePage, ResourcePage } from './features/resources/ResourcePage'
import { AuthorizePage } from './features/session/AuthorizePage'
import { SessionGate } from './features/session/SessionGate'
import { ClusterLayout } from './features/shell/ClusterLayout'
import { ServerWarningNotices } from './features/events/warnings'
import { FleetPage } from './features/fleet/FleetPage'
import { WelcomePage } from './features/welcome/WelcomePage'
import { WorkloadsPage } from './features/workloads/WorkloadsPage'
import { api } from './lib/api'
import { watchQueries } from './lib/watches'
import { clusterPath } from './lib/routes'
import { useSession } from './state/session'
import { SETTINGS_CHANGED } from './web/api'
import { PreferencesApplied } from './features/settings/Applied'
import { SettingsPage } from './features/settings/SettingsPage'
import { SettingsWindow } from './features/settings/SettingsWindow'
import { BelowKept } from './features/terminal/BelowKept'
import { TabWindow } from './features/terminal/TabWindow'
import { LinkCard } from './features/links/LinkCard'
import { basename } from './web/session'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

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
// What the page shows, read again as it changes in the cluster.
watchQueries(queryClient, api.watches)

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
      {
        path: '/assistants/:tab?',
        element: (
          <OnALargerScreen
            title="AI assistants"
            says="Set up an assistant in Lumovi on a larger screen. When one asks to connect, you can answer it here."
          >
            <AssistantsPage />
          </OnALargerScreen>
        ),
      },
      // What was done through Lumovi, by whom, and how it went.
      { path: '/audit', element: <AuditPage /> },
      // A server's: who may do what (its admins'), and what the person may (everyone's).
      {
        path: '/access/:tab?',
        element: (
          <OnALargerScreen title="Access" to="set who may do what">
            <AccessPage />
          </OnALargerScreen>
        ),
      },
      { path: '/your-access', element: <YourAccessPage /> },
      // Several clusters' lists, merged: a page of its own, outside any one cluster.
      {
        path: '/clusters/:page',
        element: <SeveralLayout />,
        children: [{ index: true, element: <SeveralList /> }],
      },
      // Settings from the start screen (in a cluster, its own page: the cluster's frame around it).
      { path: '/settings', element: <SettingsWindow /> },
      // The desktop app's: a tab below, in a window of its own.
      ...(api.desktop ? [{ path: '/tab', element: <TabWindow /> }] : []),
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
              { path: 'alerts', element: <AlertsPage /> },
              { path: 'metrics/right-sizing', element: <RightsizingPage /> },
              ...RESOURCES.map((resource) => ({
                path: resource.plural,
                element: <ResourcePage key={resource.kind} resource={resource} />,
              })),
              { path: 'r/:kind', element: <CustomResourcePage /> },
              { path: 'plugins', element: <PluginsPage /> },
              { path: 'plugins/:name', element: <PluginPage /> },
              { path: 'plugins/:name/:page', element: <PluginPage /> },
              { path: 'api-resources', element: <ApiResourcesPage /> },
              // Two objects side by side: not on a phone at first.
              {
                path: 'compare',
                element: (
                  <OnALargerScreen title="Compare" to="compare two objects">
                    <ComparePage />
                  </OnALargerScreen>
                ),
              },
              // The kit's parts, each with its hard cases: for the tests' build alone, until
              // something in Lumovi draws a plugin's page from them. A release has none of it.
              ...(LUMOVI_TEST_BUILD
                ? [
                    {
                      path: 'kit/:part?',
                      lazy: () =>
                        import('./kit/KitPage').then(({ KitPage }) => ({ Component: KitPage })),
                    },
                  ]
                : []),
              { path: 'helm', element: <HelmPage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]

// Someone changed the server's clusters' settings: which are read-only, or where their metrics
// come from (and so their history).
// The desktop's settings changed (in another window, say): read again, here too.
api.app.onSettingsChanged?.(() => dispatchEvent(new Event(SETTINGS_CHANGED)))
addEventListener(SETTINGS_CHANGED, () => {
  void queryClient.invalidateQueries({ queryKey: ['settings'] })
  void queryClient.invalidateQueries({ queryKey: ['usage-source'] })
  void queryClient.invalidateQueries({ queryKey: ['usage'] })
})

// The desktop app's kubeconfig changed on disk (a context a cloud's tool added, a file in a
// folder): the clusters read again, and so the files, without Reload.
api.kubeconfigFiles?.onChange(() => {
  void queryClient.invalidateQueries({ queryKey: ['contexts'] })
})

// The desktop app's page is a file, so it keeps its place in the hash; a served page has real
// addresses, below the server's base path, that can be shared.
const router =
  api.host === 'desktop'
    ? createHashRouter(routes)
    : createBrowserRouter(routes, { basename: basename() || '/' })

/** Where a notification of new warnings was about (a server's page): opened in this tab. */
const openNotice = (path: string) => void router.navigate(path)

// A notification's click (the desktop app's, of new warnings): Lumovi opens where it was about,
// from whichever page is shown.
api.desktop?.onCommand((command) => {
  if (command.startsWith('open:')) void router.navigate(command.slice('open:'.length))
})

/** The changes AI assistants ask for (the desktop app's, or a server's), wherever the page is. */
const assistants = api.approvals && <ApprovalCenter approvals={api.approvals} />
/** A change a plugin's page proposed, in Lumovi's own dialog: one at a time, above everything. */
const proposals = <ProposalDialog />

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        {api.host === 'server' ? (
          <SessionGate>
            {/* (The signed-in person's: read over the connection a session opens.) */}
            <PreferencesApplied />
            <AccessUpdates />
            <ServerWarningNotices navigate={openNotice} />
            <RouterProvider router={router} />
            {/* The signed-in person's: over the page's connection, which a session opens. */}
            {assistants}
            {proposals}
          </SessionGate>
        ) : (
          <>
            <PreferencesApplied />
            <RouterProvider router={router} />
            {assistants}
            {proposals}
            {api.desktop && <BelowKept />}
            {/* lumovi:// links, asked about in this window: never on a server, whose links are its pages'. */}
            {api.desktop && <LinkCard navigate={(to) => void router.navigate(to)} />}
          </>
        )}
        <Toaster />
        {api.updates && <UpdateNotice updates={api.updates} />}
        {api.app.problems && <StartupProblems problems={api.app.problems} />}
      </TooltipProvider>
    </QueryClientProvider>
  )
}
