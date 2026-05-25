import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    /** SQLite and CLI E2E files spawn real runtime resources; keep per-test timeouts meaningful under CI load. */
    fileParallelism: false,
  },
})
