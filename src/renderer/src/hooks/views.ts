import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/api'
import { loadShippedViews, parseViews, setLocalViews, shippedViews } from '@renderer/lib/views'

// KubeStacks' own views and add-ons, bundled with the app.
const SHIPPED_PROBLEMS = loadShippedViews(
  import.meta.glob<string>('../views/*.yaml', { query: '?raw', import: 'default', eager: true }),
)

/**
 * The views and add-ons in use: KubeStacks' and the user's own, read again
 * on refresh (⌘R) so edits to them show up. Subscribing re-renders when
 * they change.
 */
export function useViews() {
  return useQuery({
    queryKey: ['views'],
    queryFn: async () => {
      const { directory, files } = await api.app.views()
      const parsed = files.map((file) =>
        file.error
          ? { views: [], addOns: [], problems: [`${file.name}: ${file.error}`] }
          : parseViews(file.text, file.name),
      )
      const local = parsed.flatMap((p) => p.views)
      const localAddOns = parsed.flatMap((p) => p.addOns)
      setLocalViews(local, localAddOns)
      return {
        directory,
        local,
        localAddOns,
        shipped: shippedViews(),
        problems: [...SHIPPED_PROBLEMS, ...parsed.flatMap((p) => p.problems)],
      }
    },
    staleTime: Infinity,
  })
}
