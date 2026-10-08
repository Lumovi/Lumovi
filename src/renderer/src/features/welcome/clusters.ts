/**
 * What the clusters page shows of a cluster and of the kubeconfig files it reads, worked out
 * from what the kubeconfig and Lumovi say: names, letters, and the words for where a file is from.
 */
import type { KubeconfigFiles, KubeContext } from '@shared/api'
import { api } from '@renderer/lib/api'

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

/** What's wrong with a file, if anything: gone, or unreadable. */
export function trouble(file: KubeconfigFile): 'gone' | 'unreadable' | undefined {
  if (file.problem) return 'unreadable'
  // KUBECONFIG may name files that aren't there, as kubectl allows; ~/.kube/config may not be.
  if (!file.exists && (file.origin === 'chosen' || file.origin === 'added')) return 'gone'
  return undefined
}

/** A file's note: where it's from and how many clusters, or what's wrong. */
export function fileNote(file: KubeconfigFile): string {
  const wrong = trouble(file)
  if (wrong === 'gone') return 'Missing: it was moved or deleted'
  if (wrong === 'unreadable') return `Couldn’t be read: ${file.problem}`
  if (!file.exists) return `${ORIGIN[file.origin]} · not there`
  return `${ORIGIN[file.origin]} · ${clusterCount(file.contexts ?? 0)}`
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
