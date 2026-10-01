import { apiGroupOf, apiKindOf, type ResourceKind } from '@shared/resources'

const SAFE = /^[\w@%+=:,./-]+$/

/** Quotes an argument for a POSIX shell when it needs quoting. */
function quote(arg: string): string {
  return SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * `deployment/storefront`, `certificate.cert-manager.io/api-tls`: how kubectl
 * names one object, with the group when it isn't one of the built-in kinds.
 */
export function objectArg(kind: ResourceKind, name: string): string {
  const group = apiGroupOf(kind)
  return `${apiKindOf(kind).toLowerCase()}${group ? `.${group}` : ''}/${name}`
}

/**
 * The kubectl command that makes the same change, shown next to every action
 * so people can learn from it, script it, or run it elsewhere.
 */
export function kubectl(context: string, namespace: string | undefined, ...args: string[]): string {
  return ['kubectl', ...args, ...(namespace ? ['-n', namespace] : []), '--context', context]
    .map(quote)
    .join(' ')
}
