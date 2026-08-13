import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts', 'src/**/*.integration.test.ts'],
  },
})
