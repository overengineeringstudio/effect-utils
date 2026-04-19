import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts', 'src/**/*.unit.test.tsx'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.integration.test.tsx'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
