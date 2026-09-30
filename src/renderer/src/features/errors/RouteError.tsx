import { RotateCw } from 'lucide-react'
import { useRouteError } from 'react-router'
import { Button } from '@renderer/components/Button'
import { useGo } from '@renderer/hooks/go'
import { CrashView } from './CrashView'

/** Shown by the router when a page fails to render. */
export function RouteError() {
  const error = useRouteError() as Error
  const go = useGo()
  return (
    <div className="grid h-full place-items-center overflow-y-auto">
      <CrashView error={error} title="Something went wrong">
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RotateCw /> Reload
        </Button>
        <Button onClick={() => go('/')}>Back to clusters</Button>
      </CrashView>
    </div>
  )
}
