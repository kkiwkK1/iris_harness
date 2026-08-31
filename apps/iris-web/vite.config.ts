import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

/**
 * Workspace packages are aliased straight at their sources rather than
 * installed.
 *
 * This app is npm-managed and outside the pnpm workspace (see
 * `pnpm-workspace.yaml` for why), so it cannot resolve `workspace:*`. Aliasing
 * to source is the standard answer and buys something anyway: editing a domain
 * package is picked up by HMR with no build step in between.
 */
const workspace = (name: string): string => src(`../../packages/${name}/src/index.ts`)

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    // The shell holds its boot at top-level await.
    target: 'es2022',
    sourcemap: true,
  },
  resolve: {
    // One React instance: a second copy splits hook and element identity.
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@iris/protocol', replacement: workspace('iris-protocol') },
      { find: '@iris/rpc-client', replacement: workspace('iris-rpc-client') },
      { find: '@iris/client-fake', replacement: workspace('iris-client-fake') },
      // The vendored Cordis Loader's only Node import.
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
  },
  server: {
    /*
     * The two host paths, proxied so `?transport=rpc` works against a running
     * host during development.
     *
     * The real client defaults to the page's own origin, which is the right
     * default — the host serves both the page and these paths in production, so
     * the browser stays same-origin and the host needs no cross-origin exception.
     * A dev server should therefore proxy rather than have the client point
     * elsewhere, or the two setups would differ in exactly the way that hides
     * bugs. `ws: true` because the event channel is a WebSocket.
     */
    proxy: {
      '/iris/rpc': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/iris/events': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
  define: {
    // The vendored Cordis loader probes the Node major to pick an internal
    // module-loader shape; "0.0.0" takes neither branch and leaves the slot
    // empty, which is exactly what the client module system fills.
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
