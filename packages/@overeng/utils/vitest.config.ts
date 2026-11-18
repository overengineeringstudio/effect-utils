import { defineConfig } from 'vitest/config'

// Shared CLI golden fixtures freeze the legacy, process-local calendar bucket in UTC.
process.env.TZ = 'UTC'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Host integration suites run through the exact unbounded complement declared in BUCK.genie.ts.
    exclude: ['src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // The first lock/file-system test in a fresh CI worker can exceed the 5s
    // default under load (it passes in <1s locally). 20s absorbs cold-start cost.
    testTimeout: 20000,
  },
})
