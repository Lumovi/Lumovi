/**
 * Istanbul instrumentation for coverage builds (`npm run build:coverage`).
 *
 * The raw TypeScript sources are instrumented *before* any other transform, so
 * the recorded locations map 1:1 onto the files in `src/` without source-map
 * remapping. Counters live on `globalThis.__coverage__` in every process:
 *
 * - main:     flushed to `$LUMOVI_COVERAGE_DIR` when the process exits
 * - server:   the same, and when the tests ask (over IPC: Windows can't
 *             signal a process to exit gracefully)
 * - preload:  exposed to the page as `window.__lumoviCoverage__()`
 * - renderer: read straight from `window.__coverage__`, and sent to the main
 *             process (or, in a browser, the tests) to be written before the
 *             page reloads; its maps are written by the build too
 *             (`RENDERER_MAPS`), for counters a browser kept without them
 * - worker:   a page's worker sends its counters after each message it posts;
 *             the page takes them (its app code never sees them) and adds what's
 *             new to its own, which go as the page's do; its maps are written
 *             with the page's (`RENDERER_MAPS`)
 *
 * The collection hooks are appended after instrumentation, so they are never
 * counted as application code. Files are keyed by repo-relative POSIX paths so
 * the coverage of the Linux, macOS and Windows runs can be merged in CI: a few
 * code paths are OS-specific and only the union reaches 100%.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { createInstrumenter } from 'istanbul-lib-instrument'
import type { Plugin } from 'vite'

type Target = 'main' | 'server' | 'preload' | 'renderer' | 'worker'

const MAIN_FLUSH = `
import { app as __lumoviApp, ipcMain as __lumoviIpc } from 'electron';
;(() => {
  const dir = process.env.LUMOVI_COVERAGE_DIR
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
  __lumoviApp.once('will-quit', flush)
  // A second instance quits before it is ready, without emitting will-quit.
  if (!__lumoviApp.hasSingleInstanceLock()) flush()
  // Renderer counters would otherwise be lost when the page reloads.
  __lumoviIpc.on('lumovi:coverage', (event, data) => {
    write('renderer-' + unique(), data)
    event.returnValue = null
  })
})();
`

// Before the server's own code, so a server that fails to start still reports what ran.
const SERVER_FLUSH = `
;(() => {
  const dir = process.env.LUMOVI_COVERAGE_DIR
  if (!dir) return
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const file = path.join(dir, 'server-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  const flush = () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(globalThis.__coverage__))
  }
  process.once('exit', flush)
  process.on('message', (message) => {
    // Windows has no signal that asks a process to stop: the tests ask so, and the server
    // stops as it does for SIGTERM (by its own handler; one not yet listening just ends).
    if (message === 'lumovi:stop' && !process.emit('SIGTERM')) process.exit(0)
    if (message !== 'lumovi:coverage') return
    flush()
    process.send('lumovi:coverage-saved')
  })
})();
`

const PRELOAD_EXPOSE = `
;(() => {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('__lumoviCoverage__', () => globalThis.__coverage__);
  contextBridge.exposeInMainWorld('__lumoviSaveCoverage__', (data) => ipcRenderer.sendSync('lumovi:coverage', data));
})();
`

// The desktop app hands its counters to the main process. A browser keeps them in the
// page's localStorage, adding each page's to its earlier ones', for the tests to read
// (the maps they belong to are every page's, and too large to keep there).
const RENDERER_SAVE = `
;addEventListener('pagehide', () => {
  const coverage = globalThis.__coverage__
  if (globalThis.__lumoviSaveCoverage__) return globalThis.__lumoviSaveCoverage__(coverage)
  const key = 'lumovi:coverage'
  const kept = JSON.parse(localStorage.getItem(key) || '{}')
  for (const [path, file] of Object.entries(coverage)) {
    const counts = (kept[path] = kept[path] || { s: {}, f: {}, b: {} })
    for (const [id, hits] of Object.entries(file.s)) counts.s[id] = (counts.s[id] || 0) + hits
    for (const [id, hits] of Object.entries(file.f)) counts.f[id] = (counts.f[id] || 0) + hits
    for (const [id, hits] of Object.entries(file.b)) {
      counts.b[id] = hits.map((n, i) => ((counts.b[id] || [])[i] || 0) + n)
    }
  }
  localStorage.setItem(key, JSON.stringify(kept))
});
`

// A worker posts its counters after each message of its own: all of them so far, for the page
// to take what's new since the last. Its maps go once, with the first; after that, its counts.
const WORKER_SEND = `
;(() => {
  const post = globalThis.postMessage.bind(globalThis)
  let mapped = false
  globalThis.postMessage = (...message) => {
    post(...message)
    const coverage = globalThis.__coverage__ || {}
    const counters = mapped
      ? Object.fromEntries(
          Object.entries(coverage).map(([path, file]) => [
            path,
            { hash: file.hash, s: file.s, f: file.f, b: file.b },
          ]),
        )
      : coverage
    mapped = true
    post({ __lumoviCoverage__: counters })
  }
})();
`

// Before the page's own code: its workers' counters are taken as they come, before any
// listener of the page's hears of them, and what's new in each is added to the page's. A file
// the page has too is counted against the page's maps only where both were made from the same
// code (istanbul's hash); otherwise the worker's are kept under a name of their own, which no
// build's maps have, so the tests' bookkeeping fails on it by name rather than count them wrong.
const RENDERER_WORKERS = `
;(() => {
  const Base = globalThis.Worker
  if (!Base) return
  const add = (counters, before) => {
    const into = (globalThis.__coverage__ = globalThis.__coverage__ || {})
    for (const [path, file] of Object.entries(counters)) {
      const was = before[path] || { s: {}, f: {}, b: {} }
      const key =
        into[path] && into[path].hash !== file.hash ? path + ' (a worker’s, from other code)' : path
      if (!into[key] && !file.statementMap) continue
      const counts = (into[key] = into[key] || { ...file, s: {}, f: {}, b: {} })
      for (const [id, hits] of Object.entries(file.s)) {
        counts.s[id] = (counts.s[id] || 0) + hits - (was.s[id] || 0)
      }
      for (const [id, hits] of Object.entries(file.f)) {
        counts.f[id] = (counts.f[id] || 0) + hits - (was.f[id] || 0)
      }
      for (const [id, hits] of Object.entries(file.b)) {
        counts.b[id] = hits.map((n, i) => ((counts.b[id] || [])[i] || 0) + n - ((was.b[id] || [])[i] || 0))
      }
    }
  }
  globalThis.Worker = class extends Base {
    constructor(...args) {
      super(...args)
      let before = {}
      this.addEventListener('message', (event) => {
        const counters = event.data && event.data.__lumoviCoverage__
        if (!counters) return
        event.stopImmediatePropagation()
        add(counters, before)
        before = counters
      })
    }
  }
})();
`

const toPosix = (path: string) => path.split(sep).join('/')

/**
 * Every renderer file's maps, as a coverage build instruments them: beside the pages, never
 * among them (they're served). The tests read them from here, since a page's are large and
 * reading them from it takes its thread for seconds while a test is timing it.
 */
