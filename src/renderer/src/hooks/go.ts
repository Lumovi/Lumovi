import { useNavigate } from 'react-router'
import { currentPath } from '@renderer/lib/routes'

/**
 * Navigates with a page transition. The transition starts right away
 * (flushSync), so URL changes made meanwhile can wait for it to swap in the
 * new page (see useUpdateParams). Going to the current page replaces it, as
 * a link does.
 */
export function useGo(): (to: string) => void {
  const navigate = useNavigate()
  return (to) =>
    void navigate(to, {
      viewTransition: true,
      flushSync: true,
      replace: to === currentPath(),
    })
}
