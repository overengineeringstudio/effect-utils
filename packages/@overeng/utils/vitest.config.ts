import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // The first lock/file-system test in a fresh CI worker can exceed the 5s
    // default under load (it passes in <1s locally). 20s absorbs cold-start cost.
    testTimeout: 20000,
  },
})
