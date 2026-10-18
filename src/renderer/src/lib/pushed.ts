/**
 * What Lumovi asks for once and is then told of each change to (pushed): who's connected, the
 * person's AI permissions, port forwards. Each is written to the cache by one listener for the
 * app's whole life, so a change told while no page shows it (a page opening, say) isn't missed;
 * and an answer to an ask that a push overtook is dropped, as the push is as new as it, or newer
 * (every change is pushed). Otherwise an assistant that left could stay listed.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'

/** How many pushes each has had, by its key. */
const pushes = new Map<string, number>()

/** Writes each push of `key` to the cache, from now until the returned function is called. */
export function feed<T>(
  queryClient: QueryClient,
  key: QueryKey,
  subscribe: (listener: (value: T) => void) => () => void,
): () => void {
  const id = JSON.stringify(key)
  return subscribe((value) => {
    pushes.set(id, (pushes.get(id) ?? 0) + 1)
    queryClient.setQueryData(key, value)
  })
}

/** An ask's answer, unless a push came while it was on its way: then what that said. */
export async function asked<T>(
  queryClient: QueryClient,
  key: QueryKey,
  ask: () => Promise<T>,
): Promise<T> {
  const id = JSON.stringify(key)
  const before = pushes.get(id) ?? 0
  const answer = await ask()
  if ((pushes.get(id) ?? 0) === before) return answer
  return (queryClient.getQueryData<T>(key) ?? answer) as T
}
