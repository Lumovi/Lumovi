/**
 * A folder's context whose credentials do something on this computer (run a program, send a
 * file, go to a server Lumovi can't verify): shown exactly as it would do it, in the same panels
 * and words as adding a cluster, to be allowed or not. Nothing of it is used before then.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { PastedKubeconfig } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { api } from '@renderer/lib/api'
import { Agreement } from './AddClusterDialog'
import { DialogIcon, PageDialog } from './PageDialog'

/** Its programs, files and servers, each by what agreeing gives back: the servers first. */
function consentsOf(asks: PastedKubeconfig) {
  return {
    servers: asks.unverified.map(({ consent }) => consent),
    rest: [...asks.commands, ...asks.tokenFiles].map(({ consent }) => consent),
  }
}

export function FolderConsentDialog({
  context,
  onAllowed,
  onClose,
}: {
  context: string
  /** Allowed: to be opened. */
  onAllowed: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const asks = useQuery({
    queryKey: ['kubeconfig-asks', context],
    queryFn: () => api.kubeconfigFiles!.asks(context),
    gcTime: 0,
  })
  const [agreed, setAgreed] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const inspected = asks.data?.ok ? asks.data.data : undefined
  const { servers, rest } = inspected ? consentsOf(inspected) : { servers: [], rest: [] }
  const open = (consents: string[]) => consents.filter((consent) => !agreed.includes(consent))
  // The server's first; then the rest.
  const kind = open(servers).length > 0 ? 'servers' : 'rest'

  const allow = async () => {
    const now = [...agreed, ...open(kind === 'servers' ? servers : rest)]
    setAgreed(now)
    if (open([...servers, ...rest]).some((consent) => !now.includes(consent))) return
    // (Nothing left to ask: allowed already, from another of its file's contexts, say.)
    if (now.length > 0) {
      const result = await api.kubeconfigFiles!.agree(context, now)
      if (!result.ok) return setError(result.error.message)
    }
    await queryClient.invalidateQueries({ queryKey: ['contexts'] })
    await queryClient.invalidateQueries({ queryKey: ['version', context] })
    onAllowed()
  }

  return (
    <PageDialog
      leading={
        <DialogIcon>
          <ShieldAlert />
        </DialogIcon>
      }
      title={`Allow “${context}” to sign in`}
      subtitle="It’s from a folder of kubeconfigs. Nothing of it is used until you allow it."
      error={error ?? (asks.data && !asks.data.ok ? asks.data.error.message : undefined)}
      onSubmit={() => void allow()}
      onClose={onClose}
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={onClose}>
            Don’t use it
          </Button>
          <Button type="submit" variant="primary" disabled={!inspected}>
            Allow and continue
          </Button>
        </>
      }
    >
      {inspected && <Agreement inspected={inspected} kind={kind} addsAtOnce={false} />}
    </PageDialog>
  )
}
