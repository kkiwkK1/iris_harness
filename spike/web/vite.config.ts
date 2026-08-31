import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

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
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
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
