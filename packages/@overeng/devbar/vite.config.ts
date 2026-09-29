import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

const publicationEntry = new URL('./src/mod.ts', import.meta.url).pathname
const tokensEntry = new URL('./src/tokens.stylex.ts', import.meta.url).pathname
const themesEntry = new URL('./src/themes.ts', import.meta.url).pathname
const storybookPreviewEntry = new URL('./.storybook/preview.tsx', import.meta.url).pathname

export default defineConfig({
  plugins: [
    createStylexVitePlugins({
      entries: [publicationEntry, tokensEntry, themesEntry, storybookPreviewEntry],
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
        /^@overeng\/stylex-tokens(?:\/|$)/,
        /^@stylexjs\/stylex(?:\/|$)/,
        /^react(?:\/|$)/,
      ],
    },
    sourcemap: true,
  },
})
