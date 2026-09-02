import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: '../../../.devenv/vite-cache/tui-core',
  test: {
    include: ['test/**/*.test.ts'],
  },
})
