import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.integration.test.ts',
      'src/**/*.integration.test.tsx',
      'src/**/*.e2e.test.ts',
      'src/**/*.e2e.test.tsx',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // E2E tests hit the live Notion API and must serialize to stay within
    // rate limits. The `helpers.ts` lane also serializes within a file, but
    // we disable cross-file parallelism so the 3 req/s ceiling is safe.
    fileParallelism: false,
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
