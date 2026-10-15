import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/pnpm-deployed.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    testTimeout: 30_000,
  },
})
