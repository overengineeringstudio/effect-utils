import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['genie/buck2/**/*.unit.test.ts', 'genie/buck2/**/*.integration.test.ts'],
  },
})
