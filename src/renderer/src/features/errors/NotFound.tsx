import { Compass } from 'lucide-react'
import { useLocation, useMatch } from 'react-router'
import { Button } from '@renderer/components/Button'
import { useGo } from '@renderer/hooks/go'
import { clusterPath } from '@renderer/lib/routes'

export function NotFound() {
  const go = useGo()
  const { pathname } = useLocation()
  const context = useMatch('/cluster/:context/*')?.params.context
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-md animate-rise flex-col items-center px-6 py-16 text-center">
        <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
          <Compass className="size-6" />
        </div>
        <h2 className="text-[17px] font-semibold text-ink-1">This page doesn’t exist</h2>
        <p className="mt-1.5 font-mono text-xs break-all text-ink-3 selectable">{pathname}</p>
        <Button
          variant="primary"
          className="mt-5"
          onClick={() => go(context ? clusterPath(context) : '/')}
        >
          {context ? 'Go to the overview' : 'Back to clusters'}
        </Button>
      </div>
    </div>
  )
}
