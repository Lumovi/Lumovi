/**
 * Istanbul instrumentation for coverage builds (`npm run build:coverage`).
 *
 * The raw TypeScript sources are instrumented *before* any other transform, so
 * the recorded locations map 1:1 onto the files in `src/` without source-map
 * remapping. Counters live on `globalThis.__coverage__` in every process:
 *
 * - main:     flushed to `$KUBESTACKS_COVERAGE_DIR` when the process exits
 * - preload:  exposed to the page as `window.__kubestacksCoverage__()`
 * - renderer: read straight from `window.__coverage__`, and sent to the main
 *             process to be written before the page reloads
 *
 * The collection hooks are appended after instrumentation, so they are never
 * counted as application code. Files are keyed by repo-relative POSIX paths so
 * the coverage of the Linux, macOS and Windows runs can be merged in CI: a few
 * code paths are OS-specific and only the union reaches 100%.
 */
import { relative, resolve, sep } from 'node:path'
import { createInstrumenter } from 'istanbul-lib-instrument'
import type { Plugin } from 'vite'

type Target = 'main' | 'preload' | 'renderer'

const MAIN_FLUSH = `
import { app as __kubestacksApp, ipcMain as __kubestacksIpc } from 'electron';
;(() => {
  const dir = process.env.KUBESTACKS_COVERAGE_DIR
  const write = (name, data) => {
    if (!dir || !data) return
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data))
  }
  const unique = () => process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  // Written when quitting starts and again at exit (same file), so code that runs
  // while the app shuts down (closing streams…) is counted too.
  const file = 'main-' + unique()
  const flush = () => write(file, globalThis.__coverage__)
  process.once('exit', flush)
  __kubestacksApp.once('will-quit', flush)
  // A second instance quits before it is ready, without emitting will-quit.
  if (!__kubestacksApp.hasSingleInstanceLock()) flush()
  // Renderer counters would otherwise be lost when the page reloads.
  __kubestacksIpc.on('kubestacks:coverage', (event, data) => {
    write('renderer-' + unique(), data)
    event.returnValue = null
  })
})();
`

const PRELOAD_EXPOSE = `
;(() => {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('__kubestacksCoverage__', () => globalThis.__coverage__);
  contextBridge.exposeInMainWorld('__kubestacksSaveCoverage__', (data) => ipcRenderer.sendSync('kubestacks:coverage', data));
})();
`

const RENDERER_SAVE = `
;addEventListener('pagehide', () => globalThis.__kubestacksSaveCoverage__?.(globalThis.__coverage__));
`

const toPosix = (path: string) => path.split(sep).join('/')

export function coverage(target: Target, enabled: boolean): Plugin[] {
  if (!enabled) return []
  // Vite reports module ids with forward slashes on every OS (C:/repo/src/... on Windows).
  const srcDir = `${toPosix(resolve('src'))}/`.toLowerCase()
  const instrumenter = createInstrumenter({
    esModules: true,
    compact: false,
    produceSourceMap: true,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: ['typescript', 'jsx', 'importAttributes', 'explicitResourceManagement'],
  })

  return [
    {
      name: 'kubestacks:coverage-instrument',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0] ?? id
        const inSrc = toPosix(file).toLowerCase().startsWith(srcDir)
        if (!inSrc || !/\.tsx?$/.test(file) || file.endsWith('.d.ts')) return
        // Repo-relative POSIX paths let coverage from Linux, macOS and Windows runs merge.
        const key = toPosix(relative(process.cwd(), file))
        const instrumented = instrumenter.instrumentSync(code, key)
        return { code: instrumented, map: instrumenter.lastSourceMap() as never }
      },
    },
    {
      name: 'kubestacks:coverage-collect',
      renderChunk(code, chunk) {
        if (!chunk.isEntry) return null
        if (target === 'main') return code + MAIN_FLUSH
        if (target === 'preload') return code + PRELOAD_EXPOSE
        return code + RENDERER_SAVE
      },
    },
  ]
}
