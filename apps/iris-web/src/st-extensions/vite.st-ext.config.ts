/**
 * The facade build: seventeen ES-module entry points whose OUTPUT PATHS are
 * the URL contract the upstream bundle's relative imports resolve to, served
 * by the host route under `/iris-st-ext/<extensionId>/<rev>/…`:
 *
 *   <rev>/script.js                                     ← facade/script.ts
 *   <rev>/scripts/events.js                             ← facade/scripts-events.ts
 *   <rev>/scripts/extensions/regex/engine.js            ← facade/scripts-extensions-regex-engine.ts
 *   …
 *
 * The kernel (the extension frame's live half) is a shared chunk behind every
 * entry, so the frame gets exactly one kernel instance no matter which facade
 * the upstream bundle imports first. Output goes to `public/st-ext/facades`
 * with `emptyOutDir: false` — the same pattern the sandbox builds use, because
 * `public/` is the one directory Vite serves verbatim and the main build
 * copies into `dist` untouched.
 */

import { defineConfig } from 'vite'

const facade = (name: string): string => `src/st-extensions/facade/${name}.ts`

const entries: Record<string, string> = {
  script: facade('script'),
  lib: facade('lib'),
  'scripts/events': facade('scripts-events'),
  'scripts/extensions': facade('scripts-extensions'),
  'scripts/world-info': facade('scripts-world-info'),
  'scripts/popup': facade('scripts-popup'),
  'scripts/openai': facade('scripts-openai'),
  'scripts/power-user': facade('scripts-power-user'),
  'scripts/slash-commands': facade('scripts-slash-commands'),
  'scripts/slash-commands/SlashCommand': facade('scripts-slash-commands-SlashCommand'),
  'scripts/slash-commands/SlashCommandArgument': facade('scripts-slash-commands-SlashCommandArgument'),
  'scripts/slash-commands/SlashCommandParser': facade('scripts-slash-commands-SlashCommandParser'),
  'scripts/tokenizers': facade('scripts-tokenizers'),
  'scripts/utils': facade('scripts-utils'),
  'scripts/group-chats': facade('scripts-group-chats'),
  'scripts/reasoning': facade('scripts-reasoning'),
  'scripts/extensions/regex/engine': facade('scripts-extensions-regex-engine'),
}

export default defineConfig({
  // The main build copies `public/` into `dist` (this output included); this
  // config is build-only and must not re-copy the tree into itself.
  publicDir: false,
  build: {
    outDir: 'public/st-ext',
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: entries,
      output: {
        format: 'es',
        entryFileNames: 'facades/[name].js',
        chunkFileNames: 'facades/chunks/[name]-[hash].js',
      },
    },
  },
})
