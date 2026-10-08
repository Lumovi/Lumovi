/**
 * The kubeconfig files the desktop app reads, from the clusters page's footer: which, from
 * where, how many clusters each has or what's wrong with it, and choosing others. Lumovi never
 * writes them.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronUp,
  FileInput,
  FilePlus,
  FileText,
  FileWarning,
  Folder,
  FolderOpen,
  Info,
  Lock,
  RotateCcw,
  X,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useRef, type ReactNode } from 'react'
import type { KubeconfigFiles as Files, Result } from '@shared/api'
import { Tooltip } from '@renderer/components/Tooltip'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { menuContent, menuItem } from '../shell/menu-styles'
import { fileNote, REVEAL, shownFiles, tilde, trouble, type KubeconfigFile } from './clusters'

/** The files read, as last read (again whenever the clusters are). */
export function useKubeconfigFiles() {
  const contexts = useContexts()
  return useQuery({
    queryKey: ['kubeconfig-files', contexts.dataUpdatedAt],
    queryFn: () => api.kubeconfigFiles!.list(),
    enabled: !!api.kubeconfigFiles && contexts.isSuccess,
    placeholderData: keepPreviousData,
  })
}

/** Changes the files read, then reads the clusters again; says what went wrong, if anything. */
export function useChangeFiles() {
  const queryClient = useQueryClient()
  return async (change: () => Promise<Result<Files | null>>): Promise<boolean> => {
    const result = await change()
    if (!result.ok) {
      toast({
        tone: 'error',
        title: 'The kubeconfig files weren’t changed',
        description: result.error.message,
      })
      return false
    }
    if (result.data === null) return false
    await queryClient.invalidateQueries({ queryKey: ['contexts'] })
    return true
  }
}

/** The ways to change the files read, for the popover and the page's empty states. */
export function useFileActions() {
  const change = useChangeFiles()
  const files = api.kubeconfigFiles!
  return {
    choose: () => change(() => files.choose('replace')),
    add: () => change(() => files.choose('add')),
    useDefault: () => change(() => files.useDefault()),
    remove: (path: string) => change(() => files.remove(path)),
    chooseAgain: (path: string) => change(() => files.chooseAgain(path)),
    show: (path: string) => void files.show(path),
  }
}

/** The footer's button: the first file read, how many others, and the popover with them all. */
export function KubeconfigFilesButton({ files }: { files: Files }) {
  const content = useRef<HTMLDivElement>(null)
  const shown = shownFiles(files)
  const first = shown.find((file) => file.exists || trouble(file)) ?? shown[0]
  const others = shown.filter((file) => file !== first && (file.exists || trouble(file))).length
  const wrong = shown.some((file) => trouble(file))
  const Icon = wrong ? FileWarning : FileText
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Kubeconfig files"
        className="-ml-2 flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-ink-3 no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3"
      >
        <Icon className={cn('size-3.5 shrink-0', wrong && 'text-critical-text')} />
        {first?.exists || (first && trouble(first)) ? (
          // Cut from the start, so the file's name stays.
          <span className="min-w-0 truncate font-mono text-xs text-ink-2 [direction:rtl]">
            <bdi>{tilde(first.path, files.home)}</bdi>
          </span>
        ) : (
          <span className="text-xs text-ink-2">No kubeconfig</span>
        )}
        {others > 0 && (
          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-2xs font-medium text-ink-2">
            +{others}
          </span>
        )}
        <ChevronUp className="size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          aria-label="Kubeconfig files"
          // Opened on the popover, not its first file's button (whose tooltip would show).
          tabIndex={-1}
          ref={content}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            content.current?.focus()
          }}
          className={cn(menuContent, 'w-[440px] p-0')}
        >
          <FilesPopover files={files} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function FilesPopover({ files }: { files: Files }) {
  const actions = useFileActions()
  const locked = !!files.locked
  // Only "Back to…" when there's something to go back from.
  const changed = files.from === 'chosen' || files.files.some((file) => file.origin === 'added')
  return (
    <>
      <div className="flex items-baseline justify-between px-3.5 pt-3 pb-1.5">
        <span className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Kubeconfig files
        </span>
        <span className="text-xs text-ink-3">{locked ? 'Managed' : 'Merged as kubectl does'}</span>
      </div>
      <div className="pb-1">
        {shownFiles(files).map((file) => (
          <FileRow key={file.path} file={file} home={files.home} locked={locked} />
        ))}
      </div>
      {!locked && (
        <div className="border-t border-line p-1">
          <Popover.Close asChild>
            <button type="button" className={cn(menuItem, 'w-full')} onClick={actions.choose}>
              <FileInput className="size-4 text-ink-2" />
              Choose a kubeconfig…
              <span className="ml-auto text-xs text-ink-3">Use only that file</span>
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" className={cn(menuItem, 'w-full')} onClick={actions.add}>
              <FilePlus className="size-4 text-ink-2" />
              Add another file…
            </button>
          </Popover.Close>
          {changed && (
            <Popover.Close asChild>
              <button type="button" className={cn(menuItem, 'w-full')} onClick={actions.useDefault}>
                <RotateCcw className="size-4 text-ink-2" />
                Back to <span className="font-mono text-xs">KUBECONFIG</span> and{' '}
                <span className="font-mono text-xs">~/.kube/config</span>
              </button>
            </Popover.Close>
          )}
        </div>
      )}
      <p className="flex gap-2 border-t border-line px-3.5 pt-2.5 pb-3 text-xs text-ink-3">
        {locked ? (
          <Lock className="mt-px size-3.5 shrink-0" />
        ) : (
          <Info className="mt-px size-3.5 shrink-0" />
        )}
        {locked
          ? 'Your organization’s policy keeps Lumovi to these files.'
          : 'Lumovi reads these files and never writes to them. Removing one only stops Lumovi reading it.'}
      </p>
    </>
  )
}

function FileRow({ file, home, locked }: { file: KubeconfigFile; home: string; locked: boolean }) {
  const actions = useFileActions()
  const wrong = trouble(file)
  const Icon = wrong ? FileWarning : file.origin === 'own' ? Folder : FileText
  const removable = !locked && file.removable
  return (
    <div className="group/file mx-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 focus-within:bg-surface-3 hover:bg-surface-3">
      <Icon className={cn('size-4 shrink-0', wrong ? 'text-critical-text' : 'text-ink-3')} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate font-mono text-xs [direction:rtl] selectable',
            wrong ? 'text-ink-2' : 'text-ink-1',
          )}
          title={file.path}
        >
          <bdi>{tilde(file.path, home)}</bdi>
        </span>
        <span
          className={cn('block truncate text-xs', wrong ? 'text-critical-text' : 'text-ink-3')}
          title={fileNote(file)}
        >
          {fileNote(file)}
        </span>
      </span>
      <span
        className={cn(
          'flex shrink-0 gap-0.5',
          // A file's own buttons on hover or focus; a gone one's always.
          !wrong && 'opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100',
        )}
      >
        {wrong === 'gone' && !locked ? (
          <FileButton label="Choose it again…" onClick={() => void actions.chooseAgain(file.path)}>
            <FileInput />
          </FileButton>
        ) : (
          file.exists && (
            <FileButton label={REVEAL} onClick={() => actions.show(file.path)}>
              <FolderOpen />
            </FileButton>
          )
        )}
        {removable && (
          <FileButton label="Remove" onClick={() => void actions.remove(file.path)}>
            <X />
          </FileButton>
        )}
      </span>
    </div>
  )
}

function FileButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-[26px] place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink-1 [&_svg]:size-[15px]"
      >
        {children}
      </button>
    </Tooltip>
  )
}
