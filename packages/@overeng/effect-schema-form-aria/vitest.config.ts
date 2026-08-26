import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { createStylexVitePlugin } from '@overeng/stylex-preset/vite'

// StyleX styles are compiled away at build time, so unit tests that render
// components need the same transform the bundler applies. The token package
// ships uncompiled StyleX source and must be inlined so the plugin can
// transform it.
export default defineConfig({
  plugins: [createStylexVitePlugin(), react()],
  ssr: { noExternal: ['@overeng/stylex-preset'] },
  test: {
    exclude: ['**/dist/**', '**/node_modules/**'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
