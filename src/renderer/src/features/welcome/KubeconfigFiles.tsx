/**
 * The kubeconfig files the desktop app reads, from the clusters page's footer: which, from
 * where, how many clusters each has or what's wrong with it, and choosing others; and the folders
 * added, each with its kubeconfigs and what it skipped. Lumovi never writes them, and a change to
 * them shows by itself.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileInput,
  FilePlus,
  FileText,
  FileWarning,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  Lock,
  RotateCcw,
  X,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useRef, useState, type ReactNode } from 'react'
import type { KubeconfigFiles as Files, Result } from '@shared/api'
import { Tooltip } from '@renderer/components/Tooltip'
import { useContexts } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { menuContent, menuItem } from '../shell/menu-styles'
import {
  fileNote,
  folderFileNote,
  folderNote,
  REVEAL,
  shownFiles,
  SKIPPED,
  tilde,
  trouble,
  type FolderFile,
  type KubeconfigFile,
  type KubeconfigFolder,
} from './clusters'

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
    addFolder: () => change(() => files.addFolder()),
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
  const others =
    shown.filter((file) => file !== first && (file.exists || trouble(file))).length +
    files.folders.length
  const folderFiles = files.folders.flatMap((folder) => folder.files)
  const wrong =
    [...shown, ...folderFiles].some((file) => trouble(file)) ||
    files.folders.some((folder) => folder.problem)
  // Some can't be read: a warning; none can (nothing loads): critical. One kept as last read
  // still loads: a warning, never critical.
  const lost = (file: KubeconfigFile) => {
    const problem = trouble(file)
    return (problem && problem !== 'kept') || !file.exists
  }
  const nothing = wrong && folderFiles.length === 0 && shown.every(lost)
  const Icon = wrong ? FileWarning : FileText
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Kubeconfig files"
        className="-ml-2 flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-ink-3 no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3"
      >
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            nothing ? 'text-critical-text' : wrong && 'text-warn-text',
          )}
        />
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
          // In line with the card above, not with the button's hover area (8 px further out).
          alignOffset={8}
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
  const changed =
    files.from === 'chosen' ||
    files.files.some((file) => file.origin === 'added') ||
    files.folders.length > 0
  return (
    <>
      <div className="flex items-baseline justify-between px-3.5 pt-3 pb-1.5">
        <span className="text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Kubeconfig files
        </span>
        <span className="text-xs text-ink-3">{locked ? 'Managed' : 'Merged as kubectl does'}</span>
      </div>
      {/* Past twelve rows or so, the list scrolls; the actions and the foot stay. */}
      <div className="max-h-[600px] overflow-y-auto pb-1">
        {shownFiles(files).map((file) => (
          <FileRow key={file.path} file={file} home={files.home} locked={locked} />
        ))}
        {files.folders.map((folder) => (
          <FolderRows key={folder.path} folder={folder} home={files.home} locked={locked} />
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
          <Popover.Close asChild>
            <button type="button" className={cn(menuItem, 'w-full')} onClick={actions.addFolder}>
              <FolderPlus className="size-4 text-ink-2" />
              Add a folder…
              <span className="ml-auto text-xs text-ink-3">Every kubeconfig in it</span>
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
          : `Lumovi reads these files and never writes to them.${
              files.files.some((file) => file.removable) || files.folders.length > 0
                ? ' Removing one only stops Lumovi reading it.'
                : ''
            } A change to them shows here within a second.`}
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
      <Icon className={cn('size-4 shrink-0', toneOf(wrong) ?? 'text-ink-3')} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            // Cut from the start, but set from the left when it fits.
            'block truncate text-left font-mono text-xs [direction:rtl] selectable',
            wrong ? 'text-ink-2' : 'text-ink-1',
          )}
          title={file.path}
        >
          <bdi>{tilde(file.path, home)}</bdi>
        </span>
        <Note wrong={wrong}>{fileNote(file)}</Note>
        <Refused lines={file.refused} />
      </span>
      <span
        className={cn(
          'flex shrink-0 gap-0.5',
          // A file's own buttons on hover or focus; a gone one's always.
          (!wrong || wrong === 'kept') &&
            'opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100',
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

/** A note's colour: amber for one kept as last read, red for what's lost. */
function toneOf(wrong: ReturnType<typeof trouble> | 'folder'): string | undefined {
  if (wrong === 'kept') return 'text-warn-text'
  return wrong ? 'text-critical-text' : undefined
}

/** A row's note: one line, or (kept as last read, where the reason is the point) wrapped. */
function Note({
  wrong,
  children,
}: {
  wrong: ReturnType<typeof trouble> | 'folder'
  children: string
}) {
  return (
    <span
      className={cn(
        'block text-xs',
        wrong === 'kept' ? 'whitespace-normal' : 'truncate',
        toneOf(wrong) ?? 'text-ink-3',
      )}
      title={children}
    >
      {children}
    </span>
  )
}

/** Why some of a file's contexts aren't used (they take parts across a folder's kubeconfig). */
function Refused({ lines }: { lines?: string[] }) {
  return lines?.map((line) => (
    <span key={line} className="block text-xs whitespace-normal text-critical-text">
      {line}
    </span>
  ))
}

/**
 * A folder: its row (open or shut), its kubeconfigs under it, each a row of its own, and last,
 * what it skipped, shut until pressed. Open as the popover opens with five or fewer.
 */
function FolderRows({
  folder,
  home,
  locked,
}: {
  folder: KubeconfigFolder
  home: string
  locked: boolean
}) {
  const actions = useFileActions()
  const [open, setOpen] = useState(folder.files.length <= 5)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  const lost = folder.problem ? 'folder' : undefined
  return (
    <>
      <div className="group/file mx-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 focus-within:bg-surface-3 hover:bg-surface-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Shut' : 'Open'}
          onClick={() => setOpen(!open)}
          className="-mr-1 grid size-4 shrink-0 place-items-center text-ink-3"
        >
          <Chevron className="size-3.5" />
        </button>
        {lost ? (
          <FileWarning className="size-4 shrink-0 text-critical-text" />
        ) : (
          <Folder className="size-4 shrink-0 text-ink-3" />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-left font-mono text-xs [direction:rtl] selectable',
              lost ? 'text-ink-2' : 'text-ink-1',
            )}
            title={folder.path}
          >
            <bdi>{tilde(folder.path, home)}</bdi>
          </span>
          <Note wrong={lost}>{folderNote(folder)}</Note>
        </span>
        <span
          className={cn(
            'flex shrink-0 gap-0.5',
            !lost && 'opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100',
          )}
        >
          {!folder.problem && (
            <FileButton label={REVEAL} onClick={() => actions.show(folder.path)}>
              <FolderOpen />
            </FileButton>
          )}
          {!locked && (
            <FileButton label="Remove" onClick={() => void actions.remove(folder.path)}>
              <X />
            </FileButton>
          )}
        </span>
      </div>
      {open && (
        <div role="group" aria-label={`In ${tilde(folder.path, home)}`}>
          {folder.files.map((file) => (
            <FolderFileRow key={file.path} file={file} />
          ))}
          {folder.files.length === 0 && !folder.problem && (
            <p className="mr-1 ml-[34px] px-2.5 py-1.5 text-xs text-ink-3">No kubeconfigs in it</p>
          )}
          {folder.skipped.length > 0 && (
            <div className="mr-1 ml-[34px] px-2.5 pb-1.5">
              <button
                type="button"
                aria-expanded={skippedOpen}
                onClick={() => setSkippedOpen(!skippedOpen)}
                className="flex h-[26px] items-center gap-1.5 text-xs text-ink-3"
              >
                {skippedOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {folder.skipped.length} skipped
              </button>
              {skippedOpen && (
                <ul aria-label="Skipped">
                  {folder.skipped.map(({ name, why }) => (
                    <li
                      key={name}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-0.5 pl-[22px] text-xs leading-[18px]"
                    >
                      <code className="truncate font-mono text-[11.5px] text-ink-2" title={name}>
                        {name}
                      </code>
                      <span className="text-ink-3">{SKIPPED[why]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** One of a folder's kubeconfigs: by its name (the folder says where), and only shown, not removed. */
function FolderFileRow({ file }: { file: FolderFile }) {
  const actions = useFileActions()
  const wrong = trouble(file)
  const Icon = wrong ? FileWarning : FileText
  return (
    <div className="group/file mr-1 ml-[34px] flex items-center gap-2.5 rounded-lg px-2.5 py-[5px] focus-within:bg-surface-3 hover:bg-surface-3">
      <Icon className={cn('size-4 shrink-0', toneOf(wrong) ?? 'text-ink-3')} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate font-mono text-xs selectable',
            wrong ? 'text-ink-2' : 'text-ink-1',
          )}
          title={file.path}
        >
          {file.name}
        </span>
        <Note wrong={wrong}>{folderFileNote(file)}</Note>
        <Refused lines={file.refused} />
      </span>
      <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100">
        <FileButton label={REVEAL} onClick={() => actions.show(file.path)}>
          <FolderOpen />
        </FileButton>
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
