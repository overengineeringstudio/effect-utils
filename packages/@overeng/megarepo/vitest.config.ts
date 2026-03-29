import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    /** Integration tests spawn git subprocesses whose overhead varies across CI runners */
    testTimeout: 15_000,
  },
})
