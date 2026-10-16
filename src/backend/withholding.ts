/**
 * What this process withholds of each kind (`@shared/withheld`), for every read and change of
 * the cluster it makes: set once as it starts (`withholdFrom`), by what reads its plugin files
 * (`withholding`, in plugins-known). Until it's set, nothing of a kind that isn't Kubernetes' own
 * leaves: what can't be told is withheld.
 */
import type { Withholding } from '@shared/withheld'
import { KubeRequestError } from './kube/errors'

let reader: (() => Promise<Withholding>) | undefined

/**
 * Where what's withheld is read from, now and from now on: read once at once, so the first
 * object asked for doesn't wait for every file to be read.
 */
export function withholdFrom(read: () => Promise<Withholding>): void {
  reader = read
  // (Failing, it's read again, and said, when it's asked for.)
  read().catch(() => undefined)
}

/**
 * What's withheld of each kind now, and the files that may withhold what can't be told; refused
 * while nothing has said where it's read from.
 */
export async function withheld(): Promise<Withholding> {
  if (!reader) {
    throw new KubeRequestError(
      'server',
      'Lumovi can’t show this yet: it hasn’t read what its plugins keep from being shown.',
    )
  }
  return reader()
}
