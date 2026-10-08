/**
 * Access, for Lumovi's admins: who's in which group, what each profile lets
 * them do, the grants that give it where, and the limits that hold anyone
 * back; someone checked anywhere; and every change made. Changes are made to
 * a draft and saved together, after they're read back, so nobody gets half
 * of one; saving after someone else did is refused, never lost in theirs.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Shield } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useBlocker, useParams } from 'react-router'
import { canonical, changesOf, type AccessPolicy, type AdminAccess } from '@shared/access'
import type { KubeContext } from '@shared/api'
import { Button, buttonClass } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { useNamespaceIndex } from '../assistants/namespaces'
import { plural } from './access-model'
import { CheckTab } from './CheckTab'
import { GroupsTab } from './GroupsTab'
import { HistoryTab } from './HistoryTab'
import { Frame } from './parts'
import { ProfilesTab } from './ProfilesTab'
import { RulesTab } from './RulesTab'
import { useClusters, useMyAccess } from './use-access'

/** What every tab works with: the draft, how to change it, and what's known of the server. */
export interface TabProps {
  policy: AccessPolicy
  update: (change: (policy: AccessPolicy) => AccessPolicy) => void
  admin: AdminAccess
  /** The clusters (one or more), and every one's namespaces, with their labels, as listed. */
  clusters: KubeContext[]
  index: ReturnType<typeof useNamespaceIndex>
}

const TABS = ['groups', 'profiles', 'rules', 'check', 'history'] as const

export function AccessPage() {
  useEffect(() => {
    document.title = 'Access — Lumovi'
  }, [])
  const mine = useMyAccess()
  if (!api.access) return <Navigate replace to="/" />
  if (!mine) return null
  if (!mine.admin) return <NotAnAdmin admins={mine.admins} />
  return <Admin />
}

function NotAnAdmin({ admins }: { admins: string[] }) {
  return (
    <Frame
      title="Access"
      subtitle="Who may do what, through Lumovi."
      intro={<p>Lumovi’s admins decide it here.</p>}
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-2.5 py-14 text-center">
        <span className="grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
          <Shield className="size-5" aria-hidden />
        </span>
        <h2 className="text-[15px] font-semibold text-ink-1">Only Lumovi’s admins see this</h2>
        <p className="text-[13px] text-ink-2">
          {admins.length
            ? `The server names them: ${admins.join(', ')}.`
            : 'The server names nobody as an admin (LUMOVI_ADMINS).'}{' '}
          What you may do yourself is in your access.
        </p>
        <Link to="/your-access" className={buttonClass('primary', 'mt-1.5')}>
          See your access
        </Link>
      </div>
    </Frame>
  )
}

