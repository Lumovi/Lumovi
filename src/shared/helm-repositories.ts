/**
 * Chart repositories and registries Lumovi reads charts from (LMV-354), as the page and the
 * backend both judge them: what an address may be, where a sign-in may go, and which release has
 * a newer chart in the one repository it can be from.
 */
import type { HelmRelease, HelmRepository, RepositoryChart } from './api'

/** The label Lumovi puts on a release it installed or upgraded from a repository: its id. */
export const REPOSITORY_LABEL = 'lumovi.dev/repository'

/** A repository's id: 16 hex digits, as the release label holds it. */
export const REPOSITORY_ID = /^[0-9a-f]{16}$/

/** A repository's name, as Helm's `repo add` takes one. */
export const REPOSITORY_NAME = /^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/i

/** A chart's name in a repository's index, or in a registry. */
export const CHART_NAME = /^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/i

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** A version's parts, or none where it isn't Semantic Versioning's. */
function parts(version: string) {
  const m = VERSION.exec(version.trim())
  if (!m) return undefined
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') ?? [] }
}

/** Whether a version is a pre-release (2.5.0-rc.1). */
export const isPreRelease = (version: string) => (parts(version)?.pre.length ?? 0) > 0

/**
 * Compares chart versions as Semantic Versioning orders them: negative when `a` is older. A
 * pre-release is older than its release; a version that isn't one is older than any that is.
 */
export function compareChartVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)]
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (m && n) return Number(p) - Number(q)
    if (m !== n) return m ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Whether a sign-in may be sent to an address: over https alone, never http (localhost too). */
export function signInGoes(url: URL): boolean {
  return url.protocol === 'https:'
}

/**
 * Where a repository's address points, as a URL Lumovi fetches from (a registry's over https), or
 * why it can't be one.
 */
export function addressOf(
  kind: HelmRepository['kind'],
  address: string,
): { url: URL } | { problem: string } {
  const text = address.trim()
  let url: URL
  try {
    url = new URL(kind === 'oci' ? text.replace(/^oci:\/\//i, 'https://') : text)
  } catch {
    return {
      problem:
        kind === 'oci'
          ? 'A registry’s address is oci://, its host and its path.'
          : 'A repository’s address is an https:// URL.',
    }
  }
  if (kind === 'oci' && !/^oci:\/\//i.test(text)) {
    return { problem: 'A registry’s address starts with oci://.' }
  }
  if (kind === 'http' && url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { problem: 'A repository’s address is an https:// URL.' }
  }
  if (url.username || url.password) {
    return {
      problem: 'Leave the sign-in out of the address: give it under “It needs a sign-in”.',
    }
  }
  if (url.search || url.hash) return { problem: 'A repository’s address has no ? or #.' }
  if (kind === 'oci' && url.pathname.replace(/\/+$/, '') === '') {
    return { problem: 'Add the path its charts are under: oci://ghcr.io/acme/charts.' }
  }
  return { url }
}

/**
 * Whether a sign-in given for one address still goes to another: the same scheme, host and port.
 * Anything else, and the saved one is removed.
 */
export function sameOrigin(a: string, b: string, kind: HelmRepository['kind']): boolean {
  const [x, y] = [addressOf(kind, a), addressOf(kind, b)]
  return 'url' in x && 'url' in y && x.url.origin === y.url.origin
}

/** Whether a release's chart says it comes from where a repository's chart does. */
function sameSource(release: HelmRelease, chart: RepositoryChart): boolean {
  const norm = (url: string) =>
    url
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .toLowerCase()
  const urls = (home: string | undefined, sources: string[] | undefined) =>
    [home, ...(sources ?? [])].filter((url): url is string => Boolean(url)).map(norm)
  const ours = urls(release.chartHome, release.chartSources)
  const theirs = urls(chart.home, chart.sources)
  return ours.some((url) => theirs.includes(url))
}

/**
 * What a release's Update column says: a newer version, and where from; or nothing, and why where
 * it couldn't be sure (never "up to date": with nothing newer there's nothing to say).
 */
export type ReleaseUpdate =
  | { version: string; repository: HelmRepository; why?: undefined }
  | { version?: undefined; why?: string }

/**
 * Whether a release has a newer chart: only where Lumovi knows where it came from. Lumovi
 * installed or upgraded it from a repository (the release's label says which) and that
 * repository's chart by its name matches it by home or sources; or, with no label, its chart's
 * name and its home or sources match the one repository that has a chart by that name. Never a
 * guess: anything else says nothing, and why.
 */
export function releaseUpdate(
  release: HelmRelease,
  repositories: HelmRepository[],
  charts: RepositoryChart[],
): ReleaseUpdate {
  const named = charts.filter((chart) => chart.name === release.chart)
  const by = new Map(repositories.map((r) => [r.id, r]))
  let found: RepositoryChart | undefined
  if (release.repository) {
    const from = by.get(release.repository)
    if (!from) {
      return {
        why: `Lumovi installed ${release.name} from a repository that’s since been removed.`,
      }
    }
    found = named.find((chart) => chart.repository === from.id)
    if (!found) {
      return {
        why:
          from.read && 'error' in from.read
            ? `Lumovi couldn’t read ${from.name}, which ${release.name} came from.`
            : `${from.name}, which ${release.name} came from, has no ${release.chart} now.`,
      }
    }
    // Whoever can write the release's record can write its label: the chart must be that
    // repository's too, by its home or sources. Never another repository in its place.
    if (!sameSource(release, found)) {
      return {
        why: `${release.name}’s label names ${from.name}, but its chart’s sources differ from ${from.name}’s ${release.chart}.`,
      }
    }
  } else {
    const unread = repositories.filter((r) => r.read && 'error' in r.read)
    if (named.length === 0) {
      return {
        why: unread.length
          ? `No repository Lumovi could read has ${release.chart}.`
          : `No repository added has ${release.chart}.`,
      }
    }
    if (named.length > 1) {
      return {
        why: `${named.length} repositories have ${release.chart}, and nothing says which ${release.name} came from.`,
      }
    }
    found = named[0]!
    if (!sameSource(release, found)) {
      return {
        why: `${by.get(found.repository)?.name ?? 'A repository'} has a ${release.chart}, but nothing says ${release.name} came from there: Lumovi didn’t install it, and their sources differ.`,
      }
    }
  }
  const repository = by.get(found.repository)!
  // A pre-release counts only where the release runs one.
  const pre = isPreRelease(release.chartVersion)
  const newer = found.versions
    .map((v) => v.version)
    .filter((v) => pre || !isPreRelease(v))
    .sort((a, b) => compareChartVersions(b, a))[0]
  if (!newer || compareChartVersions(newer, release.chartVersion) <= 0) return {}
  return { version: newer, repository }
}
