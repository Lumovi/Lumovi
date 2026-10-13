/**
 * `virtual:lumovi-plugins`: the plugins Lumovi comes with, each plugin's file by its file name,
 * from the bundle plugins.lock.json pins, downloaded and checked as the build starts
 * (plugins-bundle.ts). If they can't be, the build stops, saying why.
 *
 * `virtual:lumovi-plugins/code`: the code beside them, by its own file name, in the backend's
 * builds alone. A page is handed a plugin's code by the backend (`pluginCode`) and by nothing
 * else, so the page's build has none of it: one that asks for it stops, saying so.
 *
 * `virtual:lumovi-plugins/coded`: the names of the plugins that have code beside them, and no
 * code: what the page needs to offer their pages, only where their code is part of this Lumovi.
 */
import type { Plugin } from 'vite'
import {
  codedPlugins,
  pluginsAndCode,
  verifiedPlugins,
  type PluginFiles,
} from './plugins-bundle.ts'

const ID = 'virtual:lumovi-plugins'
const CODE_ID = `${ID}/code`
const CODED_ID = `${ID}/coded`

/**
 * The plugin. `code`: whether this build may hold the plugins' code (the backend's do; the
 * page's never). `take` is how the build takes the plugins' files (its tests give their own).
 */
export function lumoviPlugins({
  code: holdsCode = false,
  take = verifiedPlugins,
}: { code?: boolean; take?: () => Promise<PluginFiles> } = {}): Plugin {
  let files: PluginFiles | undefined
  return {
    name: 'lumovi:plugins',
    async buildStart() {
      try {
        files = await take()
      } catch (error) {
        this.error(`Lumovi’s plugins can’t be built in:\n${(error as Error).message}`)
      }
    },
    resolveId(id) {
      if (id === CODE_ID && !holdsCode) {
        this.error(`${CODE_ID}: plugins’ code isn’t built into the page; the backend hands it over`)
      }
      return id === ID || id === CODE_ID || id === CODED_ID ? `\0${id}` : undefined
    },
    load(id) {
      if (id !== `\0${ID}` && id !== `\0${CODE_ID}` && id !== `\0${CODED_ID}`) return undefined
      const { plugins, code } = pluginsAndCode(files ?? {})
      if (id === `\0${CODED_ID}`) {
        return `export default Object.freeze(${JSON.stringify(codedPlugins(code))})`
      }
      return `export default Object.freeze(${JSON.stringify(id === `\0${ID}` ? plugins : code)})`
    },
  }
}
