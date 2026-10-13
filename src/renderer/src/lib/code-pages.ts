/**
 * Whether Lumovi offers plugins' pages drawn by their own code: their pages, tabs and commands, the
 * switch that turns a plugin's code off, and the Plugins page's words that go with them. One
 * constant for all of it, so a release has all of them, or none.
 *
 * In the tests' build, always (its stand-ins' code comes with the tests). In a release, where
 * `IN_A_RELEASE` says so, and only for a plugin whose code comes with this Lumovi: never a page
 * that couldn't start.
 */
/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

/** Whether a release offers plugins' pages drawn by their code. */
export const IN_A_RELEASE = true

/** Whether this is the tests' build. (Asked so that a test that reads this module outside a build can.) */
const TESTS = typeof LUMOVI_TEST_BUILD !== 'undefined' && LUMOVI_TEST_BUILD

/** Whether this Lumovi offers any: the switch and the Plugins page's words follow this. */
export const CODE_PAGES: boolean = TESTS || IN_A_RELEASE

/**
 * The plugins whose code comes with this Lumovi, as its build says (`virtual:lumovi-plugins/coded`,
 * handed over where the page's plugins are loaded: this stays free of what only a build has).
 */
let coded: ReadonlySet<string> = new Set()
export function setCodedPlugins(names: readonly string[]): void {
  coded = new Set(names)
}

/** What decides it: the tests' build or not, a release's flag, and the plugins with code here. */
export interface Offering {
  tests: boolean
  release: boolean
  coded: ReadonlySet<string>
}

/** Whether `plugin`'s pages, tabs and commands are offered, as `offering` decides. */
export const offered = ({ tests, release, coded }: Offering, plugin: string): boolean =>
  tests || (release && coded.has(plugin))

/**
 * The desktop app's: the person's own plugins with code (each in a folder of its own), whose
 * pages are offered as Lumovi's own are. Whether their code runs is Developer mode's and the
 * person's to say, as their pages open.
 */
let own: ReadonlySet<string> = new Set()
export function setOwnPlugins(names: readonly string[]): void {
  own = new Set(names)
}

/** Whether `plugin`'s pages, tabs and commands are offered here. */
export const offersPages = (plugin: string): boolean =>
  offered({ tests: TESTS, release: IN_A_RELEASE, coded: new Set([...coded, ...own]) }, plugin)
