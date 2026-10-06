/** The way into the Admin pages, for Lumovi's admins only: next to the audit log. */
import { Shield } from 'lucide-react'
import { useNavigate } from 'react-router'
import { IconButton } from '@renderer/components/Button'
import { useIsAdmin } from './use-access'

export function AdminButton() {
  const navigate = useNavigate()
  if (!useIsAdmin()) return null
  return (
    <IconButton label="Admin: who may do what" onClick={() => void navigate('/access')}>
      <Shield />
    </IconButton>
  )
}
