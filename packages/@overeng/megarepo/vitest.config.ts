import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    /** CLI integration tests mutate process.env and stdio while running in-process. */
    fileParallelism: false,
    /** Integration tests spawn git subprocesses whose overhead varies across CI runners */
    testTimeout: 15_000,
  },
})
