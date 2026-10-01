import { useQuery } from '@tanstack/react-query'
import { api } from '@renderer/lib/api'
import { loadShippedViews, parseViews, setLocalViews, shippedViews } from '@renderer/lib/views'

// KubeStacks' own views, bundled with the app.
const SHIPPED_PROBLEMS = loadShippedViews(
  import.meta.glob<string>('../views/*.yaml', { query: '?raw', import: 'default', eager: true }),
)

/**
 * The views in use: KubeStacks' and the user's own, read again on refresh
 * (⌘R) so edits to them show up. Subscribing re-renders when they change.
 */
export function useViews() {
  return useQuery({
    queryKey: ['views'],
    queryFn: async () => {
      const { directory, files } = await api.app.views()
      const parsed = files.map((file) =>
        file.error
          ? { views: [], problems: [`${file.name}: ${file.error}`] }
          : parseViews(file.text, file.name),
      )
      const local = parsed.flatMap((p) => p.views)
      setLocalViews(local)
      return {
        directory,
        local,
        shipped: shippedViews(),
        problems: [...SHIPPED_PROBLEMS, ...parsed.flatMap((p) => p.problems)],
      }
    },
    staleTime: Infinity,
  })
}
