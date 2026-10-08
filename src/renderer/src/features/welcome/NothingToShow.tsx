/**
 * The clusters page with no clusters to show, and why: none yet, a kubeconfig that can't be
 * read, a chosen one that's gone, or an organization's that has none. Each offers what to do,
 * the first with the focus.
 */
import {
  Building2,
  FileInput,
  FileWarning,
  FolderOpen,
  Plus,
  RotateCcw,
  RotateCw,
  ServerOff,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { ContextsResult, KubeconfigFiles } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/States'
import { REVEAL, tilde, trouble } from './clusters'
import { useFileActions } from './KubeconfigFiles'

export function NothingToShow({
  contexts,
  files,
  onReload,
  onAdd,
}: {
  contexts: ContextsResult
  /** The files read (the desktop app's). */
  files?: KubeconfigFiles
  onReload: () => void
  /** Adding a cluster, where Lumovi can. */
  onAdd?: () => void
}) {
  return (
    <div className="flex min-h-[380px] animate-rise flex-col justify-center rounded-2xl border border-line bg-surface-2 shadow-panel [animation-delay:60ms] [@media(max-height:800px)]:min-h-[320px]">
      {files ? (
        <Why contexts={contexts} files={files} onReload={onReload} onAdd={onAdd} />
      ) : contexts.error ? (
        <Unreadable message={contexts.error} />
      ) : (
        <EmptyState icon={ServerOff} title="No clusters found" className="max-w-[460px]">
          Lumovi reads clusters from your kubeconfig. Set the{' '}
          <code className="font-mono">KUBECONFIG</code> environment variable, or create{' '}
          <code className="font-mono">~/.kube/config</code>, then reload.
        </EmptyState>
      )}
    </div>
  )
}

function Why({
  contexts,
  files,
  onReload,
  onAdd,
}: {
  contexts: ContextsResult
  files: KubeconfigFiles
  onReload: () => void
  onAdd?: () => void
}) {
  const actions = useFileActions()
  const path = (file: { path: string }) => (
    <code className="font-mono">{tilde(file.path, files.home)}</code>
  )
  const choose = (
    <Button variant="primary" autoFocus onClick={() => void actions.choose()}>
      <FileInput /> Choose a kubeconfig…
    </Button>
  )

  const unreadable = files.files.find((file) => file.problem)
  if (contexts.error && unreadable) {
    return (
      <Unreadable
        message={unreadable.problem!}
        about={
          <>
            Lumovi reads {path(unreadable)}, and it couldn’t be read. Fix it and reload, or choose
            another file.
          </>
        }
      >
        {!files.locked && choose}
        <Button variant="secondary" onClick={() => actions.show(unreadable.path)}>
          <FolderOpen /> {REVEAL}
        </Button>
      </Unreadable>
    )
  }

  const gone = files.files.filter((file) => trouble(file) === 'gone')
  if (files.from === 'chosen' && gone.length > 0) {
    return (
      <EmptyState
        icon={FileWarning}
        title="The kubeconfig you chose is gone"
        className="max-w-[460px]"
      >
        Lumovi was reading {path(gone[0]!)}, and it’s been moved or deleted, so there are no
        clusters to show.
        <Actions>
          {choose}
          <Button variant="secondary" onClick={() => void actions.useDefault()}>
            <RotateCcw /> Back to KUBECONFIG and ~/.kube/config
          </Button>
        </Actions>
      </EmptyState>
    )
  }

  if (files.locked) {
    return (
      <EmptyState icon={Building2} title="No clusters yet" className="max-w-[460px]">
        Your organization’s policy keeps Lumovi to KUBECONFIG and ~/.kube/config, and neither has a
        cluster. Ask whoever looks after this computer.
        <Actions>
          <Button variant="secondary" autoFocus onClick={onReload}>
            <RotateCw /> Reload
          </Button>
        </Actions>
      </EmptyState>
    )
  }

  const read = files.files.filter((file) => file.exists)
  return (
    <EmptyState icon={ServerOff} title="No clusters yet" className="max-w-[460px]">
      {files.from === 'chosen' && read.length > 0 ? (
        <>
          Lumovi reads {path(read[0]!)}, and found no clusters in it. Choose another file, or add a
          cluster.
        </>
      ) : (
        <>
          Lumovi looks for a kubeconfig in <code className="font-mono">KUBECONFIG</code> and{' '}
          <code className="font-mono">~/.kube/config</code>, and found none. Choose the file you use
          with kubectl, or add a cluster.
        </>
      )}
      <Actions>
        {choose}
        {onAdd && (
          <Button variant="secondary" onClick={onAdd}>
            <Plus /> Add a cluster
          </Button>
        )}
      </Actions>
    </EmptyState>
  )
}

/** A kubeconfig that couldn't be read: the parser's own words, and what to do. */
function Unreadable({
  message,
  about,
  children,
}: {
  message: string
  about?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-[460px] flex-col items-center py-14 text-center"
    >
      <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-critical/10 text-critical-text">
        <FileWarning className="size-5" />
      </div>
      <h3 className="text-[15px] font-semibold text-ink-1">Your kubeconfig couldn’t be read</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        {about ?? 'Fix the file, then choose Reload.'}
      </p>
      <p className="mt-3 max-w-full rounded-md bg-surface-3 px-2.5 py-1.5 font-mono text-xs break-words text-ink-2 selectable">
        {message}
      </p>
      {children && <Actions>{children}</Actions>}
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-center gap-2">{children}</div>
}
