import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only by default (fast feedback loop)
    include: ['src/**/*.unit.test.ts'],
    // Exclude integration and playwright tests
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    // Required for @effect/vitest
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
