/**
 * The user's own plugins: YAML files in ~/.lumovi/plugins (or the folder in
 * LUMOVI_PLUGINS_DIR). They are read whenever the page asks, so changes show
 * up on the next refresh; the page checks and applies them.
 */
import type { Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LocalPlugins } from '@shared/api'

const MAX_FILES = 200
const MAX_BYTES = 256 * 1024

/** Where the user's plugins are, and how to show that folder: inside the home folder as ~/… */
export function pluginsDirectory(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; shown: string } {
  const path = env.LUMOVI_PLUGINS_DIR || join(home, '.lumovi', 'plugins')
  return { path, shown: path.startsWith(home + sep) ? join('~', relative(home, path)) : path }
}

export async function readPlugins({
  path,
  shown,
}: {
  path: string
  shown: string
}): Promise<LocalPlugins> {
  const directory = shown
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    // No folder: no plugins of one's own.
    return { directory, files: [] }
  }
  const names = entries
    // Links too: a ConfigMap mounted as a volume (as the Helm chart's plugins are) is links into
    // a folder of its own.
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_FILES)
  const files = await Promise.all(
    names.map(async (name) => {
      try {
        // Checked and read through one open file, so it can't be swapped in between.
        const file = await open(join(path, name), 'r')
        try {
          const { size } = await file.stat()
          if (size > MAX_BYTES) {
            return { name, text: '', error: `It’s larger than ${MAX_BYTES / 1024} KB.` }
          }
          return { name, text: await file.readFile('utf8') }
        } finally {
          await file.close()
        }
      } catch (error) {
        // A link to nothing, or to a folder: the others still load.
        return { name, text: '', error: `It couldn’t be read: ${(error as Error).message}` }
      }
    }),
  )
  return { directory, files }
}
