import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['genie/buck2/**/*.unit.test.ts'],
  },
})
