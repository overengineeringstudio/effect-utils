import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts', 'src/**/*.integration.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 30000,
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