function Admin() {
  const { tab } = useParams()
  const client = useQueryClient()
  const read = useQuery({
    queryKey: ['access', 'admin'],
    queryFn: () => api.access!.admin(),
    gcTime: 0,
  })
  const contexts = useClusters()
  const index = useNamespaceIndex(contexts)
  // What's shown starts once the clusters are known: tabs count and suggest from them.
  const ready = contexts.length > 0
  /** What the draft started from, and the draft. */
  const [basis, setBasis] = useState<AdminAccess>()
  const [draft, setDraft] = useState<AccessPolicy>()
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [conflict, setConflict] = useState(false)

  const dirty = Boolean(basis && draft && canonical(basis.policy) !== canonical(draft))
  const latest = read.data
  // Someone else's change: taken at once with nothing unsaved; said, with something.
  const [known, setKnown] = useState<string>()
  if (latest && latest.version !== known) {
    setKnown(latest.version)
    if (basis && dirty) setConflict(true)
    else {
      setBasis(latest)
      setDraft(latest.policy)
    }
  }

  const changes = useMemo(
    () => (basis && draft ? changesOf(basis.policy, draft) : []),
    [basis, draft],
  )

  // Leaving with changes unsaved asks first: the page, or the browser.
  const blocker = useBlocker(
    ({ nextLocation }) => dirty && !nextLocation.pathname.startsWith('/access'),
  )
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [dirty])

  if (tab === undefined || !TABS.includes(tab as (typeof TABS)[number])) {
    return <Navigate replace to="/access/groups" />
  }
  if (!basis || !draft || !ready) {
    return (
      <Frame title="Access" subtitle="Who may do what, through Lumovi." intro={null}>
        <Loading label="Reading who may do what…" className="py-24" />
      </Frame>
    )
  }

  const update = (change: (policy: AccessPolicy) => AccessPolicy) => {
    setProblem(undefined)
    setDraft((current) => change(current!))
  }
  const discard = () => {
    setDraft(basis.policy)
    setProblem(undefined)
  }
  const startOver = async () => {
    const fresh = await client.fetchQuery({
      queryKey: ['access', 'admin'],
      queryFn: () => api.access!.admin(),
    })
    setKnown(fresh.version)
    setBasis(fresh)
    setDraft(fresh.policy)
    setConflict(false)
    setProblem(undefined)
  }
  const save = async () => {
    setSaving(true)
    setProblem(undefined)
    const result = await api.access!.set(draft, basis.version)
    setSaving(false)
    if (result.ok) {
      setKnown(result.data.version)
      setBasis(result.data)
      setDraft(result.data.policy)
      client.setQueryData(['access', 'admin'], result.data)
      void client.invalidateQueries({ queryKey: ['access', 'mine'] })
      toast({
        tone: 'success',
        title: changes.length === 1 ? 'Saved the change' : `Saved ${changes.length} changes`,
        description: 'Who may do what applies at once, everywhere. The audit log has it.',
      })
    } else if (result.error.code === 'conflict') {
      setConflict(true)
    } else {
      setProblem(result.error.message)
    }
  }

  const { admins } = basis
  const props: TabProps = { policy: draft, update, admin: basis, clusters: contexts, index }
  return (
    <Frame
      title="Access"
      subtitle="Who may do what, through Lumovi."
      base="/access"
      current={tab}
      tabs={[
        { path: 'groups', label: 'Groups', count: draft.groups.length },
        { path: 'profiles', label: 'Profiles', count: draft.profiles.length + 1 },
        {
          path: 'rules',
          label: 'Grants & limits',
          count: draft.grants.length + draft.limits.length,
        },
        { path: 'check', label: 'Check someone' },
        { path: 'history', label: 'History' },
      ]}
      intro={
        <>
          <p>
            Kubernetes RBAC says what anyone may do in a cluster. These say what Lumovi lets them do
            there: never more than RBAC, often less.
          </p>
          <p className="text-xs text-ink-3">
            Admins are named by the server’s settings (
            <span className="font-mono">LUMOVI_ADMINS</span>: {admins.join(', ')}), never here.
            Every change is recorded in the audit log.
            {basis.kept === 'memory' &&
              ' This server keeps it in memory: it’s lost when Lumovi restarts (set LUMOVI_DATA_DIR, or install the Helm chart).'}
          </p>
        </>
      }
      footer={
        (dirty || conflict) && (
          <SaveBar
            changes={changes}
            saving={saving}
            problem={problem}
            conflict={conflict}
            onSave={() => void save()}
            onDiscard={discard}
            onStartOver={() => void startOver()}
          />
        )
      }
    >
      {tab === 'groups' && <GroupsTab {...props} />}
      {tab === 'profiles' && <ProfilesTab {...props} />}
      {tab === 'rules' && <RulesTab {...props} />}
      {tab === 'check' && <CheckTab {...props} />}
      {tab === 'history' && <HistoryTab />}
      {blocker.state === 'blocked' && (
        <LeaveDialog
          count={changes.length}
          onStay={() => blocker.reset()}
          onLeave={() => blocker.proceed()}
        />
      )}
    </Frame>
  )
}

/** What isn't saved yet, read back before it is: kept at the bottom of the page. */
function SaveBar({
  changes,
  saving,
  problem,
  conflict,
  onSave,
  onDiscard,
  onStartOver,
}: {
  changes: string[]
  saving: boolean
  problem?: string
  conflict: boolean
  onSave: () => void
  onDiscard: () => void
  onStartOver: () => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <div
      role="region"
      aria-label="Changes not saved"
      className="shrink-0 animate-toast-in border-t border-line-strong bg-surface shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.18)]"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-2 px-5 py-3">
        {conflict ? (
          <div className="flex flex-wrap items-center gap-3">
            <CircleAlert className="size-4 shrink-0 text-warn-text" aria-hidden />
            <p className="min-w-0 flex-[1_1_320px] text-[13px] text-ink-1">
              <span className="font-semibold">Someone else saved changes to access</span>
              <span className="text-ink-2">
                {' '}
                since you started. Yours weren’t saved: start over from theirs, and make yours
                again.
              </span>
            </p>
            <Button variant="primary" onClick={onStartOver}>
              Start over from theirs
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
              <p className="text-[13px] font-medium text-ink-1">
                {plural(changes.length, 'change', 'changes')} not saved
              </p>
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => setShown(!shown)}
                className="text-xs font-medium text-accent-strong hover:underline"
              >
                {shown ? 'Hide them' : 'Read them'}
              </button>
              <span className="flex-1" />
              <Button variant="ghost" disabled={saving} onClick={onDiscard}>
                Discard
              </Button>
              <Button variant="primary" disabled={saving} onClick={onSave}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
            {shown && (
              <ul className="flex max-h-48 animate-fade-in flex-col gap-1 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
                {changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            )}
            {problem && (
              <p role="alert" className={cn('text-xs text-critical-text selectable')}>
                Not saved: {problem}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function LeaveDialog({
  count,
  onStay,
  onLeave,
}: {
  count: number
  onStay: () => void
  onLeave: () => void
}) {
  return (
    <Dialog.Root open onOpenChange={onStay}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-1/2 animate-pop-in rounded-2xl border border-line-strong bg-surface p-5 shadow-pop"
        >
          <Dialog.Title className="text-[15px] font-semibold text-ink-1">
            Leave without saving?
          </Dialog.Title>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Not saved yet, and lost if you leave: {plural(count, 'change', 'changes')} to access.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={onLeave}>
              Leave
            </Button>
            <Button variant="primary" autoFocus onClick={onStay}>
              Stay
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
