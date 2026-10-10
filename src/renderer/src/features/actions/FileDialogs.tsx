import { Download, File, Folder, Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import {
  containerPath,
  debugKubectl,
  downloadKubectl,
  sized,
  uploadKubectl,
  type FileCopyBegun,
  type FileCopyError,
  type FileCopyResult,
  type PickedFiles,
} from '@shared/files'
import { Button } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { useProduction } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'
import { copied, stopped, useFileCopies, type FileCopy } from '@renderer/state/file-copies'
import { ActionDialog } from './ActionDialog'
import { count, subjectOf, type ActionProps } from './common'

interface Named {
  name: string
}

/** A pod's containers that run, its debug containers too: the ones tar can run in. */
function containersOf(pod: KubeObject): string[] {
  const statuses: (Named & { state?: { running?: unknown } })[] = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.ephemeralContainerStatuses ?? []),
  ]
  const names: string[] = [...pod.spec.containers, ...(pod.spec.ephemeralContainers ?? [])].map(
    (container: Named) => container.name,
  )
  const running = names.filter((name) =>
    statuses.some((status) => status.name === name && status.state?.running),
  )
  return running.length > 0 ? running : names
}

/** Whether a pod's containers are Windows': they have no tar to copy files with. */
const onWindows = (pod: KubeObject) =>
  pod.spec.os?.name === 'windows' || pod.spec.nodeSelector?.['kubernetes.io/os'] === 'windows'

const FIELD =
  'h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[12.5px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
    </label>
  )
}

