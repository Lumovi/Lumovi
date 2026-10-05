import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { coverage } from './scripts/vite-coverage'

const withCoverage = process.env.LUMOVI_COVERAGE === 'true'

/**
 * The stdio bridge AI assistants start on Windows, run as Node by the app's
 * own executable (`ELECTRON_RUN_AS_NODE=1 Lumovi.exe out/mcp-stdio/bridge.cjs`).
 * One file, CommonJS whatever the package says, outside the app's archive.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@backend': resolve('src/backend') },
  },
  plugins: coverage('server', withCoverage),
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/main/mcp-node.ts',
    outDir: 'out/mcp-stdio',
    target: 'node22',
    // Small and unminified: as readable as it is.
    sourcemap: false,
    minify: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'bridge.cjs' } },
  },
})
