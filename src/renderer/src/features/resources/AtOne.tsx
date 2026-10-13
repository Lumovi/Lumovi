/**
 * A kind's list at one object, as a plugin's page opens it (`spec.opens`): its exact name, and its
 * namespace where it has one. The list says so, and whose page opened it, with a way back to the
 * whole list. What it reads is the list's own, as the person, and nothing of it reaches a plugin.
 */
import { X } from 'lucide-react'
import { OBJECT_NAME } from '@shared/kit/declare'
import { NAMESPACE_NAME } from '@shared/node-shell'
import { whose, type ListedPlugin } from '@shared/plugins'
import { PluginIcon } from '@renderer/components/KindIcon'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { CODE_PAGES } from '@renderer/lib/code-pages'
import { AT_ONE } from '@renderer/lib/routes'

export interface AtOne {
  name: string
  namespace?: string
  /** The plugin whose page opened it, where its file says its pages open this kind. */
  plugin?: ListedPlugin
}

/**
 * The one object a list's address names, or nothing: a name an object can have, and a namespace
 * that's a namespace's name (another is no filter at all). Whose page opened it is said only of a
 * plugin in use whose file says its pages open this kind: never a name the address alone gives.
 * (Only a plugin's page opens a list so: where Lumovi offers code pages.)
 */
export function atOne(
  params: URLSearchParams,
  kind: string,
  plugins: readonly ListedPlugin[],
): AtOne | undefined {
  if (!CODE_PAGES) return undefined
  const name = params.get(AT_ONE.name)
  if (name === null || !OBJECT_NAME.test(name)) return undefined
  const namespace = params.get(AT_ONE.namespace)
  if (namespace !== null && !NAMESPACE_NAME.test(namespace)) return undefined
  const named = params.get(AT_ONE.plugin)
  const plugin = plugins.find((each) => each.name === named && each.opens.includes(kind))
  return {
    name,
    ...(namespace !== null && { namespace }),
    ...(plugin && { plugin }),
  }
}

/** The field selector of one object's name, as Kubernetes reads one: `\`, `,` and `=` escaped. */
export const nameSelector = (name: string) =>
  `metadata.name=${name.replace(/[\\,=]/g, (character) => `\\${character}`)}`

/** What forgets a list's one object: the address without it. */
export function clearAtOne(params: URLSearchParams) {
  for (const key of Object.values(AT_ONE)) params.delete(key)
}

/**
 * Above the list: a chip of the one object, as Lumovi's filters that can be cleared are drawn
 * (whose mark before it; its name, cut in its middle where it's long, and its namespace whole; and
 * × to clear it), and a line of why only it is shown.
 */
export function AtOneNote({
  at,
  apiKind,
  namespaced,
  onClear,
}: {
  at: AtOne
  apiKind: string
  namespaced: boolean
  onClear: () => void
}) {
  const shown = namespaced && at.namespace !== undefined
  return (
    <div
      role="note"
      data-testid="list-at-one"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-2 px-5 py-2 text-xs text-ink-2 phone:px-4"
    >
      <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-surface pr-0.5 pl-2 text-ink-1">
        {at.plugin && <PluginIcon plugin={at.plugin} className="size-3.5 shrink-0 text-ink-2" />}
        {/* (Its parts apart in its row, and as words where it's read: the spaces between.) */}
        <span className="shrink-0 text-ink-3">name</span>{' '}
        <MiddleTruncate text={at.name} className="max-w-[260px]" />
        {shown && (
          <>
            {' '}
            <span className="shrink-0 whitespace-nowrap">
              <span className="text-ink-3">· namespace</span> {at.namespace}
            </span>
          </>
        )}
        <button
          type="button"
          aria-label={`Clear the filter and show every ${apiKind}`}
          onClick={onClear}
          // (Under a finger, 44 pixels to hit, round the chip's own small ×.)
          className="relative grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink-1 touch:after:absolute touch:after:-inset-3 touch:after:content-['']"
        >
          <X className="size-3" aria-hidden />
        </button>
      </span>
      {/* (On a phone, a row of its own under the chip: never a narrow column beside it.) */}
      <span className="min-w-0 flex-1 phone:basis-full">
        {at.plugin
          ? `Opened from ${whose(at.plugin.label)} page: only this one is shown.`
          : 'Only this one is shown.'}{' '}
        Clear the filter to see every {apiKind}.
      </span>
    </div>
  )
}

/**
 * Where none is found: which one, and where it was looked for, as the person may see it. Of a kind
 * with namespaces, named without one (an address made by hand), that's the namespaces picked.
 */
export function atOneEmpty(at: AtOne, apiKind: string, namespaced: boolean, scope: string): string {
  const where = !namespaced ? '' : at.namespace !== undefined ? ` in ${at.namespace}` : ` ${scope}`
  return `No ${apiKind} ${at.name}${where} that you can see`
}