function Containers({
  containers,
  value,
  onChange,
}: {
  containers: string[]
  value: string
  onChange: (container: string) => void
}) {
  return (
    <Field label="Container">
      <select
        aria-label="Container"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink-1 outline-none focus:border-accent"
      >
        {containers.map((container) => (
          <option key={container} value={container}>
            {container}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** Something to know before copying, or after: quiet, beside the form. */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-3">{children}</p>
}

/** A container without tar: why nothing was copied, and what reaches its files instead. */
function NoTar({ container, command }: { container: string; command: string }) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2.5 text-[13px] leading-relaxed text-ink-1"
    >
      <p>
        <span className="font-medium">{container} has no tar</span>, which copying files needs, as
        kubectl cp does. A debug container with tools, started beside it, sees its files under{' '}
        <code className="font-mono text-xs">/proc/1/root</code>:
      </p>
      <div className="group relative rounded-md bg-surface px-2.5 py-2">
        <code className="block pr-8 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
          {command}
        </code>
        <span className="absolute top-1 right-1">
          <CopyButton text={command} label="Copy the debug command" />
        </span>
      </div>
      <p className="text-xs text-ink-2">Or use Debug… in this pod’s actions, then copy from it.</p>
    </div>
  )
}

/** How far a copy is: what's moved so far, of how much when that's known. */
function Progress({ copy }: { copy: FileCopy }) {
  const { bytes, files, total } = copy.progress
  const going = copy.direction === 'download' ? 'Downloading' : 'Uploading'
  const known = total !== undefined && total > 0
  const part = known ? Math.min(1, bytes / total) : undefined
  return (
    <div role="status" className="space-y-2">
      <p className="text-[13px] text-ink-1">
        {going} {copy.what}
      </p>
      <div
        role="progressbar"
        aria-label={`${going} ${copy.what}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(part === undefined ? {} : { 'aria-valuenow': Math.round(part * 100) })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-series-1/20"
      >
        <div
          className={
            part === undefined
              ? 'h-full w-full animate-pulse rounded-full bg-series-1/60'
              : 'h-full rounded-full bg-series-1 transition-[width] duration-200'
          }
          style={part === undefined ? undefined : { width: `${part * 100}%` }}
        />
      </div>
      <p className="font-mono text-xs text-ink-3 tabular-nums">
        {sized(bytes)}
        {known ? ` of ${sized(total)}` : ''}
        {files > 0 ? ` · ${count(files, 'file')}` : ''}
      </p>
    </div>
  )
}

/** A copy that's done: what was copied, and where it is. */
function Done({ copy }: { copy: FileCopy }) {
  const end = copy.end!
  return (
    <div role="status" className="space-y-1.5">
      <p className="text-[13px] font-medium text-ink-1">
        {copy.direction === 'download' ? 'Downloaded' : 'Uploaded'} {copy.what}
      </p>
      <p className="text-xs leading-relaxed text-ink-2">{copied(end)}</p>
      {end.saved && (
        <p className="font-mono text-xs [overflow-wrap:anywhere] text-ink-3 selectable">
          {end.saved}
        </p>
      )}
    </div>
  )
}

/**
 * A copy as its dialog follows it: none yet, under way, done, or ended some other way (which
 * is said, and the form is there to try again).
 */
function useCopy() {
  const [id, setId] = useState<string>()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<FileCopyError>()
  const copy = useFileCopies((state) => (id ? state.copies[id] : undefined))
  const leave = useFileCopies((state) => state.leave)
  const begin = useFileCopies((state) => state.begin)
  // The dialog gone, a copy still under way says how it ends in a toast.
  useEffect(() => (id ? () => leave(id) : undefined), [id, leave])
  const ended = copy?.end
  const active = copy !== undefined && (!ended || ended.outcome === 'done')
  return {
    copy: active ? copy : undefined,
    pending,
    /** Why the last try didn't copy anything. */
    failure:
      failure ??
      (ended?.outcome === 'failed'
        ? ended.error
        : ended?.outcome === 'cancelled'
          ? ({ code: 'invalid', message: stopped(copy!.direction) } satisfies FileCopyError)
          : undefined),
    async start(
      direction: FileCopy['direction'],
      about: { what: string; context: string; command: string; total?: number },
      run: (id: string) => Promise<FileCopyResult<FileCopyBegun>>,
    ) {
      const next = crypto.randomUUID()
      setPending(true)
      setFailure(undefined)
      setId(undefined)
      try {
        const result = await run(next)
        if (result.ok) {
          begin({ id: next, direction, total: result.data.total, ...about })
          setId(next)
        } else {
          setFailure(result.error)
        }
      } finally {
        setPending(false)
      }
    },
  }
}

/** What a dialog's buttons are while its copy runs, and once it's done. */
function footerFor(copy: FileCopy | undefined, onClose: () => void): ReactNode {
  if (!copy) return undefined
  if (!copy.end) {
    return (
      <>
        <Button variant="ghost" onClick={() => api.files.cancel(copy.id)}>
          Stop
        </Button>
        <Button variant="secondary" data-confirm onClick={onClose}>
          Hide
        </Button>
      </>
    )
  }
  const { saved } = copy.end
  return (
    <>
      {saved && api.files.show && (
        <Button variant="ghost" onClick={() => api.files.show!(saved)}>
          Show in folder
        </Button>
      )}
      <Button variant="primary" data-confirm onClick={onClose}>
        Done
      </Button>
    </>
  )
}

const WINDOWS =
  'Copying files isn’t supported for Windows containers: it runs tar in the container, and they have none.'

/** `kubectl cp pod:path .`: a file or a folder out of a container. */
export function DownloadDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const { name, namespace } = object.metadata
  const containers = containersOf(object)
  const [container, setContainer] = useState(containers[0]!)
  const [path, setPath] = useState('')
  const { copy, pending, failure, start } = useCopy()
  const request = { context, namespace: namespace!, pod: name, container, path: path.trim() }
  const at = containerPath(request.path)
  const windows = onWindows(object)
  const noTar = failure?.reason === 'no-tar'
  return (
    <ActionDialog
      icon={Download}
      title={`Download from ${name}`}
      subject={subjectOf(object)}
      command={downloadKubectl(request)}
      confirmLabel="Download"
      ready={at !== undefined && !windows && !copy}
      pending={pending}
      error={noTar ? undefined : failure?.message}
      footer={footerFor(copy, onClose)}
      onClose={onClose}
      onSubmit={() =>
        void start(
          'download',
          { what: `${at!.path} from ${name}`, context, command: downloadKubectl(request) },
          (id) => api.files.download(id, request),
        )
      }
    >
      {copy ? (
        copy.end ? (
          <Done copy={copy} />
        ) : (
          <Progress copy={copy} />
        )
      ) : (
        <>
          <Containers containers={containers} value={container} onChange={setContainer} />
          <Field label="File or folder in the container">
            <input
              aria-label="File or folder in the container"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/var/log/app.log"
              spellCheck={false}
              autoComplete="off"
              className={FIELD}
            />
          </Field>
          {windows ? (
            <Note>{WINDOWS}</Note>
          ) : (
            <Note>
              {api.host === 'desktop'
                ? 'You choose where it’s saved once the container starts sending it.'
                : 'Your browser saves it: a folder comes as a .tar archive.'}{' '}
              Links in a folder aren’t copied. It runs tar in the container, and changes nothing
              there.
            </Note>
          )}
          {noTar && <NoTar container={container} command={debugKubectl(request)} />}
        </>
      )}
    </ActionDialog>
  )
}

/** `kubectl cp file pod:folder/`: a file or a folder into a folder of a container. */
export function UploadDialog({ object, onClose }: ActionProps) {
  const { context } = useCluster()
  const production = useProduction(context)
  const { name, namespace } = object.metadata
  const containers = containersOf(object)
  const [container, setContainer] = useState(containers[0]!)
  const [path, setPath] = useState('/tmp')
  const [picked, setPicked] = useState<PickedFiles>()
  const [pickFailure, setPickFailure] = useState<string>()
  const { copy, pending, failure, start } = useCopy()
  const where = { context, namespace: namespace!, pod: name, container, path: path.trim() }
  const at = containerPath(where.path)
  const windows = onWindows(object)
  const noTar = failure?.reason === 'no-tar'
  const command = uploadKubectl(where, picked?.name ?? '<file>')
  const pick = async (what: 'file' | 'folder') => {
    const result = await api.files.pick(what)
    setPickFailure(result.ok ? undefined : result.error.message)
    if (result.ok && result.data) setPicked(result.data)
  }
  return (
    <ActionDialog
      icon={Upload}
      title={`Upload to ${name}`}
      subject={subjectOf(object)}
      command={command}
      confirmLabel="Upload"
      // A container of production's takes its pod's name, typed, as other risky changes do.
      typeToConfirm={production && !copy ? name : undefined}
      ready={at !== undefined && picked !== undefined && !windows && !copy}
      pending={pending}
      error={noTar ? undefined : (failure?.message ?? pickFailure)}
      footer={footerFor(copy, onClose)}
      onClose={onClose}
      onSubmit={() =>
        void start(
          'upload',
          {
            what: `${picked!.name} to ${at!.path} in ${name}`,
            context,
            command,
            total: picked!.bytes,
          },
          (id) => api.files.upload(id, { ...where, source: picked!.handle }),
        )
      }
    >
      {copy ? (
        copy.end ? (
          <Done copy={copy} />
        ) : (
          <Progress copy={copy} />
        )
      ) : (
        <>
          <Containers containers={containers} value={container} onChange={setContainer} />
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">What to upload</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void pick('file')}>
                <File />
                Choose a file…
              </Button>
              <Button onClick={() => void pick('folder')}>
                <Folder />
                Choose a folder…
              </Button>
            </div>
            {picked && (
              <p className="mt-2 text-[13px] text-ink-1" data-picked>
                <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                  {picked.name}
                </span>
                <span className="text-ink-3">
                  {' '}
                  · {picked.folder ? `${count(picked.files, 'file')}, ` : ''}
                  {sized(picked.bytes)}
                  {picked.leftOut > 0
                    ? ` · ${count(picked.leftOut, 'link')} in it ${picked.leftOut === 1 ? 'isn’t' : 'aren’t'} sent`
                    : ''}
                </span>
              </p>
            )}
          </div>
          <Field label="Folder in the container">
            <input
              aria-label="Folder in the container"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className={FIELD}
            />
          </Field>
          {windows ? (
            <Note>{WINDOWS}</Note>
          ) : (
            <Note>
              It’s put in that folder, which must be there. Files there with the same names are
              replaced. It runs tar in the container.
            </Note>
          )}
          {noTar && <NoTar container={container} command={debugKubectl(where)} />}
        </>
      )}
    </ActionDialog>
  )
}
