import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@renderer/lib/api'
import { feed } from '@renderer/lib/pushed'

/**
 * What Lumovi is told of each change to, written to the cache for the app's whole life (see
 * pushed.ts): its assistants and who's connected, the person's AI permissions, port forwards.
 */
export function PushedFeeds() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const feeds = [
      api.assistants && feed(queryClient, ['assistants'], api.assistants.onStatus),
      api.serverAssistants &&
        feed(queryClient, ['server-assistants'], api.serverAssistants.onStatus),
      api.aiPermissions && feed(queryClient, ['ai-permissions'], api.aiPermissions.onChanged),
      api.forwards && feed(queryClient, ['forwards'], api.forwards.onChange),
    ]
    return () => feeds.forEach((stop) => stop && stop())
  }, [queryClient])
  return null
}
