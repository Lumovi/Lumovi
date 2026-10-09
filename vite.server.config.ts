import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { coverage } from './scripts/vite-coverage'
import { licenses } from './scripts/vite-licenses'

const withCoverage = process.env.LUMOVI_COVERAGE === 'true'

/**
 * The server (`node out/server/index.js`), with every package it uses bundled
 * in: its image needs Node.js, helm and the page's build in out/renderer.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@backend': resolve('src/backend') },
  },
  plugins: [...coverage('server', withCoverage), licenses('server')],
  // The chart of Lumovi's metrics stack is built in (src/backend/helm/metrics-stack).
  assetsInclude: ['**/*.tgz'],
  // ws looks for optional native add-ons, which aren't bundled: it does without them.
  define: {
    // The tests' stand-ins (backend/sponsor/source.ts) are in test builds only.
    LUMOVI_TEST_BUILD: JSON.stringify(withCoverage),
    'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'out/server',
    target: 'node24',
    sourcemap: withCoverage ? false : 'hidden',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
  },
})
