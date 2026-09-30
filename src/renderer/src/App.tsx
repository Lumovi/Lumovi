import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createHashRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { RESOURCES } from '@shared/resources'
import { TooltipProvider } from './components/Tooltip'
import { OverviewPage } from './features/overview/OverviewPage'
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
  { path: '/', element: <WelcomePage /> },
  {
    path: '/cluster/:context',
    element: <ClusterLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      ...RESOURCES.map((resource) => ({
        path: resource.plural,
        element: <ResourcePage key={resource.kind} kind={resource.kind} />,
      })),
    ],
  },
])

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