export const RENDERER_MAPS = 'out/renderer-coverage-maps.json'

/**
 * The renderer's files' maps, and its workers': one object, filled by both builds' transforms
 * (a worker's build runs inside the renderer's), and written once, by the renderer's, after its
 * workers' are done. A file only a worker runs is then mapped too, not "counted with no maps".
 */
const maps: Record<string, unknown> = {}

export function coverage(target: Target, enabled: boolean): Plugin[] {
  // (A build made as a release's leaves none behind from an earlier one.)
  if (!enabled) {
    return target === 'renderer'
      ? [{ name: 'lumovi:coverage-none', buildStart: () => rmSync(RENDERER_MAPS, { force: true }) }]
      : []
  }
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
      name: 'lumovi:coverage-instrument',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0] ?? id
        const inSrc = toPosix(file).toLowerCase().startsWith(srcDir)
        if (!inSrc || !/\.tsx?$/.test(file) || file.endsWith('.d.ts')) return
        // Repo-relative POSIX paths let coverage from Linux, macOS and Windows runs merge.
        const key = toPosix(relative(process.cwd(), file))
        const instrumented = instrumenter.instrumentSync(code, key)
        if (target === 'renderer' || target === 'worker')
          maps[key] = instrumenter.lastFileCoverage()
        return { code: instrumented, map: instrumenter.lastSourceMap() as never }
      },
      writeBundle() {
        if (target !== 'renderer') return
        mkdirSync(dirname(resolve(RENDERER_MAPS)), { recursive: true })
        writeFileSync(resolve(RENDERER_MAPS), JSON.stringify(maps))
      },
    },
    {
      name: 'lumovi:coverage-collect',
      renderChunk(code, chunk) {
        if (!chunk.isEntry) return null
        if (target === 'main') return code + MAIN_FLUSH
        if (target === 'server') return SERVER_FLUSH + code
        if (target === 'preload') return code + PRELOAD_EXPOSE
        if (target === 'worker') return code + WORKER_SEND
        return RENDERER_WORKERS + code + RENDERER_SAVE
      },
    },
  ]
}
