/**
 * What a Secret's part on a plugin's page is drawn from: its title, and the Secret its token
 * stood for, with whose page it is and what that page's code was handed with. A press's read
 * names those, and the backend holds the read to them.
 *
 * A page Lumovi doesn't know both of (whose it is, and what its code was handed with) is never
 * read for: its part is drawn with no Secret at all, and its card says there's none. Nothing is
 * read for a plugin's page as a read of the person's own and no plugin's.
 */
import type { SecretRef } from '@shared/kit/declare'
import type { SecretShown } from '@shared/kit/shown'

export interface SecretVia {
  plugin: string
  digest: string
  codeDigest: string
}

export function secretPart(
  props: Readonly<Record<string, unknown>>,
  /** Whose page it is, as Lumovi lists the plugin (`PageBy`). */
  by: { plugin: string } | undefined,
  /** What the page's code was handed with (`HandedWith`). */
  code: { digest: string; codeDigest: string } | undefined,
): { shown: SecretShown; via?: SecretVia } {
  const { title, secret, keys } = props as {
    title: { their: string }
    secret?: SecretRef
    keys?: readonly { their: string }[]
  }
  // (A name or a digest that says nothing is as good as none.)
  const via =
    by?.plugin && code?.digest && code.codeDigest
      ? { plugin: by.plugin, digest: code.digest, codeDigest: code.codeDigest }
      : undefined
  return {
    shown: {
      title: title.their,
      ...(via && secret ? { secret } : {}),
      ...(keys ? { keys: keys.map((key) => key.their) } : {}),
    },
    ...(via ? { via } : {}),
  }
}
