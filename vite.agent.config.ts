import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { coverage } from './scripts/vite-coverage'

const withCoverage = process.env.LUMOVI_COVERAGE === 'true'

/**
 * A fleet's agent (`node out/agent/agent.js`), for a cluster its hub can't
 * reach: it dials the hub and relays its API server's connections. ws is its
 * only package, which the server's third-party notices cover.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@backend': resolve('src/backend') },
  },
  plugins: coverage('server', withCoverage),
  // ws looks for optional native add-ons, which aren't bundled: it does without them.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/server/agent.ts',
    outDir: 'out/agent',
    target: 'node24',
    sourcemap: withCoverage ? false : 'hidden',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'agent.js' } },
  },
})
