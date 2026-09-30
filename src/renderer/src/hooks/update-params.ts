import { useSearchParams } from 'react-router'

export type UpdateParams = (
  change: (params: URLSearchParams) => void,
  options?: { replace?: boolean },
) => void

/**
 * Changes the search params of the current page. Starts from the URL as it is
 * right now, since React Router hands functional updates the params of the
 * last render, and waits for a page transition in progress to swap in its
 * page first: React Router would otherwise replace this change with the state
 * it is transitioning to (e.g. when typing right after following a link).
 */
export function useUpdateParams(): UpdateParams {
  const [, setParams] = useSearchParams()
  return (change, { replace = false } = {}) => {
    const apply = () => {
      const params = new URLSearchParams(window.location.hash.split('?')[1])
      change(params)
      // Rendered at once, so lists keep up with typing.
      setParams(params, { replace, flushSync: true })
    }
    const transition = document.activeViewTransition
    if (transition) void transition.updateCallbackDone.then(apply, apply)
    else apply()
  }
}
