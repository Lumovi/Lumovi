/**
 * What the clusters page shows of a cluster and of the kubeconfig files it reads, worked out
 * from what the kubeconfig and Lumovi say: names, letters, and the words for where a file is from.
 */
import type { KubeconfigFiles, KubeContext } from '@shared/api'
import { api } from '@renderer/lib/api'
import { pluralize } from '@renderer/lib/format'

/** One or two letters for a cluster's tile: a display name's words, or the context's first letter. */
export function initials(context: string, name?: string): string {
  if (!name) return (context.match(/[A-Za-z0-9]/)?.[0] ?? context[0] ?? '?').toUpperCase()
  const words = name.split(/\s+/).filter((word) => /^[A-Za-z0-9]/.test(word))
  if (words.length === 0) return initials(context)
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2)).toUpperCase()
}

/** A long name, cut in the middle so both its start and its end show. */
export function middle(text: string, max = 46): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) * 0.42)
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

/** A path in the home folder from `~`, as people write it. */
export function tilde(path: string, home: string): string {
  const separator = api.platform === 'win32' ? '\\' : '/'
  return path === home
    ? '~'
    : path.startsWith(home + separator)
      ? `~${separator}${path.slice(home.length + 1)}`
      : path
}

export type KubeconfigFile = KubeconfigFiles['files'][number]
export type KubeconfigFolder = KubeconfigFiles['folders'][number]
export type FolderFile = KubeconfigFolder['files'][number]

/** Where a file is from, in a word or two. */
export const ORIGIN: Record<KubeconfigFile['origin'], string> = {
  default: 'The default',
  env: 'From KUBECONFIG',
  chosen: 'Chosen in Lumovi',
  added: 'Added in Lumovi',
  own: 'Clusters added in Lumovi',
}

/** How many clusters, as a note says it. */
export const clusterCount = (count: number) => `${count} ${count === 1 ? 'cluster' : 'clusters'}`

/**
 * What's wrong with a file, if anything: gone, or unreadable; or unreadable now, with what it said
 * when it last could be read kept (milder: its clusters still work).
 */
export function trouble(
  file: KubeconfigFile | FolderFile,
): 'gone' | 'unreadable' | 'kept' | undefined {
  if (file.keptFrom) return 'kept'
  if (file.problem) return 'unreadable'
  // KUBECONFIG may name files that aren't there, as kubectl allows; ~/.kube/config may not be.
  if ('origin' in file && !file.exists && (file.origin === 'chosen' || file.origin === 'added')) {
    return 'gone'
  }
  return undefined
}

/** A time of day, as this computer says it. */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** What a file that can't be read now, and whose last read is kept, says. */
function keptNote(file: KubeconfigFile | FolderFile): string {
  return `Couldn’t be read at ${clock(file.failedAt!)}: ${file.problem!.replace(/\.$/, '')}. Its ${pluralize(file.contexts ?? 0, 'context')} are as they were at ${clock(file.keptFrom!)}, and still connect with the credentials it held then.`
}

/** A file's note: where it's from and how many clusters, or what's wrong. */
export function fileNote(file: KubeconfigFile): string {
  const wrong = trouble(file)
  if (wrong === 'kept') return keptNote(file)
  if (wrong === 'gone') return 'Missing: it was moved or deleted'
  if (wrong === 'unreadable') return `Couldn’t be read: ${file.problem}`
  if (!file.exists) return `${ORIGIN[file.origin]} · not there`
  return `${ORIGIN[file.origin]} · ${clusterCount(file.contexts ?? 0)}`
}

/** A folder's kubeconfig's note: its contexts and how many ask first, or what's wrong. */
export function folderFileNote(file: FolderFile): string {
  const wrong = trouble(file)
  if (wrong === 'kept') return keptNote(file)
  if (wrong === 'unreadable') return `Couldn’t be read: ${file.problem}`
  return [
    pluralize(file.contexts ?? 0, 'context'),
    file.asks && `${file.asks} ${file.asks === 1 ? 'asks before it runs' : 'ask before they run'}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Why a folder can't be read at all. */
export const FOLDER_PROBLEM: Record<NonNullable<KubeconfigFolder['problem']>, string> = {
  gone: 'This folder isn’t there any more.',
  'not-allowed': 'Lumovi isn’t allowed to read this folder.',
  'not-a-folder': 'This isn’t a folder any more.',
}

/** A folder's note: how many kubeconfigs, contexts and skipped (none of what's nothing). */
export function folderNote(folder: KubeconfigFolder): string {
  if (folder.problem) return FOLDER_PROBLEM[folder.problem]
  const contexts = folder.files.reduce((sum, file) => sum + (file.contexts ?? 0), 0)
  return [
    folder.files.length > 0 && pluralize(folder.files.length, 'kubeconfig'),
    contexts > 0 && pluralize(contexts, 'context'),
    folder.skipped.length > 0 && `${folder.skipped.length} skipped`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Why a file in a folder isn't read. */
export const SKIPPED: Record<KubeconfigFolder['skipped'][number]['why'], string> = {
  folder: 'A folder: only the files directly in this one are read',
  'link-out': 'A link to somewhere outside this folder',
  hidden: 'Hidden, or an editor’s temporary file',
  large: 'Larger than 1 MB',
  'not-kubeconfig': 'Not a kubeconfig',
  'not-allowed': 'Lumovi isn’t allowed to read it',
}

/**
 * The files as the popover shows them: Lumovi's own as one, its folder, with all their clusters.
 */
export function shownFiles(files: KubeconfigFiles): KubeconfigFile[] {
  const own = files.files.filter((file) => file.origin === 'own')
  const others = files.files.filter((file) => file.origin !== 'own')
  if (own.length === 0) return others
  return [
    ...others,
    {
      path: files.ownFolder,
      exists: true,
      origin: 'own',
      own: true,
      contexts: own.reduce((sum, file) => sum + (file.contexts ?? 0), 0),
    },
  ]
}

/** What a cluster's second line says: its context, if it has a name of its own; else where it is. */
export function secondLine(context: KubeContext, host: string | undefined, named: boolean): string {
  if (named) return middle(context.name)
  return `${host ?? 'No cluster defined'} · ${context.user}`
}

/** Showing a file where it is, as this computer calls it. */
export const REVEAL =
  api.platform === 'darwin'
    ? 'Show in Finder'
    : api.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in folder'
