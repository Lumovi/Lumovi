import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { coverage } from './scripts/vite-coverage'
import { licenses } from './scripts/vite-licenses'

const withCoverage = process.env.KUBESTACKS_COVERAGE === 'true'

/**
 * The dev server injects an inline React Refresh preamble and talks to the page
 * over a websocket, so the Content Security Policy is relaxed for `npm run dev`
 * only. Builds keep the strict policy from index.html.
 */
const devContentSecurityPolicy: Plugin = {
  name: 'kubestacks:dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'self'", "connect-src 'self' ws: wss:"),
}
const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [...coverage('main', withCoverage), licenses()],
    build: {
      externalizeDeps: true,
      sourcemap: withCoverage ? false : 'hidden',
    },
  },
  preload: {
    resolve: { alias },
    plugins: [...coverage('preload', withCoverage), licenses()],
    build: {
      externalizeDeps: true,
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { ...alias, '@renderer': resolve('src/renderer/src') },
    },
    plugins: [
      react(),
      tailwindcss(),
      devContentSecurityPolicy,
      ...coverage('renderer', withCoverage),
      licenses(),
    ],
    build: {
      minify: true,
      sourcemap: false,
    },
  },
})
