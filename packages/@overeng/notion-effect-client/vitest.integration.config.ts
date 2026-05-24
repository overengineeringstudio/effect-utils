import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
