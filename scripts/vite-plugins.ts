/**
 * `virtual:lumovi-plugins`: the plugins Lumovi comes with, each plugin's file by its file name,
 * from the bundle plugins.lock.json pins, downloaded and checked as the build starts
 * (plugins-bundle.ts). If they can't be, the build stops, saying why.
 */
import type { Plugin } from 'vite'
import { verifiedPlugins, type PluginFiles } from './plugins-bundle.ts'

const ID = 'virtual:lumovi-plugins'
const RESOLVED = `\0${ID}`

/** The plugin; `take` is how the build takes the plugins' files (its tests give their own). */
export function lumoviPlugins(take: () => Promise<PluginFiles> = verifiedPlugins): Plugin {
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
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined
      return `export default Object.freeze(${JSON.stringify(files)})`
    },
  }
}
