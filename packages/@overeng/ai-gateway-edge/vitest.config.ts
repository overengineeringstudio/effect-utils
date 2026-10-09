import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
