import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    testTimeout: 60000, // Integration tests with pnpm can be slow
  },
})
