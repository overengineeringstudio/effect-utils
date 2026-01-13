import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Integration tests only
    include: ['src/**/*.integration.test.ts'],
    // Required for @effect/vitest
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
