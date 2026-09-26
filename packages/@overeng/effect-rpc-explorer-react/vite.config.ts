import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

const publicationEntry = new URL('./src/mod.ts', import.meta.url).pathname
const tokensEntry = new URL('./src/tokens.stylex.ts', import.meta.url).pathname
const themesEntry = new URL('./src/themes.ts', import.meta.url).pathname
const storybookPreviewEntry = new URL('./.storybook/preview.tsx', import.meta.url).pathname
const resetStylesheet = new URL('./src/styles.css', import.meta.url).pathname

const includePublicationReset = {
  name: 'effect-rpc-explorer-react:publication-reset',
  apply: 'build',
  enforce: 'pre',
  // oxlint-disable-next-line overeng/named-args -- Vite's transform hook is positional.
  transform: (code, id) =>
    id === publicationEntry
      ? { code: `import ${JSON.stringify(resetStylesheet)}\n${code}`, map: null }
      : undefined,
} satisfies Plugin

export default defineConfig({
  plugins: [
    includePublicationReset,
    createStylexVitePlugins({
      entries: [publicationEntry, tokensEntry, themesEntry, storybookPreviewEntry],
      useCSSLayers: { before: ['overeng.reset'] },
    }),
    react(),
  ],
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        mod: publicationEntry,
        'tokens.stylex': tokensEntry,
        themes: themesEntry,
      },
      formats: ['es'],
      cssFileName: 'styles',
    },
    rolldownOptions: {
      external: [
        /^@overeng\/effect-rpc-explorer(?:\/|$)/,
        /^@overeng\/stylex-tokens(?:\/|$)/,
        /^@stylexjs\/stylex(?:\/|$)/,
        /^effect(?:\/|$)/,
        /^react(?:\/|$)/,
        /^react-aria-components(?:\/|$)/,
      ],
    },
    sourcemap: true,
  },
})
