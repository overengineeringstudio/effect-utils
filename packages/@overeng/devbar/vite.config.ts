import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

const publicationEntry = new URL('./src/mod.ts', import.meta.url).pathname
const tokensEntry = new URL('./src/tokens.stylex.ts', import.meta.url).pathname
const themesEntry = new URL('./src/themes.ts', import.meta.url).pathname
const buildIdentityEntry = new URL('./src/BuildIdentitySegment.tsx', import.meta.url).pathname
const storybookPreviewEntry = new URL('./.storybook/preview.tsx', import.meta.url).pathname

export default defineConfig({
  plugins: [
    createStylexVitePlugins({
      entries: [
        publicationEntry,
        tokensEntry,
        themesEntry,
        buildIdentityEntry,
        storybookPreviewEntry,
      ],
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
        BuildIdentitySegment: buildIdentityEntry,
      },
      formats: ['es'],
      cssFileName: 'styles',
    },
    rolldownOptions: {
      external: [
        /^@overeng\/stylex-tokens(?:\/|$)/,
        /^@overeng\/utils(?:\/|$)/,
        /^@stylexjs\/stylex(?:\/|$)/,
        /^react(?:\/|$)/,
      ],
    },
    sourcemap: true,
  },
})
