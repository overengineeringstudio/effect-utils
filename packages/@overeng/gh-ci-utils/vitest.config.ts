import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['effect', 'vitest', '@effect/vitest'] },
  test: {
    // BUCK.genie.ts keeps the loopback integration fixture in the source-side complement.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.integration.test.ts'],
    server: { deps: { inline: ['@effect/vitest', 'effect'] } },
  },
})
