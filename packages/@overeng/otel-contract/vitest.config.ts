import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
