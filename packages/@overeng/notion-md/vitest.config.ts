import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    setupFiles: ['@overeng/utils-dev/node-vitest/setup-fast-check'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
