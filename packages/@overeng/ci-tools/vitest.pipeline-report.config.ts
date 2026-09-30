import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/pipeline-report.integration.test.ts'],
    testTimeout: 30_000,
  },
})
