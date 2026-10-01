import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHashRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { RESOURCES } from '@shared/resources'
import { Toaster } from './components/Toaster'
import { TooltipProvider } from './components/Tooltip'
import { NotFound } from './features/errors/NotFound'
import { RouteError } from './features/errors/RouteError'
import { OverviewPage } from './features/overview/OverviewPage'
import { MetricsPage } from './features/metrics/MetricsPage'
import { ResourcePage } from './features/resources/ResourcePage'
import { ClusterLayout } from './features/shell/ClusterLayout'
import { WelcomePage } from './features/welcome/WelcomePage'

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

const router = createHashRouter([
  {
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <WelcomePage /> },
      {
        path: '/cluster/:context',
        element: <ClusterLayout />,
        children: [
          {
            // Page errors render inside the layout, so the sidebar stays usable.
            errorElement: <RouteError />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: 'metrics', element: <MetricsPage /> },
              ...RESOURCES.map((resource) => ({
                path: resource.plural,
                element: <ResourcePage key={resource.kind} kind={resource.kind} />,
              })),
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
